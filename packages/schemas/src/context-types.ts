export type ContextTaskTypeV03 =
  | 'small_ui' | 'small_code_fix' | 'module_feature' | 'integration' | 'qa' | 'orchestration';

export interface ContextSnapshotV03 {
  repository_id: string;
  head?: string;
  worktree_digest: string;
}

export interface ContextBudgetLimitsV03 {
  max_items: number;
  max_bytes: number;
  max_estimated_tokens: number;
}

export interface ContextPlanRequestV03 {
  schema_version: '0.3';
  task: {
    task_id: string;
    task_type: ContextTaskTypeV03;
    goal: string;
    query: string;
    acceptance_criteria: Array<{ id: string; text: string; required_terms?: string[] }>;
    hints?: { paths?: string[]; symbols?: string[]; terms?: string[] };
  };
  budget: ContextBudgetLimitsV03;
  snapshot: ContextSnapshotV03;
  policy_version: string;
  required_sources?: string[];
  capsule_digest?: string;
}

export interface ContextIntentV03 {
  schema_version: '0.3';
  task_id: ContextPlanRequestV03['task']['task_id'];
  task_type: ContextTaskTypeV03;
  goal: string;
  acceptance: string[];
  query?: string;
  paths?: string[];
  symbols?: string[];
  terms?: string[];
  required_sources?: string[];
}

export type ContextCandidateKindV03 =
  | 'document' | 'code' | 'test' | 'configuration' | 'history' | 'repository_map';
export type ContextProviderV03 = 'filesystem' | 'documents' | 'repo_map' | 'git' | 'fts' | 'codegraph';
export type ContextAuthorityV03 =
  | 'policy' | 'adr' | 'specification' | 'contract_schema' | 'roadmap'
  | 'implementation_note' | 'generated_summary' | 'source_code' | 'test'
  | 'configuration' | 'history' | 'repository_map';

export interface ContextCandidateV03 {
  schema_version: '0.3';
  id: string;
  kind: ContextCandidateKindV03;
  provider: ContextProviderV03;
  path: string;
  line_start?: number;
  line_end?: number;
  symbol?: string;
  source_hash: string;
  excerpt_hash: string;
  snapshot: ContextSnapshotV03;
  freshness: 'live' | 'snapshot' | 'unknown';
  observed_size_bytes: number;
  authority: ContextAuthorityV03;
  authority_evidence: string[];
  excerpt: string;
  excerpt_bytes: number;
  estimated_tokens: number;
  discovery: {
    matched_terms: string[];
    criteria_ids: string[];
    graph_distance?: number;
    truncated: boolean;
  };
}

export type ContextEvidenceStatusV03 = 'READY' | 'INSUFFICIENT_EVIDENCE' | 'CONFLICT';
export type ContextBudgetStatusV03 = 'WITHIN_BUDGET' | 'TRUNCATED' | 'EXHAUSTED';

export type ContextScoreComponentsV03 = {
  required_source: number;
  applicable_policy: number;
  hinted_path: number;
  hinted_symbol: number;
  required_terms: number;
  query_terms: number;
  graph_distance: number;
  authority: number;
  related_test: number;
  live_freshness: number;
};

export type ContextIncludeReasonV03 =
  | 'INCLUDE_REQUIRED_SOURCE' | 'INCLUDE_APPLICABLE_POLICY'
  | 'INCLUDE_CRITERION_COVERAGE' | 'INCLUDE_RELEVANCE';
export type ContextOmitReasonV03 =
  | 'OMIT_DUPLICATE_CONTENT' | 'OMIT_NO_MATCH' | 'OMIT_LOWER_MARGINAL_COVERAGE'
  | 'OMIT_BUDGET_ITEMS' | 'OMIT_BUDGET_BYTES' | 'OMIT_BUDGET_TOKENS'
  | 'OMIT_STALE_SOURCE' | 'OMIT_UNSAFE_SOURCE' | 'OMIT_INVALID_SOURCE'
  | 'OMIT_SOURCE_TRUNCATED' | 'OMIT_CONFLICT_REVIEW';
export type ContextDecisionReasonV03 = ContextIncludeReasonV03 | ContextOmitReasonV03;

export interface SelectedContextCandidateV03 extends ContextCandidateV03 {
  mandatory: boolean;
  score: number;
  score_components: ContextScoreComponentsV03;
  selection_reason: ContextIncludeReasonV03;
}

export interface ContextConflictV03 {
  conflict_key: string;
  candidate_ids: string[];
  criterion_ids: string[];
  reason: 'AUTHORITATIVE_SOURCES_DISAGREE';
}

export interface ContextSourceFailureV03 {
  provider: ContextProviderV03;
  code: string;
  message: string;
  security_control: boolean;
}

export interface ContextEnvelopeV03 {
  schema_version: '0.3';
  task_id: string;
  request_digest: string;
  selection_digest: string;
  policy_version: string;
  snapshot: ContextSnapshotV03;
  capsule_digest?: string;
  evidence_status: ContextEvidenceStatusV03;
  budget_status: ContextBudgetStatusV03;
  budget: ContextBudgetLimitsV03 & {
    used_items: number;
    used_bytes: number;
    used_estimated_tokens: number;
  };
  items: SelectedContextCandidateV03[];
  criteria_coverage: Array<{
    criterion_id: string;
    match_mode: 'ANY' | 'ALL';
    required_terms: string[];
    status: 'COVERED' | 'MISSING' | 'CONFLICTED';
    candidate_ids: string[];
    matched_terms: string[];
  }>;
  missing_required_sources: string[];
  missing_required_terms: string[];
  conflicts: ContextConflictV03[];
  source_failures: ContextSourceFailureV03[];
  truncation: {
    considered_candidates: number;
    selected_candidates: number;
    omitted_candidates: number;
    source_truncated: boolean;
  };
}

export interface ContextSelectionDecisionV03 {
  candidate_id: string;
  status: 'INCLUDED' | 'OMITTED';
  reason: ContextDecisionReasonV03;
  mandatory: boolean;
  score: number;
  score_components: ContextScoreComponentsV03;
  marginal_criteria_ids: string[];
  marginal_terms: string[];
  duplicate_of?: string;
}

export interface SelectionReceiptV03 {
  schema_version: '0.3';
  task_id: string;
  request_digest: string;
  selection_digest: string;
  receipt_digest: string;
  policy_version: string;
  policy_components: ContextScoreComponentsV03;
  decisions: ContextSelectionDecisionV03[];
  duplicate_groups: Array<{ representative_id: string; duplicate_ids: string[] }>;
  conflicts: ContextConflictV03[];
  source_failures: ContextSourceFailureV03[];
  truncation: ContextEnvelopeV03['truncation'];
}

export interface TaskContextPackageV03 {
  envelope: ContextEnvelopeV03;
  receipt: SelectionReceiptV03;
}

export interface ExpansionRequestV03 {
  schema_version: '0.3';
  task_id: string;
  previous_selection_digest: string;
  known_candidate_ids: string[];
  reason: 'MISSING_CRITERION' | 'MISSING_REQUIRED_SOURCE' | 'MISSING_TERM' | 'CONFLICT_REVIEW';
  requested_paths: string[];
  requested_symbols: string[];
  requested_terms: string[];
  additional_budget: ContextBudgetLimitsV03;
}

export interface ExpansionDecisionV03 {
  schema_version: '0.3';
  task_id: string;
  previous_selection_digest: string;
  selection_digest: string;
  status: 'ALLOWED' | 'PARTIAL' | 'DENIED';
  reason_codes: Array<'EVIDENCE_ADDED' | 'NO_NEW_EVIDENCE' | 'HARD_LIMIT_REACHED' | 'STALE_PARENT' | 'DUPLICATE_ONLY'>;
  additions: string[];
  cumulative_budget: ContextEnvelopeV03['budget'];
  remaining_missing_evidence: string[];
  snapshot: ContextSnapshotV03;
}

export interface ContextOutcomeInputV03 {
  schema_version: '0.3';
  run_id: string;
  task_id: string;
  selection_digest: string;
  snapshot: ContextSnapshotV03;
  started_at: string;
  recorded_at: string;
  used_candidate_ids: string[];
  touched_paths: string[];
  test_status: 'PASS' | 'FAIL' | 'PARTIAL' | 'NOT_RUN';
  review_status: 'PASS' | 'FAIL' | 'PARTIAL' | 'NOT_RUN';
  completion_status: 'PASS' | 'FAIL' | 'PARTIAL' | 'NOT_RUN';
  metrics: { duration_ms?: number; input_tokens?: number; output_tokens?: number; rework_count?: number };
  estimated_fields?: Array<'duration_ms' | 'input_tokens' | 'output_tokens' | 'rework_count'>;
  source: 'human' | 'tool' | 'imported';
  notes?: string;
}

export interface OutcomeReceiptV03 extends ContextOutcomeInputV03 {
  outcome_digest: string;
  causality: 'OBSERVATIONAL_ONLY';
}

export interface AblationRequestV03 {
  schema_version: '0.3';
  task_id: string;
  selection_digest: string;
  candidate_id: string;
}

export interface AblationResultV03 {
  schema_version: '0.3';
  task_id: string;
  parent_selection_digest: string;
  ablated_selection_digest?: string;
  removed_candidate_id: string;
  decision: 'DERIVED' | 'DENIED';
  reason: 'NON_MANDATORY_REMOVED' | 'MANDATORY_CANDIDATE' | 'CANDIDATE_NOT_SELECTED';
  evidence_status: ContextEvidenceStatusV03;
  missing_criteria_ids: string[];
  missing_required_terms: string[];
  experimental: true;
  causal_claim: 'NONE';
}

export interface ReplayResultV03 {
  schema_version: '0.3';
  task_id: string;
  status: 'IDENTICAL' | 'DRIFTED' | 'UNREPLAYABLE';
  old_selection_digest: string;
  new_selection_digest?: string;
  old_snapshot: ContextSnapshotV03;
  new_snapshot?: ContextSnapshotV03;
  added_candidate_ids: string[];
  removed_candidate_ids: string[];
  source_failures: ContextSourceFailureV03[];
  freshness: 'MATCHED' | 'CHANGED' | 'UNAVAILABLE';
  replay_digest: string;
}
