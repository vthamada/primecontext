import { isAbsolute, relative, resolve, sep } from 'node:path';
import { PrimeContextError } from '@primecontext/core';

const blockedDirectoryNames = new Set([
  '.git',
  '.obsidian',
  '.primecontext',
  'node_modules',
  '.pnpm-store',
  'coverage',
  '.ssh',
  '.aws',
  '.azure',
  '.gcp',
  'private-uploads',
  'private_uploads',
]);

const blockedExactFileNames = new Set([
  '.env',
  'credentials.json',
  'secrets.json',
  'secret.json',
  'id_rsa',
  'id_ed25519',
  'backup.sql',
  'dump.sql',
  '.npmrc',
  '.pypirc',
  '.netrc',
]);

const blockedExtensions = ['.pem', '.key', '.p12', '.pfx', '.dump'];

function normalizeRelativePath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\//, '');
}

export function isSensitivePath(relativePath: string): boolean {
  const normalized = normalizeRelativePath(relativePath).toLowerCase();
  const rawSegments = normalized.split('/').filter(Boolean);
  if (rawSegments.some((segment) => /[<>:"|?*]/.test(segment))) return true;
  const segments = rawSegments.map((segment) => segment.replace(/[. ]+$/, ''));
  if (segments.some((segment) => /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])[ .]*(?:\.|$)/.test(segment))) return true;
  if (segments.some((segment) => blockedDirectoryNames.has(segment))) return true;
  const fileName = segments.at(-1) ?? normalized;
  if (fileName === '.env' || fileName.startsWith('.env.')) return true;
  if (blockedExactFileNames.has(fileName)) return true;
  if (blockedExtensions.some((extension) => fileName.endsWith(extension))) return true;
  if (/^(credentials|secrets?)[._-]/.test(fileName)) return true;
  if (/^(api[-_.]?keys?|access[-_.]?tokens?|refresh[-_.]?tokens?|tokens?|passwords?|cookies|(?:client[-_.]?)?pii|private[-_.]?(?:dump|backup))([._-]|$)/.test(fileName)) return true;
  return false;
}

export function assertPathInsideRoot(root: string, candidateRelativePath: string): string {
  if (isAbsolute(candidateRelativePath)) {
    throw new PrimeContextError('SECURITY_ERROR', 'Absolute paths are not allowed for repository reads');
  }
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(resolvedRoot, candidateRelativePath);
  const rel = relative(resolvedRoot, resolvedCandidate);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new PrimeContextError('SECURITY_ERROR', 'Path traversal outside repository root is blocked');
  }
  return resolvedCandidate;
}
