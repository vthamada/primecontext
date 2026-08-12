export type TaskType = 'small_ui' | 'small_code_fix' | 'module_feature' | 'integration' | 'qa' | 'orchestration';

export interface ContextBudget {
  initial_tokens: number;
  soft_limit_tokens: number;
  hard_limit_tokens: number;
}

export interface TaskBoundaries {
  allowed_paths: string[];
  forbidden_paths: string[];
}

export interface DecisionReference {
  source: string;
  summary: string;
}

export interface WorktreeMetadata {
  root: string;
  branch?: string;
  head?: string;
}

export interface TaskCapsule {
  schema_version: '0.1';
  task_id: string;
  goal: string;
  task_type: TaskType;
  module?: string;
  priority?: string;
  boundaries: TaskBoundaries;
  decisions?: DecisionReference[];
  contracts?: string[];
  documents?: string[];
  code_targets?: string[];
  acceptance: string[];
  context_budget: ContextBudget;
  worktree?: WorktreeMetadata;
  metadata?: Record<string, unknown>;
}

export interface TaskDefinitionInput {
  task_id: string;
  goal: string;
  task_type: TaskType;
  module?: string;
  priority?: string;
  boundaries: TaskBoundaries;
  decisions?: DecisionReference[];
  contracts?: string[];
  documents?: string[];
  code_targets?: string[];
  acceptance: string[];
  metadata?: Record<string, unknown>;
}

export type HandoffStatus = 'PASS' | 'FAIL' | 'PARTIAL' | 'BLOCKED';

export interface CompactHandoff {
  schema_version: '0.1';
  task_id: string;
  status: HandoffStatus;
  commit?: string;
  changed_files: string[];
  interfaces_added?: string[];
  decisions?: string[];
  tests: { passed: number; failed: number; skipped?: number };
  risks: string[];
  next_unblocked: string[];
  artifacts?: string[];
  metrics_ref?: string;
}

export type MetricNumericField =
  | 'input_tokens' | 'cached_input_tokens' | 'output_tokens' | 'tool_calls' | 'file_reads'
  | 'codegraph_calls' | 'context_expansions' | 'duration_ms' | 'selected_context_tokens' | 'rework_count';

export interface MetricRecord {
  schema_version: '0.1';
  task_id: string;
  recorded_at: string;
  arm?: 'A' | 'B';
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  tool_calls?: number;
  file_reads?: number;
  codegraph_calls?: number;
  context_expansions?: number;
  duration_ms?: number;
  selected_context_tokens?: number;
  test_status?: 'PASS' | 'FAIL' | 'UNKNOWN';
  review_status?: 'PASS' | 'FAIL' | 'UNKNOWN';
  completion_status?: 'PASS' | 'FAIL' | 'UNKNOWN';
  rework_count?: number;
  estimated_fields?: MetricNumericField[];
}

export interface DiscoveredPath {
  relative_path: string;
  kind: 'file' | 'directory';
  size_bytes?: number;
}

export interface WalkResult {
  paths: DiscoveredPath[];
  excluded_path_count: number;
}

export interface GitState {
  branch?: string;
  head?: string;
}

export interface FileSystemPort {
  walk(root: string): Promise<WalkResult>;
  readText(root: string, relativePath: string, maxBytes?: number): Promise<string>;
}

export interface GitPort {
  inspect(root: string): Promise<GitState | undefined>;
}

export interface MetricSink {
  record(metric: MetricRecord): Promise<void>;
}

export type RepoModuleKind = 'workspace_package' | 'source' | 'tests' | 'documentation' | 'configuration' | 'examples' | 'benchmarks' | 'other';

export interface RepoModule {
  id: string;
  path: string;
  kind: RepoModuleKind;
  role: string;
  evidence: string[];
}

export interface RepositoryIdentity {
  root: string;
  name: string;
  branch?: string;
  head?: string;
}

export interface SemanticRepoMap {
  schema_version: '0.1';
  generated_at: string;
  repository: RepositoryIdentity;
  modules: RepoModule[];
  summary: {
    module_count: number;
    discovered_path_count: number;
    excluded_path_count: number;
  };
}

export type DocumentAuthority =
  | 'policy'
  | 'adr'
  | 'specification'
  | 'contract_schema'
  | 'roadmap'
  | 'implementation_note'
  | 'generated_summary';

export type DocumentMatchField = 'title' | 'path' | 'module' | 'topic' | 'body';

export type DocumentAuthorityBasis =
  | { kind: 'convention'; rule_id: string }
  | { kind: 'default' };

export interface DocumentSource {
  path: string;
  format: 'markdown';
  title: string;
  authority: DocumentAuthority;
  authority_basis: DocumentAuthorityBasis;
  modules: string[];
  topics: string[];
  source_hash: string;
  size_bytes: number;
  content: string;
}

export interface DocumentSourceCollection {
  documents: DocumentSource[];
  summary: {
    discovered_path_count: number;
    excluded_path_count: number;
    candidate_document_count: number;
    omitted_document_count: number;
  };
}

export interface DocumentHashPort {
  sha256(value: string | Uint8Array): string;
}

export interface DocumentCatalogEntry {
  id: string;
  path: string;
  format: 'markdown';
  title: string;
  authority: DocumentAuthority;
  authority_basis: DocumentAuthorityBasis;
  modules: string[];
  topics: string[];
  source_hash: string;
  size_bytes: number;
}

export interface DocumentCatalog {
  schema_version: '0.2';
  generated_at: string;
  catalog_digest: string;
  worktree?: { branch?: string; head?: string };
  documents: DocumentCatalogEntry[];
  summary: {
    discovered_path_count: number;
    excluded_path_count: number;
    candidate_document_count: number;
    document_count: number;
    omitted_document_count: number;
    total_source_bytes: number;
  };
}

export interface DocumentCatalogInput {
  generated_at: string;
  worktree?: { branch?: string; head?: string };
  source_collection: DocumentSourceCollection;
}

export interface DocumentSearchFilters {
  authorities?: DocumentAuthority[];
  modules?: string[];
  topics?: string[];
}

export interface DocumentSearchQuery {
  schema_version: '0.2';
  query: string;
  filters?: DocumentSearchFilters;
  limit?: number;
}

export interface DocumentExcerpt {
  text: string;
  start_line: number;
  end_line: number;
  truncated: boolean;
}

export interface DocumentSearchHit {
  document_id: string;
  path: string;
  title: string;
  authority: DocumentAuthority;
  source_hash: string;
  score: number;
  matched_fields: DocumentMatchField[];
  matched_terms: string[];
  excerpt: DocumentExcerpt;
}

export interface DocumentConflict {
  normalized_title: string;
  document_ids: string[];
}

export interface DocumentSearchResult {
  schema_version: '0.2';
  catalog_digest: string;
  query: string;
  terms: string[];
  effective_filters: {
    authorities: DocumentAuthority[];
    modules: string[];
    topics: string[];
  };
  hits: DocumentSearchHit[];
  conflicts: DocumentConflict[];
  summary: {
    catalog_document_count: number;
    filtered_document_count: number;
    matched_document_count: number;
    returned_hit_count: number;
    truncated: boolean;
  };
}
