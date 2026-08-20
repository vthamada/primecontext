import { realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { PrimeContextError } from '@primecontext/core';
import {
  assertNoSymbolicLinkComponents,
  isConfiguredRepositoryPathExcluded,
} from './filesystem.js';
import { assertPathInsideRoot, isSensitivePath } from './security.js';

function nodeErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

function physicalRelativePath(physicalRoot: string, physicalPath: string): string {
  const repositoryRelative = relative(physicalRoot, physicalPath);
  if (isAbsolute(repositoryRelative) || repositoryRelative === '..'
    || repositoryRelative.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
    throw new PrimeContextError('SECURITY_ERROR', 'Repository path resolves outside the physical repository root');
  }
  return repositoryRelative.replaceAll('\\', '/');
}

export async function resolvePhysicalRepositoryRelativePath(
  root: string,
  relativePath: string,
  options: { allowMissing?: boolean } = {},
): Promise<string> {
  const normalized = relativePath.replaceAll('\\', '/');
  if (process.platform !== 'win32') return normalized;
  const resolvedRoot = resolve(root);
  assertPathInsideRoot(resolvedRoot, normalized);
  await assertNoSymbolicLinkComponents(resolvedRoot, normalized, options);

  let physicalRoot: string;
  try {
    physicalRoot = await realpath(resolvedRoot);
  } catch (error) {
    throw new PrimeContextError('IO_ERROR', 'Unable to resolve the physical repository root', [
      error instanceof Error ? error.message : String(error),
    ]);
  }

  let current = physicalRoot;
  let missingSuffix = false;
  for (const segment of normalized.split('/').filter(Boolean)) {
    const next = join(current, segment);
    if (missingSuffix) {
      current = next;
      continue;
    }
    try {
      current = await realpath(next);
    } catch (error) {
      if (options.allowMissing && nodeErrorCode(error) === 'ENOENT') {
        current = next;
        missingSuffix = true;
        continue;
      }
      throw new PrimeContextError('IO_ERROR', 'Unable to resolve a physical repository path', [
        error instanceof Error ? error.message : String(error),
      ]);
    }
    physicalRelativePath(physicalRoot, current);
  }

  const physicalRelative = physicalRelativePath(physicalRoot, current);
  await assertNoSymbolicLinkComponents(resolvedRoot, normalized, options);
  return physicalRelative;
}

export async function assertPhysicalRepositorySourcePathAllowed(
  root: string,
  relativePath: string,
  configuredExcludes: ReadonlySet<string>,
): Promise<void> {
  if (isSensitivePath(relativePath)
    || isConfiguredRepositoryPathExcluded(relativePath, configuredExcludes)) {
    throw new PrimeContextError('SECURITY_ERROR', 'Accepted repository source resolves to a blocked path');
  }
  if (process.platform !== 'win32') return;
  const physicalRelative = await resolvePhysicalRepositoryRelativePath(root, relativePath);
  if (isSensitivePath(physicalRelative)
    || isConfiguredRepositoryPathExcluded(physicalRelative, configuredExcludes)) {
    throw new PrimeContextError('SECURITY_ERROR', 'Accepted repository source resolves to a blocked path');
  }
}
