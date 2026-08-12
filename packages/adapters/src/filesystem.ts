import type { Dirent, Stats } from 'node:fs';
import { lstat, opendir, readFile } from 'node:fs/promises';
import { join, parse, relative, resolve } from 'node:path';
import { PrimeContextError, type DiscoveredPath, type FileSystemPort, type WalkResult } from '@primecontext/core';
import { assertPathInsideRoot, isSensitivePath } from './security.js';

const DEFAULT_MAX_READ_BYTES = 1024 * 1024;

export interface RepositoryDiscoveryLimits {
  maxEntries: number;
  maxDepth: number;
  maxExcludes: number;
}

export const DEFAULT_REPOSITORY_DISCOVERY_LIMITS: Readonly<RepositoryDiscoveryLimits> = Object.freeze({
  maxEntries: 100_000,
  maxDepth: 64,
  maxExcludes: 1_024,
});

function ordinalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function boundedLimit(
  name: keyof RepositoryDiscoveryLimits,
  value: number | undefined,
  minimum: number,
): number {
  const hardMaximum = DEFAULT_REPOSITORY_DISCOVERY_LIMITS[name];
  const resolved = value ?? hardMaximum;
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > hardMaximum) {
    throw new PrimeContextError(
      'CONFIG_ERROR',
      `Invalid repository discovery limit: ${name}`,
      [`expected an integer from ${minimum} through ${hardMaximum}`],
    );
  }
  return resolved;
}

function resolveDiscoveryLimits(overrides: Partial<RepositoryDiscoveryLimits>): RepositoryDiscoveryLimits {
  return {
    maxEntries: boundedLimit('maxEntries', overrides.maxEntries, 1),
    maxDepth: boundedLimit('maxDepth', overrides.maxDepth, 0),
    maxExcludes: boundedLimit('maxExcludes', overrides.maxExcludes, 0),
  };
}

function nodeErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

export async function assertNoSymbolicLinkComponents(
  root: string,
  relativePath = '',
  options: { allowMissing?: boolean } = {},
): Promise<void> {
  const resolvedRoot = resolve(root);
  let current = parse(resolvedRoot).root;
  const rootSegments = relative(current, resolvedRoot).split(/[\\/]/).filter(Boolean);
  const inspectRootComponent = async (path: string): Promise<void> => {
    let stat: Stats;
    try {
      stat = await lstat(path);
    } catch (error) {
      throw new PrimeContextError('IO_ERROR', 'Unable to inspect a repository-root component', [error instanceof Error ? error.message : String(error)]);
    }
    if (stat.isSymbolicLink()) {
      throw new PrimeContextError('SECURITY_ERROR', 'Repository roots beneath symbolic links or junctions are not allowed');
    }
  };

  await inspectRootComponent(current);
  for (const segment of rootSegments) {
    current = join(current, segment);
    await inspectRootComponent(current);
  }
  for (const segment of relativePath.replaceAll('\\', '/').split('/').filter(Boolean)) {
    current = join(current, segment);
    let stat: Stats;
    try {
      stat = await lstat(current);
    } catch (error) {
      if (options.allowMissing && nodeErrorCode(error) === 'ENOENT') return;
      throw new PrimeContextError('IO_ERROR', `Unable to inspect repository path: ${relativePath}`, [error instanceof Error ? error.message : String(error)]);
    }
    if (stat.isSymbolicLink()) throw new PrimeContextError('SECURITY_ERROR', `Symbolic-link path component is blocked: ${relativePath}`);
  }
}

export class NodeFileSystemAdapter implements FileSystemPort {
  private readonly additionalExcludes: ReadonlySet<string>;
  private readonly limits: RepositoryDiscoveryLimits;

  constructor(additionalExcludes: string[] = [], limits: Partial<RepositoryDiscoveryLimits> = {}) {
    this.limits = resolveDiscoveryLimits(limits);
    if (additionalExcludes.length > this.limits.maxExcludes) {
      throw new PrimeContextError(
        'SECURITY_ERROR',
        'Repository exclude limit exceeded',
        [`maximum=${this.limits.maxExcludes}`, `received=${additionalExcludes.length}`],
      );
    }
    const normalizedExcludes = additionalExcludes
      .map((path) => path.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, ''))
      .filter(Boolean);
    this.additionalExcludes = new Set(normalizedExcludes);
  }

  private isConfiguredExcluded(relativePath: string): boolean {
    const normalized = relativePath.replaceAll('\\', '/');
    if (this.additionalExcludes.has(normalized)) return true;
    let separator = normalized.lastIndexOf('/');
    while (separator >= 0) {
      if (this.additionalExcludes.has(normalized.slice(0, separator))) return true;
      separator = normalized.lastIndexOf('/', separator - 1);
    }
    return false;
  }

  async walk(root: string): Promise<WalkResult> {
    const resolvedRoot = resolve(root);
    try {
      await assertNoSymbolicLinkComponents(resolvedRoot);
      const paths: DiscoveredPath[] = [];
      let excludedPathCount = 0;
      let visitedEntryCount = 0;

      const readEntries = async (absoluteDir: string): Promise<Dirent[]> => {
        const entries: Dirent[] = [];
        const directory = await opendir(absoluteDir);
        for await (const entry of directory) {
          visitedEntryCount += 1;
          if (visitedEntryCount > this.limits.maxEntries) {
            throw new PrimeContextError(
              'SECURITY_ERROR',
              'Repository discovery entry limit exceeded',
              [`maximum=${this.limits.maxEntries}`],
            );
          }
          entries.push(entry);
        }
        entries.sort((a, b) => ordinalCompare(a.name, b.name));
        return entries;
      };

      const visit = async (absoluteDir: string, depth: number): Promise<void> => {
        const entries = await readEntries(absoluteDir);
        for (const entry of entries) {
          const entryDepth = depth + 1;
          if (entryDepth > this.limits.maxDepth) {
            throw new PrimeContextError(
              'SECURITY_ERROR',
              'Repository discovery depth limit exceeded',
              [`maximum=${this.limits.maxDepth}`],
            );
          }
          const absolutePath = resolve(absoluteDir, entry.name);
          const relativePath = relative(resolvedRoot, absolutePath).replaceAll('\\', '/');
          if (isSensitivePath(relativePath) || this.isConfiguredExcluded(relativePath) || entry.isSymbolicLink()) {
            excludedPathCount += 1;
            continue;
          }
          const stat = await lstat(absolutePath);
          if (stat.isSymbolicLink()) {
            excludedPathCount += 1;
            continue;
          }
          if (stat.isDirectory()) {
            paths.push({ relative_path: relativePath, kind: 'directory' });
            await visit(absolutePath, entryDepth);
            continue;
          }
          if (stat.isFile()) {
            paths.push({ relative_path: relativePath, kind: 'file', size_bytes: stat.size });
          }
        }
      };

      await visit(resolvedRoot, 0);
      return { paths, excluded_path_count: excludedPathCount };
    } catch (error) {
      if (error instanceof PrimeContextError) throw error;
      throw new PrimeContextError('IO_ERROR', `Unable to discover repository: ${resolvedRoot}`, [error instanceof Error ? error.message : String(error)]);
    }
  }

  async readText(root: string, relativePath: string, maxBytes = DEFAULT_MAX_READ_BYTES): Promise<string> {
    if (isSensitivePath(relativePath)) {
      throw new PrimeContextError('SECURITY_ERROR', `Sensitive path is blocked: ${relativePath}`);
    }
    try {
      const absolutePath = assertPathInsideRoot(root, relativePath);
      await assertNoSymbolicLinkComponents(resolve(root), relativePath);
      const stat = await lstat(absolutePath);
      if (stat.isSymbolicLink()) throw new PrimeContextError('SECURITY_ERROR', 'Symbolic links are not readable in v0.1');
      if (!stat.isFile()) throw new PrimeContextError('IO_ERROR', `Path is not a file: ${relativePath}`);
      if (stat.size > maxBytes) throw new PrimeContextError('IO_ERROR', `File exceeds read limit: ${relativePath}`);
      return await readFile(absolutePath, 'utf8');
    } catch (error) {
      if (error instanceof PrimeContextError) throw error;
      throw new PrimeContextError('IO_ERROR', `Unable to read repository file: ${relativePath}`, [error instanceof Error ? error.message : String(error)]);
    }
  }
}
