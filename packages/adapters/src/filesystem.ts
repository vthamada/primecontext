import { lstat, readFile, readdir } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { PrimeContextError, type DiscoveredPath, type FileSystemPort, type WalkResult } from '@primecontext/core';
import { assertPathInsideRoot, isSensitivePath } from './security.js';

const DEFAULT_MAX_READ_BYTES = 1024 * 1024;

export class NodeFileSystemAdapter implements FileSystemPort {
  private readonly additionalExcludes: string[];

  constructor(additionalExcludes: string[] = []) {
    this.additionalExcludes = additionalExcludes
      .map((path) => path.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, ''))
      .filter(Boolean);
  }

  private isConfiguredExcluded(relativePath: string): boolean {
    const normalized = relativePath.replaceAll('\\', '/');
    return this.additionalExcludes.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`));
  }

  async walk(root: string): Promise<WalkResult> {
    const resolvedRoot = resolve(root);
    const paths: DiscoveredPath[] = [];
    let excludedPathCount = 0;

    const visit = async (absoluteDir: string): Promise<void> => {
      const entries = await readdir(absoluteDir, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        const absolutePath = resolve(absoluteDir, entry.name);
        const relativePath = relative(resolvedRoot, absolutePath).replaceAll('\\', '/');
        if (isSensitivePath(relativePath) || this.isConfiguredExcluded(relativePath) || entry.isSymbolicLink()) {
          excludedPathCount += 1;
          continue;
        }
        if (entry.isDirectory()) {
          paths.push({ relative_path: relativePath, kind: 'directory' });
          await visit(absolutePath);
          continue;
        }
        if (entry.isFile()) {
          const stat = await lstat(absolutePath);
          paths.push({ relative_path: relativePath, kind: 'file', size_bytes: stat.size });
        }
      }
    };

    await visit(resolvedRoot);
    return { paths, excluded_path_count: excludedPathCount };
  }

  async readText(root: string, relativePath: string, maxBytes = DEFAULT_MAX_READ_BYTES): Promise<string> {
    if (isSensitivePath(relativePath)) {
      throw new PrimeContextError('SECURITY_ERROR', `Sensitive path is blocked: ${relativePath}`);
    }
    const absolutePath = assertPathInsideRoot(root, relativePath);
    const stat = await lstat(absolutePath);
    if (stat.isSymbolicLink()) throw new PrimeContextError('SECURITY_ERROR', 'Symbolic links are not readable in v0.1');
    if (!stat.isFile()) throw new PrimeContextError('IO_ERROR', `Path is not a file: ${relativePath}`);
    if (stat.size > maxBytes) throw new PrimeContextError('IO_ERROR', `File exceeds read limit: ${relativePath}`);
    return readFile(absolutePath, 'utf8');
  }
}
