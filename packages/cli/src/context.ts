import { basename, isAbsolute, resolve } from 'node:path';
import {
  assertValidLocalCodeGraphV03,
  isSensitiveDocumentContent,
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
import { generateRepoMap } from '@primecontext/repo-map';
import {
  isValidTaskId,
  type ContextSnapshotV03,
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
const FILESYSTEM_EXTENSIONS = new Set([
  '.c', '.cc', '.cjs', '.cpp', '.cs', '.css', '.cts', '.go', '.h', '.hpp', '.html', '.java', '.js', '.jsx',
  '.kt', '.kts', '.php', '.ps1', '.py', '.rb', '.rs', '.sh', '.sql', '.swift', '.toml', '.tsx',
  '.md', '.mdx', '.mjs', '.mts', '.ts', '.vue', '.xml', '.yaml', '.yml',
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

interface CollectedContextSources {
  repository_id: string;
  snapshot: ContextSnapshotV03;
  documents: DocumentSourceCollectionResult;
  graph: LocalCodeGraphV03 | undefined;
  repo_map: SemanticRepoMap;
  git: GitState | undefined;
  source_failures: ContextSourceFailureV03[];
  filesystem_sources: HybridIndexSourceV03[];
  hybrid_sources: HybridIndexSourceV03[];
}

export interface ContextIndexCommandResult {
  repository_id: string;
  head?: string;
  index_path: string;
  index_digest: string;
  worktree_digest: string;
  indexed_source_count: number;
  document_source_count: number;
  code_file_count: number;
  code_symbol_count: number;
  secure_delete: boolean;
  fts_secure_delete: boolean;
  manifest_digest: string;
  fallback_used: boolean;
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

function normalizeTerms(value: string): string[] {
  return [...new Set(value.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [])]
    .filter(Boolean)
    .sort(ordinal)
    .slice(0, 128);
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)].sort(ordinal);
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

async function withOptionalAdapterTimeout<T>(label: string, operation: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new PrimeContextError('CAPABILITY_ERROR', `${label} exceeded the 30 second optional-adapter timeout`)), OPTIONAL_ADAPTER_TIMEOUT_MS);
        timeout.unref?.();
      }),
    ]);
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
  const lower = value.normalize('NFKC').toLowerCase();
  let anchor = -1;
  for (const term of normalizedTerms) {
    const index = lower.indexOf(term);
    if (index >= 0 && (anchor < 0 || index < anchor)) anchor = index;
  }
  if (anchor < 0) return boundedExcerpt(value, maximumBytes);
  if (valueLines.length > MAX_EXCERPT_LINES) {
    const prefixLineCount = value.slice(0, anchor).split(/\r?\n/u).length - 1;
    const startLine = Math.max(0, prefixLineCount - Math.floor(MAX_EXCERPT_LINES / 3));
    return boundedExcerpt(valueLines.slice(startLine, startLine + MAX_EXCERPT_LINES).join('\n'), maximumBytes);
  }
  if (new TextEncoder().encode(value).byteLength <= maximumBytes) return boundedExcerpt(value, maximumBytes);
  const characters = [...value];
  const prefixCharacters = [...value.slice(0, anchor)].length;
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

function graphHybridSources(graph: LocalCodeGraphV03): HybridIndexSourceV03[] {
  const nodesByPath = new Map<string, LocalCodeGraphV03['nodes']>();
  for (const node of graph.nodes) {
    const values = nodesByPath.get(node.locator.path) ?? [];
    values.push(node);
    nodesByPath.set(node.locator.path, values);
  }
  const sources: HybridIndexSourceV03[] = [];
  for (const file of graph.files) {
    const nodes = (nodesByPath.get(file.path) ?? []).sort((left, right) => (
      left.locator.start_line - right.locator.start_line || ordinal(left.id, right.id)
    ));
    if (nodes.length === 0) continue;
    const content = boundedExcerpt(nodes.map((node) => node.excerpt).join('\n\n'), 1024 * 1024);
    if (isSensitiveDocumentContent(content)) {
      throw new PrimeContextError('SECURITY_ERROR', 'Sensitive CodeGraph content cannot enter the hybrid index');
    }
    const isTest = /(?:^|\/)(?:test|tests|__tests__)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(file.path);
    sources.push({
      path: file.path,
      kind: isTest ? 'test' : 'code',
      authority: isTest ? 'test' : 'source_code',
      source_hash: hashContextText(content),
      content,
      title: basename(file.path),
    });
  }
  return sources.sort((left, right) => ordinal(left.path, right.path));
}

function filesystemKind(path: string): HybridIndexSourceV03['kind'] {
  if (/(?:^|\/)(?:test|tests|__tests__)(?:\/|$)|\.(?:test|spec)\.[^./]+$/i.test(path)) return 'test';
  if (/(?:^|\/)(?:config|configuration)(?:\/|$)|\.(?:json|toml|ya?ml)$/i.test(path)) return 'configuration';
  return 'code';
}

async function collectFilesystemFallbackSources(
  root: string,
  fileSystem: NodeFileSystemAdapter,
  documents: DocumentSourceCollectionResult,
): Promise<HybridIndexSourceV03[]> {
  const walk = await fileSystem.walk(root);
  const documentPaths = new Set(documents.sources.map((source) => source.relative_path));
  const candidates = walk.paths.filter((entry) => (
    entry.kind === 'file'
    && FILESYSTEM_EXTENSIONS.has(entry.relative_path.slice(entry.relative_path.lastIndexOf('.')).toLowerCase())
    && !documentPaths.has(entry.relative_path)
  )).sort((left, right) => ordinal(left.relative_path, right.relative_path));
  const sources: HybridIndexSourceV03[] = [];
  let acceptedBytes = 0;
  for (const candidate of candidates) {
    if (sources.length >= MAX_FILESYSTEM_CANDIDATES) {
      throw new PrimeContextError('CAPABILITY_ERROR', 'Safe filesystem fallback source-count limit exceeded');
    }
    if ((candidate.size_bytes ?? 0) > MAX_FILESYSTEM_SOURCE_BYTES) continue;
    const source = await readSafeRepositoryText(root, candidate.relative_path, MAX_FILESYSTEM_SOURCE_BYTES);
    if (!source) continue;
    acceptedBytes += source.size_bytes;
    if (!Number.isSafeInteger(acceptedBytes) || acceptedBytes > MAX_FILESYSTEM_TOTAL_BYTES) {
      throw new PrimeContextError('CAPABILITY_ERROR', 'Safe filesystem fallback total byte limit exceeded');
    }
    const kind = filesystemKind(candidate.relative_path);
    sources.push({
      path: candidate.relative_path, kind,
      authority: kind === 'test' ? 'test' : kind === 'configuration' ? 'configuration' : 'source_code',
      source_hash: source.source_hash, content: source.content, title: basename(candidate.relative_path),
    });
  }
  return sources;
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
  const documents = await new NodeDocumentSourceAdapter(excludes).collect(root);
  const sourceFailures: ContextSourceFailureV03[] = [];
  const fileSystem = new NodeFileSystemAdapter(excludes);
  const gitAdapter = new NodeGitAdapter();
  const [git, repoMap] = await Promise.all([
    gitAdapter.inspect(root),
    generateRepoMap(root, fileSystem, gitAdapter),
  ]);
  const filesystemSources = await collectFilesystemFallbackSources(root, fileSystem, documents);
  const repositoryId = basename(resolve(root));
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
      new NodeCodeGraphAdapter(excludes).collect(root, {
        snapshot,
        accepted_sources: acceptedCodeSources,
      }),
    );
  } catch (error) {
    if (error instanceof PrimeContextError && error.code === 'SECURITY_ERROR') throw error;
    sourceFailures.push({
      provider: 'codegraph', code: 'OPTIONAL_SOURCE_UNAVAILABLE',
      message: error instanceof PrimeContextError ? error.code : 'local CodeGraph source unavailable',
      security_control: false,
    });
  }
  return {
    repository_id: repositoryId,
    snapshot,
    documents,
    graph,
    repo_map: repoMap,
    git,
    source_failures: sourceFailures,
    filesystem_sources: filesystemSources,
    hybrid_sources: [
      ...documents.sources.map(documentHybridSource),
      ...filesystemSources,
    ].sort((left, right) => ordinal(left.path, right.path)),
  };
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
    discovery: { ...signalEvidence(content, request), truncated: bytes < new TextEncoder().encode(content).byteLength },
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
    discovery: { ...signals, truncated: false },
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
  const contentTerms = new Set(normalizeTerms(text));
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

function documentCandidates(
  collection: DocumentSourceCollectionResult,
  request: ContextPlanRequestV03,
): ContextCandidateV03[] {
  const candidates: ContextCandidateV03[] = [];
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
    const signals = signalEvidence(`${source.relative_path} ${source.metadata.title} ${excerpt}`, request);
    if (signals.matched_terms.length === 0 && source.metadata.authority !== 'policy'
        && !(request.required_sources ?? []).includes(source.relative_path)) continue;
    eligibleSourceCount += 1;
    if (candidates.length >= MAX_DOCUMENT_CANDIDATES) continue;
    const bytes = new TextEncoder().encode(excerpt).byteLength;
    candidates.push(finishCandidate({
      schema_version: '0.3', kind: 'document', provider: 'documents', path: source.relative_path,
      source_hash: source.source_hash, excerpt_hash: hashContextText(excerpt), snapshot: request.snapshot,
      freshness: 'live', observed_size_bytes: source.size_bytes, authority: source.metadata.authority,
      authority_evidence: [source.authority_basis.kind === 'convention'
        ? `convention:${source.authority_basis.rule_id}` : 'document-default'],
      excerpt, excerpt_bytes: bytes, estimated_tokens: Math.ceil(bytes / 4),
      discovery: { ...signals, truncated: bytes < source.size_bytes },
    }));
  }
  const sourceWasTruncated = eligibleSourceCount > candidates.length;
  return candidates.map((candidate) => ({
    ...candidate,
    discovery: {
      ...candidate.discovery,
      truncated: candidate.discovery.truncated || sourceWasTruncated,
    },
  }));
}

function filesystemCandidates(
  sources: HybridIndexSourceV03[],
  request: ContextPlanRequestV03,
): ContextCandidateV03[] {
  const candidates: ContextCandidateV03[] = [];
  for (const source of sources) {
    const excerpt = boundedRelevantExcerpt(source.content, requestSearchTerms(request));
    const signals = signalEvidence(`${source.path} ${source.title ?? ''} ${excerpt}`, request);
    const hintedPath = (request.task.hints?.paths ?? []).some((path) => (
      source.path === path || source.path.startsWith(`${path}/`)
    ));
    if (signals.matched_terms.length === 0 && !hintedPath
        && !(request.required_sources ?? []).includes(source.path)) continue;
    const bytes = new TextEncoder().encode(excerpt).byteLength;
    candidates.push(finishCandidate({
      schema_version: '0.3', kind: source.kind, provider: 'filesystem', path: source.path,
      source_hash: source.source_hash, excerpt_hash: hashContextText(excerpt), snapshot: request.snapshot,
      freshness: 'live', observed_size_bytes: new TextEncoder().encode(source.content).byteLength,
      authority: source.authority, authority_evidence: ['safe-filesystem-fallback'],
      excerpt, excerpt_bytes: bytes, estimated_tokens: Math.ceil(bytes / 4),
      discovery: { ...signals, truncated: bytes < new TextEncoder().encode(source.content).byteLength },
    }));
  }
  const sourceWasTruncated = candidates.length > MAX_FILESYSTEM_RETURNED_CANDIDATES;
  return candidates.sort((left, right) => {
    const requiredDifference = Number((request.required_sources ?? []).includes(right.path))
      - Number((request.required_sources ?? []).includes(left.path));
    return requiredDifference || ordinal(left.id, right.id);
  }).slice(0, MAX_FILESYSTEM_RETURNED_CANDIDATES).map((candidate) => ({
    ...candidate,
    discovery: {
      ...candidate.discovery,
      truncated: candidate.discovery.truncated || sourceWasTruncated,
    },
  }));
}

function ftsCandidate(
  hit: SqliteFtsHitV03,
  request: ContextPlanRequestV03,
  liveSource: HybridIndexSourceV03,
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
      criteria_ids: signals.criteria_ids, truncated: true,
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
  for (const node of graph.nodes) {
    const signals = signalEvidence(`${node.locator.path} ${node.name} ${node.qualified_name} ${node.excerpt}`, request);
    const hintedPath = (request.task.hints?.paths ?? []).some((path) => node.locator.path === path || node.locator.path.startsWith(`${path}/`));
    const hintedSymbol = (request.task.hints?.symbols ?? []).includes(node.name);
    const requiredPath = (request.required_sources ?? []).includes(node.locator.path);
    if (signals.matched_terms.length === 0 && !hintedPath && !hintedSymbol && !requiredPath) continue;
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
        truncated: true,
      },
    }));
    if (candidates.length >= MAX_GRAPH_CANDIDATES) break;
  }
  return candidates;
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
  let fts: ContextCandidateV03[] = [];
  try {
    const manifest = await readValidatedIndexManifest(root, config, live.snapshot);
    const result = await withOptionalAdapterTimeout(
      'SQLite FTS',
      new NodeSqliteFtsAdapter().search(root, indexRelativePath(root, config), query, {
        limit: MAX_FTS_CANDIDATES,
        expected_worktree_digest: live.snapshot.worktree_digest,
      }),
    );
    if (result.index_digest !== manifest.index_digest || result.repository_id !== manifest.repository_id) {
      throw new PrimeContextError('FRESHNESS_ERROR', 'SQLite FTS result is not linked to the validated index manifest');
    }
    const liveByIdentity = new Map(
      live.hybrid_sources.map((source) => [`${source.path}:${source.source_hash}`, source]),
    );
    for (const hit of result.hits) {
      const source = liveByIdentity.get(`${hit.path}:${hit.source_hash}`);
      if (!source) {
        failures.push({
          provider: 'fts', code: 'STALE_SELECTED_SOURCE',
          message: 'FTS candidate is absent from the live accepted-source manifest', security_control: false,
        });
        continue;
      }
      fts.push(ftsCandidate(hit, effectiveRequest, source));
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
  const directDocuments = documentCandidates(live.documents, effectiveRequest).filter((candidate) => (
    candidate.authority === 'policy'
    || (request.required_sources ?? []).includes(candidate.path)
    || !ftsDocumentKeys.has(`${candidate.path}:${candidate.source_hash}`)
  ));
  const gitMetadataCandidate = gitCandidate(live.git, request);
  const candidates = [
    ...directDocuments,
    ...filesystemCandidates(live.filesystem_sources, effectiveRequest),
    ...fts,
    ...(live.graph ? graphCandidates(live.graph, effectiveRequest, live.filesystem_sources) : []),
    repoMapCandidate(live.repo_map, effectiveRequest),
    ...(gitMetadataCandidate ? [gitMetadataCandidate] : []),
  ];
  const unique = new Map<string, ContextCandidateV03>();
  for (const candidate of candidates) unique.set(candidate.id, candidate);
  const ordered = [...unique.values()].sort((left, right) => {
    const requiredDifference = Number((request.required_sources ?? []).includes(right.path))
      - Number((request.required_sources ?? []).includes(left.path));
    const policyDifference = Number(right.authority === 'policy' && (right.provider === 'documents' || right.provider === 'filesystem'))
      - Number(left.authority === 'policy' && (left.provider === 'documents' || left.provider === 'filesystem'));
    return requiredDifference || policyDifference || ordinal(left.id, right.id);
  });
  const aggregateWasTruncated = ordered.length > MAX_AGGREGATE_CANDIDATES;
  return {
    candidates: ordered.slice(0, MAX_AGGREGATE_CANDIDATES).map((candidate) => ({
      ...candidate,
      discovery: { ...candidate.discovery, truncated: candidate.discovery.truncated || aggregateWasTruncated },
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
  if (request.capsule_digest) {
    const capsulePath = stateRelativePath(root, config, `capsules/${request.task.task_id}.json`);
    const capsuleValue = await readInternalJsonBounded(root, capsulePath);
    const validation = validateTaskCapsule(capsuleValue);
    if (!validation.valid) throw new PrimeContextError('STATE_ERROR', 'Linked Task Capsule is invalid', validation.errors);
    const capsule = capsuleValue as TaskCapsule;
    if (capsule.task_id !== request.task.task_id || capsule.task_type !== request.task.task_type
        || hashContextJson(capsule) !== request.capsule_digest) {
      throw new PrimeContextError('STATE_ERROR', 'Context request does not match its linked Task Capsule');
    }
    tokenLimit = Math.min(tokenLimit, capsule.context_budget.hard_limit_tokens);
  }
  return {
    ...request,
    budget: { ...request.budget, max_estimated_tokens: Math.min(request.budget.max_estimated_tokens, tokenLimit) },
  };
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
      || !/^sha256:[0-9a-f]{64}$/.test(String(manifest.index_digest))
      || manifest.index_path !== indexRelativePath(root, config)
      || !Number.isSafeInteger(manifest.indexed_source_count)
      || (manifest.indexed_source_count as number) < 0
      || typeof manifest.secure_delete !== 'boolean'
      || typeof manifest.fts_secure_delete !== 'boolean'
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

export async function contextIndexCommand(root: string): Promise<ContextIndexCommandResult> {
  const resolvedRoot = resolve(root);
  const config = await loadProtectedContextConfig(resolvedRoot);
  const stateLock = stateRelativePath(resolvedRoot, config, 'context/index-state.lock');
  return withInternalExclusiveLock(resolvedRoot, stateLock, async () => {
    const live = await collectContextSources(resolvedRoot, config);
    const relativeIndex = indexRelativePath(resolvedRoot, config);
    let rebuilt: {
      index_path: string; index_digest: string; worktree_digest: string;
      indexed_source_count: number; secure_delete: boolean; fts_secure_delete: boolean;
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
        new NodeSqliteFtsAdapter().rebuild(
          resolvedRoot,
          relativeIndex,
          live.hybrid_sources,
          { repository_id: live.repository_id, worktree_digest: live.snapshot.worktree_digest },
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
          new NodeSqliteFtsAdapter().search(
            resolvedRoot,
            relativeIndex,
            'primecontext preservation probe',
            { limit: 1, expected_worktree_digest: live.snapshot.worktree_digest },
          ),
        );
        if (probe.index_digest !== preserved.index_digest
            || probe.repository_id !== preserved.repository_id
            || probe.worktree_digest !== preserved.worktree_digest) {
          throw new PrimeContextError('STATE_ERROR', 'Preserved FTS index does not match its manifest');
        }
        return {
          repository_id: live.repository_id,
          ...(live.snapshot.head ? { head: live.snapshot.head } : {}),
          index_path: preserved.index_path,
          index_digest: preserved.index_digest,
          worktree_digest: preserved.worktree_digest,
          indexed_source_count: preserved.indexed_source_count,
          document_source_count: preserved.document_source_count,
          code_file_count: preserved.code_file_count,
          code_symbol_count: preserved.code_symbol_count,
          secure_delete: preserved.secure_delete,
          fts_secure_delete: preserved.fts_secure_delete,
          manifest_digest: preserved.manifest_digest,
          fallback_used: true,
          source_failures: [...live.source_failures, fallbackFailure],
        };
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
      index_path: rebuilt.index_path, indexed_source_count: rebuilt.indexed_source_count,
      document_source_count: live.documents.sources.length,
      code_file_count: live.graph?.files.length ?? 0, code_symbol_count: live.graph?.nodes.length ?? 0,
      graph_digest: live.graph?.graph_digest ?? hashContextText('codegraph-unavailable'),
      ...(live.graph ? { graph_summary: live.graph.summary } : {}),
      secure_delete: rebuilt.secure_delete, fts_secure_delete: rebuilt.fts_secure_delete,
      source_failures: live.source_failures,
    };
    const manifest: ContextIndexManifestV03 = {
      ...manifestWithoutDigest,
      manifest_digest: hashContextJson(manifestWithoutDigest),
    };
    try {
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
      worktree_digest: rebuilt.worktree_digest, indexed_source_count: rebuilt.indexed_source_count,
      document_source_count: live.documents.sources.length, code_file_count: live.graph?.files.length ?? 0,
      code_symbol_count: live.graph?.nodes.length ?? 0, secure_delete: rebuilt.secure_delete,
      fts_secure_delete: rebuilt.fts_secure_delete, manifest_digest: manifest.manifest_digest,
      fallback_used: fallbackUsed, source_failures: structuredClone(live.source_failures),
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
): Promise<ContextPlanRequestV03> {
  const resolvedRoot = resolve(root);
  const config = await loadProtectedContextConfig(resolvedRoot);
  const live = await collectContextSources(resolvedRoot, config);
  const tokenBudget = Math.min(1_000_000, config.budgets[intent.task_type].initial_tokens);
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
): Promise<PreparedContextResultV03> {
  const resolvedRoot = resolve(root);
  const config = await loadProtectedContextConfig(resolvedRoot);
  const boundedRequest = await applyPlanPolicyLimits(resolvedRoot, config, structuredClone(request));
  const live = await collectContextSources(resolvedRoot, config);
  assertRequestedSnapshot(boundedRequest, live.snapshot);
  const collected = await collectPlanCandidates(resolvedRoot, config, boundedRequest, live);
  const contextPackage = compileContext(boundedRequest, collected.candidates, collected.failures);
  const stateLock = stateRelativePath(resolvedRoot, config, `context/plans/${boundedRequest.task.task_id}/state.lock`);
  const planPath = await withInternalExclusiveLock(resolvedRoot, stateLock, async () => {
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
): Promise<{ outcome_path: string; receipt: OutcomeReceiptV03 }> {
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
  await appendValidatedJsonLine(resolvedRoot, path, receipt, (value) => {
    assertValidOutcomeReceipt(value);
    return true;
  });
  return { outcome_path: path, receipt };
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
