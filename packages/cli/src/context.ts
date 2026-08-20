import { basename, isAbsolute, resolve } from 'node:path';
import {
  assertValidLocalCodeGraphV03,
  isSensitiveDocumentContent,
  isSensitivePath,
  NodeCodeGraphAdapter,
  NodeDocumentSourceAdapter,
  NodeFileSystemAdapter,
  NodeGitAdapter,
  NodeSqliteFtsAdapter,
  readSafeRepositoryText,
  type CollectedDocumentSource,
  type DocumentSourceCollectionResult,
  type HybridIndexSourceV03,
  type LocalCodeGraphV03,
  type RepositoryWalkResult,
  type SqliteFtsToolchainV03,
  type SqliteFtsHitV03,
} from '@primecontext/adapters';
import {
  ablateContext,
  assertValidOutcomeReceipt,
  assertValidTaskContextPackage,
  compareContextReplay,
  compileContext,
  createContextCandidateId,
  expandContext,
  hashContextJson,
  hashContextText,
  PrimeContextError,
  recordContextOutcome,
  type ContextCandidateV03,
  type ContextEnvelopeV03,
  type ContextOutcomeInputV03,
  type ContextPlanRequestV03,
  type ContextSourceFailureV03,
  type ExpansionDecisionV03,
  type ExpansionRequestV03,
  type GitState,
  type OutcomeReceiptV03,
  type SemanticRepoMap,
  type SelectionReceiptV03,
  type TaskCapsule,
  type TaskContextPackageV03,
} from '@primecontext/core';
import { generateRepoMapFromObservation } from '@primecontext/repo-map';
import {
  isValidTaskId,
  type ContextSnapshotV03,
  type ContextTruncationReasonV03,
  validateContextPlanRequest,
  validateExpansionDecision,
  validateExpansionRequest,
  validateTaskCapsule,
} from '@primecontext/schemas';
import { loadConfig, type PrimeContextConfig } from './config.js';
import {
  assertStateDirectoryIgnored,
  captureInternalFileRollback,
  discardInternalFileRollback,
  MAX_JSON_VALUE_HARD_LIMIT,
  parseBoundedJson,
  readInternalText,
  readCommandJsonInput,
  repositoryRelativePath,
  restoreInternalFileRollback,
  withInternalExclusiveLock,
  writeInternalTextAtomic,
} from './safe-io.js';

const CONTEXT_INDEX_FILE = 'context/index.sqlite';
const CONTEXT_INDEX_MANIFEST = 'context/index-manifest.json';
const MAX_CONTEXT_ARTIFACT_BYTES = 8 * 1024 * 1024;
const MAX_CONTEXT_INDEX_BYTES = 512 * 1024 * 1024;
const MAX_CONTEXT_VALUES = MAX_JSON_VALUE_HARD_LIMIT;
const MAX_OUTCOMES = 1_024;
const MAX_GRAPH_CANDIDATES = 1_024;
const MAX_DOCUMENT_CANDIDATES = 1_024;
const MAX_FTS_CANDIDATES = 50;
const MAX_AGGREGATE_CANDIDATES = 2_048;
const MAX_FILESYSTEM_CANDIDATES = 16_384;
const MAX_FILESYSTEM_RETURNED_CANDIDATES = 1_024;
const MAX_FILESYSTEM_SOURCE_BYTES = 1024 * 1024;
const MAX_FILESYSTEM_TOTAL_BYTES = 256 * 1024 * 1024;
const OPTIONAL_ADAPTER_TIMEOUT_MS = 30_000;
const MAX_EXCERPT_LINES = 400;
const CONTEXT_INDEX_SCHEMA_IDENTITY = 'primecontext-context-index-v0.3-consolidated-1';
const CONTEXT_INDEX_POLICY_IDENTITY = 'primecontext-accepted-source-policy-v0.3-consolidated-1';
const FILESYSTEM_EXTENSIONS = new Set([
  '.c', '.cc', '.cjs', '.cpp', '.cs', '.css', '.cts', '.go', '.h', '.hpp', '.html', '.java', '.js', '.jsx',
  '.kt', '.kts', '.php', '.ps1', '.py', '.rb', '.rs', '.sh', '.sql', '.swift', '.toml', '.tsx',
  '.md', '.mdx', '.mjs', '.mts', '.ts', '.vue', '.xml', '.yaml', '.yml',
]);
const SCREENED_JSON_BASENAMES = new Set([
  'package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'composer.json', 'composer.lock',
  'deno.json', 'deno.jsonc', 'jsconfig.json', 'tsconfig.json', '.eslintrc.json', '.stylelintrc.json',
]);
const SCREENED_LOCK_BASENAMES = new Set([
  'bun.lock', 'bun.lockb', 'cargo.lock', 'gemfile.lock', 'pipfile.lock', 'poetry.lock',
  'pnpm-lock.yaml', 'uv.lock', 'yarn.lock',
]);
const SCREENED_EXTENSIONLESS_BASENAMES = new Set([
  'dockerfile', 'gnumakefile', 'makefile', 'procfile', 'gemfile', 'rakefile', 'justfile',
]);
const SECURITY_RELEVANT_TERMS = new Set([
  '2fa', 'advisories', 'advisory', 'apikey', 'apikeys', 'attack', 'attacks', 'audit', 'audits',
  'auth', 'authentication', 'authorization', 'credential', 'credentials', 'crypto', 'cryptographic',
  'cors', 'csrf', 'cve', 'ddos', 'deserialization', 'deserialize', 'deserialized', 'exploit', 'exploited', 'exploits',
  'harden', 'hardened', 'hardening', 'hardens', 'idor', 'jwks', 'jws', 'jwt', 'mfa',
  'mitigate', 'mitigated', 'mitigates', 'mitigating', 'mitigation',
  'permission', 'permissions', 'privilege', 'privileged', 'privileges',
  'decrypt', 'decrypted', 'decryption', 'encrypt', 'encrypted', 'encryption', 'login', 'oauth', 'oauth2',
  'passphrase', 'password', 'passwords', 'privacy', 'secret', 'secrets', 'security', 'sensitive', 'signin',
  'rbac', 'rce', 'redirect', 'redirected', 'redirection', 'redirects', 'sandbox', 'sandboxed', 'sandboxing',
  'secure', 'secured', 'secures', 'securing', 'sqli', 'ssl', 'ssrf', 'threat', 'threats', 'tls',
  'token', 'tokens', 'upload', 'uploaded', 'uploads', 'vulnerability', 'vulnerabilities', 'vulnerable',
  'webhook', 'webhooks', 'xss', 'xsrf', 'xxe',
]);
const DENIAL_OF_SERVICE_ACRONYM = /\b(?:DDoS|DoS|DOS)\b/u;
const INJECTION_OR_EXECUTION_TERMS = new Set(['execution', 'injection']);
const COMMAND_OR_CODE_TERMS = new Set(['code', 'command', 'commands']);
const INJECTION_CONTEXT_TERMS = new Set([
  'html', 'javascript', 'ldap', 'nosql', 'query', 'script', 'shell', 'sql', 'template', 'xpath', 'xml',
]);
const KEY_TERMS = new Set(['key', 'keys']);
const KEY_SECURITY_CONTEXT_TERMS = new Set([
  'api', 'credential', 'credentials', 'crypto', 'cryptographic', 'decrypt', 'decryption', 'encrypt',
  'encryption', 'jwt', 'oauth', 'private', 'public', 'rotate', 'rotated', 'rotation', 'secret', 'secrets',
  'sign', 'signed', 'signing',
]);
const SIGNATURE_TERMS = new Set(['signature', 'signatures', 'signed', 'signing']);
const SIGNATURE_SECURITY_CONTEXT_TERMS = new Set([
  'crypto', 'cryptographic', 'jwt', 'jwks', 'jws', 'key', 'keys', 'request', 'requests',
  'token', 'tokens', 'validate', 'validated', 'validation', 'verification', 'verified', 'verify',
  'webhook', 'webhooks',
]);
const TRAVERSAL_TERMS = new Set(['traversal', 'traverse']);
const TRAVERSAL_SECURITY_CONTEXT_TERMS = new Set([
  'directories', 'directory', 'file', 'files', 'filesystem', 'path', 'paths',
]);
const DEPENDENCY_CONTEXT_TERMS = new Set([
  'dependencies', 'dependency', 'lockfile', 'lockfiles', 'npm', 'package', 'packages', 'pnpm', 'yarn',
]);
const DEPENDENCY_SECURITY_TERMS = new Set([
  'advisories', 'advisory', 'audit', 'audits', 'cve', 'cvss', 'malware', 'supplychain',
]);
const activeLedgerWriters = new Set<string>();

async function loadProtectedContextConfig(root: string): Promise<PrimeContextConfig> {
  const config = await loadConfig(root);
  await assertStateDirectoryIgnored(root, config.state_dir);
  return config;
}

interface ContextIndexManifestV03 {
  schema_version: '0.3';
  repository_id: string;
  worktree_digest: string;
  accepted_source_digest: string;
  schema_identity: string;
  policy_identity: string;
  toolchain_identity: string;
  index_digest: string;
  index_path: string;
  indexed_source_count: number;
  document_source_count: number;
  code_file_count: number;
  code_symbol_count: number;
  graph_digest: string;
  graph_summary?: LocalCodeGraphV03['summary'];
  secure_delete: boolean;
  fts_secure_delete: boolean;
  provenance: ContextToolchainProvenanceV03;
  source_failures: ContextSourceFailureV03[];
  manifest_digest: string;
}

interface StoredContextPlanV03 {
  schema_version: '0.3';
  request: ContextPlanRequestV03;
  envelope: ContextEnvelopeV03;
  receipt: SelectionReceiptV03;
  base_selection_digest: string;
  expansion_ledger_digest: string;
}

interface StoredExpansionV03 {
  schema_version: '0.3';
  request: ExpansionRequestV03;
  decision: ExpansionDecisionV03;
  record_digest: string;
}

interface StoredOutcomeRecordV03 {
  schema_version: '0.3';
  sequence: number;
  previous_record_digest?: string;
  receipt: OutcomeReceiptV03;
  record_digest: string;
}

export interface CollectedContextSources {
  repository_id: string;
  snapshot: ContextSnapshotV03;
  documents: DocumentSourceCollectionResult;
  graph: LocalCodeGraphV03 | undefined;
  repo_map: SemanticRepoMap;
  git: GitState | undefined;
  source_failures: ContextSourceFailureV03[];
  filesystem_sources: HybridIndexSourceV03[];
  filesystem_collection_truncated: boolean;
  hybrid_sources: HybridIndexSourceV03[];
}

interface ScreenedFilesystemOmissionsV03 {
  paths: ReadonlySet<string>;
}

const screenedFilesystemOmissions = new WeakMap<CollectedContextSources, ScreenedFilesystemOmissionsV03>();
const contextPreparationObservationBindings = new WeakMap<ContextPreparationObservationV03, string>();

export interface ContextToolchainProvenanceV03 {
  primecontext: {
    context_version: '0.3';
    schema_identity: string;
    policy_identity: string;
  };
  node: { version: string };
  capabilities: { typescript_codegraph: boolean; sqlite_fts: boolean };
  typescript_codegraph?: { typescript_version: string };
  sqlite_fts?: SqliteFtsToolchainV03 & { secure_delete: boolean; fts_secure_delete: boolean };
}

export interface ContextPreparationObservationV03 {
  resolved_root: string;
  config: PrimeContextConfig;
  live: CollectedContextSources;
}

export interface ContextIndexCommandResult {
  repository_id: string;
  head?: string;
  index_path: string;
  index_digest: string;
  worktree_digest: string;
  accepted_source_digest: string;
  indexed_source_count: number;
  document_source_count: number;
  code_file_count: number;
  code_symbol_count: number;
  secure_delete: boolean;
  fts_secure_delete: boolean;
  manifest_digest: string;
  fallback_used: boolean;
  reused: boolean;
  provenance: ContextToolchainProvenanceV03;
  source_failures: ContextSourceFailureV03[];
}

export interface ContextPlanCommandResult {
  task_id: string;
  evidence_status: ContextEnvelopeV03['evidence_status'];
  budget_status: ContextEnvelopeV03['budget_status'];
  selection_digest: string;
  receipt_digest: string;
  selected_count: number;
  plan_path: string;
}

export interface PreparedContextResultV03 {
  request: ContextPlanRequestV03;
  envelope: ContextEnvelopeV03;
  receipt: SelectionReceiptV03;
  plan_path: string;
}

function ordinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function allNormalizedTerms(value: string): string[] {
  return value.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function normalizeTerms(value: string): string[] {
  return [...new Set(allNormalizedTerms(value))]
    .filter(Boolean)
    .sort(ordinal)
    .slice(0, 64);
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)].sort(ordinal);
}

function discoveryTruncation(
  reasons: readonly ContextTruncationReasonV03[],
): Pick<ContextCandidateV03['discovery'], 'truncated' | 'truncation_reasons'> {
  const uniqueReasons = [...new Set(reasons)].sort(ordinal);
  return uniqueReasons.length > 0
    ? { truncated: true, truncation_reasons: uniqueReasons }
    : { truncated: false };
}

function excerptWasBounded(value: string, maximumBytes = 32 * 1024): boolean {
  const clean = value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, ' ')
    .trim();
  if (!clean) return false;
  const lines = clean.split(/\r?\n/u);
  if (lines.length > MAX_EXCERPT_LINES) return true;
  return new TextEncoder().encode(clean).byteLength > maximumBytes;
}

function boundedExcerpt(value: string, maximumBytes = 32 * 1024): string {
  const clean = value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, ' ')
    .trim();
  if (!clean) return '(empty source excerpt)';
  const lineBounded = clean.split(/\r?\n/u).slice(0, MAX_EXCERPT_LINES).join('\n');
  const encoder = new TextEncoder();
  if (encoder.encode(lineBounded).byteLength <= maximumBytes) return lineBounded;
  const characters = [...lineBounded];
  let low = 1;
  let high = characters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (encoder.encode(characters.slice(0, middle).join('')).byteLength <= maximumBytes) low = middle;
    else high = middle - 1;
  }
  return characters.slice(0, low).join('').trimEnd();
}

async function withOptionalAdapterTimeout<T>(
  label: string,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  const operationPromise = operation(controller.signal);
  try {
    const timedOut = Symbol('timed-out');
    const result = await Promise.race([
      operationPromise,
      new Promise<typeof timedOut>((resolveTimeout) => {
        timeout = setTimeout(() => {
          controller.abort();
          resolveTimeout(timedOut);
        }, OPTIONAL_ADAPTER_TIMEOUT_MS);
        timeout.unref?.();
      }),
    ]);
    if (result !== timedOut) return result;
    try { await operationPromise; } catch { /* cooperative cancellation is expected */ }
    throw new PrimeContextError('CAPABILITY_ERROR', `${label} exceeded the 30 second optional-adapter timeout`);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function boundedRelevantExcerpt(
  value: string,
  terms: readonly string[],
  maximumBytes = 32 * 1024,
): string {
  const normalizedTerms = terms.flatMap(normalizeTerms);
  const valueLines = value.split(/\r?\n/u);
  if (normalizedTerms.length === 0) {
    return boundedExcerpt(value, maximumBytes);
  }
  let anchorLine = -1;
  let normalizedAnchorColumn = -1;
  for (let lineIndex = 0; lineIndex < valueLines.length; lineIndex += 1) {
    const normalizedLine = (valueLines[lineIndex] as string).normalize('NFKC').toLowerCase();
    for (const term of normalizedTerms) {
      const column = normalizedLine.indexOf(term);
      if (column >= 0) {
        anchorLine = lineIndex;
        normalizedAnchorColumn = column;
        break;
      }
    }
    if (anchorLine >= 0) break;
  }
  if (anchorLine < 0) return boundedExcerpt(value, maximumBytes);
  if (valueLines.length > MAX_EXCERPT_LINES) {
    const startLine = Math.max(0, anchorLine - Math.floor(MAX_EXCERPT_LINES / 3));
    return boundedExcerpt(valueLines.slice(startLine, startLine + MAX_EXCERPT_LINES).join('\n'), maximumBytes);
  }
  if (new TextEncoder().encode(value).byteLength <= maximumBytes) return boundedExcerpt(value, maximumBytes);
  const normalizedValue = value.normalize('NFKC');
  const characters = [...normalizedValue];
  const normalizedPrefix = valueLines.slice(0, anchorLine).join('\n').normalize('NFKC');
  const prefixCharacters = [...normalizedPrefix].length
    + (anchorLine > 0 ? 1 : 0)
    + Math.max(0, normalizedAnchorColumn);
  const windowSize = Math.min(characters.length, Math.max(1, Math.floor(maximumBytes / 2)));
  const start = Math.max(0, prefixCharacters - Math.floor(windowSize / 3));
  return boundedExcerpt(characters.slice(start, start + windowSize).join(''), maximumBytes);
}

function stateRelativePath(root: string, config: PrimeContextConfig, suffix: string): string {
  const state = repositoryRelativePath(root, config.state_dir, 'state_dir');
  return `${state}/${suffix}`;
}

function indexRelativePath(root: string, config: PrimeContextConfig): string {
  return stateRelativePath(root, config, CONTEXT_INDEX_FILE);
}

function manifestRelativePath(root: string, config: PrimeContextConfig): string {
  return stateRelativePath(root, config, CONTEXT_INDEX_MANIFEST);
}

function contextIndexPolicyIdentity(config: PrimeContextConfig): string {
  return hashContextJson({
    policy: CONTEXT_INDEX_POLICY_IDENTITY,
    state_dir: normalizedRepositoryPath(config.state_dir),
    exclude: [...config.exclude].sort(ordinal),
  });
}

function contextIndexToolchainIdentity(
  live: CollectedContextSources,
  sqliteToolchain: SqliteFtsToolchainV03 | undefined,
): string {
  return hashContextJson({
    node: process.versions.node,
    sqlite_fts: sqliteToolchain ?? 'unavailable',
    typescript: live.graph?.toolchain.typescript_version ?? 'unavailable',
    sqlite_schema: 3,
    codegraph: 'typescript-ast-v0.3',
  });
}

function contextToolchainProvenance(
  config: PrimeContextConfig,
  live: CollectedContextSources,
  sqlite: {
    toolchain?: SqliteFtsToolchainV03;
    secure_delete: boolean;
    fts_secure_delete: boolean;
  },
): ContextToolchainProvenanceV03 {
  return {
    primecontext: {
      context_version: '0.3',
      schema_identity: CONTEXT_INDEX_SCHEMA_IDENTITY,
      policy_identity: contextIndexPolicyIdentity(config),
    },
    node: { version: process.versions.node },
    capabilities: {
      typescript_codegraph: live.graph !== undefined,
      sqlite_fts: sqlite.toolchain !== undefined,
    },
    ...(live.graph ? {
      typescript_codegraph: {
        typescript_version: live.graph.toolchain.typescript_version,
      },
    } : {}),
    ...(sqlite.toolchain ? {
      sqlite_fts: {
        ...sqlite.toolchain,
        secure_delete: sqlite.secure_delete,
        fts_secure_delete: sqlite.fts_secure_delete,
      },
    } : {}),
  };
}

function assertTaskId(taskId: string): void {
  if (!isValidTaskId(taskId)
      || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(taskId)
      || /[. ]$/.test(taskId)) {
    throw new PrimeContextError('VALIDATION_ERROR', 'Context task id uses an unsafe or unsupported format');
  }
}

function planRelativePath(root: string, config: PrimeContextConfig, taskId: string): string {
  assertTaskId(taskId);
  return stateRelativePath(root, config, `context/plans/${taskId}/package.json`);
}

function outcomeRelativePath(root: string, config: PrimeContextConfig, taskId: string): string {
  assertTaskId(taskId);
  return stateRelativePath(root, config, `context/outcomes/${taskId}.jsonl`);
}

function expansionRelativePath(root: string, config: PrimeContextConfig, taskId: string): string {
  assertTaskId(taskId);
  return stateRelativePath(root, config, `context/plans/${taskId}/expansions.jsonl`);
}

function experimentRelativePath(
  root: string,
  config: PrimeContextConfig,
  taskId: string,
  name: string,
): string {
  assertTaskId(taskId);
  if (!/^[a-z0-9-]{1,160}$/i.test(name)) throw new PrimeContextError('VALIDATION_ERROR', 'Experiment name is unsafe');
  return stateRelativePath(root, config, `context/experiments/${taskId}/${name}.json`);
}

function assertRepositoryInputPath(path: string): void {
  if (isAbsolute(path)) throw new PrimeContextError('VALIDATION_ERROR', 'Context input path must be repository-relative');
}

function documentHybridSource(source: CollectedDocumentSource): HybridIndexSourceV03 {
  return {
    path: source.relative_path,
    kind: 'document',
    authority: source.metadata.authority,
    source_hash: source.source_hash,
    content: source.content,
    title: source.metadata.title,
  };
}

function filesystemKind(path: string): HybridIndexSourceV03['kind'] {
  if (/(?:^|\/)agents\.md$/i.test(path)
      || /^(?:security|code_of_conduct)\.md$/i.test(path)) return 'document';
  if (/(?:^|\/)(?:test|tests|__tests__)(?:\/|$)|\.(?:test|spec)\.[^./]+$/i.test(path)) return 'test';
  if (/(?:^|\/)(?:config|configuration)(?:\/|$)|\.(?:json|toml|ya?ml)$/i.test(path)) return 'configuration';
  return 'code';
}

function filesystemAuthority(
  path: string,
  kind: HybridIndexSourceV03['kind'],
): HybridIndexSourceV03['authority'] {
  if (/(?:^|\/)agents\.md$/i.test(path)
      || /^(?:security|code_of_conduct)\.md$/i.test(path)) return 'policy';
  if (kind === 'test') return 'test';
  if (kind === 'configuration') return 'configuration';
  return 'source_code';
}

function isFilesystemPolicyPath(path: string): boolean {
  return filesystemAuthority(path, filesystemKind(path)) === 'policy';
}

function recordOmittedFilesystemPolicies(
  omittedPaths: Set<string>,
  candidates: readonly { relative_path: string }[],
  startIndex: number,
): void {
  for (let index = startIndex; index < candidates.length; index += 1) {
    const path = candidates[index]?.relative_path;
    if (path !== undefined && isFilesystemPolicyPath(path)) {
      omittedPaths.add(normalizedRepositoryPath(path));
    }
  }
}

function isAcceptedFilesystemCorpusPath(path: string): boolean {
  const normalized = path.replaceAll('\\', '/');
  const name = normalized.slice(normalized.lastIndexOf('/') + 1);
  const lowerName = name.toLowerCase();
  const lastDot = normalized.lastIndexOf('.');
  const extension = lastDot > normalized.lastIndexOf('/') ? normalized.slice(lastDot).toLowerCase() : '';
  if (FILESYSTEM_EXTENSIONS.has(extension)) return true;
  if (SCREENED_JSON_BASENAMES.has(lowerName)
      || SCREENED_LOCK_BASENAMES.has(lowerName)
      || SCREENED_EXTENSIONLESS_BASENAMES.has(lowerName)) return true;
  if (/^(?:ts|js)config(?:\.[a-z0-9_-]+)*\.json$/i.test(name)) return true;
  if (/^(?:dockerfile|containerfile)(?:\.[a-z0-9_-]+)?$/i.test(name)) return true;
  if (/^(?:eslint|prettier|stylelint)\.config\.[cm]?[jt]s$/i.test(name)) return true;
  return /^(?:go\.(?:mod|sum)|requirements(?:-[a-z0-9_-]+)?\.txt|pom\.xml|build\.gradle(?:\.kts)?)$/i.test(name);
}

async function collectFilesystemFallbackSources(
  root: string,
  walk: RepositoryWalkResult,
  documents: DocumentSourceCollectionResult,
): Promise<{
  sources: HybridIndexSourceV03[];
  truncated: boolean;
  screened_omitted_paths: ReadonlySet<string>;
}> {
  const documentPaths = new Set(documents.sources.map((source) => source.relative_path));
  const candidates = walk.paths.filter((entry) => (
    entry.kind === 'file'
    && isAcceptedFilesystemCorpusPath(entry.relative_path)
    && !documentPaths.has(entry.relative_path)
  )).sort((left, right) => ordinal(left.relative_path, right.relative_path));
  const sources: HybridIndexSourceV03[] = [];
  const screenedOmittedPaths = new Set<string>();
  let acceptedBytes = 0;
  let truncated = walk.truncated;
  for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
    const candidate = candidates[candidateIndex] as (typeof candidates)[number];
    if (sources.length >= MAX_FILESYSTEM_CANDIDATES) {
      truncated = true;
      recordOmittedFilesystemPolicies(screenedOmittedPaths, candidates, candidateIndex);
      break;
    }
    if ((candidate.size_bytes ?? 0) > MAX_FILESYSTEM_SOURCE_BYTES) {
      truncated = true;
      if (isFilesystemPolicyPath(candidate.relative_path)) {
        screenedOmittedPaths.add(normalizedRepositoryPath(candidate.relative_path));
      }
      continue;
    }
    const source = await readSafeRepositoryText(root, candidate.relative_path, MAX_FILESYSTEM_SOURCE_BYTES);
    if (!source) {
      screenedOmittedPaths.add(normalizedRepositoryPath(candidate.relative_path));
      continue;
    }
    const nextAcceptedBytes = acceptedBytes + source.size_bytes;
    if (!Number.isSafeInteger(nextAcceptedBytes) || nextAcceptedBytes > MAX_FILESYSTEM_TOTAL_BYTES) {
      truncated = true;
      recordOmittedFilesystemPolicies(screenedOmittedPaths, candidates, candidateIndex);
      break;
    }
    acceptedBytes = nextAcceptedBytes;
    const kind = filesystemKind(candidate.relative_path);
    sources.push({
      path: candidate.relative_path, kind,
      authority: filesystemAuthority(candidate.relative_path, kind),
      source_hash: source.source_hash, content: source.content, title: basename(candidate.relative_path),
    });
  }
  return { sources, truncated, screened_omitted_paths: screenedOmittedPaths };
}

function contextWorktreeDigest(
  documents: DocumentSourceCollectionResult,
  _graph: LocalCodeGraphV03 | undefined,
  repoMap: SemanticRepoMap,
  filesystemSources: HybridIndexSourceV03[],
): string {
  return hashContextJson({
    accepted_sources: [
      ...documents.sources.map((source) => ({
      path: source.relative_path,
      source_hash: source.source_hash,
      size_bytes: source.size_bytes,
      kind: 'document',
    })),
      ...filesystemSources.map((source) => ({
        path: source.path, source_hash: source.source_hash, kind: source.kind,
        size_bytes: new TextEncoder().encode(source.content).byteLength,
      })),
    ].sort((left, right) => ordinal(left.path, right.path)),
    document_summary: {
      candidate_document_count: documents.candidate_document_count,
      omitted_document_count: documents.omitted_document_count,
    },
    repository_modules: repoMap.modules.map((module) => ({
      id: module.id, path: module.path, kind: module.kind,
      role: module.role, evidence: [...module.evidence].sort(ordinal),
    })).sort((left, right) => ordinal(left.path, right.path) || ordinal(left.id, right.id)),
  });
}

async function collectContextSources(
  root: string,
  config: PrimeContextConfig,
): Promise<CollectedContextSources> {
  const excludes = [...new Set([...config.exclude, config.state_dir])];
  const fileSystem = new NodeFileSystemAdapter(excludes);
  const gitAdapter = new NodeGitAdapter();
  const [walk, git] = await Promise.all([
    fileSystem.walk(root, { capacityLimitBehavior: 'truncate' }),
    gitAdapter.inspect(root),
  ]);
  const documents = await new NodeDocumentSourceAdapter(excludes).collect(root, {
    capacityLimitBehavior: 'truncate',
    acceptedRepositoryWalk: walk,
  });
  const sourceFailures: ContextSourceFailureV03[] = [];
  const repoMap = await generateRepoMapFromObservation(root, fileSystem, {
    walk,
    ...(git ? { git } : {}),
  });
  const filesystemCollection = await collectFilesystemFallbackSources(root, walk, documents);
  const filesystemSources = filesystemCollection.sources;
  if (filesystemCollection.truncated) {
    sourceFailures.push({
      provider: 'filesystem',
      code: 'SOURCE_COLLECTION_TRUNCATED',
      message: 'Safe filesystem collection reached a bounded source or byte ceiling',
      security_control: false,
    });
  }
  if (documents.skipped_oversize_count > 0 || documents.discovery_truncated === true) {
    sourceFailures.push({
      provider: 'documents',
      code: 'SOURCE_COLLECTION_TRUNCATED',
      message: 'Document collection omitted sources at a bounded discovery ceiling',
      security_control: false,
    });
  }
  const rootName = basename(resolve(root)).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
    || 'repository';
  const rootIdentity = resolve(root).replaceAll('\\', '/').normalize('NFKC').toLowerCase();
  const repositoryId = `${rootName.slice(0, 80)}-${hashContextText(rootIdentity).slice(7, 23)}`;
  let graph: LocalCodeGraphV03 | undefined;
  const worktreeDigest = contextWorktreeDigest(documents, graph, repoMap, filesystemSources);
  const snapshot: ContextSnapshotV03 = {
    repository_id: repositoryId,
    ...(git?.head ? { head: git.head } : {}),
    worktree_digest: worktreeDigest,
  };
  try {
    const acceptedCodeSources = filesystemSources
      .filter((source) => /\.(?:[cm]?[jt]sx?)$/i.test(source.path))
      .map((source) => ({ path: source.path, source_hash: source.source_hash }));
    graph = await withOptionalAdapterTimeout(
      'TypeScript CodeGraph',
      (signal) => new NodeCodeGraphAdapter(excludes).collect(root, {
        snapshot,
        accepted_sources: acceptedCodeSources,
      }, { signal }),
    );
  } catch (error) {
    if (error instanceof PrimeContextError && error.code === 'SECURITY_ERROR') throw error;
    sourceFailures.push({
      provider: 'codegraph', code: 'OPTIONAL_SOURCE_UNAVAILABLE',
      message: error instanceof PrimeContextError ? error.code : 'local CodeGraph source unavailable',
      security_control: false,
    });
  }
  const collected: CollectedContextSources = {
    repository_id: repositoryId,
    snapshot,
    documents,
    graph,
    repo_map: repoMap,
    git,
    source_failures: sourceFailures,
    filesystem_sources: filesystemSources,
    filesystem_collection_truncated: filesystemCollection.truncated,
    hybrid_sources: [
      ...documents.sources.map(documentHybridSource),
      ...filesystemSources,
    ].sort((left, right) => ordinal(left.path, right.path)),
  };
  screenedFilesystemOmissions.set(collected, {
    paths: new Set(filesystemCollection.screened_omitted_paths),
  });
  return collected;
}

function acceptedSourceFreshnessIdentity(live: CollectedContextSources): unknown {
  const screenedOmittedPaths = [...(screenedFilesystemOmissions.get(live)?.paths ?? [])]
    .map(normalizedRepositoryPath)
    .sort(ordinal);
  return {
    repository_id: live.repository_id,
    snapshot: structuredClone(live.snapshot),
    accepted_sources: live.hybrid_sources.map((source) => ({
      path: normalizedRepositoryPath(source.path),
      kind: source.kind,
      authority: source.authority,
      source_hash: source.source_hash,
      ...(source.title !== undefined ? { title: source.title } : {}),
      ...(source.locator !== undefined ? { locator: structuredClone(source.locator) } : {}),
      ...(source.source_truncated !== undefined ? { source_truncated: source.source_truncated } : {}),
    })).sort((left, right) => ordinal(left.path, right.path) || ordinal(left.source_hash, right.source_hash)),
    collection: {
      filesystem_truncated: live.filesystem_collection_truncated,
      document_candidate_count: live.documents.candidate_document_count,
      document_omitted_count: live.documents.omitted_document_count,
      document_skipped_oversize_count: live.documents.skipped_oversize_count,
      document_skipped_binary_count: live.documents.skipped_binary_count,
      document_skipped_sensitive_content_count: live.documents.skipped_sensitive_content_count,
      document_capacity_omitted_count: live.documents.capacity_omitted_document_count ?? 0,
      document_discovery_truncated: live.documents.discovery_truncated ?? false,
      document_discovery_truncation_reasons: [
        ...(live.documents.discovery_truncation_reasons ?? []),
      ].sort(ordinal),
      blocked_policy_count: live.documents.blocked_policy_count ?? 0,
      blocked_policy_kinds: structuredClone(live.documents.blocked_policy_kinds ?? {
        operational: 0,
        security: 0,
        governance: 0,
      }),
      screened_omitted_paths: screenedOmittedPaths,
    },
  };
}

function hybridSourceObservationDigest(source: HybridIndexSourceV03): string {
  return hashContextJson({
    path: source.path,
    kind: source.kind,
    authority: source.authority,
    source_hash: source.source_hash,
    content_hash: hashContextText(source.content),
    ...(source.title !== undefined ? { title: source.title } : {}),
    ...(source.locator !== undefined ? { locator: source.locator } : {}),
    ...(source.source_truncated !== undefined ? { source_truncated: source.source_truncated } : {}),
  });
}

function documentSourceObservationDigest(source: CollectedDocumentSource): string {
  return hashContextJson({
    relative_path: source.relative_path,
    size_bytes: source.size_bytes,
    source_hash: source.source_hash,
    content_hash: hashContextText(source.content),
    authority_basis: source.authority_basis,
    metadata: source.metadata,
  });
}

function contextPreparationObservationIdentity(observation: ContextPreparationObservationV03): string {
  const { sources: _documentSources, ...documentCollection } = observation.live.documents;
  const graph = observation.live.graph;
  if (graph !== undefined) assertValidLocalCodeGraphV03(graph);
  return hashContextJson({
    resolved_root: observation.resolved_root,
    config_digest: hashContextJson(observation.config),
    repository_id: observation.live.repository_id,
    snapshot_digest: hashContextJson(observation.live.snapshot),
    document_collection_digest: hashContextJson(documentCollection),
    document_source_digests: observation.live.documents.sources.map(documentSourceObservationDigest),
    graph_digest: graph?.graph_digest ?? null,
    repo_map_digest: hashContextJson(observation.live.repo_map),
    git_digest: observation.live.git === undefined ? null : hashContextJson(observation.live.git),
    source_failures_digest: hashContextJson(observation.live.source_failures),
    filesystem_source_digests: observation.live.filesystem_sources.map(hybridSourceObservationDigest),
    filesystem_collection_truncated: observation.live.filesystem_collection_truncated,
    hybrid_source_digests: observation.live.hybrid_sources.map(hybridSourceObservationDigest),
    screened_omitted_paths: [...(screenedFilesystemOmissions.get(observation.live)?.paths ?? [])]
      .sort(ordinal),
  });
}

async function matchingProtectedContextConfig(
  root: string,
  expected: PrimeContextConfig,
): Promise<PrimeContextConfig> {
  const current = await loadProtectedContextConfig(root);
  if (hashContextJson(current) !== hashContextJson(expected)) {
    throw new PrimeContextError('FRESHNESS_ERROR', 'Context observation configuration changed after discovery');
  }
  return current;
}

async function assertAcceptedSourceManifestFresh(
  root: string,
  expectedConfig: PrimeContextConfig,
  expectedLive: CollectedContextSources,
): Promise<void> {
  const currentConfig = await matchingProtectedContextConfig(root, expectedConfig);
  // This is a freshness-verification pass only. Selection must continue using expectedLive.
  const verification = await collectContextSources(root, currentConfig);
  if (hashContextJson(acceptedSourceFreshnessIdentity(verification))
      !== hashContextJson(acceptedSourceFreshnessIdentity(expectedLive))) {
    throw new PrimeContextError('FRESHNESS_ERROR', 'Accepted source manifest changed after discovery');
  }
}

function repoMapCandidate(
  repoMap: SemanticRepoMap,
  request: ContextPlanRequestV03,
): ContextCandidateV03 {
  const content = JSON.stringify({
    repository: repoMap.repository.name,
    modules: repoMap.modules.map((module) => ({
      id: module.id, path: module.path, kind: module.kind,
      role: module.role, evidence: [...module.evidence].sort(ordinal),
    })).sort((left, right) => ordinal(left.path, right.path) || ordinal(left.id, right.id)),
  });
  if (isSensitiveDocumentContent(content)) {
    throw new PrimeContextError('SECURITY_ERROR', 'Sensitive repository-map content cannot enter a context envelope');
  }
  const excerpt = boundedExcerpt(content);
  const bytes = new TextEncoder().encode(excerpt).byteLength;
  return finishCandidate({
    schema_version: '0.3', kind: 'repository_map', provider: 'repo_map', path: 'repository-map',
    source_hash: hashContextText(content), excerpt_hash: hashContextText(excerpt), snapshot: request.snapshot,
    freshness: 'live', observed_size_bytes: new TextEncoder().encode(content).byteLength,
    authority: 'repository_map', authority_evidence: ['generated-safe-repository-map'],
    excerpt, excerpt_bytes: bytes, estimated_tokens: Math.ceil(bytes / 4),
    discovery: {
      ...signalEvidence(content, request),
      ...discoveryTruncation(excerptWasBounded(content) ? ['EXCERPT_BOUND'] : []),
    },
  });
}

function gitCandidate(
  git: GitState | undefined,
  request: ContextPlanRequestV03,
): ContextCandidateV03 | undefined {
  if (!git?.head && !git?.branch) return undefined;
  const content = JSON.stringify({ ...(git.branch ? { branch: git.branch } : {}), ...(git.head ? { head: git.head } : {}) });
  const signals = signalEvidence(`git repository branch head ${content}`, request);
  if (signals.matched_terms.length === 0) return undefined;
  const bytes = new TextEncoder().encode(content).byteLength;
  return finishCandidate({
    schema_version: '0.3', kind: 'history', provider: 'git', path: 'git-state',
    source_hash: hashContextText(content), excerpt_hash: hashContextText(content), snapshot: request.snapshot,
    freshness: 'live', observed_size_bytes: bytes, authority: 'history', authority_evidence: ['local-git-metadata'],
    excerpt: content, excerpt_bytes: bytes, estimated_tokens: Math.ceil(bytes / 4),
    discovery: { ...signals, ...discoveryTruncation([]) },
  });
}

function assertRequestedSnapshot(request: ContextPlanRequestV03, live: ContextSnapshotV03): void {
  if (request.snapshot.repository_id !== live.repository_id
      || request.snapshot.worktree_digest !== live.worktree_digest
      || (request.snapshot.head !== undefined && request.snapshot.head !== live.head)) {
    throw new PrimeContextError('FRESHNESS_ERROR', 'Context request does not match the live repository snapshot', [
      `requested_repository=${request.snapshot.repository_id}`,
      `live_repository=${live.repository_id}`,
      `requested_worktree=${request.snapshot.worktree_digest}`,
      `live_worktree=${live.worktree_digest}`,
    ]);
  }
}

function signalEvidence(
  text: string,
  request: ContextPlanRequestV03,
): { matched_terms: string[]; criteria_ids: string[] } {
  const contentTerms = new Set(
    text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [],
  );
  const requestedTerms = new Set([
    ...normalizeTerms(request.task.query),
    ...(request.task.hints?.terms ?? []).flatMap(normalizeTerms),
    ...request.task.acceptance_criteria.flatMap((criterion) => (
      criterion.required_terms ?? normalizeTerms(criterion.text)
    )).flatMap(normalizeTerms),
  ]);
  const matchedTerms = [...requestedTerms].filter((term) => contentTerms.has(term)).sort(ordinal).slice(0, 128);
  const criteriaIds = request.task.acceptance_criteria.filter((criterion) => {
    const terms = (criterion.required_terms ?? normalizeTerms(criterion.text)).flatMap(normalizeTerms);
    return terms.length === 0 ? false : terms.some((term) => contentTerms.has(term));
  }).map((criterion) => criterion.id).sort(ordinal);
  return { matched_terms: matchedTerms, criteria_ids: criteriaIds };
}

function requestSearchTerms(request: ContextPlanRequestV03): string[] {
  return [...new Set([
    ...normalizeTerms(request.task.query),
    ...(request.task.hints?.terms ?? []).flatMap(normalizeTerms),
    ...request.task.acceptance_criteria.flatMap((criterion) => (
      criterion.required_terms ?? normalizeTerms(criterion.text)
    )).flatMap(normalizeTerms),
  ])].sort(ordinal).slice(0, 128);
}

function finishCandidate(
  value: Omit<ContextCandidateV03, 'id'>,
): ContextCandidateV03 {
  const candidate = { ...value, id: '' } as ContextCandidateV03;
  candidate.id = createContextCandidateId(candidate);
  return candidate;
}

function normalizedRepositoryPath(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '');
}

function requestIsSecurityRelevant(request: ContextPlanRequestV03): boolean {
  const values = [
    request.task.goal, request.task.query,
    ...request.task.acceptance_criteria.map((criterion) => criterion.text),
    ...request.task.acceptance_criteria.flatMap((criterion) => criterion.required_terms ?? []),
    ...(request.task.hints?.paths ?? []), ...(request.task.hints?.terms ?? []),
    ...(request.required_sources ?? []),
  ];
  const terms = new Set(values.flatMap(allNormalizedTerms));
  const hasAny = (vocabulary: ReadonlySet<string>): boolean => (
    [...terms].some((term) => vocabulary.has(term))
  );
  // SECURITY.md can be screened before Core sees a candidate, so this bounded
  // projection is kept in behavioral parity with Core by the end-to-end corpus test.
  return hasAny(SECURITY_RELEVANT_TERMS)
    || values.some((value) => DENIAL_OF_SERVICE_ACRONYM.test(value))
    || (terms.has('cross') && terms.has('site') && terms.has('scripting'))
    || (terms.has('sql') && terms.has('injection'))
    || (hasAny(INJECTION_OR_EXECUTION_TERMS) && hasAny(COMMAND_OR_CODE_TERMS))
    || (terms.has('injection') && hasAny(INJECTION_CONTEXT_TERMS))
    || (hasAny(KEY_TERMS) && hasAny(KEY_SECURITY_CONTEXT_TERMS))
    || (terms.has('prototype') && terms.has('pollution'))
    || (terms.has('denial') && (terms.has('service') || terms.has('services')))
    || ((terms.has('buffer') || terms.has('stack')) && (terms.has('overflow') || terms.has('overflows')))
    || (terms.has('session') && terms.has('fixation'))
    || (hasAny(SIGNATURE_TERMS) && hasAny(SIGNATURE_SECURITY_CONTEXT_TERMS))
    || (hasAny(TRAVERSAL_TERMS) && hasAny(TRAVERSAL_SECURITY_CONTEXT_TERMS))
    || (hasAny(DEPENDENCY_CONTEXT_TERMS) && hasAny(DEPENDENCY_SECURITY_TERMS));
}

interface PhysicalSourceExpectationV03 {
  path: string;
  source_hash: string;
}

async function assertPhysicalSourcesFresh(
  root: string,
  expectations: readonly PhysicalSourceExpectationV03[],
): Promise<void> {
  const unique = new Map<string, string>();
  for (const expectation of expectations) {
    const path = normalizedRepositoryPath(expectation.path);
    const previousHash = unique.get(path);
    if (previousHash !== undefined && previousHash !== expectation.source_hash) {
      throw new PrimeContextError('FRESHNESS_ERROR', 'Selected physical source identities conflict');
    }
    unique.set(path, expectation.source_hash);
  }
  for (const [path, expectedHash] of [...unique.entries()].sort(([left], [right]) => ordinal(left, right))) {
    let reread: Awaited<ReturnType<typeof readSafeRepositoryText>>;
    try {
      reread = await readSafeRepositoryText(root, path, MAX_FILESYSTEM_SOURCE_BYTES);
    } catch (error) {
      if (error instanceof PrimeContextError && error.code === 'SECURITY_ERROR') {
        throw new PrimeContextError('SECURITY_ERROR', 'Selected physical source failed final safety verification');
      }
      throw new PrimeContextError('FRESHNESS_ERROR', 'Selected physical source is no longer readable');
    }
    if (!reread || isSensitiveDocumentContent(reread.content)) {
      throw new PrimeContextError('SECURITY_ERROR', 'Selected physical source failed final safety screening');
    }
    if (reread.source_hash !== expectedHash) {
      throw new PrimeContextError('FRESHNESS_ERROR', 'Selected physical source changed after observation');
    }
  }
}

async function assertEnvelopePhysicalSourcesFresh(
  root: string,
  envelope: ContextEnvelopeV03,
  live: CollectedContextSources,
): Promise<void> {
  const acceptedByPath = new Map(live.hybrid_sources.map((source) => [
    normalizedRepositoryPath(source.path),
    source.source_hash,
  ]));
  const physicalProviders = new Set(['documents', 'filesystem', 'fts', 'codegraph']);
  const expectations: PhysicalSourceExpectationV03[] = [];
  for (const item of envelope.items) {
    if (!physicalProviders.has(item.provider)) continue;
    const path = normalizedRepositoryPath(item.path);
    if (acceptedByPath.get(path) !== item.source_hash) {
      throw new PrimeContextError('FRESHNESS_ERROR', 'Selected physical source is absent from the accepted observation');
    }
    expectations.push({ path, source_hash: item.source_hash });
  }
  await assertPhysicalSourcesFresh(root, expectations);
}

function pathWithin(path: string, boundary: string): boolean {
  const normalizedPath = normalizedRepositoryPath(path);
  const normalizedBoundary = normalizedRepositoryPath(boundary);
  return normalizedPath === normalizedBoundary || normalizedPath.startsWith(`${normalizedBoundary}/`);
}

function isDirectPolicyCandidate(candidate: ContextCandidateV03): boolean {
  return candidate.authority === 'policy'
    && (candidate.provider === 'documents' || candidate.provider === 'filesystem');
}

interface BlockedPolicyApplicability {
  security_relevant: boolean;
  target_scopes: ReadonlySet<string>;
  target_scope_coverage_complete: boolean;
}

function blockedPolicyApplicability(
  request: ContextPlanRequestV03,
  candidatePaths: readonly string[],
): BlockedPolicyApplicability {
  const targetScopes = new Set<string>();
  let targetScopeCoverageComplete = true;
  for (const target of [
    ...(request.task.hints?.paths ?? []),
    ...(request.required_sources ?? []),
    ...candidatePaths,
  ]) {
    const normalized = normalizedRepositoryPath(target);
    if (normalized.length === 0) continue;
    const segments = normalized.split('/');
    if (segments.length > 64) {
      targetScopeCoverageComplete = false;
      continue;
    }
    let scope = '';
    for (const segment of segments) {
      scope = scope.length === 0 ? segment : `${scope}/${segment}`;
      targetScopes.add(scope);
    }
  }
  return {
    security_relevant: requestIsSecurityRelevant(request),
    target_scopes: targetScopes,
    target_scope_coverage_complete: targetScopeCoverageComplete,
  };
}

function blockedFilesystemPolicyApplies(
  path: string,
  applicability: BlockedPolicyApplicability,
): boolean {
  const normalized = normalizedRepositoryPath(path);
  const lower = normalized.toLowerCase();
  if (lower === 'agents.md') return true;
  if (lower === 'security.md') return applicability.security_relevant;
  if (!lower.endsWith('/agents.md')) return false;
  if (!applicability.target_scope_coverage_complete) return true;
  const policyDirectory = normalized.slice(0, -'/AGENTS.md'.length);
  return applicability.target_scopes.has(policyDirectory);
}

interface BoundedCandidateCollection {
  candidates: ContextCandidateV03[];
  omitted_policy_paths: ReadonlySet<string>;
}

function documentCandidates(
  collection: DocumentSourceCollectionResult,
  request: ContextPlanRequestV03,
): BoundedCandidateCollection {
  const candidates: ContextCandidateV03[] = [];
  const omittedPolicyPaths = new Set<string>();
  let eligibleSourceCount = 0;
  const orderedSources = [...collection.sources].sort((left, right) => {
    const requiredDifference = Number((request.required_sources ?? []).includes(right.relative_path))
      - Number((request.required_sources ?? []).includes(left.relative_path));
    const policyDifference = Number(right.metadata.authority === 'policy')
      - Number(left.metadata.authority === 'policy');
    return requiredDifference || policyDifference || ordinal(left.relative_path, right.relative_path);
  });
  for (const source of orderedSources) {
    const excerpt = boundedRelevantExcerpt(source.content, requestSearchTerms(request));
    const excerptBounded = excerptWasBounded(source.content);
    const signals = signalEvidence(`${source.relative_path} ${source.metadata.title} ${excerpt}`, request);
    if (signals.matched_terms.length === 0 && source.metadata.authority !== 'policy'
        && !(request.required_sources ?? []).includes(source.relative_path)) continue;
    eligibleSourceCount += 1;
    if (candidates.length >= MAX_DOCUMENT_CANDIDATES) {
      if (source.metadata.authority === 'policy') {
        omittedPolicyPaths.add(normalizedRepositoryPath(source.relative_path));
      }
      continue;
    }
    const bytes = new TextEncoder().encode(excerpt).byteLength;
    candidates.push(finishCandidate({
      schema_version: '0.3', kind: 'document', provider: 'documents', path: source.relative_path,
      source_hash: source.source_hash, excerpt_hash: hashContextText(excerpt), snapshot: request.snapshot,
      freshness: 'live', observed_size_bytes: source.size_bytes, authority: source.metadata.authority,
      authority_evidence: [source.authority_basis.kind === 'convention'
        ? `convention:${source.authority_basis.rule_id}` : 'document-default'],
      excerpt, excerpt_bytes: bytes, estimated_tokens: Math.ceil(bytes / 4),
      discovery: {
        ...signals,
        ...discoveryTruncation(excerptBounded ? ['EXCERPT_BOUND'] : []),
      },
    }));
  }
  const providerResultWasLimited = eligibleSourceCount > candidates.length;
  const sourceCollectionWasLimited = collection.discovery_truncated === true
    || collection.skipped_oversize_count > 0;
  return {
    candidates: candidates.map((candidate) => ({
      ...candidate,
      discovery: {
        ...candidate.discovery,
        ...discoveryTruncation([
          ...(candidate.discovery.truncation_reasons ?? []),
          ...(providerResultWasLimited ? ['PROVIDER_RESULT_LIMIT' as const] : []),
          ...(sourceCollectionWasLimited ? ['SOURCE_COLLECTION_LIMIT' as const] : []),
        ]),
      },
    })),
    omitted_policy_paths: omittedPolicyPaths,
  };
}

function filesystemCandidates(
  sources: HybridIndexSourceV03[],
  request: ContextPlanRequestV03,
  collectionTruncated: boolean,
): BoundedCandidateCollection {
  const candidates: ContextCandidateV03[] = [];
  for (const source of sources) {
    const excerpt = boundedRelevantExcerpt(source.content, requestSearchTerms(request));
    const excerptBounded = excerptWasBounded(source.content);
    const signals = signalEvidence(`${source.path} ${source.title ?? ''} ${excerpt}`, request);
    const hintedPath = (request.task.hints?.paths ?? []).some((path) => (
      source.path === path || source.path.startsWith(`${path}/`)
    ));
    if (signals.matched_terms.length === 0 && source.authority !== 'policy' && !hintedPath
        && !(request.required_sources ?? []).includes(source.path)) continue;
    const bytes = new TextEncoder().encode(excerpt).byteLength;
    candidates.push(finishCandidate({
      schema_version: '0.3', kind: source.kind, provider: 'filesystem', path: source.path,
      source_hash: source.source_hash, excerpt_hash: hashContextText(excerpt), snapshot: request.snapshot,
      freshness: 'live', observed_size_bytes: new TextEncoder().encode(source.content).byteLength,
      authority: source.authority, authority_evidence: [source.authority === 'policy'
        ? 'convention:ancestor-agents-file' : 'safe-filesystem-fallback'],
      excerpt, excerpt_bytes: bytes, estimated_tokens: Math.ceil(bytes / 4),
      discovery: {
        ...signals,
        ...discoveryTruncation([
          ...(excerptBounded ? ['EXCERPT_BOUND' as const] : []),
          ...(collectionTruncated ? ['SOURCE_COLLECTION_LIMIT' as const] : []),
        ]),
      },
    }));
  }
  const ordered = candidates.sort((left, right) => {
    const requiredDifference = Number((request.required_sources ?? []).includes(right.path))
      - Number((request.required_sources ?? []).includes(left.path));
    const policyDifference = Number(isDirectPolicyCandidate(right)) - Number(isDirectPolicyCandidate(left));
    return requiredDifference || policyDifference || ordinal(left.id, right.id);
  });
  const sourceWasTruncated = ordered.length > MAX_FILESYSTEM_RETURNED_CANDIDATES;
  const omittedPolicyPaths = new Set(
    ordered.slice(MAX_FILESYSTEM_RETURNED_CANDIDATES)
      .filter(isDirectPolicyCandidate)
      .map((candidate) => normalizedRepositoryPath(candidate.path)),
  );
  return {
    candidates: ordered.slice(0, MAX_FILESYSTEM_RETURNED_CANDIDATES).map((candidate) => ({
      ...candidate,
      discovery: {
        ...candidate.discovery,
        ...discoveryTruncation([
          ...(candidate.discovery.truncation_reasons ?? []),
          ...(sourceWasTruncated ? ['PROVIDER_RESULT_LIMIT' as const] : []),
        ]),
      },
    })),
    omitted_policy_paths: omittedPolicyPaths,
  };
}

function ftsCandidate(
  hit: SqliteFtsHitV03,
  request: ContextPlanRequestV03,
  liveSource: HybridIndexSourceV03,
  providerResultWasLimited: boolean,
): ContextCandidateV03 {
  if (liveSource.path !== hit.path || liveSource.source_hash !== hit.source_hash) {
    throw new PrimeContextError('FRESHNESS_ERROR', 'FTS hit does not match the live accepted source');
  }
  if (isSensitiveDocumentContent(liveSource.content)) {
    throw new PrimeContextError('SECURITY_ERROR', 'Sensitive live source cannot enter a context envelope');
  }
  const excerpt = boundedRelevantExcerpt(liveSource.content, hit.matched_terms);
  const bytes = new TextEncoder().encode(excerpt).byteLength;
  const signals = signalEvidence(`${hit.path} ${hit.title} ${excerpt}`, request);
  return finishCandidate({
    schema_version: '0.3', kind: hit.kind, provider: 'fts', path: hit.path,
    ...(hit.locator ? {
      line_start: hit.locator.start_line,
      line_end: hit.locator.end_line,
      ...(hit.locator.symbol ? { symbol: hit.locator.symbol } : {}),
    } : {}),
    source_hash: liveSource.source_hash, excerpt_hash: hashContextText(excerpt), snapshot: request.snapshot,
    freshness: 'live', observed_size_bytes: new TextEncoder().encode(liveSource.content).byteLength,
    authority: liveSource.authority,
    authority_evidence: ['safe-live-source-reread', 'screened-local-fts-index'], excerpt, excerpt_bytes: bytes,
    estimated_tokens: Math.ceil(bytes / 4), discovery: {
      matched_terms: signals.matched_terms,
      criteria_ids: signals.criteria_ids,
      ...discoveryTruncation([
        ...(excerptWasBounded(liveSource.content) ? ['EXCERPT_BOUND' as const] : []),
        ...(providerResultWasLimited ? ['PROVIDER_RESULT_LIMIT' as const] : []),
      ]),
    },
  });
}

function graphCandidates(
  graph: LocalCodeGraphV03,
  request: ContextPlanRequestV03,
  acceptedSources: readonly HybridIndexSourceV03[],
): ContextCandidateV03[] {
  assertValidLocalCodeGraphV03(graph);
  if (graph.binding.snapshot.repository_id !== request.snapshot.repository_id
    || graph.binding.snapshot.worktree_digest !== request.snapshot.worktree_digest
    || graph.binding.snapshot.head !== request.snapshot.head) {
    throw new PrimeContextError('FRESHNESS_ERROR', 'CodeGraph snapshot does not match the live ContextPlan request');
  }
  const acceptedByPath = new Map(acceptedSources.map((source) => [source.path, source]));
  for (const accepted of graph.binding.accepted_sources) {
    if (acceptedByPath.get(accepted.path)?.source_hash !== accepted.source_hash) {
      throw new PrimeContextError('FRESHNESS_ERROR', 'CodeGraph accepted-source binding is absent from the live collection');
    }
  }
  const candidates: ContextCandidateV03[] = [];
  let eligibleNodeCount = 0;
  for (const node of graph.nodes) {
    const signals = signalEvidence(`${node.locator.path} ${node.name} ${node.qualified_name} ${node.excerpt}`, request);
    const hintedPath = (request.task.hints?.paths ?? []).some((path) => node.locator.path === path || node.locator.path.startsWith(`${path}/`));
    const hintedSymbol = (request.task.hints?.symbols ?? []).includes(node.name);
    const requiredPath = (request.required_sources ?? []).includes(node.locator.path);
    if (signals.matched_terms.length === 0 && !hintedPath && !hintedSymbol && !requiredPath) continue;
    eligibleNodeCount += 1;
    if (candidates.length >= MAX_GRAPH_CANDIDATES) continue;
    const acceptedSource = acceptedByPath.get(node.locator.path);
    if (!acceptedSource || acceptedSource.source_hash !== node.source_hash) {
      throw new PrimeContextError('FRESHNESS_ERROR', 'CodeGraph candidate source is absent from the live accepted-source collection');
    }
    const excerpt = boundedExcerpt(node.excerpt);
    const bytes = new TextEncoder().encode(excerpt).byteLength;
    const isTest = /(?:^|\/)(?:test|tests|__tests__)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(node.locator.path);
    candidates.push(finishCandidate({
      schema_version: '0.3', kind: isTest ? 'test' : 'code', provider: 'codegraph', path: node.locator.path,
      line_start: node.locator.start_line, line_end: node.locator.end_line, symbol: node.name,
      source_hash: node.source_hash, excerpt_hash: hashContextText(excerpt), snapshot: structuredClone(graph.binding.snapshot),
      freshness: 'snapshot', observed_size_bytes: new TextEncoder().encode(acceptedSource.content).byteLength,
      authority: isTest ? 'test' : 'source_code', authority_evidence: [`typescript-ast:${node.kind}`],
      excerpt, excerpt_bytes: bytes, estimated_tokens: Math.ceil(bytes / 4), discovery: {
        ...signals,
        ...(hintedSymbol ? { graph_distance: 0 } : {}),
        ...discoveryTruncation(
          node.excerpt_truncated || excerptWasBounded(node.excerpt) ? ['EXCERPT_BOUND'] : [],
        ),
      },
    }));
  }
  const providerResultWasLimited = eligibleNodeCount > candidates.length;
  return candidates.map((candidate) => ({
    ...candidate,
    discovery: {
      ...candidate.discovery,
      ...discoveryTruncation([
        ...(candidate.discovery.truncation_reasons ?? []),
        ...(providerResultWasLimited ? ['PROVIDER_RESULT_LIMIT' as const] : []),
      ]),
    },
  }));
}

async function collectPlanCandidates(
  root: string,
  config: PrimeContextConfig,
  request: ContextPlanRequestV03,
  live: CollectedContextSources,
  query = request.task.query,
  expansion?: ExpansionRequestV03,
): Promise<{ candidates: ContextCandidateV03[]; failures: ContextSourceFailureV03[] }> {
  const effectiveRequest = query === request.task.query
    ? request
    : {
        ...request,
        task: {
          ...request.task,
          query,
          hints: {
            paths: uniqueStrings([...(request.task.hints?.paths ?? []), ...(expansion?.requested_paths ?? [])]),
            symbols: uniqueStrings([...(request.task.hints?.symbols ?? []), ...(expansion?.requested_symbols ?? [])]),
            terms: uniqueStrings([...(request.task.hints?.terms ?? []), ...(expansion?.requested_terms ?? []), ...normalizeTerms(query)]),
          },
        },
      };
  const failures: ContextSourceFailureV03[] = [...live.source_failures];
  const screenedOmittedPaths = screenedFilesystemOmissions.get(live)?.paths ?? new Set<string>();
  const blockedPolicyKinds = live.documents.blocked_policy_kinds;
  const applicableBlockedDocumentPolicy = blockedPolicyKinds
    ? blockedPolicyKinds.operational > 0
      || (blockedPolicyKinds.security > 0 && requestIsSecurityRelevant(effectiveRequest))
    : (live.documents.blocked_policy_count ?? 0) > 0;
  const capsule = await linkedTaskCapsule(root, config, effectiveRequest);
  let fts: ContextCandidateV03[] = [];
  try {
    const manifest = await readValidatedIndexManifest(root, config, live.snapshot);
    const result = await withOptionalAdapterTimeout(
      'SQLite FTS',
      (signal) => new NodeSqliteFtsAdapter().search(root, indexRelativePath(root, config), query, {
        state_dir: repositoryRelativePath(root, config.state_dir, 'state_dir'),
        limit: MAX_FTS_CANDIDATES,
        expected_worktree_digest: live.snapshot.worktree_digest,
        signal,
      }),
    );
    if (result.index_digest !== manifest.index_digest || result.repository_id !== manifest.repository_id) {
      throw new PrimeContextError('FRESHNESS_ERROR', 'SQLite FTS result is not linked to the validated index manifest');
    }
    assertManifestToolchain(config, live, manifest, result.toolchain);
    const liveByIdentity = new Map(
      live.hybrid_sources.map((source) => [`${source.path}:${source.source_hash}`, source]),
    );
    const providerResultWasLimited = result.hits.length >= MAX_FTS_CANDIDATES;
    for (const hit of result.hits) {
      const source = liveByIdentity.get(`${hit.path}:${hit.source_hash}`);
      if (!source) {
        failures.push({
          provider: 'fts', code: 'STALE_SELECTED_SOURCE',
          message: 'FTS candidate is absent from the live accepted-source manifest', security_control: false,
        });
        continue;
      }
      fts.push(ftsCandidate(hit, effectiveRequest, source, providerResultWasLimited));
    }
  } catch (error) {
    if (error instanceof PrimeContextError && error.code === 'SECURITY_ERROR') throw error;
    failures.push({
      provider: 'fts', code: 'OPTIONAL_SOURCE_UNAVAILABLE',
      message: error instanceof PrimeContextError ? error.code : 'local FTS source unavailable',
      security_control: false,
    });
  }
  const ftsDocumentKeys = new Set(
    fts.filter((candidate) => candidate.kind === 'document')
      .map((candidate) => `${candidate.path}:${candidate.source_hash}`),
  );
  const documentProvider = documentCandidates(live.documents, effectiveRequest);
  const directDocuments = documentProvider.candidates.filter((candidate) => (
    candidate.authority === 'policy'
    || (request.required_sources ?? []).includes(candidate.path)
    || !ftsDocumentKeys.has(`${candidate.path}:${candidate.source_hash}`)
  ));
  const gitMetadataCandidate = gitCandidate(live.git, request);
  const filesystemProvider = filesystemCandidates(
    live.filesystem_sources,
    effectiveRequest,
    live.filesystem_collection_truncated,
  );
  const candidates = [
    ...directDocuments,
    ...filesystemProvider.candidates,
    ...fts,
    ...(live.graph ? graphCandidates(live.graph, effectiveRequest, live.filesystem_sources) : []),
    repoMapCandidate(live.repo_map, effectiveRequest),
    ...(gitMetadataCandidate ? [gitMetadataCandidate] : []),
  ];
  const acceptedPaths = new Set(live.hybrid_sources.map((source) => normalizedRepositoryPath(source.path)));
  const hasBlockedRequiredSource = (effectiveRequest.required_sources ?? []).some((requiredPath) => {
    const normalized = normalizedRepositoryPath(requiredPath);
    return !acceptedPaths.has(normalized)
      && (isSensitivePath(normalized) || screenedOmittedPaths.has(normalized));
  });
  if (hasBlockedRequiredSource && !failures.some((failure) => (
    failure.security_control && failure.code === 'REQUIRED_SOURCE_BLOCKED'
  ))) {
    failures.push({
      provider: 'filesystem',
      code: 'REQUIRED_SOURCE_BLOCKED',
      message: 'Required evidence was blocked by repository safety policy',
      security_control: true,
    });
  }
  const unique = new Map<string, ContextCandidateV03>();
  for (const candidate of candidates) {
    if (candidateAllowedByCapsule(candidate, capsule)) unique.set(candidate.id, candidate);
  }
  const candidatePaths = [...unique.values()]
    .filter((candidate) => candidate.authority !== 'policy'
      && ['documents', 'filesystem', 'fts', 'codegraph'].includes(candidate.provider))
    .map((candidate) => candidate.path);
  const policyApplicability = blockedPolicyApplicability(effectiveRequest, candidatePaths);
  const ordered = [...unique.values()].sort((left, right) => {
    const requiredDifference = Number((request.required_sources ?? []).includes(right.path))
      - Number((request.required_sources ?? []).includes(left.path));
    const policyDifference = Number(right.authority === 'policy' && (right.provider === 'documents' || right.provider === 'filesystem'))
      - Number(left.authority === 'policy' && (left.provider === 'documents' || left.provider === 'filesystem'));
    return requiredDifference || policyDifference || ordinal(left.id, right.id);
  });
  const aggregateWasTruncated = ordered.length > MAX_AGGREGATE_CANDIDATES;
  const omittedPolicyPaths = new Set([
    ...screenedOmittedPaths,
    ...documentProvider.omitted_policy_paths,
    ...filesystemProvider.omitted_policy_paths,
    ...ordered.slice(MAX_AGGREGATE_CANDIDATES)
      .filter(isDirectPolicyCandidate)
      .map((candidate) => normalizedRepositoryPath(candidate.path)),
  ]);
  const applicableBlockedPolicy = applicableBlockedDocumentPolicy
    || [...omittedPolicyPaths].some((path) => (
      blockedFilesystemPolicyApplies(path, policyApplicability)
    ));
  if (applicableBlockedPolicy && !failures.some((failure) => (
    failure.security_control && failure.code === 'REQUIRED_SOURCE_BLOCKED'
  ))) {
    failures.push({
      provider: 'documents',
      code: 'REQUIRED_SOURCE_BLOCKED',
      message: 'An applicable repository policy was blocked by safety screening',
      security_control: true,
    });
  }
  return {
    candidates: ordered.slice(0, MAX_AGGREGATE_CANDIDATES).map((candidate) => ({
      ...candidate,
      discovery: {
        ...candidate.discovery,
        ...discoveryTruncation([
          ...(candidate.discovery.truncation_reasons ?? []),
          ...(aggregateWasTruncated ? ['CANDIDATE_SET_LIMIT' as const] : []),
        ]),
      },
    })),
    failures,
  };
}

function serializeArtifact(value: unknown): string {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > MAX_CONTEXT_ARTIFACT_BYTES) {
    throw new PrimeContextError('STATE_ERROR', 'Context artifact exceeds the 8 MiB state limit');
  }
  return serialized;
}

async function readInternalJsonBounded(root: string, path: string): Promise<unknown> {
  const content = await readInternalText(root, path, MAX_CONTEXT_ARTIFACT_BYTES);
  return parseBoundedJson(content as string, 'STATE_ERROR', path, { maxValues: MAX_CONTEXT_VALUES });
}

function validateStoredPlan(value: unknown): StoredContextPlanV03 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PrimeContextError('STATE_ERROR', 'Stored context plan is not an object');
  }
  const record = value as Record<string, unknown>;
  if (record.schema_version !== '0.3' || !record.request || !record.envelope || !record.receipt
      || !/^sha256:[0-9a-f]{64}$/.test(String(record.base_selection_digest))
      || !/^sha256:[0-9a-f]{64}$/.test(String(record.expansion_ledger_digest))
      || Object.keys(record).some((key) => ![
        'schema_version', 'request', 'envelope', 'receipt',
        'base_selection_digest', 'expansion_ledger_digest',
      ].includes(key))) {
    throw new PrimeContextError('STATE_ERROR', 'Stored context plan has an incompatible structure');
  }
  const requestValidation = validateContextPlanRequest(record.request);
  if (!requestValidation.valid) throw new PrimeContextError('STATE_ERROR', 'Stored context request is invalid', requestValidation.errors);
  const contextPackage = assertValidTaskContextPackage({ envelope: record.envelope, receipt: record.receipt });
  const { envelope, receipt } = contextPackage;
  const request = structuredClone(record.request) as ContextPlanRequestV03;
  if (envelope.task_id !== request.task.task_id || receipt.task_id !== envelope.task_id
      || receipt.request_digest !== envelope.request_digest
      || receipt.selection_digest !== envelope.selection_digest
      || envelope.request_digest !== hashContextJson(request)) {
    throw new PrimeContextError('STATE_ERROR', 'Stored context plan linkage is invalid');
  }
  return {
    schema_version: '0.3', request, envelope, receipt,
    base_selection_digest: record.base_selection_digest as string,
    expansion_ledger_digest: record.expansion_ledger_digest as string,
  };
}

async function readStoredPlan(
  root: string,
  config: PrimeContextConfig,
  taskId: string,
): Promise<StoredContextPlanV03> {
  return validateStoredPlan(await readInternalJsonBounded(root, planRelativePath(root, config, taskId)));
}

async function applyPlanPolicyLimits(
  root: string,
  config: PrimeContextConfig,
  request: ContextPlanRequestV03,
): Promise<ContextPlanRequestV03> {
  let tokenLimit = config.budgets[request.task.task_type].hard_limit_tokens;
  let capsule: TaskCapsule | undefined;
  if (request.capsule_digest) {
    const capsulePath = stateRelativePath(root, config, `capsules/${request.task.task_id}.json`);
    const capsuleValue = await readInternalJsonBounded(root, capsulePath);
    const validation = validateTaskCapsule(capsuleValue);
    if (!validation.valid) throw new PrimeContextError('STATE_ERROR', 'Linked Task Capsule is invalid', validation.errors);
    capsule = capsuleValue as TaskCapsule;
    if (capsule.task_id !== request.task.task_id || capsule.task_type !== request.task.task_type
        || capsule.goal !== request.task.goal
        || capsule.acceptance.some((criterion) => !request.task.acceptance_criteria.some((item) => item.text === criterion))
        || hashContextJson(capsule) !== request.capsule_digest) {
      throw new PrimeContextError('STATE_ERROR', 'Context request does not match its linked Task Capsule');
    }
    tokenLimit = Math.min(tokenLimit, capsule.context_budget.hard_limit_tokens);
  }
  const capsuleDocuments = capsule?.documents ?? [];
  const capsuleCodePaths = (capsule?.code_targets ?? []).filter((target) => (
    target.includes('/') || /\.(?:[cm]?[jt]sx?|c|cc|cpp|cs|go|java|kt|php|py|rb|rs|swift|vue)$/i.test(target)
  ));
  const capsuleSymbols = (capsule?.code_targets ?? []).filter((target) => !capsuleCodePaths.includes(target));
  const capsuleReferencePaths = [
    ...(capsule?.contracts ?? []),
    ...(capsule?.decisions?.map((decision) => decision.source) ?? []),
  ].flatMap((reference) => {
    if (isAbsolute(reference) || reference.includes('\\') || reference.includes(':')
        || /[\u0000-\u001f\u007f-\u009f]/u.test(reference)
        || (!reference.includes('/') && !/^[^/]+\.[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/u.test(reference))) {
      return [];
    }
    try {
      const path = repositoryRelativePath(root, reference, 'Task Capsule reference');
      return isSensitivePath(path) ? [] : [path];
    } catch {
      return [];
    }
  });
  const hints = request.task.hints;
  const requiredSources = uniqueStrings([
    ...(request.required_sources ?? []),
    ...capsuleDocuments,
    ...capsuleCodePaths,
    ...capsuleReferencePaths,
  ]);
  const boundedInitialTokens = Math.min(request.budget.max_estimated_tokens, tokenLimit);
  const progressiveBudget = request.progressive_budget ? {
    soft: {
      ...request.progressive_budget.soft,
      max_estimated_tokens: Math.max(
        boundedInitialTokens,
        Math.min(request.progressive_budget.soft.max_estimated_tokens, tokenLimit),
      ),
    },
    hard: {
      ...request.progressive_budget.hard,
      max_estimated_tokens: Math.max(
        boundedInitialTokens,
        Math.min(request.progressive_budget.hard.max_estimated_tokens, tokenLimit),
      ),
    },
  } : undefined;
  if (progressiveBudget) {
    progressiveBudget.hard.max_estimated_tokens = Math.max(
      progressiveBudget.soft.max_estimated_tokens,
      progressiveBudget.hard.max_estimated_tokens,
    );
  }
  return {
    ...request,
    budget: { ...request.budget, max_estimated_tokens: boundedInitialTokens },
    ...(progressiveBudget ? { progressive_budget: progressiveBudget } : {}),
    task: {
      ...request.task,
      ...((hints || capsuleCodePaths.length > 0 || capsuleSymbols.length > 0) ? {
        hints: {
          ...(uniqueStrings([...(hints?.paths ?? []), ...capsuleCodePaths]).length > 0
            ? { paths: uniqueStrings([...(hints?.paths ?? []), ...capsuleCodePaths]) } : {}),
          ...(uniqueStrings([...(hints?.symbols ?? []), ...capsuleSymbols]).length > 0
            ? { symbols: uniqueStrings([...(hints?.symbols ?? []), ...capsuleSymbols]) } : {}),
          ...((hints?.terms?.length ?? 0) > 0 ? { terms: uniqueStrings(hints?.terms ?? []) } : {}),
        },
      } : {}),
    },
    ...(requiredSources.length > 0 ? { required_sources: requiredSources } : {}),
  };
}

async function linkedTaskCapsule(
  root: string,
  config: PrimeContextConfig,
  request: ContextPlanRequestV03,
): Promise<TaskCapsule | undefined> {
  if (!request.capsule_digest) return undefined;
  const capsulePath = stateRelativePath(root, config, `capsules/${request.task.task_id}.json`);
  const value = await readInternalJsonBounded(root, capsulePath);
  const validation = validateTaskCapsule(value);
  if (!validation.valid) throw new PrimeContextError('STATE_ERROR', 'Linked Task Capsule is invalid', validation.errors);
  const capsule = value as TaskCapsule;
  if (capsule.task_id !== request.task.task_id || capsule.task_type !== request.task.task_type
      || capsule.goal !== request.task.goal
      || capsule.acceptance.some((criterion) => !request.task.acceptance_criteria.some((item) => item.text === criterion))
      || hashContextJson(capsule) !== request.capsule_digest) {
    throw new PrimeContextError('STATE_ERROR', 'Context request does not match its linked Task Capsule');
  }
  return capsule;
}

function candidateAllowedByCapsule(candidate: ContextCandidateV03, capsule: TaskCapsule | undefined): boolean {
  if (!capsule || isDirectPolicyCandidate(candidate)) return true;
  if (capsule.boundaries.forbidden_paths.some((path) => pathWithin(candidate.path, path))) return false;
  if (capsule.boundaries.allowed_paths.length === 0) return true;
  return capsule.boundaries.allowed_paths.some((path) => pathWithin(candidate.path, path));
}

async function replaceStoredPlan(
  root: string,
  config: PrimeContextConfig,
  request: ContextPlanRequestV03,
  contextPackage: TaskContextPackageV03,
  expansionState?: Pick<StoredContextPlanV03, 'base_selection_digest' | 'expansion_ledger_digest'>,
): Promise<string> {
  const path = planRelativePath(root, config, request.task.task_id);
  const baseSelectionDigest = expansionState?.base_selection_digest ?? contextPackage.envelope.selection_digest;
  const value: StoredContextPlanV03 = {
    schema_version: '0.3', request, envelope: contextPackage.envelope, receipt: contextPackage.receipt,
    base_selection_digest: baseSelectionDigest,
    expansion_ledger_digest: expansionState?.expansion_ledger_digest
      ?? expansionLedgerDigest(request.task.task_id, baseSelectionDigest, []),
  };
  validateStoredPlan(value);
  await writeInternalTextAtomic(root, path, serializeArtifact(value));
  return path;
}

async function appendValidatedJsonLine(
  root: string,
  path: string,
  value: unknown,
  validateLine: (line: unknown) => boolean,
): Promise<void> {
  const absoluteKey = resolve(root, path);
  const lockKey = process.platform === 'win32' ? absoluteKey.toLowerCase() : absoluteKey;
  if (activeLedgerWriters.has(lockKey)) {
    throw new PrimeContextError('STATE_ERROR', 'A context ledger writer is already active');
  }
  activeLedgerWriters.add(lockKey);
  try {
    await withInternalExclusiveLock(root, `${path}.lock`, async () => {
      const prior = await readInternalText(root, path, MAX_CONTEXT_ARTIFACT_BYTES, { allowMissing: true });
      const lines = prior === undefined || prior.length === 0
        ? []
        : prior.split(/\r?\n/u).filter((line) => line.length > 0);
      if (lines.length >= MAX_OUTCOMES) throw new PrimeContextError('STATE_ERROR', 'Context ledger record limit exceeded');
      for (const line of lines) {
        const parsed = parseBoundedJson(line, 'STATE_ERROR', path);
        if (!validateLine(parsed)) throw new PrimeContextError('STATE_ERROR', 'Context ledger contains an invalid record');
      }
      if (!validateLine(value)) throw new PrimeContextError('VALIDATION_ERROR', 'Context ledger record is invalid');
      const serialized = `${lines.join('\n')}${lines.length > 0 ? '\n' : ''}${JSON.stringify(value)}\n`;
      if (Buffer.byteLength(serialized, 'utf8') > MAX_CONTEXT_ARTIFACT_BYTES) {
        throw new PrimeContextError('STATE_ERROR', 'Context ledger exceeds the 8 MiB state limit');
      }
      await writeInternalTextAtomic(root, path, serialized);
    });
  } finally {
    activeLedgerWriters.delete(lockKey);
  }
}

function outcomeRecordDigest(
  value: Omit<StoredOutcomeRecordV03, 'record_digest'>,
): string {
  return hashContextJson(value);
}

function legacyOutcomePrefixDigest(receipts: readonly OutcomeReceiptV03[]): string {
  return hashContextJson({
    schema_version: '0.3',
    legacy_outcome_digests: receipts.map((receipt) => receipt.outcome_digest),
  });
}

function validatedOutcomeLedger(
  content: string | undefined,
  path: string,
  taskId: string,
): { receipts: OutcomeReceiptV03[]; records: StoredOutcomeRecordV03[]; legacy_count: number } {
  const receipts: OutcomeReceiptV03[] = [];
  const records: StoredOutcomeRecordV03[] = [];
  const runKeys = new Set<string>();
  let legacyCount = 0;
  let chained = false;
  const lines = content === undefined || content.length === 0
    ? []
    : content.split(/\r?\n/u).filter(Boolean);
  if (lines.length > MAX_OUTCOMES) throw new PrimeContextError('STATE_ERROR', 'Context outcome ledger record limit exceeded');
  for (let index = 0; index < lines.length; index += 1) {
    const parsed = parseBoundedJson(lines[index] as string, 'STATE_ERROR', path);
    const looksChained = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      && Object.hasOwn(parsed, 'receipt');
    if (!looksChained) {
      if (chained) throw new PrimeContextError('STATE_ERROR', 'Legacy outcome receipts must form a validated ledger prefix');
      assertValidOutcomeReceipt(parsed);
      const receipt = structuredClone(parsed) as OutcomeReceiptV03;
      if (receipt.task_id !== taskId) throw new PrimeContextError('STATE_ERROR', 'Outcome ledger task linkage is invalid');
      const key = hashContextJson([receipt.task_id, receipt.selection_digest, receipt.run_id]);
      if (runKeys.has(key)) throw new PrimeContextError('STATE_ERROR', 'Outcome ledger contains a duplicate run_id for this task and selection');
      runKeys.add(key);
      receipts.push(receipt);
      legacyCount += 1;
      continue;
    }
    chained = true;
    const candidate = parsed as Partial<StoredOutcomeRecordV03>;
    if (candidate.schema_version !== '0.3'
        || candidate.sequence !== index + 1
        || typeof candidate.record_digest !== 'string'
        || !candidate.receipt
        || Object.keys(candidate).some((key) => ![
          'schema_version', 'sequence', 'previous_record_digest', 'receipt', 'record_digest',
        ].includes(key))) {
      throw new PrimeContextError('STATE_ERROR', 'Outcome ledger sequence or structure is invalid');
    }
    assertValidOutcomeReceipt(candidate.receipt);
    const receipt = structuredClone(candidate.receipt) as OutcomeReceiptV03;
    if (receipt.task_id !== taskId) throw new PrimeContextError('STATE_ERROR', 'Outcome ledger task linkage is invalid');
    const key = hashContextJson([receipt.task_id, receipt.selection_digest, receipt.run_id]);
    if (runKeys.has(key)) throw new PrimeContextError('STATE_ERROR', 'Outcome ledger contains a duplicate run_id for this task and selection');
    runKeys.add(key);
    const expectedPrevious = records.length > 0
      ? records[records.length - 1]?.record_digest
      : legacyCount > 0 ? legacyOutcomePrefixDigest(receipts) : undefined;
    if (candidate.previous_record_digest !== expectedPrevious) {
      throw new PrimeContextError('STATE_ERROR', 'Outcome ledger digest chain is invalid');
    }
    const withoutDigest: Omit<StoredOutcomeRecordV03, 'record_digest'> = {
      schema_version: '0.3',
      sequence: candidate.sequence,
      ...(candidate.previous_record_digest ? { previous_record_digest: candidate.previous_record_digest } : {}),
      receipt,
    };
    if (candidate.record_digest !== outcomeRecordDigest(withoutDigest)) {
      throw new PrimeContextError('STATE_ERROR', 'Outcome ledger record digest is invalid');
    }
    const record: StoredOutcomeRecordV03 = { ...withoutDigest, record_digest: candidate.record_digest };
    records.push(record);
    receipts.push(receipt);
  }
  return { receipts, records, legacy_count: legacyCount };
}

async function appendOutcomeReceipt(
  root: string,
  path: string,
  taskId: string,
  receipt: OutcomeReceiptV03,
): Promise<string> {
  const absoluteKey = resolve(root, path);
  const lockKey = process.platform === 'win32' ? absoluteKey.toLowerCase() : absoluteKey;
  if (activeLedgerWriters.has(lockKey)) {
    throw new PrimeContextError('STATE_ERROR', 'A context ledger writer is already active');
  }
  activeLedgerWriters.add(lockKey);
  try {
    return await withInternalExclusiveLock(root, `${path}.lock`, async () => {
      const prior = await readInternalText(root, path, MAX_CONTEXT_ARTIFACT_BYTES, { allowMissing: true });
      const ledger = validatedOutcomeLedger(prior, path, taskId);
      if (ledger.receipts.length >= MAX_OUTCOMES) {
        throw new PrimeContextError('STATE_ERROR', 'Context outcome ledger record limit exceeded');
      }
      if (ledger.receipts.some((item) => (
        item.task_id === receipt.task_id
        && item.selection_digest === receipt.selection_digest
        && item.run_id === receipt.run_id
      ))) {
        throw new PrimeContextError('STATE_ERROR', 'Outcome ledger contains a duplicate run_id for this task and selection');
      }
      const previousRecordDigest = ledger.records.length > 0
        ? ledger.records[ledger.records.length - 1]?.record_digest
        : ledger.legacy_count > 0 ? legacyOutcomePrefixDigest(ledger.receipts) : undefined;
      const withoutDigest: Omit<StoredOutcomeRecordV03, 'record_digest'> = {
        schema_version: '0.3',
        sequence: ledger.receipts.length + 1,
        ...(previousRecordDigest ? { previous_record_digest: previousRecordDigest } : {}),
        receipt: structuredClone(receipt),
      };
      const record: StoredOutcomeRecordV03 = {
        ...withoutDigest,
        record_digest: outcomeRecordDigest(withoutDigest),
      };
      const prefix = prior === undefined || prior.length === 0 ? '' : `${prior.trimEnd()}\n`;
      const serialized = `${prefix}${JSON.stringify(record)}\n`;
      if (Buffer.byteLength(serialized, 'utf8') > MAX_CONTEXT_ARTIFACT_BYTES) {
        throw new PrimeContextError('STATE_ERROR', 'Context outcome ledger exceeds the 8 MiB state limit');
      }
      await writeInternalTextAtomic(root, path, serialized);
      return record.record_digest;
    });
  } finally {
    activeLedgerWriters.delete(lockKey);
  }
}

function validateStoredExpansion(value: unknown): value is StoredExpansionV03 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.schema_version !== '0.3' || !record.request || !record.decision
      || typeof record.record_digest !== 'string'
      || Object.keys(record).some((key) => !['schema_version', 'request', 'decision', 'record_digest'].includes(key))) return false;
  if (!validateExpansionRequest(record.request).valid || !validateExpansionDecision(record.decision).valid) return false;
  const request = record.request as unknown as ExpansionRequestV03;
  const decision = record.decision as unknown as ExpansionDecisionV03;
  return request.task_id === decision.task_id
    && request.previous_selection_digest === decision.previous_selection_digest
    && record.record_digest === storedExpansionDigest(request, decision);
}

async function readStoredExpansions(
  root: string,
  config: PrimeContextConfig,
  taskId: string,
  stored: StoredContextPlanV03,
): Promise<StoredExpansionV03[]> {
  const path = expansionRelativePath(root, config, taskId);
  const content = await readInternalText(root, path, MAX_CONTEXT_ARTIFACT_BYTES, { allowMissing: true });
  const records: StoredExpansionV03[] = [];
  if (content !== undefined && content.length > 0) {
    for (const line of content.split(/\r?\n/u).filter(Boolean)) {
      const parsed = parseBoundedJson(line, 'STATE_ERROR', path);
      if (!validateStoredExpansion(parsed)) throw new PrimeContextError('STATE_ERROR', 'Stored expansion ledger is invalid');
      records.push(structuredClone(parsed));
    }
  }
  if (records.length > 8) throw new PrimeContextError('STATE_ERROR', 'Stored expansion count exceeds the v0.3 limit');

  if (stored.request.task.task_id !== taskId || stored.envelope.task_id !== taskId) {
    throw new PrimeContextError('STATE_ERROR', 'Stored expansion ledger task anchor is invalid');
  }
  if (expansionLedgerDigest(taskId, stored.base_selection_digest, records)
      !== stored.expansion_ledger_digest) {
    throw new PrimeContextError('STATE_ERROR', 'Stored expansion ledger digest is not anchored to the original plan');
  }

  const finalItems = new Map(stored.envelope.items.map((item) => [item.id, item]));
  const allAdditionIds = new Set<string>();
  for (const record of records) {
    for (const addition of record.decision.additions) {
      if (allAdditionIds.has(addition) || !finalItems.has(addition)) {
        throw new PrimeContextError('STATE_ERROR', 'Stored expansion ledger additions are invalid');
      }
      allAdditionIds.add(addition);
    }
  }
  const knownIds = new Set(
    stored.envelope.items.map((item) => item.id).filter((id) => !allAdditionIds.has(id)),
  );
  let priorSelectionDigest = stored.base_selection_digest;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] as StoredExpansionV03;
    if (record.request.task_id !== taskId || record.decision.task_id !== taskId
        || record.request.previous_selection_digest !== priorSelectionDigest
        || record.decision.previous_selection_digest !== priorSelectionDigest
        || [...knownIds].some((id) => !record.request.known_candidate_ids.includes(id))) {
      throw new PrimeContextError('STATE_ERROR', 'Stored expansion ledger chain is invalid');
    }
    if (hashContextJson(record.decision.snapshot) !== hashContextJson(stored.envelope.snapshot)) {
      throw new PrimeContextError('STATE_ERROR', 'Stored expansion ledger is not linked to the current plan');
    }
    if (record.decision.additions.length === 0
        && record.decision.selection_digest !== priorSelectionDigest) {
      throw new PrimeContextError('STATE_ERROR', 'Stored denied expansion mutates the selection digest');
    }
    for (const addition of record.decision.additions) {
      if (knownIds.has(addition)) {
        throw new PrimeContextError('STATE_ERROR', 'Stored expansion ledger re-adds an existing candidate');
      }
      knownIds.add(addition);
    }
    priorSelectionDigest = record.decision.selection_digest;
  }
  if (priorSelectionDigest !== stored.envelope.selection_digest
      || knownIds.size !== stored.envelope.items.length) {
    throw new PrimeContextError('STATE_ERROR', 'Stored expansion ledger tail does not match the current plan');
  }
  return records;
}

function expansionRequestDigest(request: ExpansionRequestV03): string {
  return hashContextJson(request);
}

function storedExpansionDigest(request: ExpansionRequestV03, decision: ExpansionDecisionV03): string {
  return hashContextJson({ schema_version: '0.3', request, decision });
}

function expansionLedgerDigest(
  taskId: string,
  baseSelectionDigest: string,
  records: readonly StoredExpansionV03[],
): string {
  return hashContextJson({
    schema_version: '0.3',
    task_id: taskId,
    base_selection_digest: baseSelectionDigest,
    record_digests: records.map((record) => record.record_digest),
  });
}

async function readValidatedIndexManifest(
  root: string,
  config: PrimeContextConfig,
  expected: ContextSnapshotV03,
): Promise<ContextIndexManifestV03> {
  const value = await readInternalJsonBounded(root, manifestRelativePath(root, config));
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PrimeContextError('STATE_ERROR', 'Context index manifest is invalid');
  }
  const manifest = value as Partial<ContextIndexManifestV03>;
  if (manifest.schema_version !== '0.3'
      || manifest.repository_id !== expected.repository_id
      || manifest.worktree_digest !== expected.worktree_digest
      || manifest.accepted_source_digest !== expected.worktree_digest
      || manifest.schema_identity !== CONTEXT_INDEX_SCHEMA_IDENTITY
      || manifest.policy_identity !== contextIndexPolicyIdentity(config)
      || !/^sha256:[0-9a-f]{64}$/.test(String(manifest.toolchain_identity))
      || !/^sha256:[0-9a-f]{64}$/.test(String(manifest.index_digest))
      || manifest.index_path !== indexRelativePath(root, config)
      || !Number.isSafeInteger(manifest.indexed_source_count)
      || (manifest.indexed_source_count as number) < 0
      || typeof manifest.secure_delete !== 'boolean'
      || typeof manifest.fts_secure_delete !== 'boolean'
      || typeof manifest.provenance !== 'object'
      || manifest.provenance === null
      || !Array.isArray(manifest.source_failures)
      || typeof manifest.manifest_digest !== 'string') {
    throw new PrimeContextError('FRESHNESS_ERROR', 'Context index manifest does not match the live accepted-source snapshot');
  }
  const { manifest_digest: suppliedDigest, ...withoutDigest } = manifest as ContextIndexManifestV03;
  if (suppliedDigest !== hashContextJson(withoutDigest)) {
    throw new PrimeContextError('STATE_ERROR', 'Context index manifest digest does not match its content');
  }
  return structuredClone(manifest as ContextIndexManifestV03);
}

function assertManifestToolchain(
  config: PrimeContextConfig,
  live: CollectedContextSources,
  manifest: ContextIndexManifestV03,
  sqliteToolchain: SqliteFtsToolchainV03,
): void {
  if (manifest.toolchain_identity !== contextIndexToolchainIdentity(live, sqliteToolchain)) {
    throw new PrimeContextError('FRESHNESS_ERROR', 'Context index toolchain identity is stale');
  }
  const expectedProvenance = contextToolchainProvenance(config, live, {
    toolchain: sqliteToolchain,
    secure_delete: manifest.secure_delete,
    fts_secure_delete: manifest.fts_secure_delete,
  });
  if (hashContextJson(manifest.provenance) !== hashContextJson(expectedProvenance)) {
    throw new PrimeContextError('FRESHNESS_ERROR', 'Context index provenance is stale');
  }
}

export async function createContextPreparationObservation(
  root: string,
): Promise<ContextPreparationObservationV03> {
  const resolvedRoot = resolve(root);
  const config = await loadProtectedContextConfig(resolvedRoot);
  const live = await collectContextSources(resolvedRoot, config);
  const observation = { resolved_root: resolvedRoot, config, live };
  contextPreparationObservationBindings.set(
    observation,
    contextPreparationObservationIdentity(observation),
  );
  return observation;
}

function assertedObservation(
  root: string,
  observation: ContextPreparationObservationV03,
): ContextPreparationObservationV03 {
  const resolvedRoot = resolve(root);
  if (observation.resolved_root !== resolvedRoot) {
    throw new PrimeContextError('FRESHNESS_ERROR', 'Context observation belongs to a different repository');
  }
  const expectedBinding = contextPreparationObservationBindings.get(observation);
  if (expectedBinding === undefined) {
    throw new PrimeContextError('FRESHNESS_ERROR', 'Context observation is not bound to this preparation session');
  }
  try {
    const asserted = structuredClone(observation);
    screenedFilesystemOmissions.set(asserted.live, {
      paths: new Set(screenedFilesystemOmissions.get(observation.live)?.paths ?? []),
    });
    if (contextPreparationObservationIdentity(asserted) !== expectedBinding) {
      throw new PrimeContextError('FRESHNESS_ERROR', 'Context observation changed after discovery');
    }
    return asserted;
  } catch (error) {
    if (error instanceof PrimeContextError && error.code === 'FRESHNESS_ERROR') throw error;
    throw new PrimeContextError('FRESHNESS_ERROR', 'Context observation changed after discovery');
  }
}

function indexResultFromManifest(
  live: CollectedContextSources,
  manifest: ContextIndexManifestV03,
  reused: boolean,
  fallbackUsed: boolean,
  sourceFailures = manifest.source_failures,
): ContextIndexCommandResult {
  return {
    repository_id: live.repository_id,
    ...(live.snapshot.head ? { head: live.snapshot.head } : {}),
    index_path: manifest.index_path,
    index_digest: manifest.index_digest,
    worktree_digest: manifest.worktree_digest,
    accepted_source_digest: manifest.accepted_source_digest,
    indexed_source_count: manifest.indexed_source_count,
    document_source_count: manifest.document_source_count,
    code_file_count: manifest.code_file_count,
    code_symbol_count: manifest.code_symbol_count,
    secure_delete: manifest.secure_delete,
    fts_secure_delete: manifest.fts_secure_delete,
    manifest_digest: manifest.manifest_digest,
    fallback_used: fallbackUsed,
    reused,
    provenance: structuredClone(manifest.provenance),
    source_failures: structuredClone(sourceFailures),
  };
}

export async function contextIndexCommand(
  root: string,
  observation?: ContextPreparationObservationV03,
): Promise<ContextIndexCommandResult> {
  const resolvedRoot = resolve(root);
  const observed = observation
    ? assertedObservation(resolvedRoot, observation)
    : await createContextPreparationObservation(resolvedRoot);
  const { config } = observed;
  await matchingProtectedContextConfig(resolvedRoot, config);
  const stateLock = stateRelativePath(resolvedRoot, config, 'context/index-state.lock');
  return withInternalExclusiveLock(resolvedRoot, stateLock, async () => {
    const { live } = observed;
    await assertPhysicalSourcesFresh(resolvedRoot, live.hybrid_sources);
    await assertAcceptedSourceManifestFresh(resolvedRoot, config, live);
    const relativeIndex = indexRelativePath(resolvedRoot, config);
    const stateDirectory = repositoryRelativePath(resolvedRoot, config.state_dir, 'state_dir');
    try {
      const manifest = await readValidatedIndexManifest(resolvedRoot, config, live.snapshot);
      const probe = await withOptionalAdapterTimeout(
        'SQLite FTS current-index verification',
        (signal) => new NodeSqliteFtsAdapter().search(
          resolvedRoot,
          relativeIndex,
          'primecontext current index probe',
          { state_dir: stateDirectory, limit: 1, expected_worktree_digest: live.snapshot.worktree_digest, signal },
        ),
      );
      if (probe.index_digest !== manifest.index_digest
          || probe.repository_id !== manifest.repository_id
          || probe.worktree_digest !== manifest.worktree_digest) {
        throw new PrimeContextError('STATE_ERROR', 'Current FTS index does not match its validated manifest');
      }
      assertManifestToolchain(config, live, manifest, probe.toolchain);
      return indexResultFromManifest(live, manifest, true, false);
    } catch (error) {
      if (error instanceof PrimeContextError && error.code === 'SECURITY_ERROR') throw error;
    }
    let rebuilt: {
      index_path: string; index_digest: string; worktree_digest: string;
      indexed_source_count: number; secure_delete: boolean; fts_secure_delete: boolean;
      toolchain?: SqliteFtsToolchainV03;
    };
    let fallbackUsed = false;
    const indexRollback = await captureInternalFileRollback(
      resolvedRoot,
      relativeIndex,
      MAX_CONTEXT_INDEX_BYTES,
    );
    try {
      rebuilt = await withOptionalAdapterTimeout(
        'SQLite FTS rebuild',
        (signal) => new NodeSqliteFtsAdapter().rebuild(
          resolvedRoot,
          relativeIndex,
          live.hybrid_sources,
          { repository_id: live.repository_id, worktree_digest: live.snapshot.worktree_digest },
          { state_dir: stateDirectory, signal },
        ),
      );
    } catch (error) {
      try {
        await restoreInternalFileRollback(resolvedRoot, indexRollback);
      } catch (rollbackError) {
        throw new PrimeContextError('STATE_ERROR', 'Unable to restore the prior FTS index after rebuild failure', [
          rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
        ]);
      }
      if (error instanceof PrimeContextError && error.code === 'SECURITY_ERROR') throw error;
      if (!(error instanceof PrimeContextError)
          || !['CAPABILITY_ERROR', 'CATALOG_ERROR', 'STATE_ERROR'].includes(error.code)) {
        throw error;
      }
      const fallbackFailure: ContextSourceFailureV03 = {
        provider: 'fts', code: 'OPTIONAL_SOURCE_UNAVAILABLE',
        message: error.code,
        security_control: false,
      };
      try {
        const preserved = await readValidatedIndexManifest(resolvedRoot, config, live.snapshot);
        const probe = await withOptionalAdapterTimeout(
          'SQLite FTS preserved-index verification',
          (signal) => new NodeSqliteFtsAdapter().search(
            resolvedRoot,
            relativeIndex,
            'primecontext preservation probe',
            { state_dir: stateDirectory, limit: 1, expected_worktree_digest: live.snapshot.worktree_digest, signal },
          ),
        );
        if (probe.index_digest !== preserved.index_digest
            || probe.repository_id !== preserved.repository_id
            || probe.worktree_digest !== preserved.worktree_digest) {
          throw new PrimeContextError('STATE_ERROR', 'Preserved FTS index does not match its manifest');
        }
        assertManifestToolchain(config, live, preserved, probe.toolchain);
        return indexResultFromManifest(
          live,
          preserved,
          true,
          true,
          [...live.source_failures, fallbackFailure],
        );
      } catch (preservationError) {
        if (preservationError instanceof PrimeContextError
            && preservationError.code === 'SECURITY_ERROR') throw preservationError;
      }
      fallbackUsed = true;
      live.source_failures.push(fallbackFailure);
      rebuilt = {
        index_path: relativeIndex,
        index_digest: hashContextText('fts-unavailable'),
        worktree_digest: live.snapshot.worktree_digest,
        indexed_source_count: 0,
        secure_delete: false,
        fts_secure_delete: false,
      };
    }
    const manifestWithoutDigest = {
      schema_version: '0.3' as const, repository_id: live.repository_id,
      worktree_digest: live.snapshot.worktree_digest, index_digest: rebuilt.index_digest,
      accepted_source_digest: live.snapshot.worktree_digest,
      schema_identity: CONTEXT_INDEX_SCHEMA_IDENTITY,
      policy_identity: contextIndexPolicyIdentity(config),
      toolchain_identity: contextIndexToolchainIdentity(live, rebuilt.toolchain),
      index_path: rebuilt.index_path, indexed_source_count: rebuilt.indexed_source_count,
      document_source_count: live.documents.sources.length,
      code_file_count: live.graph?.files.length ?? 0, code_symbol_count: live.graph?.nodes.length ?? 0,
      graph_digest: live.graph?.graph_digest ?? hashContextText('codegraph-unavailable'),
      ...(live.graph ? { graph_summary: live.graph.summary } : {}),
      secure_delete: rebuilt.secure_delete, fts_secure_delete: rebuilt.fts_secure_delete,
      provenance: contextToolchainProvenance(config, live, {
        ...(rebuilt.toolchain ? { toolchain: rebuilt.toolchain } : {}),
        secure_delete: rebuilt.secure_delete,
        fts_secure_delete: rebuilt.fts_secure_delete,
      }),
      source_failures: live.source_failures,
    };
    const manifest: ContextIndexManifestV03 = {
      ...manifestWithoutDigest,
      manifest_digest: hashContextJson(manifestWithoutDigest),
    };
    try {
      await assertAcceptedSourceManifestFresh(resolvedRoot, config, live);
      await writeInternalTextAtomic(
        resolvedRoot,
        manifestRelativePath(resolvedRoot, config),
        serializeArtifact(manifest),
      );
    } catch (error) {
      try {
        await restoreInternalFileRollback(resolvedRoot, indexRollback);
      } catch (rollbackError) {
        throw new PrimeContextError('STATE_ERROR', 'Context index manifest failed and the prior FTS index could not be restored', [
          error instanceof Error ? error.message : String(error),
          rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
        ]);
      }
      throw error;
    }
    try {
      await discardInternalFileRollback(resolvedRoot, indexRollback);
    } catch {
      // The published database/manifest pair is valid; an orphaned private rollback file is safer than a false failure.
    }
    return {
      repository_id: live.repository_id,
      ...(live.snapshot.head ? { head: live.snapshot.head } : {}),
      index_path: rebuilt.index_path, index_digest: rebuilt.index_digest,
      worktree_digest: rebuilt.worktree_digest, accepted_source_digest: live.snapshot.worktree_digest,
      indexed_source_count: rebuilt.indexed_source_count,
      document_source_count: live.documents.sources.length, code_file_count: live.graph?.files.length ?? 0,
      code_symbol_count: live.graph?.nodes.length ?? 0, secure_delete: rebuilt.secure_delete,
      fts_secure_delete: rebuilt.fts_secure_delete, manifest_digest: manifest.manifest_digest,
      fallback_used: fallbackUsed, reused: false,
      provenance: structuredClone(manifest.provenance),
      source_failures: structuredClone(live.source_failures),
    };
  });
}

export async function contextPlanCommand(root: string, fromFile: string): Promise<ContextPlanCommandResult> {
  if (fromFile !== '-') assertRepositoryInputPath(fromFile);
  const resolvedRoot = resolve(root);
  const parsed = await readCommandJsonInput(resolvedRoot, fromFile);
  const validation = validateContextPlanRequest(parsed);
  if (!validation.valid) throw new PrimeContextError('VALIDATION_ERROR', 'Invalid ContextPlanRequest', validation.errors);
  const prepared = await compilePreparedContext(resolvedRoot, structuredClone(parsed) as ContextPlanRequestV03);
  return {
    task_id: prepared.request.task.task_id, evidence_status: prepared.envelope.evidence_status,
    budget_status: prepared.envelope.budget_status,
    selection_digest: prepared.envelope.selection_digest,
    receipt_digest: prepared.receipt.receipt_digest,
    selected_count: prepared.envelope.items.length, plan_path: prepared.plan_path,
  };
}

export async function prepareContextRequest(
  root: string,
  intent: import('@primecontext/schemas').ContextIntentV03,
  observation?: ContextPreparationObservationV03,
): Promise<ContextPlanRequestV03> {
  const resolvedRoot = resolve(root);
  const observed = observation
    ? assertedObservation(resolvedRoot, observation)
    : await createContextPreparationObservation(resolvedRoot);
  const { config, live } = observed;
  const tokenBudget = Math.min(1_000_000, config.budgets[intent.task_type].initial_tokens);
  const softTokenBudget = Math.min(
    1_000_000,
    Math.max(tokenBudget, config.budgets[intent.task_type].soft_limit_tokens),
  );
  const hardTokenBudget = Math.min(
    1_000_000,
    Math.max(softTokenBudget, config.budgets[intent.task_type].hard_limit_tokens),
  );
  const sortedUnique = (values: string[] | undefined): string[] | undefined => {
    if (!values) return undefined;
    return [...new Set(values)].sort(ordinal);
  };
  const paths = sortedUnique(intent.paths);
  const symbols = sortedUnique(intent.symbols);
  const terms = sortedUnique(intent.terms);
  const requiredSources = sortedUnique(intent.required_sources);
  const request: ContextPlanRequestV03 = {
    schema_version: '0.3',
    task: {
      task_id: intent.task_id,
      task_type: intent.task_type,
      goal: intent.goal,
      query: intent.query ?? intent.goal,
      acceptance_criteria: intent.acceptance.map((text, index) => ({
        id: `AC-${String(index + 1).padStart(3, '0')}`,
        text,
      })),
      ...((paths || symbols || terms) ? {
        hints: {
          ...(paths ? { paths } : {}),
          ...(symbols ? { symbols } : {}),
          ...(terms ? { terms } : {}),
        },
      } : {}),
    },
    budget: {
      max_items: 32,
      max_bytes: Math.min(8 * 1024 * 1024, tokenBudget * 4),
      max_estimated_tokens: tokenBudget,
    },
    progressive_budget: {
      soft: {
        max_items: 64,
        max_bytes: Math.min(8 * 1024 * 1024, softTokenBudget * 4),
        max_estimated_tokens: softTokenBudget,
      },
      hard: {
        max_items: 128,
        max_bytes: Math.min(8 * 1024 * 1024, hardTokenBudget * 4),
        max_estimated_tokens: hardTokenBudget,
      },
    },
    snapshot: structuredClone(live.snapshot),
    policy_version: '0.3-default',
    ...(requiredSources ? { required_sources: requiredSources } : {}),
  };
  const validation = validateContextPlanRequest(request);
  if (!validation.valid) throw new PrimeContextError('VALIDATION_ERROR', 'Generated ContextPlanRequest is invalid', validation.errors);
  return request;
}

export async function compilePreparedContext(
  root: string,
  request: ContextPlanRequestV03,
  observation?: ContextPreparationObservationV03,
): Promise<PreparedContextResultV03> {
  const resolvedRoot = resolve(root);
  const observed = observation
    ? assertedObservation(resolvedRoot, observation)
    : await createContextPreparationObservation(resolvedRoot);
  const { config, live } = observed;
  await matchingProtectedContextConfig(resolvedRoot, config);
  const boundedRequest = await applyPlanPolicyLimits(resolvedRoot, config, structuredClone(request));
  assertRequestedSnapshot(boundedRequest, live.snapshot);
  const collected = await collectPlanCandidates(resolvedRoot, config, boundedRequest, live);
  const contextPackage = compileContext(boundedRequest, collected.candidates, collected.failures);
  await assertEnvelopePhysicalSourcesFresh(resolvedRoot, contextPackage.envelope, live);
  await matchingProtectedContextConfig(resolvedRoot, config);
  const stateLock = stateRelativePath(resolvedRoot, config, `context/plans/${boundedRequest.task.task_id}/state.lock`);
  const planPath = await withInternalExclusiveLock(resolvedRoot, stateLock, async () => {
    await assertAcceptedSourceManifestFresh(resolvedRoot, config, live);
    const ledgerPath = expansionRelativePath(resolvedRoot, config, boundedRequest.task.task_id);
    const previousLedger = await readInternalText(resolvedRoot, ledgerPath, MAX_CONTEXT_ARTIFACT_BYTES, { allowMissing: true });
    if (previousLedger !== undefined) await writeInternalTextAtomic(resolvedRoot, ledgerPath, '');
    try {
      return await replaceStoredPlan(resolvedRoot, config, boundedRequest, contextPackage);
    } catch (error) {
      if (previousLedger !== undefined) await writeInternalTextAtomic(resolvedRoot, ledgerPath, previousLedger);
      throw error;
    }
  });
  return {
    request: structuredClone(boundedRequest),
    envelope: structuredClone(contextPackage.envelope),
    receipt: structuredClone(contextPackage.receipt),
    plan_path: planPath,
  };
}

export async function contextInspectCommand(root: string, taskId: string): Promise<StoredContextPlanV03> {
  assertTaskId(taskId);
  const resolvedRoot = resolve(root);
  const config = await loadProtectedContextConfig(resolvedRoot);
  return readStoredPlan(resolvedRoot, config, taskId);
}

export async function contextExpandCommand(
  root: string,
  taskId: string,
  fromFile: string,
): Promise<{ decision: ExpansionDecisionV03; selection_digest: string }> {
  assertTaskId(taskId);
  if (fromFile !== '-') assertRepositoryInputPath(fromFile);
  const resolvedRoot = resolve(root);
  const parsed = await readCommandJsonInput(resolvedRoot, fromFile);
  const validation = validateExpansionRequest(parsed);
  if (!validation.valid) throw new PrimeContextError('VALIDATION_ERROR', 'Invalid ExpansionRequest', validation.errors);
  const expansion = structuredClone(parsed) as ExpansionRequestV03;
  if (expansion.task_id !== taskId) throw new PrimeContextError('VALIDATION_ERROR', 'Expansion task id does not match argv');
  const config = await loadProtectedContextConfig(resolvedRoot);
  const stateLock = stateRelativePath(resolvedRoot, config, `context/plans/${taskId}/state.lock`);
  return withInternalExclusiveLock(resolvedRoot, stateLock, async () => {
    const stored = await readStoredPlan(resolvedRoot, config, taskId);
    const expansions = await readStoredExpansions(resolvedRoot, config, taskId, stored);
    const requestDigest = expansionRequestDigest(expansion);
    const replayed = expansions.find((item) => expansionRequestDigest(item.request) === requestDigest);
    if (replayed) {
      if (replayed.decision.selection_digest !== stored.envelope.selection_digest) {
        const stale = expandContext(
          { envelope: stored.envelope, receipt: stored.receipt },
          stored.request,
          expansion,
          [],
        );
        return { decision: stale.decision, selection_digest: stale.package.envelope.selection_digest };
      }
      return { decision: replayed.decision, selection_digest: replayed.decision.selection_digest };
    }
    if (expansion.previous_selection_digest !== stored.envelope.selection_digest
        || stored.envelope.items.some((item) => !expansion.known_candidate_ids.includes(item.id))) {
      const stale = expandContext(
        { envelope: stored.envelope, receipt: stored.receipt },
        stored.request,
        expansion,
        [],
      );
      return { decision: stale.decision, selection_digest: stale.package.envelope.selection_digest };
    }
    if (expansions.length >= 8) throw new PrimeContextError('STATE_ERROR', 'Context expansion count limit exceeded');
    const live = await collectContextSources(resolvedRoot, config);
    assertRequestedSnapshot(stored.request, live.snapshot);
    const query = [...expansion.requested_terms, ...expansion.requested_symbols, ...expansion.requested_paths].join(' ').trim()
      || stored.request.task.query;
    const collected = await collectPlanCandidates(resolvedRoot, config, stored.request, live, query, expansion);
    const expanded = expandContext(
      { envelope: stored.envelope, receipt: stored.receipt },
      stored.request,
      expansion,
      collected.candidates.filter((candidate) => !expansion.known_candidate_ids.includes(candidate.id)),
      collected.failures,
    );
    await assertEnvelopePhysicalSourcesFresh(resolvedRoot, expanded.package.envelope, live);
    await assertAcceptedSourceManifestFresh(resolvedRoot, config, live);
    const ledgerPath = expansionRelativePath(resolvedRoot, config, taskId);
    const previousLedger = await readInternalText(resolvedRoot, ledgerPath, MAX_CONTEXT_ARTIFACT_BYTES, { allowMissing: true });
    const storedExpansion: StoredExpansionV03 = {
      schema_version: '0.3', request: expansion, decision: expanded.decision,
      record_digest: storedExpansionDigest(expansion, expanded.decision),
    };
    await appendValidatedJsonLine(
      resolvedRoot,
      ledgerPath,
      storedExpansion,
      validateStoredExpansion,
    );
    try {
      await replaceStoredPlan(resolvedRoot, config, stored.request, expanded.package, {
        base_selection_digest: stored.base_selection_digest,
        expansion_ledger_digest: expansionLedgerDigest(
          taskId,
          stored.base_selection_digest,
          [...expansions, storedExpansion],
        ),
      });
    } catch (error) {
      await writeInternalTextAtomic(resolvedRoot, ledgerPath, previousLedger ?? '');
      throw error;
    }
    return { decision: expanded.decision, selection_digest: expanded.package.envelope.selection_digest };
  });
}

export async function contextOutcomeCommand(
  root: string,
  taskId: string,
  fromFile: string,
): Promise<{ outcome_path: string; receipt: OutcomeReceiptV03; ledger_digest: string }> {
  assertTaskId(taskId);
  if (fromFile !== '-') assertRepositoryInputPath(fromFile);
  const resolvedRoot = resolve(root);
  const input = await readCommandJsonInput(resolvedRoot, fromFile);
  const config = await loadProtectedContextConfig(resolvedRoot);
  const stored = await readStoredPlan(resolvedRoot, config, taskId);
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new PrimeContextError('VALIDATION_ERROR', 'Outcome input must be an object');
  }
  const typed = input as ContextOutcomeInputV03;
  const selectedIds = new Set(stored.envelope.items.map((item) => item.id));
  if (typed.task_id !== taskId || typed.selection_digest !== stored.envelope.selection_digest
      || hashContextJson(typed.snapshot) !== hashContextJson(stored.envelope.snapshot)
      || !Array.isArray(typed.used_candidate_ids)
      || typed.used_candidate_ids.some((id) => !selectedIds.has(id))) {
    throw new PrimeContextError('STATE_ERROR', 'Outcome does not link the stored context selection');
  }
  const receipt = recordContextOutcome(typed);
  const path = outcomeRelativePath(resolvedRoot, config, taskId);
  const ledgerDigest = await appendOutcomeReceipt(resolvedRoot, path, taskId, receipt);
  return { outcome_path: path, receipt, ledger_digest: ledgerDigest };
}

export async function contextReplayCommand(root: string, taskId: string) {
  assertTaskId(taskId);
  const resolvedRoot = resolve(root);
  const config = await loadProtectedContextConfig(resolvedRoot);
  const stored = await readStoredPlan(resolvedRoot, config, taskId);
  const expansions = await readStoredExpansions(resolvedRoot, config, taskId, stored);
  let current: TaskContextPackageV03 | undefined;
  const failures: ContextSourceFailureV03[] = [];
  try {
    const live = await collectContextSources(resolvedRoot, config);
    if (stored.request.snapshot.head !== undefined && live.snapshot.head === undefined) {
      failures.push(
        ...live.source_failures,
        {
          provider: 'git', code: 'REPLAY_HEAD_UNAVAILABLE',
          message: 'Stored replay snapshot requires Git HEAD but live Git metadata is unavailable',
          security_control: false,
        },
      );
    } else {
      const replaySnapshot: ContextSnapshotV03 = {
        repository_id: live.snapshot.repository_id,
        worktree_digest: live.snapshot.worktree_digest,
        ...(stored.request.snapshot.head !== undefined && live.snapshot.head !== undefined
          ? { head: live.snapshot.head }
          : {}),
      };
      const replayRequest: ContextPlanRequestV03 = { ...stored.request, snapshot: replaySnapshot };
      const collected = await collectPlanCandidates(resolvedRoot, config, replayRequest, live);
      failures.push(...collected.failures);
      current = compileContext(replayRequest, collected.candidates, collected.failures);
      for (const expansion of expansions) {
        const query = [
          ...expansion.request.requested_terms,
          ...expansion.request.requested_symbols,
          ...expansion.request.requested_paths,
        ].join(' ').trim() || replayRequest.task.query;
        const expansionCandidates = await collectPlanCandidates(resolvedRoot, config, replayRequest, live, query, expansion.request);
        failures.push(...expansionCandidates.failures);
        const replayed = expandContext(
          current,
          replayRequest,
          expansion.request,
          expansionCandidates.candidates.filter((candidate) => !expansion.request.known_candidate_ids.includes(candidate.id)),
          expansionCandidates.failures,
        );
        if (replayed.decision.selection_digest !== expansion.decision.selection_digest
            || hashContextJson(replayed.decision) !== hashContextJson(expansion.decision)) {
          throw new PrimeContextError('FRESHNESS_ERROR', 'Expansion replay no longer matches its stored decision');
        }
        current = replayed.package;
      }
    }
  } catch (error) {
    if (error instanceof PrimeContextError && (error.code === 'SECURITY_ERROR' || error.code === 'STATE_ERROR')) throw error;
    failures.push({
      provider: 'filesystem', code: 'REPLAY_UNAVAILABLE',
      message: error instanceof PrimeContextError ? error.code : 'replay collection failed', security_control: false,
    });
  }
  const result = compareContextReplay(stored.envelope, current, failures);
  await writeInternalTextAtomic(
    resolvedRoot,
    experimentRelativePath(resolvedRoot, config, taskId, `replay-${result.replay_digest.slice(7, 23)}`),
    serializeArtifact(result),
  );
  return result;
}

export async function contextAblateCommand(root: string, taskId: string, candidateId: string) {
  assertTaskId(taskId);
  if (!/^sha256:[0-9a-f]{64}$/.test(candidateId)) {
    throw new PrimeContextError('VALIDATION_ERROR', 'Ablation candidate must be a lowercase SHA-256 id');
  }
  const resolvedRoot = resolve(root);
  const config = await loadProtectedContextConfig(resolvedRoot);
  const stored = await readStoredPlan(resolvedRoot, config, taskId);
  const result = ablateContext(stored.envelope, {
    schema_version: '0.3', task_id: taskId,
    selection_digest: stored.envelope.selection_digest, candidate_id: candidateId,
  });
  await writeInternalTextAtomic(
    resolvedRoot,
    experimentRelativePath(resolvedRoot, config, taskId, `ablation-${candidateId.slice(7, 23)}`),
    serializeArtifact(result),
  );
  return result;
}
