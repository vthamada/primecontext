const draft = 'https://json-schema.org/draft/2020-12/schema';

export const contextCandidateKinds = ['document', 'code', 'test', 'configuration', 'history', 'repository_map'] as const;
export const contextProviders = ['filesystem', 'documents', 'repo_map', 'git', 'fts', 'codegraph'] as const;
export const contextAuthorities = [
  'policy', 'adr', 'specification', 'contract_schema', 'roadmap', 'implementation_note',
  'generated_summary', 'source_code', 'test', 'configuration', 'history', 'repository_map',
] as const;
export const contextFreshnessValues = ['live', 'snapshot', 'unknown'] as const;
export const contextEvidenceStatuses = ['READY', 'INSUFFICIENT_EVIDENCE', 'CONFLICT'] as const;
export const contextBudgetStatuses = ['WITHIN_BUDGET', 'TRUNCATED', 'EXHAUSTED'] as const;
export const contextBudgetTiers = ['INITIAL', 'SOFT', 'HARD'] as const;
export const contextTruncationReasons = [
  'CANDIDATE_SET_LIMIT',
  'EXCERPT_BOUND',
  'PROVIDER_RESULT_LIMIT',
  'SOURCE_COLLECTION_LIMIT',
] as const;
export const contextDecisionReasons = [
  'INCLUDE_REQUIRED_SOURCE', 'INCLUDE_APPLICABLE_POLICY', 'INCLUDE_CRITERION_COVERAGE', 'INCLUDE_RELEVANCE',
  'OMIT_DUPLICATE_CONTENT', 'OMIT_NO_MATCH', 'OMIT_LOWER_MARGINAL_COVERAGE', 'OMIT_BUDGET_ITEMS',
  'OMIT_BUDGET_BYTES', 'OMIT_BUDGET_TOKENS', 'OMIT_STALE_SOURCE', 'OMIT_UNSAFE_SOURCE',
  'OMIT_INVALID_SOURCE', 'OMIT_SOURCE_TRUNCATED', 'OMIT_CONFLICT_REVIEW', 'OMIT_SUFFICIENT_EVIDENCE',
] as const;

const nonEmpty = { type: 'string', minLength: 1 } as const;
const bounded = { ...nonEmpty, maxLength: 1024 } as const;
const hash = { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' } as const;
const nonNegativeInteger = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER } as const;
const taskId = { ...nonEmpty, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' } as const;
const stableId = { ...nonEmpty, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' } as const;
const repositoryPath = {
  ...nonEmpty, maxLength: 1024,
  pattern: '^(?!/)(?!.*\\\\)(?!.*:)(?!.*[<>"|?*])(?!.*//)(?!\\.{1,2}(?:/|$))(?!.*\\/\\.{1,2}(?:/|$))(?!.*(?:^|/)(?:[Cc][Oo][Nn]|[Pp][Rr][Nn]|[Aa][Uu][Xx]|[Nn][Uu][Ll]|[Cc][Oo][Mm][1-9]|[Ll][Pp][Tt][1-9])[ .]*(?:\\.|/|$))(?!.*[. ](?:/|$))[^\\u0000-\\u001f\\u007f-\\u009f]+$',
} as const;
const stringSet = { type: 'array', maxItems: 128, uniqueItems: true, items: bounded } as const;
const pathSet = { type: 'array', maxItems: 128, uniqueItems: true, items: repositoryPath } as const;
const idSet = { type: 'array', maxItems: 128, uniqueItems: true, items: stableId } as const;
const hashSet = { type: 'array', maxItems: 2048, uniqueItems: true, items: hash } as const;
const truncationReasonSet = {
  type: 'array', maxItems: contextTruncationReasons.length, uniqueItems: true,
  items: { enum: contextTruncationReasons },
} as const;

const snapshot = {
  type: 'object', additionalProperties: false, required: ['repository_id', 'worktree_digest'],
  properties: {
    repository_id: { ...bounded, maxLength: 256 }, head: { ...bounded, maxLength: 128 }, worktree_digest: hash,
  },
} as const;

const budget = {
  type: 'object', additionalProperties: false, required: ['max_items', 'max_bytes', 'max_estimated_tokens'],
  properties: {
    max_items: { type: 'integer', minimum: 1, maximum: 128 },
    max_bytes: { type: 'integer', minimum: 1, maximum: 8 * 1024 * 1024 },
    max_estimated_tokens: { type: 'integer', minimum: 1, maximum: 1_000_000 },
  },
} as const;

const scoreComponents = {
  type: 'object', additionalProperties: false,
  required: ['required_source', 'applicable_policy', 'hinted_path', 'hinted_symbol', 'required_terms', 'query_terms', 'graph_distance', 'authority', 'related_test', 'live_freshness'],
  properties: {
    required_source: nonNegativeInteger, applicable_policy: nonNegativeInteger,
    hinted_path: nonNegativeInteger, hinted_symbol: nonNegativeInteger,
    required_terms: nonNegativeInteger, query_terms: nonNegativeInteger,
    graph_distance: nonNegativeInteger, authority: nonNegativeInteger,
    related_test: nonNegativeInteger, live_freshness: nonNegativeInteger,
  },
} as const;

const candidate = {
  type: 'object', additionalProperties: false,
  required: [
    'schema_version', 'id', 'kind', 'provider', 'path', 'source_hash', 'excerpt_hash', 'snapshot',
    'freshness', 'observed_size_bytes', 'authority', 'authority_evidence', 'excerpt', 'excerpt_bytes',
    'estimated_tokens', 'discovery',
  ],
  properties: {
    schema_version: { const: '0.3' }, id: hash, kind: { enum: contextCandidateKinds }, provider: { enum: contextProviders },
    path: repositoryPath, line_start: { type: 'integer', minimum: 1, maximum: 10_000_000 },
    line_end: { type: 'integer', minimum: 1, maximum: 10_000_000 }, symbol: { ...bounded, maxLength: 512 },
    source_hash: hash, excerpt_hash: hash, snapshot, freshness: { enum: contextFreshnessValues },
    observed_size_bytes: { type: 'integer', minimum: 1, maximum: 1024 * 1024 }, authority: { enum: contextAuthorities },
    authority_evidence: { type: 'array', minItems: 1, maxItems: 16, uniqueItems: true, items: bounded },
    excerpt: {
      type: 'string', minLength: 1, maxLength: 32_768,
      pattern: '^(?!(?:[^\\r\\n]*(?:\\r\\n|\\r|\\n)){400})[\\s\\S]+$',
      'x-primecontext-max-utf8-bytes': 32 * 1024,
      'x-primecontext-max-lines': 400,
    },
    excerpt_bytes: { type: 'integer', minimum: 1, maximum: 32 * 1024 },
    estimated_tokens: { type: 'integer', minimum: 1, maximum: 8192 },
    discovery: {
      type: 'object', additionalProperties: false,
      required: ['matched_terms', 'criteria_ids', 'truncated'],
      properties: {
        matched_terms: stringSet, criteria_ids: idSet,
        graph_distance: { type: 'integer', minimum: 0, maximum: 5 }, truncated: { type: 'boolean' },
        truncation_reasons: truncationReasonSet,
      },
    },
  },
} as const;

export const contextSourceFailureSchema = {
  type: 'object', additionalProperties: false, required: ['provider', 'code', 'message', 'security_control'],
  properties: {
    provider: { enum: contextProviders }, code: { ...stableId, maxLength: 64 },
    message: { ...nonEmpty, maxLength: 4096, pattern: '^[^\\u0000-\\u001f\\u007f-\\u009f]+$' }, security_control: { type: 'boolean' },
  },
} as const;

export const contextSourceFailuresSchema = {
  type: 'array', maxItems: 128, items: contextSourceFailureSchema,
} as const;

const conflict = {
  type: 'object', additionalProperties: false,
  required: ['conflict_key', 'candidate_ids', 'criterion_ids', 'reason'],
  properties: {
    conflict_key: { type: 'string', pattern: '^conflict-[0-9a-f]{64}$' },
    candidate_ids: { type: 'array', minItems: 2, maxItems: 128, uniqueItems: true, items: hash },
    criterion_ids: idSet,
    reason: { enum: ['AUTHORITATIVE_VARIANTS_REQUIRE_REVIEW', 'AUTHORITATIVE_SOURCES_DISAGREE'] },
  },
} as const;

const truncation = {
  type: 'object', additionalProperties: false,
  required: ['considered_candidates', 'selected_candidates', 'omitted_candidates', 'source_truncated'],
  properties: {
    considered_candidates: { type: 'integer', minimum: 0, maximum: 2048 },
    selected_candidates: { type: 'integer', minimum: 0, maximum: 128 },
    omitted_candidates: { type: 'integer', minimum: 0, maximum: 2048 },
    source_truncated: { type: 'boolean' },
    truncation_reasons: truncationReasonSet,
  },
} as const;

export const contextPlanRequestSchema = {
  $schema: draft, $id: 'https://primecontext.dev/schemas/v0.3/context-plan-request.schema.json',
  type: 'object', additionalProperties: false,
  required: ['schema_version', 'task', 'budget', 'snapshot', 'policy_version'],
  properties: {
    schema_version: { const: '0.3' },
    task: {
      type: 'object', additionalProperties: false,
      required: ['task_id', 'task_type', 'goal', 'query', 'acceptance_criteria'],
      properties: {
        task_id: taskId,
        task_type: { enum: ['small_ui', 'small_code_fix', 'module_feature', 'integration', 'qa', 'orchestration'] },
        goal: { ...nonEmpty, maxLength: 4096, 'x-primecontext-max-utf8-bytes': 4096 },
        query: { ...nonEmpty, maxLength: 4096, 'x-primecontext-max-utf8-bytes': 4096 },
        acceptance_criteria: {
          type: 'array', minItems: 1, maxItems: 64,
          items: {
            type: 'object', additionalProperties: false, required: ['id', 'text'],
            properties: {
              id: stableId,
              text: { ...nonEmpty, maxLength: 1024, 'x-primecontext-max-utf8-bytes': 1024 },
              required_terms: stringSet,
            },
          },
        },
        hints: {
          type: 'object', additionalProperties: false,
          properties: { paths: pathSet, symbols: stringSet, terms: stringSet },
        },
      },
    },
    budget,
    progressive_budget: {
      type: 'object', additionalProperties: false, required: ['soft', 'hard'],
      properties: { soft: budget, hard: budget },
    },
    snapshot, policy_version: { ...bounded, maxLength: 128 }, required_sources: pathSet, capsule_digest: hash,
  },
} as const;

export const contextIntentSchema = {
  $schema: draft, $id: 'https://primecontext.dev/schemas/v0.3/context-intent.schema.json',
  type: 'object', additionalProperties: false,
  required: ['schema_version', 'task_id', 'task_type', 'goal', 'acceptance'],
  properties: {
    schema_version: { const: '0.3' },
    task_id: {
      ...taskId,
      pattern: '^(?!(?:[Cc][Oo][Nn]|[Pp][Rr][Nn]|[Aa][Uu][Xx]|[Nn][Uu][Ll]|[Cc][Oo][Mm][1-9¹²³]|[Ll][Pp][Tt][1-9¹²³])(?:\\.|$))[A-Za-z0-9][A-Za-z0-9._-]{0,127}$',
    },
    task_type: { enum: ['small_ui', 'small_code_fix', 'module_feature', 'integration', 'qa', 'orchestration'] },
    goal: {
      ...nonEmpty, maxLength: 4096,
      pattern: '^[^\\u0000-\\u001f\\u007f-\\u009f]+$',
      'x-primecontext-max-utf8-bytes': 4096,
    },
    acceptance: {
      type: 'array', minItems: 1, maxItems: 64, uniqueItems: true,
      items: {
        ...nonEmpty, maxLength: 1024,
        pattern: '^[^\\u0000-\\u001f\\u007f-\\u009f]+$',
        'x-primecontext-max-utf8-bytes': 1024,
      },
    },
    query: {
      ...nonEmpty, maxLength: 4096,
      pattern: '^[^\\u0000-\\u001f\\u007f-\\u009f]+$',
      'x-primecontext-max-utf8-bytes': 4096,
    },
    paths: pathSet,
    symbols: {
      ...stringSet,
      items: { ...bounded, pattern: '^[^\\u0000-\\u001f\\u007f-\\u009f]+$' },
    },
    terms: {
      ...stringSet,
      items: { ...bounded, pattern: '^[^\\u0000-\\u001f\\u007f-\\u009f]+$' },
    },
    required_sources: pathSet,
  },
} as const;

export const contextCandidateSchema = {
  $schema: draft, $id: 'https://primecontext.dev/schemas/v0.3/context-candidate.schema.json', ...candidate,
} as const;

const selectedCandidate = {
  ...candidate,
  required: [...candidate.required, 'mandatory', 'score', 'score_components', 'selection_reason'],
  properties: {
    ...candidate.properties, mandatory: { type: 'boolean' },
    score: { type: 'integer', minimum: 0, maximum: 100_000 }, score_components: scoreComponents,
    selection_reason: { enum: contextDecisionReasons.slice(0, 4) },
  },
} as const;

export const contextEnvelopeSchema = {
  $schema: draft, $id: 'https://primecontext.dev/schemas/v0.3/context-envelope.schema.json',
  type: 'object', additionalProperties: false,
  required: [
    'schema_version', 'task_id', 'request_digest', 'selection_digest', 'policy_version', 'snapshot',
    'evidence_status', 'budget_status', 'budget', 'items', 'criteria_coverage', 'missing_required_sources',
    'missing_required_terms', 'conflicts', 'source_failures', 'truncation',
  ],
  properties: {
    schema_version: { const: '0.3' }, task_id: taskId, request_digest: hash, selection_digest: hash,
    policy_version: { ...bounded, maxLength: 128 }, snapshot, capsule_digest: hash,
    evidence_status: { enum: contextEvidenceStatuses }, budget_status: { enum: contextBudgetStatuses },
    budget_tier: { enum: contextBudgetTiers },
    budget: {
      ...budget,
      required: [...budget.required, 'used_items', 'used_bytes', 'used_estimated_tokens'],
      properties: {
        ...budget.properties, used_items: nonNegativeInteger, used_bytes: nonNegativeInteger,
        used_estimated_tokens: nonNegativeInteger,
      },
    },
    items: { type: 'array', maxItems: 128, items: selectedCandidate },
    criteria_coverage: {
      type: 'array', minItems: 1, maxItems: 64, items: {
        type: 'object', additionalProperties: false,
        required: ['criterion_id', 'match_mode', 'required_terms', 'status', 'candidate_ids', 'matched_terms'],
        properties: {
          criterion_id: stableId, match_mode: { enum: ['ANY', 'ALL', 'AT_LEAST'] },
          minimum_matches: { type: 'integer', minimum: 1, maximum: 64 }, required_terms: stringSet,
          status: { enum: ['COVERED', 'MISSING', 'CONFLICTED'] },
          candidate_ids: { type: 'array', maxItems: 128, uniqueItems: true, items: hash }, matched_terms: stringSet,
        },
      },
    },
    missing_required_sources: pathSet, missing_required_terms: stringSet,
    conflicts: { type: 'array', maxItems: 128, items: conflict },
    source_failures: contextSourceFailuresSchema, truncation,
  },
} as const;

export const selectionReceiptSchema = {
  $schema: draft, $id: 'https://primecontext.dev/schemas/v0.3/selection-receipt.schema.json',
  type: 'object', additionalProperties: false,
  required: [
    'schema_version', 'task_id', 'request_digest', 'selection_digest', 'receipt_digest', 'policy_version',
    'policy_components', 'decisions', 'duplicate_groups', 'conflicts', 'source_failures', 'truncation',
  ],
  properties: {
    schema_version: { const: '0.3' }, task_id: taskId, request_digest: hash, selection_digest: hash,
    receipt_digest: hash, policy_version: { ...bounded, maxLength: 128 },
    budget_tier: { enum: contextBudgetTiers }, policy_components: scoreComponents,
    decisions: {
      type: 'array', maxItems: 2048, items: {
        type: 'object', additionalProperties: false,
        required: ['candidate_id', 'status', 'reason', 'mandatory', 'score', 'score_components', 'marginal_criteria_ids', 'marginal_terms'],
        properties: {
          candidate_id: hash, status: { enum: ['INCLUDED', 'OMITTED'] }, reason: { enum: contextDecisionReasons },
          mandatory: { type: 'boolean' }, score: { type: 'integer', minimum: 0, maximum: 100_000 },
          score_components: scoreComponents, marginal_criteria_ids: idSet, marginal_terms: stringSet, duplicate_of: hash,
        },
      },
    },
    duplicate_groups: {
      type: 'array', maxItems: 2048, items: {
        type: 'object', additionalProperties: false, required: ['representative_id', 'duplicate_ids'],
        properties: { representative_id: hash, duplicate_ids: hashSet },
      },
    },
    conflicts: { type: 'array', maxItems: 128, items: conflict },
    source_failures: contextSourceFailuresSchema, truncation,
  },
} as const;

export const expansionRequestSchema = {
  $schema: draft, $id: 'https://primecontext.dev/schemas/v0.3/expansion-request.schema.json',
  type: 'object', additionalProperties: false,
  required: [
    'schema_version', 'task_id', 'previous_selection_digest', 'known_candidate_ids', 'reason',
    'requested_paths', 'requested_symbols', 'requested_terms', 'additional_budget',
  ],
  properties: {
    schema_version: { const: '0.3' }, task_id: taskId, previous_selection_digest: hash,
    known_candidate_ids: { ...hashSet, maxItems: 128 },
    reason: { enum: ['MISSING_CRITERION', 'MISSING_REQUIRED_SOURCE', 'MISSING_TERM', 'CONFLICT_REVIEW'] },
    requested_paths: pathSet, requested_symbols: stringSet, requested_terms: stringSet,
    additional_budget: {
      ...budget,
      properties: { ...budget.properties, max_items: { type: 'integer', minimum: 1, maximum: 64 } },
    },
  },
} as const;

export const expansionDecisionSchema = {
  $schema: draft, $id: 'https://primecontext.dev/schemas/v0.3/expansion-decision.schema.json',
  type: 'object', additionalProperties: false,
  required: [
    'schema_version', 'task_id', 'previous_selection_digest', 'selection_digest', 'status', 'reason_codes',
    'additions', 'cumulative_budget', 'remaining_missing_evidence', 'snapshot',
  ],
  properties: {
    schema_version: { const: '0.3' }, task_id: taskId, previous_selection_digest: hash, selection_digest: hash,
    status: { enum: ['ALLOWED', 'PARTIAL', 'DENIED'] }, budget_tier: { enum: contextBudgetTiers },
    reason_codes: { type: 'array', minItems: 1, maxItems: 8, uniqueItems: true, items: { enum: ['EVIDENCE_ADDED', 'NO_NEW_EVIDENCE', 'HARD_LIMIT_REACHED', 'STALE_PARENT', 'DUPLICATE_ONLY'] } },
    additions: { ...hashSet, maxItems: 64 },
    cumulative_budget: {
      ...budget,
      required: [...budget.required, 'used_items', 'used_bytes', 'used_estimated_tokens'],
      properties: { ...budget.properties, used_items: nonNegativeInteger, used_bytes: nonNegativeInteger, used_estimated_tokens: nonNegativeInteger },
    },
    remaining_missing_evidence: stringSet, snapshot,
  },
} as const;

const outcomeProperties = {
  schema_version: { const: '0.3' }, run_id: stableId, task_id: taskId, selection_digest: hash, snapshot,
  started_at: { type: 'string', format: 'date-time', pattern: 'Z$', maxLength: 64 },
  recorded_at: { type: 'string', format: 'date-time', pattern: 'Z$', maxLength: 64 },
  used_candidate_ids: { ...hashSet, maxItems: 128 }, touched_paths: { ...pathSet, maxItems: 256 },
  test_status: { enum: ['PASS', 'FAIL', 'PARTIAL', 'NOT_RUN'] }, review_status: { enum: ['PASS', 'FAIL', 'PARTIAL', 'NOT_RUN'] },
  completion_status: { enum: ['PASS', 'FAIL', 'PARTIAL', 'NOT_RUN'] },
  metrics: {
    type: 'object', additionalProperties: false,
    properties: { duration_ms: nonNegativeInteger, input_tokens: nonNegativeInteger, output_tokens: nonNegativeInteger, rework_count: nonNegativeInteger },
  },
  estimated_fields: { type: 'array', maxItems: 4, uniqueItems: true, items: { enum: ['duration_ms', 'input_tokens', 'output_tokens', 'rework_count'] } },
  source: { enum: ['human', 'tool', 'imported'] },
  notes: { type: 'string', maxLength: 4096, 'x-primecontext-max-utf8-bytes': 4096 },
} as const;

const outcomeRequired = [
  'schema_version', 'run_id', 'task_id', 'selection_digest', 'snapshot', 'started_at', 'recorded_at',
  'used_candidate_ids', 'touched_paths', 'test_status', 'review_status', 'completion_status', 'metrics', 'source',
] as const;

export const outcomeDeclarationSchema = {
  $schema: draft, $id: 'https://primecontext.dev/schemas/v0.3/outcome-declaration.schema.json',
  type: 'object', additionalProperties: false, required: outcomeRequired, properties: outcomeProperties,
} as const;

export const outcomeReceiptSchema = {
  $schema: draft, $id: 'https://primecontext.dev/schemas/v0.3/outcome-receipt.schema.json',
  type: 'object', additionalProperties: false,
  required: [
    ...outcomeRequired, 'outcome_digest', 'causality',
  ],
  properties: {
    ...outcomeProperties,
    outcome_digest: hash, causality: { const: 'OBSERVATIONAL_ONLY' },
  },
} as const;

export const ablationRequestSchema = {
  $schema: draft, $id: 'https://primecontext.dev/schemas/v0.3/ablation-request.schema.json',
  type: 'object', additionalProperties: false,
  required: ['schema_version', 'task_id', 'selection_digest', 'candidate_id'],
  properties: { schema_version: { const: '0.3' }, task_id: taskId, selection_digest: hash, candidate_id: hash },
} as const;

export const ablationResultSchema = {
  $schema: draft, $id: 'https://primecontext.dev/schemas/v0.3/ablation-result.schema.json',
  type: 'object', additionalProperties: false,
  required: [
    'schema_version', 'task_id', 'parent_selection_digest', 'removed_candidate_id', 'decision', 'reason',
    'evidence_status', 'missing_criteria_ids', 'missing_required_terms', 'experimental', 'causal_claim',
  ],
  properties: {
    schema_version: { const: '0.3' }, task_id: taskId, parent_selection_digest: hash, ablated_selection_digest: hash,
    removed_candidate_id: hash, decision: { enum: ['DERIVED', 'DENIED'] },
    reason: { enum: ['NON_MANDATORY_REMOVED', 'MANDATORY_CANDIDATE', 'CANDIDATE_NOT_SELECTED'] },
    evidence_status: { enum: contextEvidenceStatuses }, missing_criteria_ids: idSet,
    missing_required_terms: stringSet, missing_required_sources: pathSet,
    budget_status: { enum: contextBudgetStatuses }, source_failures: contextSourceFailuresSchema,
    conflicts: { type: 'array', maxItems: 128, items: conflict },
    experimental: { const: true }, causal_claim: { const: 'NONE' },
  },
} as const;

export const replayResultSchema = {
  $schema: draft, $id: 'https://primecontext.dev/schemas/v0.3/replay-result.schema.json',
  type: 'object', additionalProperties: false,
  required: [
    'schema_version', 'task_id', 'status', 'old_selection_digest', 'old_snapshot',
    'added_candidate_ids', 'removed_candidate_ids', 'source_failures', 'freshness', 'replay_digest',
  ],
  properties: {
    schema_version: { const: '0.3' }, task_id: taskId,
    status: { enum: ['IDENTICAL', 'DRIFTED', 'UNREPLAYABLE'] },
    old_selection_digest: hash, new_selection_digest: hash, old_snapshot: snapshot, new_snapshot: snapshot,
    added_candidate_ids: { ...hashSet, maxItems: 128 }, removed_candidate_ids: { ...hashSet, maxItems: 128 },
    source_failures: contextSourceFailuresSchema,
    freshness: { enum: ['MATCHED', 'CHANGED', 'UNAVAILABLE'] }, replay_digest: hash,
  },
} as const;
