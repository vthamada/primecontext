const draft = 'https://json-schema.org/draft/2020-12/schema';

export const taskIdPattern = '^(?!(?:[Cc][Oo][Nn]|[Pp][Rr][Nn]|[Aa][Uu][Xx]|[Nn][Uu][Ll]|[Cc][Oo][Mm][1-9]|[Ll][Pp][Tt][1-9])(?:\\.|(?![\\s\\S])))[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9_-])?(?![\\s\\S])';

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
  'agent_output_tokens',
  'tool_calls',
  'file_reads',
  'codegraph_calls',
  'context_expansions',
  'duration_ms',
  'selected_context_tokens',
  'rework_count',
] as const;

const nonEmptyString = { type: 'string', minLength: 1 } as const;
const taskIdString = { ...nonEmptyString, maxLength: 128, pattern: taskIdPattern } as const;
const stringArray = { type: 'array', items: nonEmptyString } as const;
const nonNegativeInteger = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER } as const;
const positiveInteger = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER } as const;
const sha256 = { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' } as const;
const boundedRunText = {
  type: 'string', minLength: 1, maxLength: 1024,
  pattern: '^[^\\u0000-\\u001f\\u007f-\\u009f]+$',
} as const;

const contextBudgetContract = {
  type: 'object',
  additionalProperties: false,
  required: ['initial_tokens', 'soft_limit_tokens', 'hard_limit_tokens'],
  $comment: 'initial_tokens <= soft_limit_tokens <= hard_limit_tokens; enforced by the runtime validator.',
  properties: {
    initial_tokens: positiveInteger,
    soft_limit_tokens: positiveInteger,
    hard_limit_tokens: positiveInteger,
  },
} as const;

export const contextBudgetSchema = {
  $schema: draft,
  $id: 'https://primecontext.dev/schemas/v0.1/context-budget.schema.json',
  ...contextBudgetContract,
} as const;

export const taskCapsuleSchema = {
  $schema: draft,
  $id: 'https://primecontext.dev/schemas/v0.1/task-capsule.schema.json',
  type: 'object',
  additionalProperties: false,
  required: ['schema_version', 'task_id', 'goal', 'task_type', 'boundaries', 'acceptance', 'context_budget'],
  properties: {
    schema_version: { const: '0.1' },
    task_id: taskIdString,
    goal: nonEmptyString,
    task_type: { enum: taskTypes },
    module: nonEmptyString,
    priority: nonEmptyString,
    boundaries: {
      type: 'object', additionalProperties: false,
      required: ['allowed_paths', 'forbidden_paths'],
      properties: { allowed_paths: stringArray, forbidden_paths: stringArray },
    },
    decisions: {
      type: 'array', items: {
        type: 'object', additionalProperties: false, required: ['source', 'summary'],
        properties: { source: nonEmptyString, summary: nonEmptyString },
      },
    },
    contracts: stringArray,
    documents: stringArray,
    code_targets: stringArray,
    acceptance: { type: 'array', minItems: 1, items: nonEmptyString },
    context_budget: contextBudgetContract,
    worktree: {
      type: 'object', additionalProperties: false, required: ['root'],
      properties: {
        root: nonEmptyString,
        branch: nonEmptyString,
        head: nonEmptyString,
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
    task_id: taskIdString,
    status: { enum: ['PASS', 'FAIL', 'PARTIAL', 'BLOCKED'] },
    commit: nonEmptyString,
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
    metrics_ref: nonEmptyString,
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
    generated_at: nonEmptyString,
    repository: {
      type: 'object', additionalProperties: false, required: ['root', 'name'],
      properties: {
        root: nonEmptyString, name: nonEmptyString,
        branch: nonEmptyString, head: nonEmptyString,
      },
    },
    modules: {
      type: 'array',
      $comment: 'Module ids must be unique; enforced by the runtime validator.',
      items: {
        type: 'object', additionalProperties: false, required: ['id', 'path', 'kind', 'role', 'evidence'],
        properties: {
          id: nonEmptyString, path: nonEmptyString,
          kind: { enum: ['workspace_package', 'source', 'tests', 'documentation', 'configuration', 'examples', 'benchmarks', 'other'] },
          role: nonEmptyString, evidence: stringArray,
        },
      },
    },
    summary: {
      type: 'object', additionalProperties: false,
      required: ['module_count', 'discovered_path_count', 'excluded_path_count'],
      $comment: 'module_count must equal the length of modules; enforced by the runtime validator.',
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
    schema_version: { const: '0.1' }, task_id: taskIdString, recorded_at: nonEmptyString,
    arm: { enum: ['A', 'B'] },
    input_tokens: nonNegativeInteger, cached_input_tokens: nonNegativeInteger, output_tokens: nonNegativeInteger,
    agent_output_tokens: nonNegativeInteger,
    tool_calls: nonNegativeInteger, file_reads: nonNegativeInteger, codegraph_calls: nonNegativeInteger,
    context_expansions: nonNegativeInteger, duration_ms: nonNegativeInteger, selected_context_tokens: nonNegativeInteger,
    test_status: { enum: ['PASS', 'FAIL', 'UNKNOWN'] }, review_status: { enum: ['PASS', 'FAIL', 'UNKNOWN'] },
    completion_status: { enum: ['PASS', 'FAIL', 'UNKNOWN'] }, rework_count: nonNegativeInteger,
    estimated_fields: {
      type: 'array', uniqueItems: true, items: { enum: metricNumericFields },
      $comment: 'Each estimated field must also be present as a measurement; enforced by the runtime validator.',
    },
    run_environment: {
      type: 'object', additionalProperties: false,
      required: [
        'commit', 'worktree_digest', 'agent', 'model', 'reasoning_effort', 'permissions', 'runtime',
        'lockfile_hash', 'time_limit_ms', 'test_command', 'rubric',
      ],
      properties: {
        commit: { ...boundedRunText, maxLength: 128 }, worktree_digest: sha256,
        agent: boundedRunText, model: boundedRunText, reasoning_effort: boundedRunText,
        permissions: boundedRunText, runtime: boundedRunText, lockfile_hash: sha256,
        time_limit_ms: positiveInteger,
        test_command: { ...boundedRunText, maxLength: 4096 }, rubric: boundedRunText,
      },
    },
  },
} as const;

export const primeContextConfigSchema = {
  $schema: draft,
  $id: 'https://primecontext.dev/schemas/v0.1/primecontext-config.schema.json',
  type: 'object',
  additionalProperties: false,
  required: ['schema_version', 'state_dir', 'exclude', 'budgets'],
  properties: {
    schema_version: { const: '0.1' },
    state_dir: nonEmptyString,
    exclude: stringArray,
    budgets: {
      type: 'object',
      additionalProperties: false,
      required: taskTypes,
      properties: {
        small_ui: contextBudgetContract,
        small_code_fix: contextBudgetContract,
        module_feature: contextBudgetContract,
        integration: contextBudgetContract,
        qa: contextBudgetContract,
        orchestration: contextBudgetContract,
      },
    },
  },
} as const;
