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

export async function readInternalJson(root: string, candidate: string, errorCode: PrimeContextErrorCode = 'VALIDATION_ERROR'): Promise<unknown> {
  const content = await readInternalText(root, candidate, MAX_JSON_INPUT_BYTES);
  return parseBoundedJson(content as string, errorCode, repositoryRelativePath(root, candidate));
}

export async function writeInternalJson(root: string, candidate: string, value: unknown): Promise<void> {
  await writeInternalText(root, candidate, `${JSON.stringify(value, null, 2)}\n`);
}
