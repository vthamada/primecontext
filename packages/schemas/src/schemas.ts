const draft = 'https://json-schema.org/draft/2020-12/schema';

export const taskTypes = [
  'small_ui',
  'small_code_fix',
  'module_feature',
  'integration',
  'qa',
  'orchestration',
] as const;

export const metricNumericFields = [
  'input_tokens',
  'cached_input_tokens',
  'output_tokens',
  'tool_calls',
  'file_reads',
  'codegraph_calls',
  'context_expansions',
  'duration_ms',
  'selected_context_tokens',
  'rework_count',
] as const;

const stringArray = { type: 'array', items: { type: 'string' } } as const;
const nonNegativeInteger = { type: 'integer', minimum: 0 } as const;
const positiveInteger = { type: 'integer', minimum: 1 } as const;

export const contextBudgetSchema = {
  $schema: draft,
  $id: 'https://primecontext.dev/schemas/v0.1/context-budget.schema.json',
  type: 'object',
  additionalProperties: false,
  required: ['initial_tokens', 'soft_limit_tokens', 'hard_limit_tokens'],
  properties: {
    initial_tokens: positiveInteger,
    soft_limit_tokens: positiveInteger,
    hard_limit_tokens: positiveInteger,
  },
} as const;

export const taskCapsuleSchema = {
  $schema: draft,
  $id: 'https://primecontext.dev/schemas/v0.1/task-capsule.schema.json',
  type: 'object',
  additionalProperties: false,
  required: ['schema_version', 'task_id', 'goal', 'task_type', 'boundaries', 'acceptance', 'context_budget'],
  properties: {
    schema_version: { const: '0.1' },
    task_id: { type: 'string', minLength: 1 },
    goal: { type: 'string', minLength: 1 },
    task_type: { enum: taskTypes },
    module: { type: 'string', minLength: 1 },
    priority: { type: 'string', minLength: 1 },
    boundaries: {
      type: 'object', additionalProperties: false,
      required: ['allowed_paths', 'forbidden_paths'],
      properties: { allowed_paths: stringArray, forbidden_paths: stringArray },
    },
    decisions: {
      type: 'array', items: {
        type: 'object', additionalProperties: false, required: ['source', 'summary'],
        properties: { source: { type: 'string', minLength: 1 }, summary: { type: 'string', minLength: 1 } },
      },
    },
    contracts: stringArray,
    documents: stringArray,
    code_targets: stringArray,
    acceptance: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
    context_budget: contextBudgetSchema,
    worktree: {
      type: 'object', additionalProperties: false, required: ['root'],
      properties: {
        root: { type: 'string', minLength: 1 },
        branch: { type: 'string', minLength: 1 },
        head: { type: 'string', minLength: 1 },
      },
    },
    metadata: { type: 'object' },
  },
} as const;

export const compactHandoffSchema = {
  $schema: draft,
  $id: 'https://primecontext.dev/schemas/v0.1/compact-handoff.schema.json',
  type: 'object',
  additionalProperties: false,
  required: ['schema_version', 'task_id', 'status', 'changed_files', 'tests', 'risks', 'next_unblocked'],
  properties: {
    schema_version: { const: '0.1' },
    task_id: { type: 'string', minLength: 1 },
    status: { enum: ['PASS', 'FAIL', 'PARTIAL', 'BLOCKED'] },
    commit: { type: 'string', minLength: 1 },
    changed_files: stringArray,
    interfaces_added: stringArray,
    decisions: stringArray,
    tests: {
      type: 'object', additionalProperties: false, required: ['passed', 'failed'],
      properties: { passed: nonNegativeInteger, failed: nonNegativeInteger, skipped: nonNegativeInteger },
    },
    risks: stringArray,
    next_unblocked: stringArray,
    artifacts: stringArray,
    metrics_ref: { type: 'string', minLength: 1 },
  },
} as const;

export const repoMapSchema = {
  $schema: draft,
  $id: 'https://primecontext.dev/schemas/v0.1/semantic-repo-map.schema.json',
  type: 'object',
  additionalProperties: false,
  required: ['schema_version', 'generated_at', 'repository', 'modules', 'summary'],
  properties: {
    schema_version: { const: '0.1' },
    generated_at: { type: 'string', minLength: 1 },
    repository: {
      type: 'object', additionalProperties: false, required: ['root', 'name'],
      properties: {
        root: { type: 'string', minLength: 1 }, name: { type: 'string', minLength: 1 },
        branch: { type: 'string', minLength: 1 }, head: { type: 'string', minLength: 1 },
      },
    },
    modules: {
      type: 'array', items: {
        type: 'object', additionalProperties: false, required: ['id', 'path', 'kind', 'role', 'evidence'],
        properties: {
          id: { type: 'string', minLength: 1 }, path: { type: 'string', minLength: 1 },
          kind: { enum: ['workspace_package', 'source', 'tests', 'documentation', 'configuration', 'examples', 'benchmarks', 'other'] },
          role: { type: 'string', minLength: 1 }, evidence: stringArray,
        },
      },
    },
    summary: {
      type: 'object', additionalProperties: false,
      required: ['module_count', 'discovered_path_count', 'excluded_path_count'],
      properties: { module_count: nonNegativeInteger, discovered_path_count: nonNegativeInteger, excluded_path_count: nonNegativeInteger },
    },
  },
} as const;

export const metricRecordSchema = {
  $schema: draft,
  $id: 'https://primecontext.dev/schemas/v0.1/metric-record.schema.json',
  type: 'object',
  additionalProperties: false,
  required: ['schema_version', 'task_id', 'recorded_at'],
  properties: {
    schema_version: { const: '0.1' }, task_id: { type: 'string', minLength: 1 }, recorded_at: { type: 'string', minLength: 1 },
    arm: { enum: ['A', 'B'] },
    input_tokens: nonNegativeInteger, cached_input_tokens: nonNegativeInteger, output_tokens: nonNegativeInteger,
    tool_calls: nonNegativeInteger, file_reads: nonNegativeInteger, codegraph_calls: nonNegativeInteger,
    context_expansions: nonNegativeInteger, duration_ms: nonNegativeInteger, selected_context_tokens: nonNegativeInteger,
    test_status: { enum: ['PASS', 'FAIL', 'UNKNOWN'] }, review_status: { enum: ['PASS', 'FAIL', 'UNKNOWN'] }, rework_count: nonNegativeInteger,
    estimated_fields: { type: 'array', uniqueItems: true, items: { enum: metricNumericFields } },
  },
} as const;
