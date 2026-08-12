import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';
import { PrimeContextError } from '@primecontext/core';
import { NodeFileSystemAdapter, assertNoSymbolicLinkComponents } from './filesystem.js';
import { assertPathInsideRoot } from './security.js';

const CANONICAL_ROOT_MARKDOWN = new Set([
  'AGENTS.md',
  'CHANGELOG.md',
  'CODE_OF_CONDUCT.md',
  'CONTRIBUTING.md',
  'README.md',
  'SECURITY.md',
]);

const DOCUMENT_AUTHORITY_RULES: ReadonlyArray<{
  authority: DocumentAuthority;
  rule_id: string;
  matches: (normalizedPath: string) => boolean;
}> = [
  {
    authority: 'policy',
    rule_id: 'root-agents-file',
    matches: (path) => path === 'agents.md',
  },
  {
    authority: 'policy',
    rule_id: 'root-security-file',
    matches: (path) => path === 'security.md',
  },
  {
    authority: 'policy',
    rule_id: 'root-code-of-conduct-file',
    matches: (path) => path === 'code_of_conduct.md',
  },
  {
    authority: 'adr',
    rule_id: 'docs-adr-directory',
    matches: (path) => path.startsWith('docs/adr/'),
  },
  {
    authority: 'specification',
    rule_id: 'docs-specification-directory',
    matches: (path) => path.startsWith('docs/specification/'),
  },
  {
    authority: 'contract_schema',
    rule_id: 'docs-contract-schema-directory',
    matches: (path) => (
      path.startsWith('docs/contracts/')
      || path.startsWith('docs/contract/')
      || path.startsWith('docs/schemas/')
      || path.startsWith('docs/schema/')
    ),
  },
  {
    authority: 'roadmap',
    rule_id: 'roadmap-file',
    matches: (path) => path === 'docs/roadmap.md' || path.endsWith('/roadmap.md'),
  },
  {
    authority: 'generated_summary',
    rule_id: 'docs-generated-directory',
    matches: (path) => path.startsWith('docs/generated/'),
  },
];

const CONTENT_SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN (?:(?:(?:RSA|EC|OPENSSH|DSA|ENCRYPTED) )?PRIVATE KEY|PGP PRIVATE KEY BLOCK)-----/i,
  /\bAuthorization\s*:\s*Bearer\s+[A-Za-z0-9._~+/=-]{16,}/i,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{24,}/i,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh(?:p|o|u|s|r)_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,255}\b/,
];

const SENSITIVE_LABEL_PATTERN = /\b(api[-_. ]?key|access[-_. ]?token|refresh[-_. ]?token|client[-_. ]?secret|password|(?:client|customer)[-_. ]?(?:cpf|ssn|tax[-_. ]?id|email|phone))\b["'`*_]{0,4}\s*([:=|])/giu;

const MAX_TITLE_CHARACTERS = 256;
const MAX_SENSITIVE_LABEL_MATCHES = 1_024;
const MAX_LABELED_VALUE_SCAN_CHARACTERS = 4_096;

export interface DocumentDiscoveryLimits {
  maxDocuments: number;
  maxDocumentBytes: number;
  maxTotalBytes: number;
}

export const DEFAULT_DOCUMENT_DISCOVERY_LIMITS: Readonly<DocumentDiscoveryLimits> = Object.freeze({
  maxDocuments: 4_096,
  maxDocumentBytes: 512 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
});

export type DocumentAuthority =
  | 'policy'
  | 'adr'
  | 'specification'
  | 'contract_schema'
  | 'roadmap'
  | 'implementation_note'
  | 'generated_summary';

export type DocumentAuthorityBasis =
  | { kind: 'convention'; rule_id: string }
  | { kind: 'default' };

export interface DocumentSourceMetadata {
  title: string;
  authority: DocumentAuthority;
  modules: string[];
  topics: string[];
}

export interface CollectedDocumentSource {
  relative_path: string;
  content: string;
  size_bytes: number;
  source_hash: string;
  authority_basis: DocumentAuthorityBasis;
  metadata: DocumentSourceMetadata;
}

export interface DocumentSourceCollectionResult {
  sources: CollectedDocumentSource[];
  discovered_path_count: number;
  excluded_path_count: number;
  candidate_document_count: number;
  omitted_document_count: number;
  total_source_bytes: number;
  skipped_oversize_count: number;
  skipped_binary_count: number;
  skipped_sensitive_content_count: number;
}

function boundedLimit(
  name: keyof DocumentDiscoveryLimits,
  value: number | undefined,
): number {
  const hardMaximum = DEFAULT_DOCUMENT_DISCOVERY_LIMITS[name];
  const resolved = value ?? hardMaximum;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > hardMaximum) {
    throw new PrimeContextError(
      'CONFIG_ERROR',
      `Invalid document discovery limit: ${name}`,
      [`expected an integer from 1 through ${hardMaximum}`],
    );
  }
  return resolved;
}

function resolveLimits(overrides: Partial<DocumentDiscoveryLimits>): DocumentDiscoveryLimits {
  const allowed = new Set<keyof DocumentDiscoveryLimits>([
    'maxDocuments',
    'maxDocumentBytes',
    'maxTotalBytes',
  ]);
  for (const key of Object.keys(overrides)) {
    if (!allowed.has(key as keyof DocumentDiscoveryLimits)) {
      throw new PrimeContextError('CONFIG_ERROR', `Unknown document discovery limit: ${key}`);
    }
  }
  return {
    maxDocuments: boundedLimit('maxDocuments', overrides.maxDocuments),
    maxDocumentBytes: boundedLimit('maxDocumentBytes', overrides.maxDocumentBytes),
    maxTotalBytes: boundedLimit('maxTotalBytes', overrides.maxTotalBytes),
  };
}

function ordinalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isDocumentCorpusPath(relativePath: string): boolean {
  const normalized = relativePath.replaceAll('\\', '/');
  if (CANONICAL_ROOT_MARKDOWN.has(normalized)) return true;
  const lower = normalized.toLowerCase();
  return lower.startsWith('docs/') && lower.endsWith('.md');
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

type StableReadResult =
  | { kind: 'content'; bytes: Uint8Array }
  | { kind: 'oversize' };

async function readStableBoundedBytes(
  root: string,
  relativePath: string,
  maxBytes: number,
): Promise<StableReadResult> {
  const resolvedRoot = resolve(root);
  const absolutePath = assertPathInsideRoot(resolvedRoot, relativePath);
  try {
    await assertNoSymbolicLinkComponents(resolvedRoot, relativePath);
    const pathBefore = await lstat(absolutePath);
    if (pathBefore.isSymbolicLink()) {
      throw new PrimeContextError('SECURITY_ERROR', 'Symbolic-link documents are not readable');
    }
    if (!pathBefore.isFile()) throw new PrimeContextError('IO_ERROR', 'Document source is not a regular file');
    if (pathBefore.size > maxBytes) return { kind: 'oversize' };

    const handle = await open(absolutePath, 'r');
    try {
      const handleBefore = await handle.stat();
      if (!sameFileSnapshot(pathBefore, handleBefore)) {
        throw new PrimeContextError('SECURITY_ERROR', 'Document source changed before its bounded read');
      }
      if (handleBefore.size > maxBytes) return { kind: 'oversize' };

      const buffer = Buffer.alloc(Math.min(maxBytes + 1, handleBefore.size + 1));
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }

      const handleAfter = await handle.stat();
      const pathAfter = await lstat(absolutePath);
      await assertNoSymbolicLinkComponents(resolvedRoot, relativePath);
      if (
        !sameFileSnapshot(handleBefore, handleAfter)
        || !sameFileSnapshot(handleAfter, pathAfter)
        || offset !== handleAfter.size
      ) {
        throw new PrimeContextError('SECURITY_ERROR', 'Document source changed during its bounded read');
      }
      if (offset > maxBytes) return { kind: 'oversize' };
      return { kind: 'content', bytes: buffer.subarray(0, offset) };
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof PrimeContextError) throw error;
    throw new PrimeContextError(
      'IO_ERROR',
      'Unable to read a repository document',
      [error instanceof Error ? error.message : String(error)],
    );
  }
}

function decodeUtf8(bytes: Uint8Array): string | undefined {
  try {
    const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    if (/\u0000|[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(content)) return undefined;
    return content;
  } catch {
    return undefined;
  }
}

function containsSensitiveContent(content: string): boolean {
  return CONTENT_SECRET_PATTERNS.some((pattern) => pattern.test(content))
    || containsBasicAuthorizationCredential(content)
    || containsSensitiveLabeledValue(content)
    || containsValidatedBrazilianIdentifier(content);
}

function containsBasicAuthorizationCredential(content: string): boolean {
  const pattern = /\bAuthorization\s*:\s*Basic\s+([A-Za-z0-9+/]{2,}={0,2})(?![A-Za-z0-9+/=])/giu;
  for (const match of content.matchAll(pattern)) {
    const encoded = match[1] as string;
    if (encoded.length > 4_096) return true;
    const paddingLength = (4 - (encoded.length % 4)) % 4;
    const padded = `${encoded}${'='.repeat(paddingLength)}`;
    const decoded = Buffer.from(padded, 'base64');
    const canonical = decoded.toString('base64').replace(/=+$/, '');
    if (canonical !== encoded.replace(/=+$/, '')) continue;
    if (decoded.includes(0x3a)) return true;
  }
  return false;
}

function normalizedLabel(value: string): string {
  return value.toLowerCase().replace(/[-_. ]/g, '');
}

function cleanLabeledValue(value: string): string {
  return value
    .trim()
    .replace(/^["'`*_]+/, '')
    .trim()
    .replace(/["'`*_]+$/, '')
    .trim();
}

interface ExtractedLabeledValue {
  value: string;
  quoted: boolean;
}

function credentialValueLooksSensitive(label: string, extracted: ExtractedLabeledValue): boolean {
  const { value, quoted } = extracted;
  const characters = [...value];
  if (characters.length < 12) return false;
  if (/[A-Za-z]/.test(value) && /[^A-Za-z\s]/.test(value)) return true;
  if (normalizedLabel(label) === 'password' && characters.length >= 16) return true;
  if (!quoted || !/^[A-Za-z]+$/.test(value)) return false;
  if (normalizedLabel(label) === 'password') return true;
  return characters.length >= 20;
}

function piiValueLooksSensitive(label: string, value: string): boolean {
  const normalized = normalizedLabel(label);
  if (normalized.endsWith('email')) return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  const digits = value.replace(/\D/g, '');
  if (normalized.endsWith('phone')) return digits.length >= 8;
  return digits.length >= 9;
}

function quotedValue(value: string): ExtractedLabeledValue | undefined {
  const quote = value[0];
  if (quote !== '"' && quote !== "'" && quote !== '`') return undefined;
  let escaped = false;
  for (let index = 1; index < value.length; index += 1) {
    const character = value[index] as string;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (character === quote) {
      return {
        value: cleanLabeledValue(value.slice(1, index)),
        quoted: true,
      };
    }
  }
  return {
    value: cleanLabeledValue(value.slice(1)),
    quoted: true,
  };
}

function extractLabeledValue(
  content: string,
  valueStart: number,
  delimiter: string,
): ExtractedLabeledValue {
  const remainingContent = content.slice(valueStart, valueStart + MAX_LABELED_VALUE_SCAN_CHARACTERS);
  const lineEnd = remainingContent.search(/[\r\n]/);
  const lineRemainder = remainingContent.slice(0, lineEnd < 0 ? remainingContent.length : lineEnd);
  if (delimiter === '|') {
    return {
      value: cleanLabeledValue(lineRemainder.split('|', 1)[0] as string),
      quoted: false,
    };
  }

  const withoutClosingMarkup = lineRemainder.trimStart().replace(/^[*_]{1,4}\s*/, '');
  const quoted = quotedValue(withoutClosingMarkup);
  if (quoted) return quoted;
  return {
    value: cleanLabeledValue(withoutClosingMarkup.split(/[,;}]/, 1)[0] as string),
    quoted: false,
  };
}

function containsSensitiveLabeledValue(content: string): boolean {
  let matchCount = 0;
  for (const match of content.matchAll(SENSITIVE_LABEL_PATTERN)) {
    matchCount += 1;
    if (matchCount > MAX_SENSITIVE_LABEL_MATCHES) return true;
    const label = match[1] as string;
    const delimiter = match[2] as string;
    const valueStart = (match.index ?? 0) + match[0].length;
    const extracted = extractLabeledValue(content, valueStart, delimiter);
    const { value } = extracted;
    if (!value) continue;
    if (/^(?:api|access|refresh|clientsecret|password)/.test(normalizedLabel(label))) {
      if (credentialValueLooksSensitive(label, extracted)) return true;
      continue;
    }
    if (piiValueLooksSensitive(label, value)) return true;
  }
  return false;
}

function repeatedDigits(value: string): boolean {
  return /^(\d)\1+$/.test(value);
}

function validCpf(value: string): boolean {
  const digits = value.replace(/\D/g, '');
  if (digits.length !== 11 || repeatedDigits(digits)) return false;
  const expectedDigit = (length: number): number => {
    let sum = 0;
    for (let index = 0; index < length; index += 1) {
      sum += Number(digits[index]) * (length + 1 - index);
    }
    const remainder = (sum * 10) % 11;
    return remainder === 10 ? 0 : remainder;
  };
  return expectedDigit(9) === Number(digits[9]) && expectedDigit(10) === Number(digits[10]);
}

function validCnpj(value: string): boolean {
  const digits = value.replace(/\D/g, '');
  if (digits.length !== 14 || repeatedDigits(digits)) return false;
  const expectedDigit = (length: number): number => {
    const weights = length === 12
      ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
      : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const sum = weights.reduce((total, weight, index) => total + Number(digits[index]) * weight, 0);
    const remainder = sum % 11;
    return remainder < 2 ? 0 : 11 - remainder;
  };
  return expectedDigit(12) === Number(digits[12]) && expectedDigit(13) === Number(digits[13]);
}

function containsValidatedBrazilianIdentifier(content: string): boolean {
  const cpfPattern = /\bCPF\b["'`*_]{0,4}\s*[:=|]\s*["'`*_]{0,4}\s*(\d{3}\.?\d{3}\.?\d{3}-?\d{2})\b/giu;
  for (const match of content.matchAll(cpfPattern)) {
    if (validCpf(match[1] as string)) return true;
  }
  const cnpjPattern = /\bCNPJ\b["'`*_]{0,4}\s*[:=|]\s*["'`*_]{0,4}\s*(\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2})\b/giu;
  for (const match of content.matchAll(cnpjPattern)) {
    if (validCnpj(match[1] as string)) return true;
  }
  return false;
}

function safeTitleText(value: string): string {
  const withoutClosingHashes = value.replace(/\s+#+\s*$/, '');
  const singleLine = withoutClosingHashes
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return [...singleLine].slice(0, MAX_TITLE_CHARACTERS).join('');
}

function documentTitle(relativePath: string, content: string): string {
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index] as string;
    const line = index === 0 ? rawLine.replace(/^\uFEFF/, '') : rawLine;
    const heading = /^#\s+(.+?)\s*$/.exec(line);
    if (!heading) continue;
    const title = safeTitleText(heading[1] as string);
    if (title) return title;
  }
  const fileName = basename(relativePath);
  return safeTitleText(fileName.slice(0, -extname(fileName).length));
}

function documentAuthority(relativePath: string): {
  authority: DocumentAuthority;
  authority_basis: DocumentAuthorityBasis;
} {
  const normalized = relativePath.replaceAll('\\', '/').toLowerCase();
  for (const rule of DOCUMENT_AUTHORITY_RULES) {
    if (rule.matches(normalized)) {
      return {
        authority: rule.authority,
        authority_basis: { kind: 'convention', rule_id: rule.rule_id },
      };
    }
  }
  return { authority: 'implementation_note', authority_basis: { kind: 'default' } };
}

function metadataTokens(value: string): string[] {
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const token of value.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    const bounded = [...token].slice(0, 128).join('');
    if (!bounded || seen.has(bounded)) continue;
    seen.add(bounded);
    tokens.push(bounded);
    if (tokens.length === 32) break;
  }
  return tokens.sort(ordinalCompare);
}

function documentModules(relativePath: string): string[] {
  const segments = relativePath.replaceAll('\\', '/').split('/');
  if (segments.length === 1) return ['workspace'];
  const candidate = segments[0]?.toLowerCase() === 'docs' && segments.length > 2
    ? segments[1] as string
    : segments[0] as string;
  const tokens = metadataTokens(candidate);
  return tokens.length > 0 ? [tokens.join('-').slice(0, 128)] : [];
}

function documentTopics(relativePath: string): string[] {
  const fileName = basename(relativePath);
  return metadataTokens(fileName.slice(0, -extname(fileName).length));
}

export class NodeSha256Hasher {
  hash(value: string | Uint8Array): string {
    return this.sha256(value);
  }

  sha256(value: string | Uint8Array): string {
    const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value);
    return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  }
}

export class NodeDocumentSourceAdapter {
  private readonly excludes: string[];
  private readonly limits: DocumentDiscoveryLimits;
  private readonly hasher = new NodeSha256Hasher();

  constructor(excludes: string[] = [], limits: Partial<DocumentDiscoveryLimits> = {}) {
    this.excludes = [...excludes];
    this.limits = resolveLimits(limits);
  }

  async collect(root: string): Promise<DocumentSourceCollectionResult> {
    const resolvedRoot = resolve(root);
    const walk = await new NodeFileSystemAdapter(this.excludes).walk(resolvedRoot);
    const candidates = walk.paths
      .filter((item) => item.kind === 'file' && isDocumentCorpusPath(item.relative_path))
      .sort((left, right) => ordinalCompare(left.relative_path, right.relative_path));
    const corpusExcludedCount = walk.paths.filter(
      (item) => item.kind === 'file' && !isDocumentCorpusPath(item.relative_path),
    ).length;

    if (candidates.length > this.limits.maxDocuments) {
      throw new PrimeContextError(
        'SECURITY_ERROR',
        'Document discovery document count limit exceeded',
        [`maximum=${this.limits.maxDocuments}`],
      );
    }

    const sources: CollectedDocumentSource[] = [];
    let totalCandidateBytes = 0;
    let skippedOversizeCount = 0;
    let skippedBinaryCount = 0;
    let skippedSensitiveContentCount = 0;

    for (const candidate of candidates) {
      const declaredSize = candidate.size_bytes;
      if (typeof declaredSize !== 'number' || !Number.isSafeInteger(declaredSize) || declaredSize < 0) {
        throw new PrimeContextError('IO_ERROR', 'Document discovery returned an invalid file size');
      }
      if (declaredSize > this.limits.maxDocumentBytes) {
        skippedOversizeCount += 1;
        continue;
      }
      const declaredTotal = totalCandidateBytes + declaredSize;
      if (!Number.isSafeInteger(declaredTotal) || declaredTotal > this.limits.maxTotalBytes) {
        throw new PrimeContextError(
          'SECURITY_ERROR',
          'Document discovery total byte limit exceeded',
          [`maximum=${this.limits.maxTotalBytes}`],
        );
      }

      const read = await readStableBoundedBytes(
        resolvedRoot,
        candidate.relative_path,
        this.limits.maxDocumentBytes,
      );
      if (read.kind === 'oversize') {
        skippedOversizeCount += 1;
        continue;
      }
      const actualTotal = totalCandidateBytes + read.bytes.byteLength;
      if (!Number.isSafeInteger(actualTotal) || actualTotal > this.limits.maxTotalBytes) {
        throw new PrimeContextError(
          'SECURITY_ERROR',
          'Document discovery total byte limit exceeded',
          [`maximum=${this.limits.maxTotalBytes}`],
        );
      }
      totalCandidateBytes = actualTotal;
      const content = decodeUtf8(read.bytes);
      if (content === undefined) {
        skippedBinaryCount += 1;
        continue;
      }
      if (containsSensitiveContent(content)) {
        skippedSensitiveContentCount += 1;
        continue;
      }

      const classification = documentAuthority(candidate.relative_path);
      sources.push({
        relative_path: candidate.relative_path,
        content,
        size_bytes: read.bytes.byteLength,
        source_hash: this.hasher.sha256(read.bytes),
        authority_basis: classification.authority_basis,
        metadata: {
          title: documentTitle(candidate.relative_path, content),
          authority: classification.authority,
          modules: documentModules(candidate.relative_path),
          topics: documentTopics(candidate.relative_path),
        },
      });
    }

    const omittedDocumentCount = skippedOversizeCount + skippedBinaryCount + skippedSensitiveContentCount;
    const totalSourceBytes = sources.reduce((sum, source) => sum + source.size_bytes, 0);
    return {
      sources,
      discovered_path_count: walk.paths.length,
      excluded_path_count: walk.excluded_path_count + corpusExcludedCount,
      candidate_document_count: candidates.length,
      omitted_document_count: omittedDocumentCount,
      total_source_bytes: totalSourceBytes,
      skipped_oversize_count: skippedOversizeCount,
      skipped_binary_count: skippedBinaryCount,
      skipped_sensitive_content_count: skippedSensitiveContentCount,
    };
  }
}
