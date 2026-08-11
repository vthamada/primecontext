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
