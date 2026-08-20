import { constants, type Stats } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';
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
const MAX_INTERNAL_LOCK_BYTES = 4_096;
const MAX_INTERNAL_LOCK_OPERATION_CHARACTERS = 128;
const MAX_INTERNAL_LOCK_HOSTNAME_CHARACTERS = 255;
const MAX_STATE_IGNORE_FILES = 64;
const MAX_STATE_IGNORE_BYTES = MAX_JSON_INPUT_BYTES;

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
    await mkdir(absolute, { recursive: true, mode: 0o700 });
    await assertNoSymbolicLinkComponents(resolvedRoot, relativePath);
    const stat = await lstat(absolute);
    if (!stat.isDirectory()) throw new PrimeContextError('IO_ERROR', `Path is not a directory: ${relativePath}`);
    if (process.platform !== 'win32') {
      const directoryHandle = await open(
        absolute,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      try {
        const handleStat = await directoryHandle.stat();
        if (!handleStat.isDirectory()) {
          throw new PrimeContextError('SECURITY_ERROR', `Directory changed before permission hardening: ${relativePath}`);
        }
        await directoryHandle.chmod(0o700);
      } finally {
        await directoryHandle.close();
      }
      await assertNoSymbolicLinkComponents(resolvedRoot, relativePath);
    }
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
  let literal = '';
  for (const character of normalized) {
    literal += ['\\', '[', ']', '*', '?'].includes(character) ? `\\${character}` : character;
  }
  return `${/^[#!]/.test(normalized) ? '\\' : ''}${literal}/`;
}

function gitIgnoreRuleWithoutUnescapedTrailingSpaces(rule: string): string {
  let end = rule.length;
  while (end > 0 && rule[end - 1] === ' ') {
    let precedingBackslashes = 0;
    for (let index = end - 2; index >= 0 && rule[index] === '\\'; index -= 1) {
      precedingBackslashes += 1;
    }
    if (precedingBackslashes % 2 === 1) break;
    end -= 1;
  }
  return rule.slice(0, end);
}

interface StateDirectoryIgnoreCandidates {
  readonly full: string;
  readonly basename: string;
  readonly fullLowerCase: string;
  readonly basenameLowerCase: string;
}

function stateDirectoryIgnoreCandidates(stateDirectory: string): StateDirectoryIgnoreCandidates {
  const candidateBasename = basename(stateDirectory);
  return {
    full: stateDirectory,
    basename: candidateBasename,
    fullLowerCase: stateDirectory.toLowerCase(),
    basenameLowerCase: candidateBasename.toLowerCase(),
  };
}

function literalGitIgnoreRuleMatchesStateDirectory(
  rule: string,
  candidates: StateDirectoryIgnoreCandidates,
  caseInsensitive: boolean,
): boolean | undefined {
  let pattern = rule;
  if (pattern.startsWith('/')) pattern = pattern.slice(1);
  if (pattern.endsWith('/')) pattern = pattern.slice(0, -1);
  if (pattern.length === 0) return undefined;

  let literal = '';
  let literalPrefix = '';
  let literalSuffix = '';
  let ambiguous = false;
  let hasPathSeparator = false;
  const appendLiteral = (character: string): void => {
    literal += character;
    if (!ambiguous) literalPrefix += character;
    literalSuffix += character;
    if (character === '/') hasPathSeparator = true;
  };
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === '\\') {
      const escaped = pattern[index + 1];
      if (escaped === undefined) return undefined;
      if (escaped === '/') return undefined;
      appendLiteral(escaped);
      index += 1;
      continue;
    }
    if (character === '*' || character === '?') {
      ambiguous = true;
      literalSuffix = '';
      if (character === '*') {
        const firstStar = index;
        let finalStar = index;
        while (pattern[finalStar + 1] === '*') finalStar += 1;
        index = finalStar;
        if (finalStar > firstStar && pattern[index + 1] === '/') {
          // Git's leading/interior **/ form may consume zero directories, so
          // its slash cannot be used as a required literal suffix.
          hasPathSeparator = true;
          index += 1;
        }
      }
      continue;
    }
    if (character === '[') {
      ambiguous = true;
      literalSuffix = '';
      let closing = -1;
      for (let classIndex = index + 1; classIndex < pattern.length; classIndex += 1) {
        if (pattern[classIndex] === '\\') {
          classIndex += 1;
          continue;
        }
        if (pattern[classIndex] === ']') {
          closing = classIndex;
          break;
        }
      }
      if (closing < 0) return undefined;
      index = closing;
      continue;
    }
    if (character === ']') return undefined;
    appendLiteral(character);
  }

  const candidate = hasPathSeparator ? candidates.full : candidates.basename;
  const comparableCandidate = caseInsensitive
    ? (hasPathSeparator ? candidates.fullLowerCase : candidates.basenameLowerCase)
    : candidate;
  if (!ambiguous) {
    if (literal.length !== candidate.length) return false;
    const comparableLiteral = caseInsensitive ? literal.toLowerCase() : literal;
    return comparableLiteral === comparableCandidate;
  }

  if (literalPrefix.length > candidate.length || literalSuffix.length > candidate.length) return false;
  const comparablePrefix = caseInsensitive ? literalPrefix.toLowerCase() : literalPrefix;
  const comparableSuffix = caseInsensitive ? literalSuffix.toLowerCase() : literalSuffix;
  if (!comparableCandidate.startsWith(comparablePrefix) || !comparableCandidate.endsWith(comparableSuffix)) return false;
  return undefined;
}

function applyStateDirectoryIgnoreRules(
  content: string,
  stateDirectory: string,
  expected: string,
  initiallyIgnored: boolean,
): { ignored: boolean; exactEntryObserved: boolean } {
  let ignored = initiallyIgnored;
  let exactEntryObserved = false;
  const candidates = stateDirectoryIgnoreCandidates(stateDirectory);
  for (const rawRule of content.split(/\r?\n/)) {
    const rule = gitIgnoreRuleWithoutUnescapedTrailingSpaces(rawRule);
    if (rule.length === 0 || rule.startsWith('#')) continue;
    if (rule === expected) {
      ignored = true;
      exactEntryObserved = true;
      continue;
    }

    const negated = rule.startsWith('!');
    const pattern = negated ? rule.slice(1) : rule;
    const match = literalGitIgnoreRuleMatchesStateDirectory(pattern, candidates, negated);
    if (negated) {
      // Variant-case or ambiguous negations must fail closed because Git may
      // treat them as matching on a case-insensitive worktree.
      if (ignored && match !== false) ignored = false;
    } else if (match === true) {
      // Positive rules may restore protection only after an unambiguous,
      // case-sensitive match. A false negative is safer than exposed state.
      ignored = true;
    }
  }
  return { ignored, exactEntryObserved };
}

export async function isStateDirectoryIgnored(root: string, configuredStateDirectory: string): Promise<boolean> {
  // Configuration treats backslashes as portable separators, while POSIX
  // path resolution treats them as literal filename bytes. Refuse that
  // ambiguous representation instead of verifying a different Git path.
  if (process.platform !== 'win32' && configuredStateDirectory.includes('\\')) return false;
  const resolvedRoot = resolve(root);
  const stateDirectory = repositoryRelativePath(
    resolvedRoot,
    configuredStateDirectory,
    'state_dir',
  ).replaceAll('\\', '/');
  const segments = stateDirectory.split('/');
  if (segments.length > MAX_STATE_IGNORE_FILES) return false;

  const rootIgnore = await readInternalText(
    resolvedRoot,
    '.gitignore',
    MAX_STATE_IGNORE_BYTES,
    { allowMissing: true },
  );
  if (rootIgnore === undefined) return false;
  let totalBytes = Buffer.byteLength(rootIgnore, 'utf8');
  const rootResult = applyStateDirectoryIgnoreRules(
    rootIgnore,
    stateDirectory,
    stateDirectoryIgnoreEntry(stateDirectory),
    false,
  );
  if (!rootResult.exactEntryObserved) return false;

  let ignored = rootResult.ignored;
  for (let depth = 1; depth < segments.length; depth += 1) {
    const ignorePath = [...segments.slice(0, depth), '.gitignore'].join('/');
    const remainingBytes = MAX_STATE_IGNORE_BYTES - totalBytes;
    const ignore = await readInternalText(resolvedRoot, ignorePath, remainingBytes, { allowMissing: true });
    if (ignore === undefined) continue;
    totalBytes += Buffer.byteLength(ignore, 'utf8');
    const relativeStateDirectory = segments.slice(depth).join('/');
    ignored = applyStateDirectoryIgnoreRules(
      ignore,
      relativeStateDirectory,
      stateDirectoryIgnoreEntry(relativeStateDirectory),
      ignored,
    ).ignored;
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

export function sameFileSnapshot(left: Stats, right: Stats): boolean {
  const comparableDevice = left.dev !== 0 && right.dev !== 0;
  return left.isFile()
    && right.isFile()
    && (!comparableDevice || left.dev === right.dev)
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
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const pathBefore = await existingStat(absolute);
    if (pathBefore && (!pathBefore.isFile() || pathBefore.isSymbolicLink())) {
      throw new PrimeContextError('IO_ERROR', `Output path is not a regular file: ${relativePath}`);
    }
    handle = await open(absolute, pathBefore ? 'r+' : 'wx', 0o600);
    const handleBefore = await handle.stat();
    if (!handleBefore.isFile() || (pathBefore && !sameFileSnapshot(pathBefore, handleBefore))) {
      throw new PrimeContextError('SECURITY_ERROR', `Output path changed before writing: ${relativePath}`);
    }
    if (process.platform !== 'win32') await handle.chmod(0o600);
    await handle.truncate(0);
    await handle.writeFile(content, { encoding: 'utf8' });
    await handle.sync();
    const handleAfter = await handle.stat();
    const pathAfter = await lstat(absolute);
    await assertNoSymbolicLinkComponents(resolvedRoot, relativePath);
    if (!sameFileSnapshot(handleAfter, pathAfter)) {
      throw new PrimeContextError('SECURITY_ERROR', `Output path changed while writing: ${relativePath}`);
    }
  } catch (error) {
    if (error instanceof PrimeContextError) throw error;
    throw new PrimeContextError('IO_ERROR', `Unable to write repository file: ${relativePath}`, [error instanceof Error ? error.message : String(error)]);
  } finally {
    try { await handle?.close(); } catch { /* preserve the write result */ }
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
    const temporaryHandle = await open(temporaryAbsolute, 'wx', 0o600);
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

export async function writeInternalTextIfAbsentAtomic(
  root: string,
  candidate: string,
  content: string,
  options: { temporaryDirectory: string },
): Promise<boolean> {
  const resolvedRoot = resolve(root);
  const relativePath = repositoryRelativePath(resolvedRoot, candidate, 'output path');
  const parent = dirname(relativePath).replaceAll('\\', '/');
  if (parent && parent !== '.') await ensureSafeDirectory(resolvedRoot, parent);
  await assertNoSymbolicLinkComponents(resolvedRoot, relativePath, { allowMissing: true });
  const absolute = assertPathInsideRoot(resolvedRoot, relativePath);
  const temporaryParent = repositoryRelativePath(
    resolvedRoot,
    options.temporaryDirectory,
    'temporary directory',
  );
  await ensureSafeDirectory(resolvedRoot, temporaryParent);
  const temporaryName = `.${basename(relativePath)}.primecontext-${process.pid}-${randomUUID()}.tmp`;
  const temporaryRelativePath = `${temporaryParent}/${temporaryName}`;
  const temporaryAbsolute = assertPathInsideRoot(resolvedRoot, temporaryRelativePath);
  let temporaryMayExist = false;

  try {
    const existing = await existingStat(absolute);
    if (existing) {
      if (!existing.isFile() || existing.isSymbolicLink()) {
        throw new PrimeContextError('IO_ERROR', `Output path is not a regular file: ${relativePath}`);
      }
      return false;
    }

    await assertNoSymbolicLinkComponents(resolvedRoot, temporaryRelativePath, { allowMissing: true });
    const temporaryHandle = await open(temporaryAbsolute, 'wx', 0o600);
    temporaryMayExist = true;
    try {
      if (process.platform !== 'win32') await temporaryHandle.chmod(0o600);
      await temporaryHandle.writeFile(content, { encoding: 'utf8' });
      await temporaryHandle.sync();
    } finally {
      await temporaryHandle.close();
    }
    await assertNoSymbolicLinkComponents(resolvedRoot, temporaryRelativePath);
    const preparedStat = await lstat(temporaryAbsolute);
    if (!preparedStat.isFile() || preparedStat.isSymbolicLink()) {
      throw new PrimeContextError('SECURITY_ERROR', 'Create-only output temporary path is not a regular file');
    }

    await assertNoSymbolicLinkComponents(resolvedRoot, relativePath, { allowMissing: true });
    try {
      await link(temporaryAbsolute, absolute);
    } catch (error) {
      if (nodeErrorCode(error) !== 'EEXIST') throw error;
      await assertNoSymbolicLinkComponents(resolvedRoot, relativePath);
      const winner = await lstat(absolute);
      if (!winner.isFile() || winner.isSymbolicLink()) {
        throw new PrimeContextError('IO_ERROR', `Output path is not a regular file: ${relativePath}`);
      }
      return false;
    }

    await assertNoSymbolicLinkComponents(resolvedRoot, relativePath);
    await assertNoSymbolicLinkComponents(resolvedRoot, temporaryRelativePath);
    const [temporaryStat, finalStat] = await Promise.all([
      lstat(temporaryAbsolute),
      lstat(absolute),
    ]);
    if (
      !temporaryStat.isFile()
      || temporaryStat.isSymbolicLink()
      || !finalStat.isFile()
      || finalStat.isSymbolicLink()
      || !sameFileSnapshot(temporaryStat, finalStat)
    ) {
      throw new PrimeContextError('SECURITY_ERROR', `Create-only output path changed during publication: ${relativePath}`);
    }
    return true;
  } catch (error) {
    if (error instanceof PrimeContextError) throw error;
    throw new PrimeContextError(
      'IO_ERROR',
      `Unable to publish repository file without replacement: ${relativePath}`,
      [error instanceof Error ? error.message : String(error)],
    );
  } finally {
    if (temporaryMayExist) {
      try { await unlink(temporaryAbsolute); } catch { /* preserve the publication result */ }
    }
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

export interface InternalExclusiveLockOptions {
  readonly operation?: string;
}

interface InternalLockRecord {
  readonly schema_version: 'primecontext-lock-v1';
  readonly pid: number;
  readonly hostname: string;
  readonly created_at: string;
  readonly operation: string;
  readonly owner_token: string;
}

function internalLockOperation(value: string | undefined): string {
  const operation = value ?? 'state-write';
  if (
    operation.length === 0
    || [...operation].length > MAX_INTERNAL_LOCK_OPERATION_CHARACTERS
    || /[\u0000-\u001f\u007f-\u009f]/u.test(operation)
  ) {
    throw new PrimeContextError('CONFIG_ERROR', 'Internal lock operation must be bounded visible text');
  }
  return operation;
}

function localLockHostname(): string {
  const value = hostname();
  if (
    value.length === 0
    || [...value].length > MAX_INTERNAL_LOCK_HOSTNAME_CHARACTERS
    || /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  ) {
    throw new PrimeContextError('STATE_ERROR', 'Local hostname is unavailable for safe lock ownership');
  }
  return value;
}

function createInternalLockRecord(operation: string): InternalLockRecord {
  return {
    schema_version: 'primecontext-lock-v1',
    pid: process.pid,
    hostname: localLockHostname(),
    created_at: new Date().toISOString(),
    operation,
    owner_token: randomUUID(),
  };
}

function serializeInternalLockRecord(record: InternalLockRecord): string {
  const serialized = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > MAX_INTERNAL_LOCK_BYTES) {
    throw new PrimeContextError('STATE_ERROR', 'Internal lock metadata exceeds its byte limit');
  }
  return serialized;
}

function parseInternalLockRecord(content: string): InternalLockRecord {
  let value: unknown;
  try {
    value = JSON.parse(content) as unknown;
  } catch {
    throw new PrimeContextError('STATE_ERROR', 'Existing state lock is malformed or unverifiable');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PrimeContextError('STATE_ERROR', 'Existing state lock is malformed or unverifiable');
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.join(',') !== 'created_at,hostname,operation,owner_token,pid,schema_version'
    || record.schema_version !== 'primecontext-lock-v1'
    || !Number.isSafeInteger(record.pid)
    || (record.pid as number) < 1
    || (record.pid as number) > 2_147_483_647
    || typeof record.hostname !== 'string'
    || record.hostname.length === 0
    || [...record.hostname].length > MAX_INTERNAL_LOCK_HOSTNAME_CHARACTERS
    || /[\u0000-\u001f\u007f-\u009f]/u.test(record.hostname)
    || typeof record.operation !== 'string'
    || record.operation.length === 0
    || [...record.operation].length > MAX_INTERNAL_LOCK_OPERATION_CHARACTERS
    || /[\u0000-\u001f\u007f-\u009f]/u.test(record.operation)
    || typeof record.owner_token !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(record.owner_token)
    || typeof record.created_at !== 'string'
    || record.created_at.length > 64
    || !Number.isFinite(Date.parse(record.created_at))
    || new Date(record.created_at).toISOString() !== record.created_at
  ) {
    throw new PrimeContextError('STATE_ERROR', 'Existing state lock is malformed or unverifiable');
  }
  return record as unknown as InternalLockRecord;
}

function processLiveness(pid: number): 'ALIVE' | 'DEAD' | 'UNVERIFIABLE' {
  try {
    process.kill(pid, 0);
    return 'ALIVE';
  } catch (error) {
    if (nodeErrorCode(error) === 'ESRCH') return 'DEAD';
    return 'UNVERIFIABLE';
  }
}

async function writeLockHandle(
  handle: Awaited<ReturnType<typeof open>>,
  record: InternalLockRecord,
): Promise<void> {
  await handle.writeFile(serializeInternalLockRecord(record), { encoding: 'utf8' });
  await handle.sync();
}

async function createPopulatedLockFile(
  absolute: string,
  record: InternalLockRecord,
): Promise<Awaited<ReturnType<typeof open>>> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let created = false;
  try {
    handle = await open(absolute, 'wx', 0o600);
    created = true;
    await writeLockHandle(handle, record);
    return handle;
  } catch (error) {
    try { await handle?.close(); } catch { /* preserve the creation failure */ }
    if (created) {
      try { await unlink(absolute); } catch { /* preserve the creation failure */ }
    }
    throw error;
  }
}

async function acquireInternalLock(
  root: string,
  relativePath: string,
  absolute: string,
  record: InternalLockRecord,
): Promise<Awaited<ReturnType<typeof open>>> {
  try {
    return await createPopulatedLockFile(absolute, record);
  } catch (error) {
    if (nodeErrorCode(error) !== 'EEXIST') throw error;
  }

  let existing: string | undefined;
  try {
    existing = await readInternalText(root, relativePath, MAX_INTERNAL_LOCK_BYTES, { allowMissing: true });
  } catch {
    throw new PrimeContextError('STATE_ERROR', 'Existing state lock is malformed or unverifiable');
  }
  if (existing !== undefined) {
    const existingRecord = parseInternalLockRecord(existing);
    if (existingRecord.hostname !== record.hostname) {
      throw new PrimeContextError('STATE_ERROR', 'Existing state lock owner cannot be verified on this host');
    }
    const liveness = processLiveness(existingRecord.pid);
    if (liveness === 'DEAD') {
      // Node has no portable atomic compare-and-remove primitive for lock files.
      // Reclaiming after a liveness check can move a newer writer's lock, so an
      // orphan remains blocking until an operator removes the verified path.
      throw new PrimeContextError(
        'STATE_ERROR',
        'Existing state lock belongs to a dead process and requires manual removal',
      );
    }
    throw new PrimeContextError(
      'STATE_ERROR',
      liveness === 'ALIVE'
        ? 'Context state already has an active writer'
        : 'Existing state lock owner cannot be verified',
    );
  }

  try {
    return await createPopulatedLockFile(absolute, record);
  } catch (error) {
    if (nodeErrorCode(error) === 'EEXIST') {
      throw new PrimeContextError('STATE_ERROR', 'Context state already has an active writer');
    }
    throw error;
  }
}

export async function withInternalExclusiveLock<T>(
  root: string,
  candidate: string,
  operation: () => Promise<T>,
  options: InternalExclusiveLockOptions = {},
): Promise<T> {
  const resolvedRoot = resolve(root);
  const relativePath = repositoryRelativePath(resolvedRoot, candidate, 'lock path');
  const parent = dirname(relativePath).replaceAll('\\', '/');
  if (parent && parent !== '.') await ensureSafeDirectory(resolvedRoot, parent);
  await assertNoSymbolicLinkComponents(resolvedRoot, relativePath, { allowMissing: true });
  const absolute = assertPathInsideRoot(resolvedRoot, relativePath);
  const record = createInternalLockRecord(internalLockOperation(options.operation));
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await acquireInternalLock(resolvedRoot, relativePath, absolute, record);
  } catch (error) {
    if (error instanceof PrimeContextError) throw error;
    throw new PrimeContextError('IO_ERROR', 'Unable to acquire the context-state writer lock');
  }
  try {
    return await operation();
  } finally {
    try { await handle?.close(); } catch { /* preserve the operation result */ }
    try {
      const current = await readInternalText(resolvedRoot, relativePath, MAX_INTERNAL_LOCK_BYTES, { allowMissing: true });
      if (current === serializeInternalLockRecord(record)) await unlink(absolute);
    } catch { /* an unverifiable replacement remains blocking */ }
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
  await writeInternalTextAtomic(root, candidate, `${JSON.stringify(value, null, 2)}\n`);
}
