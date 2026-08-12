import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isValidTaskId,
  metricRecordSchema,
  primeContextConfigSchema,
  taskCapsuleSchema,
  validateCompactHandoff,
  validateMetricRecord,
  validatePrimeContextConfig,
  validateRepoMap,
  validateTaskCapsule,
} from './index.js';

const validCapsule = {
  schema_version: '0.1',
  task_id: 'PROP-014',
  goal: 'Implement immutable proposal versioning',
  task_type: 'module_feature',
  boundaries: { allowed_paths: ['src/Proposal'], forbidden_paths: ['src/Pricing'] },
  acceptance: ['Previous versions are not overwritten'],
  context_budget: { initial_tokens: 6000, soft_limit_tokens: 12000, hard_limit_tokens: 24000 },
};

test('accepts a valid Task Capsule and rejects a missing goal', () => {
  assert.equal(validateTaskCapsule(validCapsule).valid, true);
  const invalid = { ...validCapsule } as Record<string, unknown>;
  delete invalid.goal;
  const result = validateTaskCapsule(invalid);
  assert.equal(result.valid, false);
  assert.match(result.errors.join('\n'), /goal/);
});

test('accepts a valid Compact Handoff', () => {
  const result = validateCompactHandoff({
    schema_version: '0.1', task_id: 'PROP-014', status: 'PASS', changed_files: [],
    tests: { passed: 1, failed: 0 }, risks: [], next_unblocked: [],
  });
  assert.equal(result.valid, true);
});

test('accepts a valid Semantic Repo Map', () => {
  const result = validateRepoMap({
    schema_version: '0.1', generated_at: new Date().toISOString(),
    repository: { root: '/tmp/project', name: 'project' }, modules: [],
    summary: { module_count: 0, discovered_path_count: 0, excluded_path_count: 0 },
  });
  assert.equal(result.valid, true);
});

test('requires estimated metric fields to be explicitly labeled', () => {
  const valid = validateMetricRecord({
    schema_version: '0.1', task_id: 'PROP-014', recorded_at: new Date().toISOString(),
    input_tokens: 1200, estimated_fields: ['input_tokens'], test_status: 'PASS',
  });
  assert.equal(valid.valid, true);

  const invalid = validateMetricRecord({
    schema_version: '0.1', task_id: 'PROP-014', recorded_at: new Date().toISOString(),
    estimated_fields: ['not_a_metric'],
  });
  assert.equal(invalid.valid, false);
});

test('rejects integers that cannot round-trip safely through the JavaScript runtime', () => {
  const unsafe = Number.MAX_SAFE_INTEGER + 1;
  assert.equal(validateMetricRecord({
    schema_version: '0.1', task_id: 'PROP-014', recorded_at: new Date().toISOString(), input_tokens: unsafe,
  }).valid, false);
  assert.equal(validateTaskCapsule({
    ...validCapsule,
    context_budget: { initial_tokens: 1, soft_limit_tokens: 2, hard_limit_tokens: unsafe },
  }).valid, false);
});

test('accepts only the documented optional completion status values', () => {
  for (const completion_status of ['PASS', 'FAIL', 'UNKNOWN']) {
    const result = validateMetricRecord({
      schema_version: '0.1', task_id: 'PROP-014', recorded_at: new Date().toISOString(), completion_status,
    });
    assert.equal(result.valid, true, `${completion_status} must be accepted`);
  }

  const invalid = validateMetricRecord({
    schema_version: '0.1', task_id: 'PROP-014', recorded_at: new Date().toISOString(), completion_status: 'PARTIAL',
  });
  assert.equal(invalid.valid, false);
  assert.match(invalid.errors.join('\n'), /completion_status/);
  assert.deepEqual(
    (metricRecordSchema.properties as Record<string, { enum?: readonly string[] }>).completion_status?.enum,
    ['PASS', 'FAIL', 'UNKNOWN'],
  );
});

test('rejects task ids that are unsafe as a single filesystem segment', () => {
  for (const taskId of [
    '../escape', '..\\escape', '/absolute', 'C:drive', 'space id', 'trailing.', '.hidden', 'A\n',
    'CON', 'nul.json', 'LPT9', 'A'.repeat(129),
  ]) {
    const result = validateTaskCapsule({ ...validCapsule, task_id: taskId });
    assert.equal(result.valid, false, `${taskId} must be rejected`);
    assert.match(result.errors.join('\n'), /task_id/);
  }

  for (const taskId of ['X', 'A-', 'MAXSOUND-PILOT-001', 'task.v0_1', 'A'.repeat(128)]) {
    assert.equal(validateTaskCapsule({ ...validCapsule, task_id: taskId }).valid, true, `${taskId} must remain valid`);
  }

  const taskIdContract = taskCapsuleSchema.properties.task_id as { pattern?: string; maxLength?: number };
  assert.equal(taskIdContract.maxLength, 128);
  assert.equal(typeof taskIdContract.pattern, 'string');
  assert.equal(new RegExp(taskIdContract.pattern as string).test('../escape'), false);

  assert.equal(isValidTaskId('MAXSOUND-PILOT-001'), true);
  assert.equal(isValidTaskId('../escape'), false);
  assert.equal(isValidTaskId(123), false);

  assert.equal(validateCompactHandoff({
    schema_version: '0.1', task_id: '../escape', status: 'PASS', changed_files: [],
    tests: { passed: 1, failed: 0 }, risks: [], next_unblocked: [],
  }).valid, false);
  assert.equal(validateMetricRecord({
    schema_version: '0.1', task_id: '../escape', recorded_at: new Date().toISOString(),
  }).valid, false);
});

test('keeps representable string-array constraints aligned with runtime validation', () => {
  const allowedPathItems = taskCapsuleSchema.properties.boundaries.properties.allowed_paths.items as { minLength?: number };
  assert.equal(allowedPathItems.minLength, 1);
  assert.equal(validateTaskCapsule({
    ...validCapsule,
    boundaries: { allowed_paths: [''], forbidden_paths: [] },
  }).valid, false);
});

test('rejects sparse arrays and metadata that cannot round-trip through JSON', () => {
  const sparseAcceptance = new Array<string>(1);
  assert.equal(validateTaskCapsule({ ...validCapsule, acceptance: sparseAcceptance }).valid, false);

  const cyclicMetadata: Record<string, unknown> = {};
  cyclicMetadata.self = cyclicMetadata;
  for (const metadata of [
    { secret_count: 1n },
    { missing: undefined },
    { invalid_number: Number.POSITIVE_INFINITY },
    { callback: () => undefined },
    cyclicMetadata,
  ]) {
    const result = validateTaskCapsule({ ...validCapsule, metadata });
    assert.equal(result.valid, false);
    assert.match(result.errors.join('\n'), /metadata/);
  }
});

test('rejects accessor-backed metadata without invoking getters', () => {
  const metadata: Record<string, unknown> = {};
  Object.defineProperty(metadata, 'dangerous', {
    enumerable: true,
    get: () => { throw new Error('getter must not execute during validation'); },
  });
  let result: ReturnType<typeof validateTaskCapsule> | undefined;
  assert.doesNotThrow(() => { result = validateTaskCapsule({ ...validCapsule, metadata }); });
  assert.equal(result?.valid, false);
  assert.match(result?.errors.join('\n') ?? '', /metadata\.dangerous/);
});

test('rejects metadata that exceeds bounded runtime nesting', () => {
  let metadata: Record<string, unknown> = {};
  for (let depth = 0; depth < 80; depth += 1) metadata = { child: metadata };
  const result = validateTaskCapsule({ ...validCapsule, metadata });
  assert.equal(result.valid, false);
  assert.match(result.errors.join('\n'), /metadata.*nesting depth/i);

  const oversized = validateTaskCapsule({ ...validCapsule, metadata: { values: new Array(100_001).fill(null) } });
  assert.equal(oversized.valid, false);
  assert.match(oversized.errors.join('\n'), /metadata.*JSON value limit/i);
});

test('requires estimated field labels to reference present measurements', () => {
  const result = validateMetricRecord({
    schema_version: '0.1', task_id: 'PROP-014', recorded_at: new Date().toISOString(),
    estimated_fields: ['input_tokens'],
  });
  assert.equal(result.valid, false);
  assert.match(result.errors.join('\n'), /input_tokens.*present/);

  const undefinedMeasurement = validateMetricRecord({
    schema_version: '0.1', task_id: 'PROP-014', recorded_at: new Date().toISOString(),
    input_tokens: undefined, estimated_fields: ['input_tokens'],
  });
  assert.equal(undefinedMeasurement.valid, false);
});

test('rejects repo maps with inconsistent module counts or duplicate stable ids', () => {
  const module = { id: 'core', path: 'packages/core', kind: 'workspace_package', role: 'Core domain', evidence: ['workspace manifest'] };
  const base = {
    schema_version: '0.1', generated_at: new Date().toISOString(), repository: { root: '/repo', name: 'repo' },
    modules: [module], summary: { module_count: 1, discovered_path_count: 1, excluded_path_count: 0 },
  };

  const wrongCount = validateRepoMap({ ...base, summary: { ...base.summary, module_count: 0 } });
  assert.equal(wrongCount.valid, false);
  assert.match(wrongCount.errors.join('\n'), /module_count/);

  const duplicateIds = validateRepoMap({
    ...base,
    modules: [module, { ...module, path: 'packages/core-copy' }],
    summary: { ...base.summary, module_count: 2 },
  });
  assert.equal(duplicateIds.valid, false);
  assert.match(duplicateIds.errors.join('\n'), /duplicate.*core/i);
});

test('exports and validates the complete repository configuration contract', () => {
  const budget = { initial_tokens: 100, soft_limit_tokens: 200, hard_limit_tokens: 400 };
  const validConfig = {
    schema_version: '0.1',
    state_dir: '.primecontext',
    exclude: ['coverage'],
    budgets: {
      small_ui: budget,
      small_code_fix: budget,
      module_feature: budget,
      integration: budget,
      qa: budget,
      orchestration: budget,
    },
  };

  assert.equal(primeContextConfigSchema.$id, 'https://primecontext.dev/schemas/v0.1/primecontext-config.schema.json');
  assert.equal(validatePrimeContextConfig(validConfig).valid, true);

  const missingBudget = structuredClone(validConfig);
  delete (missingBudget.budgets as Partial<typeof missingBudget.budgets>).qa;
  const missingResult = validatePrimeContextConfig(missingBudget);
  assert.equal(missingResult.valid, false);
  assert.match(missingResult.errors.join('\n'), /budgets\.qa.*required/);

  const invalidOrder = structuredClone(validConfig);
  invalidOrder.budgets.integration = { initial_tokens: 500, soft_limit_tokens: 200, hard_limit_tokens: 400 };
  const orderResult = validatePrimeContextConfig(invalidOrder);
  assert.equal(orderResult.valid, false);
  assert.match(orderResult.errors.join('\n'), /budgets\.integration.*initial_tokens/);

  const extraBudget = {
    ...validConfig,
    budgets: { ...validConfig.budgets, unsupported: budget },
  };
  assert.equal(validatePrimeContextConfig(extraBudget).valid, false);
});
