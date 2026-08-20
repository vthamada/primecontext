import { createHash, randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, isAbsolute, resolve } from 'node:path';
import { PrimeContextError } from '@primecontext/core';
import { assertNoSymbolicLinkComponents } from './filesystem.js';
import { isSensitiveDocumentContent } from './documents.js';
import { resolvePhysicalRepositoryRelativePath } from './physical-path.js';
import { assertPathInsideRoot, isSensitivePath } from './security.js';
import { sameRegularFileSnapshot } from './file-snapshot.js';
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
export const DEFAULT_SQLITE_FTS_STATE_DIR_V03 = '.primecontext';
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
const ENTRIES_FTS_SCHEMA_DDL = `CREATE VIRTUAL TABLE entries_fts USING fts5(
          source_id UNINDEXED, path UNINDEXED, title, content,
          tokenize='unicode61 remove_diacritics 0'
        )`;
const MAX_FTS_WRITER_LOCK_BYTES = 4_096;
const MAX_FTS_LOCK_HOSTNAME_CHARACTERS = 255;

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
  toolchain: SqliteFtsToolchainV03;
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
  state_dir?: string;
  signal?: AbortSignal;
}

export interface SqliteFtsRebuildOptionsV03 {
  state_dir?: string;
  signal?: AbortSignal;
}

export interface SqliteFtsToolchainV03 {
  sqlite_version: string;
  fts5_available: true;
  fts5_source_id?: string;
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
  toolchain: SqliteFtsToolchainV03;
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
const pendingWriters = new Set<string>();

interface FtsWriterLockRecord {
  schema_version: 'primecontext-lock-v1';
  pid: number;
  hostname: string;
  created_at: string;
  operation: 'sqlite-fts-rebuild';
  owner_token: string;
}

function nodeErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

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

function cooperativeOperationCheck(
  assertWithinDeadline: () => void,
  signal: AbortSignal | undefined,
  label: string,
): () => void {
  if (signal !== undefined && (
    typeof signal !== 'object'
    || typeof signal.aborted !== 'boolean'
    || typeof signal.addEventListener !== 'function'
  )) {
    throw new PrimeContextError('CONFIG_ERROR', `${label} cancellation signal is invalid`);
  }
  return () => {
    if (signal?.aborted) throw new PrimeContextError('CAPABILITY_ERROR', `${label} was cancelled cooperatively`);
    assertWithinDeadline();
  };
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

function validateStateDirectory(value: unknown): asserts value is string {
  validatePortableChildPath(value, 'FTS state directory');
  if (value !== DEFAULT_SQLITE_FTS_STATE_DIR_V03 && isSensitivePath(value)) {
    throw new PrimeContextError('SECURITY_ERROR', 'Sensitive FTS state directory is blocked');
  }
}

function validateIndexPath(value: unknown, stateDirectory: string): asserts value is string {
  validateStateDirectory(stateDirectory);
  validatePortableChildPath(value, 'FTS index path');
  if (!value.toLowerCase().endsWith('.sqlite')) {
    throw new PrimeContextError('VALIDATION_ERROR', 'FTS index path must end in .sqlite');
  }
  const indexSegments = value.split('/');
  const stateSegments = stateDirectory.split('/');
  if (indexSegments.length <= stateSegments.length
    || stateSegments.some((segment, index) => indexSegments[index] !== segment)) {
    if (isSensitivePath(value)) {
      throw new PrimeContextError('SECURITY_ERROR', 'Sensitive FTS index path is blocked');
    }
    throw new PrimeContextError(
      'SECURITY_ERROR',
      'FTS index path must be strictly inside the configured state directory',
    );
  }
  const stateRelativeIndexPath = indexSegments.slice(stateSegments.length).join('/');
  if (isSensitivePath(stateRelativeIndexPath)) {
    throw new PrimeContextError('SECURITY_ERROR', 'Sensitive FTS index path is blocked');
  }
}

function isDefaultStateDirectory(value: string): boolean {
  return process.platform === 'win32'
    ? value.toLowerCase() === DEFAULT_SQLITE_FTS_STATE_DIR_V03.toLowerCase()
    : value === DEFAULT_SQLITE_FTS_STATE_DIR_V03;
}

function validatePhysicalIndexPath(value: string, stateDirectory: string): void {
  validatePortableChildPath(stateDirectory, 'Physical FTS state directory');
  validatePortableChildPath(value, 'Physical FTS index path');
  if (!value.toLowerCase().endsWith('.sqlite')) {
    throw new PrimeContextError('VALIDATION_ERROR', 'FTS index path must end in .sqlite');
  }
  if (!isDefaultStateDirectory(stateDirectory) && isSensitivePath(stateDirectory)) {
    throw new PrimeContextError('SECURITY_ERROR', 'Sensitive FTS state directory is blocked');
  }
  const indexSegments = value.split('/');
  const stateSegments = stateDirectory.split('/');
  if (indexSegments.length <= stateSegments.length
    || stateSegments.some((segment, index) => indexSegments[index] !== segment)) {
    throw new PrimeContextError(
      'SECURITY_ERROR',
      'FTS index path must be strictly inside the configured state directory',
    );
  }
  if (isSensitivePath(indexSegments.slice(stateSegments.length).join('/'))) {
    throw new PrimeContextError('SECURITY_ERROR', 'Sensitive FTS index path is blocked');
  }
}

async function assertPhysicalIndexPathSafe(
  root: string,
  relativeDbPath: string,
  stateDirectory: string,
  allowMissing: boolean,
): Promise<void> {
  if (process.platform !== 'win32') return;
  const physicalStateDirectory = await resolvePhysicalRepositoryRelativePath(
    root,
    stateDirectory,
    { allowMissing },
  );
  const physicalIndexPath = await resolvePhysicalRepositoryRelativePath(
    root,
    relativeDbPath,
    { allowMissing },
  );
  validatePhysicalIndexPath(physicalIndexPath, physicalStateDirectory);
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
  toolchain: SqliteFtsToolchainV03,
  rows: readonly IndexRow[],
): string {
  return sha256(JSON.stringify({
    schema_version: '0.3',
    repository_id: repositoryId,
    worktree_digest: worktreeDigest,
    toolchain,
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
  const [nodeMajor, nodeMinor] = process.versions.node.split('.').map((part) => Number.parseInt(part, 10));
  const warningFreeReleaseCandidate = Number.isSafeInteger(nodeMajor) && Number.isSafeInteger(nodeMinor)
    && (nodeMajor! >= 26 || nodeMajor === 25 && nodeMinor! >= 7 || nodeMajor === 24 && nodeMinor! >= 15);
  if (!warningFreeReleaseCandidate) {
    // Earlier node:sqlite builds emit an unavoidable process-global ExperimentalWarning.
    // The optional adapter stays unavailable there so JSON-process stderr remains uncontaminated.
    throw new PrimeContextError('CAPABILITY_ERROR', 'SQLite/FTS capability is unavailable');
  }
  try {
    const sqlite = await import('node:sqlite');
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

function boundedToolchainText(value: unknown, maximum: number): value is string {
  return typeof value === 'string'
    && value.length > 0
    && [...value].length <= maximum
    && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

function inspectSqliteToolchain(database: DatabaseSync): SqliteFtsToolchainV03 {
  const versionRow = database.prepare('SELECT sqlite_version() AS sqlite_version').get();
  if (!versionRow || !boundedToolchainText(versionRow.sqlite_version, 64)) {
    throw new PrimeContextError('CAPABILITY_ERROR', 'SQLite runtime version is unavailable');
  }
  let fts5SourceId: string | undefined;
  try {
    const sourceRow = database.prepare('SELECT fts5_source_id() AS fts5_source_id').get();
    if (sourceRow?.fts5_source_id !== undefined) {
      if (!boundedToolchainText(sourceRow.fts5_source_id, 512)) {
        throw new PrimeContextError('CAPABILITY_ERROR', 'FTS5 runtime identity is invalid');
      }
      fts5SourceId = sourceRow.fts5_source_id;
    }
  } catch (error) {
    if (error instanceof PrimeContextError) throw error;
    // Some supported SQLite builds expose FTS5 without the optional source-id function.
  }
  return {
    sqlite_version: versionRow.sqlite_version,
    fts5_available: true,
    ...(fts5SourceId ? { fts5_source_id: fts5SourceId } : {}),
  };
}

function storedSqliteToolchain(stored: Readonly<Record<string, string>>): SqliteFtsToolchainV03 {
  if (!boundedToolchainText(stored.sqlite_version, 64) || stored.fts5_available !== '1'
    || (stored.fts5_source_id !== undefined && !boundedToolchainText(stored.fts5_source_id, 512))) {
    throw new PrimeContextError('CATALOG_ERROR', 'Stored SQLite/FTS toolchain identity is malformed');
  }
  return {
    sqlite_version: stored.sqlite_version,
    fts5_available: true,
    ...(stored.fts5_source_id ? { fts5_source_id: stored.fts5_source_id } : {}),
  };
}

function sameSqliteToolchain(left: SqliteFtsToolchainV03, right: SqliteFtsToolchainV03): boolean {
  return left.sqlite_version === right.sqlite_version
    && left.fts5_available === right.fts5_available
    && left.fts5_source_id === right.fts5_source_id;
}

function metadata(database: DatabaseSync): Record<string, string> {
  const requiredKeys = new Set([
    'schema_version', 'repository_id', 'worktree_digest', 'index_digest',
    'indexed_source_count', 'secure_delete', 'fts_secure_delete', 'sqlite_version', 'fts5_available',
  ]);
  const allowedKeys = new Set([...requiredKeys, 'fts5_source_id']);
  const rows = database.prepare(`SELECT key, value FROM metadata ORDER BY key LIMIT ${allowedKeys.size + 1}`).all();
  if (rows.length < requiredKeys.size || rows.length > allowedKeys.size) {
    throw new PrimeContextError('CATALOG_ERROR', 'FTS metadata is incomplete or contains extra fields');
  }
  const result: Record<string, string> = {};
  for (const row of rows) {
    if (typeof row.key !== 'string' || typeof row.value !== 'string' || !allowedKeys.has(row.key)
      || [...row.value].length > 512 || /[\u0000-\u001f\u007f-\u009f]/u.test(row.value)) {
      throw new PrimeContextError('CATALOG_ERROR', 'FTS metadata is malformed');
    }
    result[row.key] = row.value;
  }
  if ([...requiredKeys].some((key) => !Object.hasOwn(result, key))) {
    throw new PrimeContextError('CATALOG_ERROR', 'FTS metadata is incomplete or contains extra fields');
  }
  return result;
}

function assertExpectedFtsSchema(database: DatabaseSync, assertWithinDeadline: () => void): void {
  assertWithinDeadline();
  const rows = database.prepare(`
    SELECT type, name, tbl_name, sql
    FROM sqlite_schema
    WHERE name = ?
    ORDER BY type COLLATE BINARY, name COLLATE BINARY
    LIMIT 2
  `).all('entries_fts');
  assertWithinDeadline();
  const row = rows[0];
  if (rows.length !== 1 || !row || row.type !== 'table' || row.name !== 'entries_fts'
    || row.tbl_name !== 'entries_fts' || row.sql !== ENTRIES_FTS_SCHEMA_DDL) {
    throw new PrimeContextError('CATALOG_ERROR', 'FTS index schema or tokenizer identity is invalid');
  }
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

async function ensureSafeStateDirectory(root: string, relativeDirectory: string): Promise<void> {
  await assertNoSymbolicLinkComponents(root, relativeDirectory, { allowMissing: true });
  const absoluteDirectory = assertPathInsideRoot(root, relativeDirectory);
  try {
    await mkdir(absoluteDirectory, { mode: 0o700 });
  } catch (error) {
    if (nodeErrorCode(error) !== 'EEXIST') throw error;
  }
  await assertNoSymbolicLinkComponents(root, relativeDirectory);
  const stat = await lstat(absoluteDirectory);
  if (!stat.isDirectory()) throw new PrimeContextError('IO_ERROR', 'FTS index parent is not a directory');
  if (process.platform !== 'win32') {
    const directoryHandle = await open(
      absoluteDirectory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      const handleStat = await directoryHandle.stat();
      if (!handleStat.isDirectory()) {
        throw new PrimeContextError('SECURITY_ERROR', 'FTS index parent changed before permission hardening');
      }
      await directoryHandle.chmod(0o700);
    } finally {
      await directoryHandle.close();
    }
    await assertNoSymbolicLinkComponents(root, relativeDirectory);
  }
}

async function ensureSafeIndexParent(
  root: string,
  stateDirectory: string,
  relativePath: string,
): Promise<void> {
  validateIndexPath(relativePath, stateDirectory);
  const parent = dirname(relativePath).replaceAll('\\', '/');
  const stateSegments = stateDirectory.split('/');
  const parentSegments = parent.split('/');
  for (let depth = stateSegments.length; depth <= parentSegments.length; depth += 1) {
    await ensureSafeStateDirectory(root, parentSegments.slice(0, depth).join('/'));
  }
}

function localFtsLockHostname(): string {
  const value = hostname();
  if (!boundedToolchainText(value, MAX_FTS_LOCK_HOSTNAME_CHARACTERS)) {
    throw new PrimeContextError('STATE_ERROR', 'Local hostname is unavailable for safe FTS lock ownership');
  }
  return value;
}

function createFtsWriterLockRecord(): FtsWriterLockRecord {
  return {
    schema_version: 'primecontext-lock-v1',
    pid: process.pid,
    hostname: localFtsLockHostname(),
    created_at: new Date().toISOString(),
    operation: 'sqlite-fts-rebuild',
    owner_token: randomUUID(),
  };
}

function serializeFtsWriterLock(record: FtsWriterLockRecord): string {
  const serialized = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > MAX_FTS_WRITER_LOCK_BYTES) {
    throw new PrimeContextError('STATE_ERROR', 'FTS writer lock metadata exceeds its byte limit');
  }
  return serialized;
}

function parseFtsWriterLock(content: string): FtsWriterLockRecord {
  let value: unknown;
  try {
    value = JSON.parse(content) as unknown;
  } catch {
    throw new PrimeContextError('STATE_ERROR', 'FTS index already has an active writer or malformed lock');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PrimeContextError('STATE_ERROR', 'FTS index already has an active writer or malformed lock');
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== 'created_at,hostname,operation,owner_token,pid,schema_version'
    || record.schema_version !== 'primecontext-lock-v1'
    || !Number.isSafeInteger(record.pid) || (record.pid as number) < 1 || (record.pid as number) > 2_147_483_647
    || !boundedToolchainText(record.hostname, MAX_FTS_LOCK_HOSTNAME_CHARACTERS)
    || record.operation !== 'sqlite-fts-rebuild'
    || typeof record.owner_token !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(record.owner_token)
    || typeof record.created_at !== 'string' || record.created_at.length > 64
    || !Number.isFinite(Date.parse(record.created_at))
    || new Date(record.created_at).toISOString() !== record.created_at) {
    throw new PrimeContextError('STATE_ERROR', 'FTS index already has an active writer or unverifiable lock');
  }
  return record as unknown as FtsWriterLockRecord;
}

function ftsWriterProcessLiveness(pid: number): 'ALIVE' | 'DEAD' | 'UNVERIFIABLE' {
  try {
    process.kill(pid, 0);
    return 'ALIVE';
  } catch (error) {
    return nodeErrorCode(error) === 'ESRCH' ? 'DEAD' : 'UNVERIFIABLE';
  }
}

async function readFtsWriterLock(
  root: string,
  relativePath: string,
  absolutePath: string,
): Promise<string | undefined> {
  await assertNoSymbolicLinkComponents(root, relativePath, { allowMissing: true });
  let pathBefore: Stats;
  try {
    pathBefore = await lstat(absolutePath);
  } catch (error) {
    if (nodeErrorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
  if (!pathBefore.isFile() || pathBefore.isSymbolicLink() || pathBefore.size > MAX_FTS_WRITER_LOCK_BYTES) {
    throw new PrimeContextError('STATE_ERROR', 'FTS index already has an active writer or unverifiable lock');
  }
  const handle = await open(absolutePath, 'r');
  try {
    const handleBefore = await handle.stat();
    if (!sameRegularFileSnapshot(pathBefore, handleBefore)) {
      throw new PrimeContextError('STATE_ERROR', 'FTS index already has an active writer or unverifiable lock');
    }
    const buffer = Buffer.alloc(Math.min(MAX_FTS_WRITER_LOCK_BYTES + 1, handleBefore.size + 1));
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const handleAfter = await handle.stat();
    const pathAfter = await lstat(absolutePath);
    await assertNoSymbolicLinkComponents(root, relativePath);
    if (!sameRegularFileSnapshot(handleBefore, handleAfter)
      || !sameRegularFileSnapshot(handleAfter, pathAfter)
      || offset !== handleAfter.size
      || offset > MAX_FTS_WRITER_LOCK_BYTES) {
      throw new PrimeContextError('STATE_ERROR', 'FTS index already has an active writer or unverifiable lock');
    }
    try {
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, offset));
    } catch {
      throw new PrimeContextError('STATE_ERROR', 'FTS index already has an active writer or malformed lock');
    }
  } finally {
    await handle.close();
  }
}

async function createFtsWriterLock(
  absolutePath: string,
  record: FtsWriterLockRecord,
): Promise<Awaited<ReturnType<typeof open>>> {
  const handle = await open(absolutePath, 'wx', 0o600);
  try {
    if (process.platform !== 'win32') await handle.chmod(0o600);
    await handle.writeFile(serializeFtsWriterLock(record), { encoding: 'utf8' });
    await handle.sync();
    return handle;
  } catch (error) {
    try { await handle.close(); } catch { /* preserve the lock population failure */ }
    throw error;
  }
}

async function acquireFtsWriterLock(
  root: string,
  relativePath: string,
  absolutePath: string,
  record: FtsWriterLockRecord,
): Promise<Awaited<ReturnType<typeof open>>> {
  try {
    return await createFtsWriterLock(absolutePath, record);
  } catch (error) {
    if (nodeErrorCode(error) !== 'EEXIST') throw error;
  }
  const existing = await readFtsWriterLock(root, relativePath, absolutePath);
  if (existing !== undefined) {
    const existingRecord = parseFtsWriterLock(existing);
    if (existingRecord.hostname !== record.hostname) {
      throw new PrimeContextError('STATE_ERROR', 'FTS writer lock owner cannot be verified on this host');
    }
    const liveness = ftsWriterProcessLiveness(existingRecord.pid);
    if (liveness === 'DEAD') {
      // Node has no portable atomic compare-and-remove primitive for lock files.
      // Reclaiming after a liveness check can move a newer writer's lock, so an
      // orphan remains blocking until an operator removes the verified path.
      throw new PrimeContextError(
        'STATE_ERROR',
        'FTS writer lock belongs to a dead process and requires manual removal',
      );
    }
    throw new PrimeContextError(
      'STATE_ERROR',
      liveness === 'ALIVE'
        ? 'FTS index already has an active writer'
        : 'FTS writer lock owner cannot be verified',
    );
  }
  try {
    return await createFtsWriterLock(absolutePath, record);
  } catch (error) {
    if (nodeErrorCode(error) === 'EEXIST') {
      throw new PrimeContextError('STATE_ERROR', 'FTS index already has an active writer');
    }
    throw error;
  }
}

async function releaseOwnedFtsWriterLock(
  root: string,
  relativePath: string,
  absolutePath: string,
  record: FtsWriterLockRecord,
): Promise<void> {
  try {
    const current = await readFtsWriterLock(root, relativePath, absolutePath);
    if (current === serializeFtsWriterLock(record)) await unlink(absolutePath);
  } catch { /* an unverifiable replacement remains blocking */ }
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
    options: SqliteFtsRebuildOptionsV03 = {},
  ): Promise<SqliteFtsRebuildResultV03> {
    if (typeof options !== 'object' || options === null || Array.isArray(options)
      || Object.keys(options).some((key) => !['signal', 'state_dir'].includes(key))) {
      throw new PrimeContextError('CONFIG_ERROR', 'Invalid SQLite/FTS rebuild options');
    }
    const assertWithinDeadline = cooperativeOperationCheck(createCooperativeDeadlineV03(
      this.monotonicNow,
      OPTIONAL_ADAPTER_DEADLINE_MS,
      'SQLite/FTS rebuild',
    ), options.signal, 'SQLite/FTS rebuild');
    assertWithinDeadline();
    const resolvedRoot = resolve(root);
    const stateDirectory = options.state_dir ?? DEFAULT_SQLITE_FTS_STATE_DIR_V03;
    validateIndexPath(relativeDbPath, stateDirectory);
    const pendingWriterKey = writerLockKey(assertPathInsideRoot(resolvedRoot, relativeDbPath));
    if (pendingWriters.has(pendingWriterKey) || activeWriters.has(pendingWriterKey)) {
      throw new PrimeContextError('STATE_ERROR', 'FTS index already has an active writer');
    }
    pendingWriters.add(pendingWriterKey);
    try {
      await assertPhysicalIndexPathSafe(resolvedRoot, relativeDbPath, stateDirectory, true);
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
    const writerLockRecord = createFtsWriterLockRecord();
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
      await ensureSafeIndexParent(resolvedRoot, stateDirectory, relativeDbPath);
      assertWithinDeadline();
      await assertNoSymbolicLinkComponents(resolvedRoot, lockRelative, { allowMissing: true });
      lockHandle = await acquireFtsWriterLock(
        resolvedRoot,
        lockRelative,
        lockAbsolute,
        writerLockRecord,
      );
      lockCreated = true;
      assertWithinDeadline();
      await assertNoSymbolicLinkComponents(resolvedRoot, relativeDbPath, { allowMissing: true });
      const handle = await open(temporaryAbsolute, 'wx', 0o600);
      try {
        if (process.platform !== 'win32') await handle.chmod(0o600);
      } finally {
        await handle.close();
      }
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
        ${ENTRIES_FTS_SCHEMA_DDL};
      `);
      assertWithinDeadline();
      let ftsSecureDelete = false;
      try {
        database.exec("INSERT INTO entries_fts(entries_fts, rank) VALUES('secure-delete', 1);");
        ftsSecureDelete = true;
      } catch { /* SQLite versions before FTS5 secure-delete remain supported. */ }
      const toolchain = inspectSqliteToolchain(database);

      const rows = sourceRows(sources, assertWithinDeadline);
      assertWithinDeadline();
      const indexDigest = canonicalIndexDigest(
        indexMetadata.repository_id,
        indexMetadata.worktree_digest,
        toolchain,
        rows,
      );
      assertWithinDeadline();
      const insertMetadata = database.prepare('INSERT INTO metadata(key, value) VALUES (?, ?)');
      const insertSource = database.prepare(`
        INSERT INTO sources(source_id, path, kind, authority, source_hash, title, content, size_bytes, start_line, end_line, symbol, source_truncated)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insertFts = database.prepare('INSERT INTO entries_fts(rowid, source_id, path, title, content) VALUES (?, ?, ?, ?, ?)');
      database.exec('BEGIN IMMEDIATE;');
      try {
        const metadataEntries: Array<readonly [string, string]> = [
          ['schema_version', '0.3'],
          ['repository_id', indexMetadata.repository_id],
          ['worktree_digest', indexMetadata.worktree_digest],
          ['index_digest', indexDigest],
          ['indexed_source_count', String(sources.length)],
          ['secure_delete', '1'],
          ['fts_secure_delete', ftsSecureDelete ? '1' : '0'],
          ['sqlite_version', toolchain.sqlite_version],
          ['fts5_available', '1'],
          ...(toolchain.fts5_source_id ? [['fts5_source_id', toolchain.fts5_source_id] as const] : []),
        ];
        for (const [key, value] of metadataEntries) insertMetadata.run(key, value);
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
      let finalStat = await lstat(absolute);
      if (!finalStat.isFile() || finalStat.isSymbolicLink()) {
        throw new PrimeContextError('SECURITY_ERROR', 'FTS index replacement is not a regular file');
      }
      if (process.platform !== 'win32') {
        const finalHandle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const handleStat = await finalHandle.stat();
          if (!sameRegularFileSnapshot(finalStat, handleStat)) {
            throw new PrimeContextError('SECURITY_ERROR', 'FTS index changed before permission hardening');
          }
          await finalHandle.chmod(0o600);
        } finally {
          await finalHandle.close();
        }
        await assertNoSymbolicLinkComponents(resolvedRoot, relativeDbPath);
        finalStat = await lstat(absolute);
        if (!finalStat.isFile() || finalStat.isSymbolicLink() || (finalStat.mode & 0o777) !== 0o600) {
          throw new PrimeContextError('SECURITY_ERROR', 'FTS index permissions could not be hardened');
        }
      }
      return {
        schema_version: '0.3',
        toolchain,
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
        await releaseOwnedFtsWriterLock(
          resolvedRoot,
          lockRelative,
          lockAbsolute,
          writerLockRecord,
        );
      }
        activeWriters.delete(lockKey);
      }
    } finally {
      pendingWriters.delete(pendingWriterKey);
    }
  }

  async search(
    root: string,
    relativeDbPath: string,
    query: string,
    options: SqliteFtsSearchOptionsV03,
  ): Promise<SqliteFtsSearchResultV03> {
    if (typeof options !== 'object' || options === null || Array.isArray(options)
      || Object.keys(options).some((key) => !['expected_worktree_digest', 'limit', 'signal', 'state_dir'].includes(key))) {
      throw new PrimeContextError('VALIDATION_ERROR', 'FTS search options are invalid');
    }
    const assertWithinDeadline = cooperativeOperationCheck(createCooperativeDeadlineV03(
      this.monotonicNow,
      OPTIONAL_ADAPTER_DEADLINE_MS,
      'SQLite/FTS search',
    ), options.signal, 'SQLite/FTS search');
    assertWithinDeadline();
    const terms = tokenizeQuery(query);
    validateHash(options.expected_worktree_digest, 'Expected FTS worktree digest');
    const limit = options.limit ?? 10;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_HITS) {
      throw new PrimeContextError('VALIDATION_ERROR', 'FTS search limit must be from 1 through 50');
    }
    const stateDirectory = options.state_dir ?? DEFAULT_SQLITE_FTS_STATE_DIR_V03;
    validateIndexPath(relativeDbPath, stateDirectory);
    const resolvedRoot = resolve(root);
    await assertPhysicalIndexPathSafe(resolvedRoot, relativeDbPath, stateDirectory, true);
    const Database = await loadDatabaseSync();
    const absolute = assertPathInsideRoot(resolvedRoot, relativeDbPath);
    await assertNoSymbolicLinkComponents(resolvedRoot, relativeDbPath);
    assertWithinDeadline();
    const stat = await lstat(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new PrimeContextError('IO_ERROR', 'FTS index is not a regular file');
    if (stat.size > MAX_INDEX_BYTES) throw new PrimeContextError('CATALOG_ERROR', 'FTS index exceeds its byte limit');

    let database: DatabaseSync | undefined;
    let readTransactionActive = false;
    try {
      database = openDatabase(Database, absolute, true);
      configureConnection(database, true);
      database.exec('BEGIN;');
      readTransactionActive = true;
      assertWithinDeadline();
      const runtimeToolchain = inspectSqliteToolchain(database);
      const version = database.prepare('PRAGMA user_version').get();
      if (!version || !Object.values(version).some((value) => value === DB_SCHEMA_VERSION)) {
        throw new PrimeContextError('CATALOG_ERROR', 'FTS index schema version is unsupported');
      }
      assertExpectedFtsSchema(database, assertWithinDeadline);
      const integrity = database.prepare('PRAGMA integrity_check').get();
      assertWithinDeadline();
      if (!integrity || !Object.values(integrity).some((value) => value === 'ok')) {
        throw new PrimeContextError('CATALOG_ERROR', 'FTS index integrity check failed');
      }
      const stored = metadata(database);
      const toolchain = storedSqliteToolchain(stored);
      if (!sameSqliteToolchain(toolchain, runtimeToolchain)) {
        throw new PrimeContextError('CATALOG_ERROR', 'FTS index toolchain identity is stale for this runtime');
      }
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
      const actualDigest = canonicalIndexDigest(
        stored.repository_id,
        stored.worktree_digest,
        toolchain,
        rows,
      );
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
      const result: SqliteFtsSearchResultV03 = {
        schema_version: '0.3',
        toolchain,
        hits,
        index_digest: stored.index_digest,
        worktree_digest: stored.worktree_digest,
        repository_id: stored.repository_id,
      };
      database.exec('COMMIT;');
      readTransactionActive = false;
      return result;
    } catch (error) {
      if (readTransactionActive) {
        try { database?.exec('ROLLBACK;'); } catch { /* preserve the original search failure */ }
        readTransactionActive = false;
      }
      if (error instanceof PrimeContextError) throw error;
      throw new PrimeContextError('CATALOG_ERROR', 'Unable to search the local FTS index', [
        error instanceof Error ? error.message : String(error),
      ]);
    } finally {
      try { database?.close(); } catch { /* preserve original result */ }
    }
  }
}
