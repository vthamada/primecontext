import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { PrimeContextError } from '@primecontext/core';
import { assertNoSymbolicLinkComponents } from './filesystem.js';
import { isSensitiveDocumentContent } from './documents.js';
import { assertPathInsideRoot, isSensitivePath } from './security.js';
import {
  createCooperativeDeadlineV03,
  systemMonotonicNowV03,
  type MonotonicNowV03,
} from './cooperative-deadline.js';

const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
const WINDOWS_DEVICE_PATTERN = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])[ .]*(?:\.|$)/i;
export const DEFAULT_SQLITE_FTS_LIMITS_V03 = Object.freeze({
  maxSources: 16_384,
  maxSourceBytes: 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
});
const MAX_SOURCES = DEFAULT_SQLITE_FTS_LIMITS_V03.maxSources;
const MAX_SOURCE_BYTES = DEFAULT_SQLITE_FTS_LIMITS_V03.maxSourceBytes;
const MAX_TOTAL_BYTES = DEFAULT_SQLITE_FTS_LIMITS_V03.maxTotalBytes;
const MAX_QUERY_BYTES = 1_024;
const MAX_QUERY_TERMS = 32;
const MAX_HITS = 50;
const MAX_EXCERPT_CHARACTERS = 1_200;
const MAX_INDEX_BYTES = 512 * 1024 * 1024;
const OPTIONAL_ADAPTER_DEADLINE_MS = 30_000;
const DB_SCHEMA_VERSION = 3;

type NodeSqliteModule = typeof import('node:sqlite');
type DatabaseSyncConstructor = NodeSqliteModule['DatabaseSync'];
type DatabaseSync = InstanceType<DatabaseSyncConstructor>;

export type HybridIndexKindV03 = 'document' | 'code' | 'test' | 'configuration' | 'history' | 'repository_map';
export type HybridIndexAuthorityV03 =
  | 'policy' | 'adr' | 'specification' | 'contract_schema' | 'roadmap'
  | 'implementation_note' | 'generated_summary' | 'source_code' | 'test'
  | 'configuration' | 'history' | 'repository_map';

const KINDS = new Set<HybridIndexKindV03>([
  'document', 'code', 'test', 'configuration', 'history', 'repository_map',
]);
const AUTHORITIES = new Set<HybridIndexAuthorityV03>([
  'policy', 'adr', 'specification', 'contract_schema', 'roadmap',
  'implementation_note', 'generated_summary', 'source_code', 'test',
  'configuration', 'history', 'repository_map',
]);

export interface HybridIndexSourceV03 {
  path: string;
  kind: HybridIndexKindV03;
  authority: HybridIndexAuthorityV03;
  source_hash: string;
  content: string;
  title?: string;
  locator?: { start_line: number; end_line: number; symbol?: string };
  source_truncated?: boolean;
}

export interface HybridIndexMetadataV03 {
  repository_id: string;
  worktree_digest: string;
}

export interface SqliteFtsRebuildResultV03 {
  schema_version: '0.3';
  index_path: string;
  index_digest: string;
  worktree_digest: string;
  indexed_source_count: number;
  secure_delete: boolean;
  fts_secure_delete: boolean;
}

export interface SqliteFtsSearchOptionsV03 {
  limit?: number;
  expected_worktree_digest: string;
}

export interface SqliteFtsHitV03 {
  path: string;
  kind: HybridIndexKindV03;
  authority: HybridIndexAuthorityV03;
  source_hash: string;
  title: string;
  excerpt: string;
  excerpt_hash: string;
  matched_terms: string[];
  observed_size_bytes: number;
  truncated: boolean;
  locator?: { start_line: number; end_line: number; symbol?: string };
}

export interface SqliteFtsSearchResultV03 {
  schema_version: '0.3';
  hits: SqliteFtsHitV03[];
  index_digest: string;
  worktree_digest: string;
  repository_id: string;
}

export interface SqliteFtsRuntimeV03 {
  monotonicNow?: MonotonicNowV03;
}

interface NormalizedSource extends HybridIndexSourceV03 {
  title: string;
  sizeBytes: number;
  sourceId: string;
}

interface IndexRow {
  source_id: string;
  path: string;
  kind: HybridIndexKindV03;
  authority: HybridIndexAuthorityV03;
  source_hash: string;
  title: string;
  size_bytes: number;
  start_line: number | null;
  end_line: number | null;
  symbol: string | null;
  source_truncated: number;
}

const activeWriters = new Set<string>();

function resolveRuntime(runtime: SqliteFtsRuntimeV03): Required<SqliteFtsRuntimeV03> {
  if (typeof runtime !== 'object' || runtime === null || Array.isArray(runtime)) {
    throw new PrimeContextError('CONFIG_ERROR', 'Invalid SQLite/FTS runtime configuration');
  }
  for (const key of Object.keys(runtime)) {
    if (key !== 'monotonicNow') throw new PrimeContextError('CONFIG_ERROR', `Unknown SQLite/FTS runtime option: ${key}`);
  }
  if (runtime.monotonicNow !== undefined && typeof runtime.monotonicNow !== 'function') {
    throw new PrimeContextError('CONFIG_ERROR', 'SQLite/FTS monotonic clock must be a function');
  }
  return { monotonicNow: runtime.monotonicNow ?? systemMonotonicNowV03 };
}

function sha256(value: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function ordinalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function validateHash(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !HASH_PATTERN.test(value)) {
    throw new PrimeContextError('VALIDATION_ERROR', `${label} must be a lowercase SHA-256 digest`);
  }
}

function validatePortableChildPath(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || [...value].length > 1_024) {
    throw new PrimeContextError('SECURITY_ERROR', `${label} must be a bounded repository-relative path`);
  }
  if (isAbsolute(value) || value.includes('\\') || value.includes(':') || /[<>"|?*]/.test(value)
    || /[\u0000-\u001f\u007f-\u009f]/.test(value)) {
    throw new PrimeContextError('SECURITY_ERROR', `${label} is not a safe portable path`);
  }
  const segments = value.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..'
    || /[. ]$/.test(segment) || WINDOWS_DEVICE_PATTERN.test(segment))) {
    throw new PrimeContextError('SECURITY_ERROR', `${label} is not a safe portable path`);
  }
}

function validateIndexPath(value: unknown): asserts value is string {
  validatePortableChildPath(value, 'FTS index path');
  if (!value.toLowerCase().endsWith('.sqlite')) {
    throw new PrimeContextError('VALIDATION_ERROR', 'FTS index path must end in .sqlite');
  }
  const segments = value.split('/');
  const isPrimeContextState = segments[0]?.toLowerCase() === '.primecontext';
  const sensitiveOutsideState = !isPrimeContextState && isSensitivePath(value);
  const sensitiveInsideState = isPrimeContextState
    && segments.length > 1
    && isSensitivePath(segments.slice(1).join('/'));
  if (sensitiveOutsideState || sensitiveInsideState) {
    throw new PrimeContextError('SECURITY_ERROR', 'Sensitive FTS index path is blocked');
  }
}

function writerLockKey(absolutePath: string): string {
  return process.platform === 'win32' ? absolutePath.toLowerCase() : absolutePath;
}

function normalizeSource(value: HybridIndexSourceV03): NormalizedSource {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PrimeContextError('VALIDATION_ERROR', 'Hybrid index source must be an object');
  }
  const allowed = new Set(['path', 'kind', 'authority', 'source_hash', 'content', 'title', 'locator', 'source_truncated']);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new PrimeContextError('VALIDATION_ERROR', `Hybrid index source field is not allowed: ${key}`);
  }
  validatePortableChildPath(value.path, 'Hybrid index source path');
  if (isSensitivePath(value.path)) {
    throw new PrimeContextError('SECURITY_ERROR', 'Sensitive hybrid index source path is blocked');
  }
  if (!KINDS.has(value.kind)) throw new PrimeContextError('VALIDATION_ERROR', 'Hybrid index source kind is invalid');
  if (!AUTHORITIES.has(value.authority)) throw new PrimeContextError('VALIDATION_ERROR', 'Hybrid index source authority is invalid');
  validateHash(value.source_hash, 'Hybrid index source hash');
  if (typeof value.content !== 'string') throw new PrimeContextError('VALIDATION_ERROR', 'Hybrid index source content must be a string');
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(value.content)) {
    throw new PrimeContextError('SECURITY_ERROR', 'Hybrid index source contains unsafe control characters');
  }
  const sizeBytes = byteLength(value.content);
  if (sizeBytes > MAX_SOURCE_BYTES) throw new PrimeContextError('SECURITY_ERROR', 'Hybrid index source byte limit exceeded');
  if (sha256(value.content) !== value.source_hash) throw new PrimeContextError('VALIDATION_ERROR', 'Hybrid index source hash does not match content');
  if (isSensitiveDocumentContent(value.content)) {
    throw new PrimeContextError('SECURITY_ERROR', 'Sensitive hybrid index source content is blocked');
  }
  const title = value.title ?? value.path;
  if (typeof title !== 'string' || title.trim().length === 0 || [...title].length > 256) {
    throw new PrimeContextError('VALIDATION_ERROR', 'Hybrid index source title is invalid');
  }
  if (/[\u0000-\u001f\u007f-\u009f]/.test(title) || isSensitiveDocumentContent(title)) {
    throw new PrimeContextError('SECURITY_ERROR', 'Sensitive hybrid index source title is blocked');
  }
  if (value.locator !== undefined) {
    const locator = value.locator;
    if (typeof locator !== 'object' || locator === null
      || !Number.isSafeInteger(locator.start_line) || locator.start_line < 1
      || !Number.isSafeInteger(locator.end_line) || locator.end_line < locator.start_line
      || (locator.symbol !== undefined && (typeof locator.symbol !== 'string' || locator.symbol.length === 0
        || [...locator.symbol].length > 512 || /[\u0000-\u001f\u007f-\u009f]/.test(locator.symbol)
        || isSensitiveDocumentContent(locator.symbol)))) {
      throw new PrimeContextError('VALIDATION_ERROR', 'Hybrid index source locator is invalid');
    }
  }
  if (value.source_truncated !== undefined && typeof value.source_truncated !== 'boolean') {
    throw new PrimeContextError('VALIDATION_ERROR', 'Hybrid index source truncation marker is invalid');
  }
  const sourceId = sha256(JSON.stringify({
    path: value.path,
    kind: value.kind,
    start_line: value.locator?.start_line ?? null,
    end_line: value.locator?.end_line ?? null,
    symbol: value.locator?.symbol ?? null,
  }));
  return {
    path: value.path,
    kind: value.kind,
    authority: value.authority,
    source_hash: value.source_hash,
    content: value.content,
    title,
    ...(value.locator ? { locator: { ...value.locator } } : {}),
    ...(value.source_truncated !== undefined ? { source_truncated: value.source_truncated } : {}),
    sizeBytes,
    sourceId,
  };
}

function canonicalIndexDigest(
  repositoryId: string,
  worktreeDigest: string,
  rows: readonly IndexRow[],
): string {
  return sha256(JSON.stringify({
    schema_version: '0.3',
    repository_id: repositoryId,
    worktree_digest: worktreeDigest,
    sources: rows.map((row) => ({
      path: row.path,
      source_id: row.source_id,
      kind: row.kind,
      authority: row.authority,
      source_hash: row.source_hash,
      title: row.title,
      size_bytes: row.size_bytes,
      start_line: row.start_line,
      end_line: row.end_line,
      symbol: row.symbol,
      source_truncated: row.source_truncated,
    })),
  }));
}

function sourceRows(sources: readonly NormalizedSource[], assertWithinDeadline: () => void): IndexRow[] {
  const rows: IndexRow[] = [];
  for (const source of sources) {
    assertWithinDeadline();
    rows.push({
      source_id: source.sourceId,
      path: source.path,
      kind: source.kind,
      authority: source.authority,
      source_hash: source.source_hash,
      title: source.title,
      size_bytes: source.sizeBytes,
      start_line: source.locator?.start_line ?? null,
      end_line: source.locator?.end_line ?? null,
      symbol: source.locator?.symbol ?? null,
      source_truncated: source.source_truncated ? 1 : 0,
    });
  }
  return rows;
}

function tokenizeQuery(query: unknown): string[] {
  if (typeof query !== 'string' || query.length === 0 || byteLength(query) > MAX_QUERY_BYTES) {
    throw new PrimeContextError('VALIDATION_ERROR', 'FTS query must contain 1 through 1024 UTF-8 bytes');
  }
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const match of query.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (!seen.has(match)) {
      seen.add(match);
      terms.push(match);
    }
  }
  if (terms.length === 0 || terms.length > MAX_QUERY_TERMS) {
    throw new PrimeContextError('VALIDATION_ERROR', 'FTS query must contain 1 through 32 distinct lexical terms');
  }
  return terms;
}

function ftsExpression(terms: readonly string[]): string {
  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(' AND ');
}

function sanitizeExcerpt(value: string): { text: string; truncated: boolean } {
  const safe = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, ' ');
  const characters = Array.from(safe);
  return {
    text: characters.slice(0, MAX_EXCERPT_CHARACTERS).join(''),
    truncated: characters.length > MAX_EXCERPT_CHARACTERS,
  };
}

async function loadDatabaseSync(): Promise<DatabaseSyncConstructor> {
  try {
    const originalEmitWarning = process.emitWarning;
    const filteredEmitWarning = ((warning: string | Error, ...args: unknown[]): void => {
      const warningText = warning instanceof Error ? warning.message : warning;
      if (
        warningText === 'SQLite is an experimental feature and might change at any time'
        && args[0] === 'ExperimentalWarning'
      ) return;
      Reflect.apply(originalEmitWarning, process, [warning, ...args]);
    }) as typeof process.emitWarning;
    process.emitWarning = filteredEmitWarning;
    let sqlite: NodeSqliteModule;
    try {
      sqlite = await import('node:sqlite');
    } finally {
      if (process.emitWarning === filteredEmitWarning) process.emitWarning = originalEmitWarning;
    }
    if (typeof sqlite.DatabaseSync !== 'function') {
      throw new Error('DatabaseSync export is unavailable');
    }
    return sqlite.DatabaseSync;
  } catch {
    throw new PrimeContextError('CAPABILITY_ERROR', 'SQLite/FTS capability is unavailable');
  }
}

function openDatabase(
  Database: DatabaseSyncConstructor,
  path: string,
  readOnly: boolean,
): DatabaseSync {
  return new Database(path, {
    allowExtension: false,
    enableForeignKeyConstraints: true,
    enableDoubleQuotedStringLiterals: false,
    ...(readOnly ? { readOnly: true } : {}),
  });
}

function configureConnection(database: DatabaseSync, readOnly: boolean): void {
  database.exec('PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000;');
  if (readOnly) database.exec('PRAGMA query_only=ON;');
  else database.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;');
}

function metadata(database: DatabaseSync): Record<string, string> {
  const allowedKeys = new Set([
    'schema_version', 'repository_id', 'worktree_digest', 'index_digest',
    'indexed_source_count', 'secure_delete', 'fts_secure_delete',
  ]);
  const rows = database.prepare('SELECT key, value FROM metadata ORDER BY key LIMIT 8').all();
  if (rows.length !== allowedKeys.size) {
    throw new PrimeContextError('CATALOG_ERROR', 'FTS metadata is incomplete or contains extra fields');
  }
  const result: Record<string, string> = {};
  for (const row of rows) {
    if (typeof row.key !== 'string' || typeof row.value !== 'string' || !allowedKeys.has(row.key)) {
      throw new PrimeContextError('CATALOG_ERROR', 'FTS metadata is malformed');
    }
    result[row.key] = row.value;
  }
  return result;
}

function rowsFromDatabase(database: DatabaseSync, assertWithinDeadline: () => void): IndexRow[] {
  assertWithinDeadline();
  const rows = database.prepare(`
    SELECT source_id, path, kind, authority, source_hash, title, content, size_bytes,
           start_line, end_line, symbol, source_truncated
    FROM sources
    ORDER BY path COLLATE BINARY, COALESCE(start_line, 0), COALESCE(end_line, 0),
             COALESCE(symbol, '') COLLATE BINARY, source_id COLLATE BINARY
    LIMIT ${MAX_SOURCES + 1}
  `).all();
  assertWithinDeadline();
  if (rows.length > MAX_SOURCES) throw new PrimeContextError('CATALOG_ERROR', 'FTS source count exceeds its bound');
  let totalBytes = 0;
  const result: IndexRow[] = [];
  for (const row of rows) {
    assertWithinDeadline();
    if (typeof row.source_id !== 'string' || !HASH_PATTERN.test(row.source_id)
      || typeof row.path !== 'string' || typeof row.kind !== 'string' || !KINDS.has(row.kind as HybridIndexKindV03)
      || typeof row.authority !== 'string' || !AUTHORITIES.has(row.authority as HybridIndexAuthorityV03)
      || typeof row.source_hash !== 'string' || !HASH_PATTERN.test(row.source_hash)
      || typeof row.title !== 'string' || typeof row.content !== 'string'
      || typeof row.size_bytes !== 'number' || !Number.isSafeInteger(row.size_bytes)
      || (row.source_truncated !== 0 && row.source_truncated !== 1)) {
      throw new PrimeContextError('CATALOG_ERROR', 'FTS source metadata is malformed');
    }
    try {
      validatePortableChildPath(row.path, 'Stored FTS source path');
    } catch {
      throw new PrimeContextError('CATALOG_ERROR', 'FTS source path is not safe');
    }
    if (isSensitivePath(row.path) || isSensitiveDocumentContent(row.title)) {
      throw new PrimeContextError('CATALOG_ERROR', 'FTS source metadata is sensitive');
    }
    if (row.title.length === 0 || row.title.length > 256 || /[\u0000-\u001f\u007f-\u009f]/.test(row.title)
      || (row.start_line !== null && (typeof row.start_line !== 'number'
        || !Number.isSafeInteger(row.start_line) || row.start_line < 1))
      || (row.end_line !== null && (typeof row.end_line !== 'number'
        || !Number.isSafeInteger(row.end_line) || row.end_line < 1))
      || ((row.start_line === null) !== (row.end_line === null))
      || (typeof row.start_line === 'number' && typeof row.end_line === 'number' && row.end_line < row.start_line)
      || (row.symbol !== null && (typeof row.symbol !== 'string' || row.symbol.length === 0
        || row.symbol.length > 512 || /[\u0000-\u001f\u007f-\u009f]/.test(row.symbol)
        || isSensitiveDocumentContent(row.symbol)))) {
      throw new PrimeContextError('CATALOG_ERROR', 'FTS source locator metadata is malformed or sensitive');
    }
    const expectedSourceId = sha256(JSON.stringify({
      path: row.path,
      kind: row.kind,
      start_line: row.start_line,
      end_line: row.end_line,
      symbol: row.symbol,
    }));
    if (row.source_id !== expectedSourceId) {
      throw new PrimeContextError('CATALOG_ERROR', 'FTS source identity does not match its locator');
    }
    const actualBytes = byteLength(row.content);
    totalBytes += actualBytes;
    if (actualBytes !== row.size_bytes || actualBytes > MAX_SOURCE_BYTES || totalBytes > MAX_TOTAL_BYTES
      || sha256(row.content) !== row.source_hash || isSensitiveDocumentContent(row.content)) {
      throw new PrimeContextError('CATALOG_ERROR', 'FTS source content does not match its safe metadata');
    }
    result.push({
      source_id: row.source_id,
      path: row.path,
      kind: row.kind as HybridIndexKindV03,
      authority: row.authority as HybridIndexAuthorityV03,
      source_hash: row.source_hash,
      title: row.title,
      size_bytes: row.size_bytes,
      start_line: typeof row.start_line === 'number' ? row.start_line : null,
      end_line: typeof row.end_line === 'number' ? row.end_line : null,
      symbol: typeof row.symbol === 'string' ? row.symbol : null,
      source_truncated: row.source_truncated,
    });
  }
  return result;
}

function assertFtsContentMatchesSources(database: DatabaseSync, assertWithinDeadline: () => void): void {
  assertWithinDeadline();
  const row = database.prepare(`
    SELECT COUNT(*) AS mismatch_count
    FROM entries_fts AS f
    LEFT JOIN sources AS s ON s.source_id = f.source_id
    WHERE s.source_id IS NULL OR f.path != s.path OR f.title != s.title OR f.content != s.content
  `).get();
  const reverse = database.prepare(`
    SELECT COUNT(*) AS missing_count
    FROM sources AS s LEFT JOIN entries_fts AS f ON f.source_id = s.source_id
    WHERE f.source_id IS NULL
  `).get();
  const counts = database.prepare(`
    SELECT (SELECT COUNT(*) FROM sources) AS source_count,
           (SELECT COUNT(*) FROM entries_fts) AS fts_count
  `).get();
  assertWithinDeadline();
  if (!row || row.mismatch_count !== 0 || !reverse || reverse.missing_count !== 0
    || !counts || counts.source_count !== counts.fts_count) {
    throw new PrimeContextError('CATALOG_ERROR', 'FTS full-text rows do not match their source records');
  }
}

async function ensureSafeIndexParent(root: string, relativePath: string): Promise<void> {
  const parent = dirname(relativePath).replaceAll('\\', '/');
  if (parent === '.') return;
  await assertNoSymbolicLinkComponents(root, parent, { allowMissing: true });
  const absoluteParent = assertPathInsideRoot(root, parent);
  await mkdir(absoluteParent, { recursive: true });
  await assertNoSymbolicLinkComponents(root, parent);
  const stat = await lstat(absoluteParent);
  if (!stat.isDirectory()) throw new PrimeContextError('IO_ERROR', 'FTS index parent is not a directory');
}

async function removeIfPresent(path: string): Promise<void> {
  try { await unlink(path); } catch (error) {
    if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')) throw error;
  }
}

export class NodeSqliteFtsAdapter {
  private readonly monotonicNow: MonotonicNowV03;

  constructor(runtime: SqliteFtsRuntimeV03 = {}) {
    this.monotonicNow = resolveRuntime(runtime).monotonicNow;
  }

  async rebuild(
    root: string,
    relativeDbPath: string,
    inputSources: readonly HybridIndexSourceV03[],
    indexMetadata: HybridIndexMetadataV03,
  ): Promise<SqliteFtsRebuildResultV03> {
    const assertWithinDeadline = createCooperativeDeadlineV03(
      this.monotonicNow,
      OPTIONAL_ADAPTER_DEADLINE_MS,
      'SQLite/FTS rebuild',
    );
    assertWithinDeadline();
    const resolvedRoot = resolve(root);
    validateIndexPath(relativeDbPath);
    if (typeof indexMetadata !== 'object' || indexMetadata === null
      || Object.keys(indexMetadata).some((key) => key !== 'repository_id' && key !== 'worktree_digest')
      || typeof indexMetadata.repository_id !== 'string' || indexMetadata.repository_id.length === 0
      || [...indexMetadata.repository_id].length > 256
      || /[\u0000-\u001f\u007f-\u009f]/.test(indexMetadata.repository_id)) {
      throw new PrimeContextError('VALIDATION_ERROR', 'FTS repository id is invalid');
    }
    validateHash(indexMetadata.worktree_digest, 'FTS worktree digest');
    if (!Array.isArray(inputSources) || inputSources.length > MAX_SOURCES) {
      throw new PrimeContextError('SECURITY_ERROR', 'FTS source count limit exceeded');
    }
    const sources: NormalizedSource[] = [];
    for (const inputSource of inputSources) {
      assertWithinDeadline();
      sources.push(normalizeSource(inputSource));
      assertWithinDeadline();
    }
    assertWithinDeadline();
    sources.sort((left, right) => (
      ordinalCompare(left.path, right.path)
      || (left.locator?.start_line ?? 0) - (right.locator?.start_line ?? 0)
      || (left.locator?.end_line ?? 0) - (right.locator?.end_line ?? 0)
      || ordinalCompare(left.locator?.symbol ?? '', right.locator?.symbol ?? '')
      || ordinalCompare(left.sourceId, right.sourceId)
    ));
    assertWithinDeadline();
    for (let index = 1; index < sources.length; index += 1) {
      assertWithinDeadline();
      if (sources[index - 1]?.sourceId === sources[index]?.sourceId) {
        throw new PrimeContextError('VALIDATION_ERROR', 'Duplicate FTS source locator is not allowed');
      }
    }
    let totalBytes = 0;
    for (const source of sources) {
      assertWithinDeadline();
      totalBytes += source.sizeBytes;
    }
    if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_TOTAL_BYTES) {
      throw new PrimeContextError('SECURITY_ERROR', 'FTS total source byte limit exceeded');
    }

    const Database = await loadDatabaseSync();

    const absolute = assertPathInsideRoot(resolvedRoot, relativeDbPath);
    const lockKey = writerLockKey(absolute);
    if (activeWriters.has(lockKey)) throw new PrimeContextError('STATE_ERROR', 'FTS index already has an active writer');
    activeWriters.add(lockKey);
    const parent = dirname(relativeDbPath).replaceAll('\\', '/');
    const temporaryRelative = parent === '.'
      ? `.primecontext-${randomUUID()}.sqlite`
      : `${parent}/.primecontext-${randomUUID()}.sqlite`;
    const temporaryAbsolute = assertPathInsideRoot(resolvedRoot, temporaryRelative);
    const lockRelative = `${relativeDbPath}.lock`;
    const lockAbsolute = assertPathInsideRoot(resolvedRoot, lockRelative);
    let temporaryMayExist = false;
    let lockCreated = false;
    let lockHandle: Awaited<ReturnType<typeof open>> | undefined;
    let database: DatabaseSync | undefined;
    try {
      assertWithinDeadline();
      await ensureSafeIndexParent(resolvedRoot, relativeDbPath);
      assertWithinDeadline();
      await assertNoSymbolicLinkComponents(resolvedRoot, lockRelative, { allowMissing: true });
      try {
        lockHandle = await open(lockAbsolute, 'wx', 0o600);
        lockCreated = true;
      } catch (error) {
        if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST') {
          throw new PrimeContextError('STATE_ERROR', 'FTS index already has an active writer');
        }
        throw error;
      }
      await assertNoSymbolicLinkComponents(resolvedRoot, relativeDbPath, { allowMissing: true });
      const handle = await open(temporaryAbsolute, 'wx');
      await handle.close();
      temporaryMayExist = true;
      database = openDatabase(Database, temporaryAbsolute, false);
      configureConnection(database, false);
      assertWithinDeadline();
      database.exec(`
        PRAGMA user_version=${DB_SCHEMA_VERSION};
        CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
        CREATE TABLE sources (
          source_id TEXT PRIMARY KEY,
          path TEXT NOT NULL,
          kind TEXT NOT NULL,
          authority TEXT NOT NULL,
          source_hash TEXT NOT NULL,
          title TEXT NOT NULL,
          content TEXT NOT NULL,
          size_bytes INTEGER NOT NULL,
          start_line INTEGER,
          end_line INTEGER,
          symbol TEXT,
          source_truncated INTEGER NOT NULL CHECK(source_truncated IN (0, 1))
        ) STRICT;
        CREATE VIRTUAL TABLE entries_fts USING fts5(
          source_id UNINDEXED, path UNINDEXED, title, content,
          tokenize='unicode61 remove_diacritics 0'
        );
      `);
      assertWithinDeadline();
      let ftsSecureDelete = false;
      try {
        database.exec("INSERT INTO entries_fts(entries_fts, rank) VALUES('secure-delete', 1);");
        ftsSecureDelete = true;
      } catch { /* SQLite versions before FTS5 secure-delete remain supported. */ }

      const rows = sourceRows(sources, assertWithinDeadline);
      assertWithinDeadline();
      const indexDigest = canonicalIndexDigest(indexMetadata.repository_id, indexMetadata.worktree_digest, rows);
      assertWithinDeadline();
      const insertMetadata = database.prepare('INSERT INTO metadata(key, value) VALUES (?, ?)');
      const insertSource = database.prepare(`
        INSERT INTO sources(source_id, path, kind, authority, source_hash, title, content, size_bytes, start_line, end_line, symbol, source_truncated)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insertFts = database.prepare('INSERT INTO entries_fts(rowid, source_id, path, title, content) VALUES (?, ?, ?, ?, ?)');
      database.exec('BEGIN IMMEDIATE;');
      try {
        for (const [key, value] of [
          ['schema_version', '0.3'],
          ['repository_id', indexMetadata.repository_id],
          ['worktree_digest', indexMetadata.worktree_digest],
          ['index_digest', indexDigest],
          ['indexed_source_count', String(sources.length)],
          ['secure_delete', '1'],
          ['fts_secure_delete', ftsSecureDelete ? '1' : '0'],
        ] as const) insertMetadata.run(key, value);
        for (let index = 0; index < sources.length; index += 1) {
          assertWithinDeadline();
          const source = sources[index] as NormalizedSource;
          insertSource.run(
            source.sourceId, source.path, source.kind, source.authority, source.source_hash, source.title,
            source.content, source.sizeBytes, source.locator?.start_line ?? null,
            source.locator?.end_line ?? null, source.locator?.symbol ?? null,
            source.source_truncated ? 1 : 0,
          );
          insertFts.run(index + 1, source.sourceId, source.path, source.title, source.content);
          assertWithinDeadline();
        }
        database.exec('COMMIT;');
        assertWithinDeadline();
      } catch (error) {
        try { database.exec('ROLLBACK;'); } catch { /* retain original failure */ }
        throw error;
      }
      const secureDeleteRow = database.prepare('PRAGMA secure_delete').get();
      if (!secureDeleteRow || !Object.values(secureDeleteRow).some((value) => value === 1)) {
        throw new PrimeContextError('CATALOG_ERROR', 'SQLite secure_delete could not be enabled');
      }
      const integrity = database.prepare('PRAGMA integrity_check').get();
      assertWithinDeadline();
      if (!integrity || !Object.values(integrity).some((value) => value === 'ok')) {
        throw new PrimeContextError('CATALOG_ERROR', 'SQLite integrity check failed');
      }
      database.close();
      database = undefined;
      assertWithinDeadline();
      await assertNoSymbolicLinkComponents(resolvedRoot, temporaryRelative);
      const temporaryStat = await lstat(temporaryAbsolute);
      if (!temporaryStat.isFile() || temporaryStat.isSymbolicLink()) {
        throw new PrimeContextError('SECURITY_ERROR', 'Temporary FTS index is not a regular file');
      }
      if (temporaryStat.size > MAX_INDEX_BYTES) {
        throw new PrimeContextError('SECURITY_ERROR', 'Temporary FTS index exceeds its byte limit');
      }
      await assertNoSymbolicLinkComponents(resolvedRoot, relativeDbPath, { allowMissing: true });
      assertWithinDeadline();
      await rename(temporaryAbsolute, absolute);
      temporaryMayExist = false;
      await assertNoSymbolicLinkComponents(resolvedRoot, relativeDbPath);
      const finalStat = await lstat(absolute);
      if (!finalStat.isFile() || finalStat.isSymbolicLink()) {
        throw new PrimeContextError('SECURITY_ERROR', 'FTS index replacement is not a regular file');
      }
      return {
        schema_version: '0.3',
        index_path: relativeDbPath,
        index_digest: indexDigest,
        worktree_digest: indexMetadata.worktree_digest,
        indexed_source_count: sources.length,
        secure_delete: true,
        fts_secure_delete: ftsSecureDelete,
      };
    } catch (error) {
      try { database?.close(); } catch { /* retain original failure */ }
      if (temporaryMayExist) {
        for (const suffix of ['', '-journal', '-wal', '-shm']) {
          try { await removeIfPresent(`${temporaryAbsolute}${suffix}`); } catch { /* retain original failure */ }
        }
      }
      if (error instanceof PrimeContextError) throw error;
      throw new PrimeContextError('IO_ERROR', 'Unable to rebuild the local FTS index', [
        error instanceof Error ? error.message : String(error),
      ]);
    } finally {
      try { await lockHandle?.close(); } catch { /* preserve original result */ }
      if (lockCreated) {
        try { await removeIfPresent(lockAbsolute); } catch { /* preserve original result */ }
      }
      activeWriters.delete(lockKey);
    }
  }

  async search(
    root: string,
    relativeDbPath: string,
    query: string,
    options: SqliteFtsSearchOptionsV03,
  ): Promise<SqliteFtsSearchResultV03> {
    const assertWithinDeadline = createCooperativeDeadlineV03(
      this.monotonicNow,
      OPTIONAL_ADAPTER_DEADLINE_MS,
      'SQLite/FTS search',
    );
    assertWithinDeadline();
    const terms = tokenizeQuery(query);
    if (typeof options !== 'object' || options === null) throw new PrimeContextError('VALIDATION_ERROR', 'FTS search options are required');
    validateHash(options.expected_worktree_digest, 'Expected FTS worktree digest');
    const limit = options.limit ?? 10;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_HITS) {
      throw new PrimeContextError('VALIDATION_ERROR', 'FTS search limit must be from 1 through 50');
    }
    validateIndexPath(relativeDbPath);
    const resolvedRoot = resolve(root);
    const Database = await loadDatabaseSync();
    const absolute = assertPathInsideRoot(resolvedRoot, relativeDbPath);
    await assertNoSymbolicLinkComponents(resolvedRoot, relativeDbPath);
    assertWithinDeadline();
    const stat = await lstat(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new PrimeContextError('IO_ERROR', 'FTS index is not a regular file');
    if (stat.size > MAX_INDEX_BYTES) throw new PrimeContextError('CATALOG_ERROR', 'FTS index exceeds its byte limit');

    let database: DatabaseSync | undefined;
    try {
      database = openDatabase(Database, absolute, true);
      configureConnection(database, true);
      assertWithinDeadline();
      const version = database.prepare('PRAGMA user_version').get();
      if (!version || !Object.values(version).some((value) => value === DB_SCHEMA_VERSION)) {
        throw new PrimeContextError('CATALOG_ERROR', 'FTS index schema version is unsupported');
      }
      const integrity = database.prepare('PRAGMA integrity_check').get();
      assertWithinDeadline();
      if (!integrity || !Object.values(integrity).some((value) => value === 'ok')) {
        throw new PrimeContextError('CATALOG_ERROR', 'FTS index integrity check failed');
      }
      const stored = metadata(database);
      assertWithinDeadline();
      validateHash(stored.worktree_digest, 'Stored FTS worktree digest');
      validateHash(stored.index_digest, 'Stored FTS index digest');
      if (stored.schema_version !== '0.3' || !stored.repository_id) {
        throw new PrimeContextError('CATALOG_ERROR', 'FTS index metadata is incomplete');
      }
      if (stored.worktree_digest !== options.expected_worktree_digest) {
        throw new PrimeContextError('CATALOG_ERROR', 'FTS index is stale for the requested worktree');
      }
      const rows = rowsFromDatabase(database, assertWithinDeadline);
      assertFtsContentMatchesSources(database, assertWithinDeadline);
      assertWithinDeadline();
      const actualDigest = canonicalIndexDigest(stored.repository_id, stored.worktree_digest, rows);
      assertWithinDeadline();
      if (actualDigest !== stored.index_digest || Number(stored.indexed_source_count) !== rows.length) {
        throw new PrimeContextError('CATALOG_ERROR', 'FTS index digest does not match source metadata');
      }
      assertWithinDeadline();
      const matches = database.prepare(`
        SELECT s.path, s.kind, s.authority, s.source_hash, s.title, s.size_bytes,
               s.start_line, s.end_line, s.symbol, s.source_truncated,
               snippet(entries_fts, 3, '', '', char(1), 48) AS excerpt,
               bm25(entries_fts, 0.0, 0.0, 8.0, 1.0) AS relevance
        FROM entries_fts JOIN sources s ON s.source_id = entries_fts.source_id
        WHERE entries_fts MATCH ?
        ORDER BY relevance ASC, s.path COLLATE BINARY ASC,
                 COALESCE(s.start_line, 0) ASC, COALESCE(s.end_line, 0) ASC,
                 COALESCE(s.symbol, '') COLLATE BINARY ASC, s.source_id COLLATE BINARY ASC
        LIMIT ?
      `).all(ftsExpression(terms), limit);
      assertWithinDeadline();
      const hits: SqliteFtsHitV03[] = [];
      for (const row of matches) {
        assertWithinDeadline();
        if (typeof row.path !== 'string' || typeof row.kind !== 'string' || !KINDS.has(row.kind as HybridIndexKindV03)
          || typeof row.authority !== 'string' || !AUTHORITIES.has(row.authority as HybridIndexAuthorityV03)
          || typeof row.source_hash !== 'string' || typeof row.title !== 'string'
          || typeof row.size_bytes !== 'number' || typeof row.excerpt !== 'string') {
          throw new PrimeContextError('CATALOG_ERROR', 'FTS search result is malformed');
        }
        const sanitized = sanitizeExcerpt(row.excerpt.replaceAll('\u0001', ' … '));
        const truncated = row.excerpt.includes('\u0001') || row.source_truncated === 1 || sanitized.truncated;
        const excerpt = sanitized.text;
        const startLine = typeof row.start_line === 'number' ? row.start_line : undefined;
        const endLine = typeof row.end_line === 'number' ? row.end_line : undefined;
        const symbol = typeof row.symbol === 'string' ? row.symbol : undefined;
        hits.push({
          path: row.path,
          kind: row.kind as HybridIndexKindV03,
          authority: row.authority as HybridIndexAuthorityV03,
          source_hash: row.source_hash,
          title: row.title,
          excerpt,
          excerpt_hash: sha256(excerpt),
          matched_terms: [...terms],
          observed_size_bytes: row.size_bytes,
          truncated,
          ...(startLine !== undefined && endLine !== undefined
            ? { locator: { start_line: startLine, end_line: endLine, ...(symbol ? { symbol } : {}) } }
            : {}),
        });
      }
      assertWithinDeadline();
      return {
        schema_version: '0.3',
        hits,
        index_digest: stored.index_digest,
        worktree_digest: stored.worktree_digest,
        repository_id: stored.repository_id,
      };
    } catch (error) {
      if (error instanceof PrimeContextError) throw error;
      throw new PrimeContextError('CATALOG_ERROR', 'Unable to search the local FTS index', [
        error instanceof Error ? error.message : String(error),
      ]);
    } finally {
      try { database?.close(); } catch { /* preserve original result */ }
    }
  }
}
