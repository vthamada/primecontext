import type { Stats } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import {
  assertNoSymbolicLinkComponents,
  assertPathInsideRoot,
  isSensitivePath,
  NodeFileSystemAdapter,
} from '@primecontext/adapters';
import { PrimeContextError, type PrimeContextErrorCode } from '@primecontext/core';

export const MAX_JSON_INPUT_BYTES = 1024 * 1024;
export const MAX_JSON_NESTING_DEPTH = 64;
export const MAX_JSON_VALUES = 100_000;
export const MAX_JSON_VALUE_HARD_LIMIT = 500_000;
export const MAX_METRICS_BYTES = 8 * 1024 * 1024;
export const MAX_METRIC_RECORDS = 10_000;

function nodeErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

export function repositoryRelativePath(root: string, candidate: string, label = 'path'): string {
  const resolvedRoot = resolve(root);
  const absolute = isAbsolute(candidate) ? resolve(candidate) : resolve(resolvedRoot, candidate);
  const relativePath = relative(resolvedRoot, absolute).replaceAll('\\', '/');
  assertPathInsideRoot(resolvedRoot, relativePath);
  if (!relativePath || relativePath === '.') {
    throw new PrimeContextError('SECURITY_ERROR', `${label} must identify a repository child path`);
  }
  return relativePath;
}

export async function ensureSafeDirectory(root: string, candidate: string): Promise<string> {
  const resolvedRoot = resolve(root);
  const relativePath = repositoryRelativePath(resolvedRoot, candidate, 'directory');
  try {
    await assertNoSymbolicLinkComponents(resolvedRoot, relativePath, { allowMissing: true });
    const absolute = assertPathInsideRoot(resolvedRoot, relativePath);
    await mkdir(absolute, { recursive: true });
    await assertNoSymbolicLinkComponents(resolvedRoot, relativePath);
    const stat = await lstat(absolute);
    if (!stat.isDirectory()) throw new PrimeContextError('IO_ERROR', `Path is not a directory: ${relativePath}`);
    return absolute;
  } catch (error) {
    if (error instanceof PrimeContextError) throw error;
    throw new PrimeContextError('IO_ERROR', `Unable to create repository directory: ${relativePath}`, [error instanceof Error ? error.message : String(error)]);
  }
}

export async function readRepositoryInputText(root: string, candidate: string, maxBytes = MAX_JSON_INPUT_BYTES): Promise<string> {
  const resolvedRoot = resolve(root);
  const relativePath = repositoryRelativePath(resolvedRoot, candidate, 'input path');
  if (isSensitivePath(relativePath)) {
    throw new PrimeContextError('SECURITY_ERROR', `Sensitive input path is blocked: ${relativePath}`);
  }
  return new NodeFileSystemAdapter().readText(resolvedRoot, relativePath, maxBytes);
}

export async function readInternalText(
  root: string,
  candidate: string,
  maxBytes: number,
  options: { allowMissing?: boolean } = {},
): Promise<string | undefined> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new PrimeContextError('IO_ERROR', 'Internal read limit must be a non-negative safe integer');
  }
  const resolvedRoot = resolve(root);
  const relativePath = repositoryRelativePath(resolvedRoot, candidate, 'internal path');
  const absolute = assertPathInsideRoot(resolvedRoot, relativePath);
  let pathWasObserved = false;
  try {
    await assertNoSymbolicLinkComponents(resolvedRoot, relativePath, options);
    const pathBefore = await lstat(absolute);
    pathWasObserved = true;
    if (!pathBefore.isFile() || pathBefore.isSymbolicLink()) {
      throw new PrimeContextError('IO_ERROR', `Path is not a regular file: ${relativePath}`);
    }
    if (pathBefore.size > maxBytes) throw new PrimeContextError('IO_ERROR', `File exceeds read limit: ${relativePath}`);

    const handle = await open(absolute, 'r');
    let bytes: Uint8Array;
    try {
      const handleBefore = await handle.stat();
      if (!sameFileSnapshot(pathBefore, handleBefore)) {
        throw new PrimeContextError('SECURITY_ERROR', `Internal file changed before its bounded read: ${relativePath}`);
      }
      const buffer = Buffer.alloc(Math.min(maxBytes + 1, handleBefore.size + 1));
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      const handleAfter = await handle.stat();
      const pathAfter = await lstat(absolute);
      await assertNoSymbolicLinkComponents(resolvedRoot, relativePath);
      if (
        !sameFileSnapshot(handleBefore, handleAfter)
        || !sameFileSnapshot(handleAfter, pathAfter)
        || offset !== handleAfter.size
      ) {
        throw new PrimeContextError('SECURITY_ERROR', `Internal file changed during its bounded read: ${relativePath}`);
      }
      if (offset > maxBytes) throw new PrimeContextError('IO_ERROR', `File exceeds read limit: ${relativePath}`);
      bytes = buffer.subarray(0, offset);
    } finally {
      await handle.close();
    }
    try {
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      throw new PrimeContextError('IO_ERROR', `File is not valid UTF-8: ${relativePath}`);
    }
  } catch (error) {
    if (options.allowMissing && !pathWasObserved && nodeErrorCode(error) === 'ENOENT') return undefined;
    if (error instanceof PrimeContextError) throw error;
    throw new PrimeContextError('IO_ERROR', `Unable to read repository file: ${relativePath}`, [error instanceof Error ? error.message : String(error)]);
  }
}

export function stateDirectoryIgnoreEntry(configuredStateDirectory: string): string {
  const normalized = configuredStateDirectory.replaceAll('\\', '/').replace(/\/$/, '');
  return `${/^[#!]/.test(normalized) ? `\\${normalized}` : normalized}/`;
}

function gitIgnoreGlobMatchesPath(pattern: string, path: string): boolean {
  let expression = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === '\\') {
      const escaped = pattern[index + 1];
      if (escaped === undefined) return true;
      expression += escaped.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      index += 1;
      continue;
    }
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        index += 1;
        if (pattern[index + 1] === '/') {
          expression += '(?:[^/]+/)*';
          index += 1;
        } else {
          expression += '.*';
        }
      } else {
        expression += '[^/]*';
      }
      continue;
    }
    if (character === '?') {
      expression += '[^/]';
      continue;
    }
    if (character === '[') {
      const closing = pattern.indexOf(']', index + 1);
      if (closing < 0) return true;
      const content = pattern.slice(index + 1, closing);
      if (content.length === 0) return true;
      const negated = content.startsWith('!') ? `^${content.slice(1)}` : content;
      expression += `[${negated.replaceAll('\\', '\\\\')}]`;
      index = closing;
      continue;
    }
    expression += character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  try {
    return new RegExp(`${expression}$`, 'u').test(path);
  } catch {
    return true;
  }
}

function negationCanReincludeStateDirectory(rule: string, stateDirectory: string): boolean {
  let pattern = rule;
  if (pattern.startsWith('/')) pattern = pattern.slice(1);
  if (pattern.endsWith('/')) pattern = pattern.slice(0, -1);
  if (pattern.length === 0) return true;
  const candidate = pattern.includes('/') ? stateDirectory : basename(stateDirectory);
  return gitIgnoreGlobMatchesPath(pattern, candidate);
}

export async function isStateDirectoryIgnored(root: string, configuredStateDirectory: string): Promise<boolean> {
  const ignore = await readInternalText(resolve(root), '.gitignore', MAX_JSON_INPUT_BYTES, { allowMissing: true });
  if (ignore === undefined) return false;
  const expected = stateDirectoryIgnoreEntry(configuredStateDirectory);
  const stateDirectory = configuredStateDirectory.replaceAll('\\', '/').replace(/\/$/, '');
  let ignored = false;
  for (const rule of ignore.split(/\r?\n/)) {
    if (rule.length === 0 || rule.startsWith('#')) continue;
    if (rule === expected) {
      ignored = true;
      continue;
    }
    if (ignored && rule.startsWith('!') && negationCanReincludeStateDirectory(rule.slice(1), stateDirectory)) {
      ignored = false;
    }
  }
  return ignored;
}

export async function assertStateDirectoryIgnored(root: string, configuredStateDirectory: string): Promise<void> {
  if (!await isStateDirectoryIgnored(root, configuredStateDirectory)) {
    throw new PrimeContextError(
      'SECURITY_ERROR',
      'state_dir must be ignored before context state can be used; run primecontext init',
    );
  }
}

function sameFileSnapshot(left: Stats, right: Stats): boolean {
  return left.isFile()
    && right.isFile()
    && left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

async function existingStat(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (nodeErrorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
}

export async function writeInternalText(root: string, candidate: string, content: string): Promise<void> {
  const resolvedRoot = resolve(root);
  const relativePath = repositoryRelativePath(resolvedRoot, candidate, 'output path');
  const parent = dirname(relativePath).replaceAll('\\', '/');
  if (parent && parent !== '.') await ensureSafeDirectory(resolvedRoot, parent);
  await assertNoSymbolicLinkComponents(resolvedRoot, relativePath, { allowMissing: true });
  const absolute = assertPathInsideRoot(resolvedRoot, relativePath);
  try {
    const stat = await existingStat(absolute);
    if (stat && !stat.isFile()) throw new PrimeContextError('IO_ERROR', `Output path is not a regular file: ${relativePath}`);
    await writeFile(absolute, content, 'utf8');
    await assertNoSymbolicLinkComponents(resolvedRoot, relativePath);
  } catch (error) {
    if (error instanceof PrimeContextError) throw error;
    throw new PrimeContextError('IO_ERROR', `Unable to write repository file: ${relativePath}`, [error instanceof Error ? error.message : String(error)]);
  }
}

export async function writeInternalTextAtomic(root: string, candidate: string, content: string): Promise<void> {
  const resolvedRoot = resolve(root);
  const relativePath = repositoryRelativePath(resolvedRoot, candidate, 'output path');
  const parent = dirname(relativePath).replaceAll('\\', '/');
  if (parent && parent !== '.') await ensureSafeDirectory(resolvedRoot, parent);
  await assertNoSymbolicLinkComponents(resolvedRoot, relativePath, { allowMissing: true });
  const absolute = assertPathInsideRoot(resolvedRoot, relativePath);
  const temporaryName = `.${basename(relativePath)}.primecontext-${process.pid}-${randomUUID()}.tmp`;
  const temporaryRelativePath = parent && parent !== '.'
    ? `${parent}/${temporaryName}`
    : temporaryName;
  const temporaryAbsolute = assertPathInsideRoot(resolvedRoot, temporaryRelativePath);
  let temporaryMayExist = false;

  try {
    const existing = await existingStat(absolute);
    if (existing && !existing.isFile()) {
      throw new PrimeContextError('IO_ERROR', `Output path is not a regular file: ${relativePath}`);
    }
    await assertNoSymbolicLinkComponents(resolvedRoot, temporaryRelativePath, { allowMissing: true });
    temporaryMayExist = true;
    const temporaryHandle = await open(temporaryAbsolute, 'wx');
    try {
      await temporaryHandle.writeFile(content, { encoding: 'utf8' });
      await temporaryHandle.sync();
    } finally {
      await temporaryHandle.close();
    }
    await assertNoSymbolicLinkComponents(resolvedRoot, temporaryRelativePath);
    const temporaryStat = await lstat(temporaryAbsolute);
    if (!temporaryStat.isFile() || temporaryStat.isSymbolicLink()) {
      throw new PrimeContextError('SECURITY_ERROR', 'Atomic output temporary path is not a regular file');
    }
    await assertNoSymbolicLinkComponents(resolvedRoot, relativePath, { allowMissing: true });
    await rename(temporaryAbsolute, absolute);
    temporaryMayExist = false;
    await assertNoSymbolicLinkComponents(resolvedRoot, relativePath);
    const finalStat = await lstat(absolute);
    if (!finalStat.isFile() || finalStat.isSymbolicLink()) {
      throw new PrimeContextError('SECURITY_ERROR', `Atomic output path is not a regular file: ${relativePath}`);
    }
  } catch (error) {
    if (temporaryMayExist) {
      try { await unlink(temporaryAbsolute); } catch { /* preserve the original failure */ }
    }
    if (error instanceof PrimeContextError) throw error;
    throw new PrimeContextError(
      'IO_ERROR',
      `Unable to replace repository file atomically: ${relativePath}`,
      [error instanceof Error ? error.message : String(error)],
    );
  }
}

export interface InternalFileRollback {
  readonly target_relative_path: string;
  readonly target_existed: boolean;
  readonly backup_relative_path?: string;
}

export async function captureInternalFileRollback(
  root: string,
  candidate: string,
  maxBytes: number,
): Promise<InternalFileRollback> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new PrimeContextError('IO_ERROR', 'Internal rollback limit must be a non-negative safe integer');
  }
  const resolvedRoot = resolve(root);
  const relativePath = repositoryRelativePath(resolvedRoot, candidate, 'rollback target');
  const absolute = assertPathInsideRoot(resolvedRoot, relativePath);
  const parent = dirname(relativePath).replaceAll('\\', '/');
  const backupName = `.${basename(relativePath)}.primecontext-${process.pid}-${randomUUID()}.rollback`;
  const backupRelativePath = parent && parent !== '.' ? `${parent}/${backupName}` : backupName;
  const backupAbsolute = assertPathInsideRoot(resolvedRoot, backupRelativePath);
  let backupMayExist = false;
  try {
    await assertNoSymbolicLinkComponents(resolvedRoot, relativePath, { allowMissing: true });
    const pathBefore = await existingStat(absolute);
    if (!pathBefore) return { target_relative_path: relativePath, target_existed: false };
    if (!pathBefore.isFile() || pathBefore.isSymbolicLink()) {
      throw new PrimeContextError('IO_ERROR', `Rollback target is not a regular file: ${relativePath}`);
    }
    if (pathBefore.size > maxBytes) throw new PrimeContextError('IO_ERROR', `Rollback target exceeds byte limit: ${relativePath}`);
    await assertNoSymbolicLinkComponents(resolvedRoot, backupRelativePath, { allowMissing: true });
    const sourceHandle = await open(absolute, 'r');
    let backupHandle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      backupMayExist = true;
      backupHandle = await open(backupAbsolute, 'wx', 0o600);
      const sourceBefore = await sourceHandle.stat();
      if (!sameFileSnapshot(pathBefore, sourceBefore)) {
        throw new PrimeContextError('SECURITY_ERROR', `Rollback target changed before backup: ${relativePath}`);
      }
      const buffer = Buffer.alloc(64 * 1024);
      let offset = 0;
      while (offset < sourceBefore.size) {
        const requested = Math.min(buffer.length, sourceBefore.size - offset);
        const { bytesRead } = await sourceHandle.read(buffer, 0, requested, offset);
        if (bytesRead <= 0) throw new PrimeContextError('IO_ERROR', `Rollback target ended during backup: ${relativePath}`);
        let written = 0;
        while (written < bytesRead) {
          const result = await backupHandle.write(buffer, written, bytesRead - written, offset + written);
          if (result.bytesWritten <= 0) throw new PrimeContextError('IO_ERROR', `Rollback backup write stalled: ${relativePath}`);
          written += result.bytesWritten;
        }
        offset += bytesRead;
      }
      await backupHandle.sync();
      const sourceAfter = await sourceHandle.stat();
      const pathAfter = await lstat(absolute);
      if (!sameFileSnapshot(sourceBefore, sourceAfter) || !sameFileSnapshot(sourceAfter, pathAfter)) {
        throw new PrimeContextError('SECURITY_ERROR', `Rollback target changed during backup: ${relativePath}`);
      }
    } finally {
      await backupHandle?.close();
      await sourceHandle.close();
    }
    const backupStat = await lstat(backupAbsolute);
    if (!backupStat.isFile() || backupStat.isSymbolicLink() || backupStat.size !== pathBefore.size) {
      throw new PrimeContextError('SECURITY_ERROR', `Rollback backup is invalid: ${relativePath}`);
    }
    return {
      target_relative_path: relativePath,
      target_existed: true,
      backup_relative_path: backupRelativePath,
    };
  } catch (error) {
    if (backupMayExist) {
      try { await unlink(backupAbsolute); } catch { /* preserve the original failure */ }
    }
    if (error instanceof PrimeContextError) throw error;
    throw new PrimeContextError('IO_ERROR', `Unable to capture rollback state: ${relativePath}`);
  }
}

export async function restoreInternalFileRollback(root: string, rollback: InternalFileRollback): Promise<void> {
  const resolvedRoot = resolve(root);
  const targetRelativePath = repositoryRelativePath(resolvedRoot, rollback.target_relative_path, 'rollback target');
  const targetAbsolute = assertPathInsideRoot(resolvedRoot, targetRelativePath);
  try {
    await assertNoSymbolicLinkComponents(resolvedRoot, targetRelativePath, { allowMissing: true });
    if (!rollback.target_existed) {
      const current = await existingStat(targetAbsolute);
      if (current) {
        if (!current.isFile() || current.isSymbolicLink()) {
          throw new PrimeContextError('SECURITY_ERROR', `Rollback target became unsafe: ${targetRelativePath}`);
        }
        await unlink(targetAbsolute);
      }
      return;
    }
    if (!rollback.backup_relative_path) throw new PrimeContextError('STATE_ERROR', 'Rollback backup path is missing');
    const backupRelativePath = repositoryRelativePath(resolvedRoot, rollback.backup_relative_path, 'rollback backup');
    const backupAbsolute = assertPathInsideRoot(resolvedRoot, backupRelativePath);
    await assertNoSymbolicLinkComponents(resolvedRoot, backupRelativePath);
    const backupStat = await lstat(backupAbsolute);
    if (!backupStat.isFile() || backupStat.isSymbolicLink()) {
      throw new PrimeContextError('SECURITY_ERROR', `Rollback backup is not a regular file: ${backupRelativePath}`);
    }
    await rename(backupAbsolute, targetAbsolute);
    await assertNoSymbolicLinkComponents(resolvedRoot, targetRelativePath);
  } catch (error) {
    if (error instanceof PrimeContextError) throw error;
    throw new PrimeContextError('STATE_ERROR', `Unable to restore rollback state: ${targetRelativePath}`);
  }
}

export async function discardInternalFileRollback(root: string, rollback: InternalFileRollback): Promise<void> {
  if (!rollback.backup_relative_path) return;
  const resolvedRoot = resolve(root);
  const backupRelativePath = repositoryRelativePath(resolvedRoot, rollback.backup_relative_path, 'rollback backup');
  const backupAbsolute = assertPathInsideRoot(resolvedRoot, backupRelativePath);
  try {
    await assertNoSymbolicLinkComponents(resolvedRoot, backupRelativePath, { allowMissing: true });
    await unlink(backupAbsolute);
  } catch (error) {
    if (nodeErrorCode(error) === 'ENOENT') return;
    if (error instanceof PrimeContextError) throw error;
    throw new PrimeContextError('IO_ERROR', `Unable to remove rollback backup: ${backupRelativePath}`);
  }
}

export async function withInternalExclusiveLock<T>(
  root: string,
  candidate: string,
  operation: () => Promise<T>,
): Promise<T> {
  const resolvedRoot = resolve(root);
  const relativePath = repositoryRelativePath(resolvedRoot, candidate, 'lock path');
  const parent = dirname(relativePath).replaceAll('\\', '/');
  if (parent && parent !== '.') await ensureSafeDirectory(resolvedRoot, parent);
  await assertNoSymbolicLinkComponents(resolvedRoot, relativePath, { allowMissing: true });
  const absolute = assertPathInsideRoot(resolvedRoot, relativePath);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let created = false;
  try {
    try {
      handle = await open(absolute, 'wx', 0o600);
      created = true;
    } catch (error) {
      if (nodeErrorCode(error) === 'EEXIST') {
        throw new PrimeContextError('STATE_ERROR', 'Context state already has an active writer');
      }
      throw error;
    }
    await handle.writeFile('primecontext-lock\n', { encoding: 'utf8' });
    await handle.sync();
    return await operation();
  } catch (error) {
    if (error instanceof PrimeContextError) throw error;
    throw new PrimeContextError('IO_ERROR', 'Unable to acquire the context-state writer lock');
  } finally {
    try { await handle?.close(); } catch { /* preserve the operation result */ }
    if (created) {
      try { await unlink(absolute); } catch { /* preserve the operation result */ }
    }
  }
}

export function parseBoundedJson(
  content: string,
  errorCode: PrimeContextErrorCode,
  label: string,
  options: { maxValues?: number } = {},
): unknown {
  const maxValues = options.maxValues ?? MAX_JSON_VALUES;
  if (!Number.isSafeInteger(maxValues) || maxValues < 1 || maxValues > MAX_JSON_VALUE_HARD_LIMIT) {
    throw new PrimeContextError(errorCode, `Invalid JSON value limit for ${label}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    throw new PrimeContextError(errorCode, `Invalid JSON input: ${label}`);
  }

  const pending: Array<{ value: unknown; depth: number }> = [{ value: parsed, depth: 0 }];
  let discoveredValueCount = 1;
  let valueCount = 0;
  while (pending.length > 0) {
    const current = pending.pop() as { value: unknown; depth: number };
    valueCount += 1;
    if (valueCount > maxValues) {
      throw new PrimeContextError(errorCode, `JSON input exceeds the ${maxValues} value limit: ${label}`);
    }
    if (current.depth > MAX_JSON_NESTING_DEPTH) {
      throw new PrimeContextError(errorCode, `JSON input exceeds the ${MAX_JSON_NESTING_DEPTH} nesting depth limit: ${label}`);
    }
    if (typeof current.value !== 'object' || current.value === null) continue;
    const values = Array.isArray(current.value)
      ? current.value
      : Object.values(current.value as Record<string, unknown>);
    if (discoveredValueCount + values.length > maxValues) {
      throw new PrimeContextError(errorCode, `JSON input exceeds the ${maxValues} value limit: ${label}`);
    }
    discoveredValueCount += values.length;
    for (const value of values) pending.push({ value, depth: current.depth + 1 });
  }
  return parsed;
}

export async function readRepositoryJson(
  root: string,
  candidate: string,
  errorCode: PrimeContextErrorCode = 'VALIDATION_ERROR',
): Promise<unknown> {
  const content = await readRepositoryInputText(root, candidate);
  return parseBoundedJson(content, errorCode, repositoryRelativePath(root, candidate));
}

export async function readCommandJsonInput(
  root: string,
  candidate: string,
  errorCode: PrimeContextErrorCode = 'VALIDATION_ERROR',
): Promise<unknown> {
  if (candidate !== '-') return readRepositoryJson(root, candidate, errorCode);
  if (process.stdin.isTTY) {
    throw new PrimeContextError(errorCode, 'Standard input requires one piped JSON value');
  }

  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  for await (const chunk of process.stdin) {
    const bytes = typeof chunk === 'string'
      ? new TextEncoder().encode(chunk)
      : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    byteLength += bytes.byteLength;
    if (byteLength > MAX_JSON_INPUT_BYTES) {
      throw new PrimeContextError(errorCode, 'Standard input exceeds the 1 MiB input limit');
    }
    chunks.push(bytes.slice());
  }
  if (byteLength === 0) throw new PrimeContextError(errorCode, 'Standard input is empty');

  const joined = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let content: string;
  try {
    content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(joined);
  } catch {
    throw new PrimeContextError(errorCode, 'Standard input must be valid UTF-8');
  }
  return parseBoundedJson(content, errorCode, 'stdin');
}

export async function readInternalJson(root: string, candidate: string, errorCode: PrimeContextErrorCode = 'VALIDATION_ERROR'): Promise<unknown> {
  const content = await readInternalText(root, candidate, MAX_JSON_INPUT_BYTES);
  return parseBoundedJson(content as string, errorCode, repositoryRelativePath(root, candidate));
}

export async function writeInternalJson(root: string, candidate: string, value: unknown): Promise<void> {
  await writeInternalText(root, candidate, `${JSON.stringify(value, null, 2)}\n`);
}
