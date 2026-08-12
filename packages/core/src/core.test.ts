import assert from 'node:assert/strict';
import test from 'node:test';
import {
  allocateContextBudget,
  assertValidHandoff,
  assertValidMetricRecord,
  createTaskCapsule,
  experimentalBudgetDefaults,
  PrimeContextError,
} from './index.js';

test('allocates the experimental module feature budget', () => {
  assert.deepEqual(allocateContextBudget('module_feature'), {
    initial_tokens: 6000,
    soft_limit_tokens: 12000,
    hard_limit_tokens: 24000,
  });
});

test('rejects a context budget whose limits are out of order', () => {
  assert.throws(
    () => allocateContextBudget('small_code_fix', { initial_tokens: 9000, soft_limit_tokens: 8000 }),
    /initial_tokens must be <= soft_limit_tokens/,
  );
});

test('creates a validated task capsule with optional worktree metadata', () => {
  const capsule = createTaskCapsule({
    task_id: 'PROP-014',
    goal: 'Implement immutable proposal versioning',
    task_type: 'module_feature',
    boundaries: { allowed_paths: ['src/Proposal'], forbidden_paths: ['src/Pricing'] },
    acceptance: ['Previous versions are not overwritten'],
  }, { branch: 'feat/proposals', root: '/repo', head: 'abc123' });

  assert.equal(capsule.schema_version, '0.1');
  assert.equal(capsule.context_budget.initial_tokens, 6000);
  assert.equal(capsule.worktree?.branch, 'feat/proposals');
});

test('rejects an invalid compact handoff at the core boundary', () => {
  assert.throws(() => assertValidHandoff({ schema_version: '0.1', task_id: 'X' }), /VALIDATION_ERROR/);
});

test('accepts metric records whose estimate labels name measurable fields', () => {
  const record = assertValidMetricRecord({
    schema_version: '0.1', task_id: 'X', recorded_at: new Date().toISOString(),
    input_tokens: 100, estimated_fields: ['input_tokens'], test_status: 'PASS',
  });
  assert.equal(record.input_tokens, 100);
});

test('preserves a validated completion status without aliasing the input', () => {
  const input = {
    schema_version: '0.1', task_id: 'X', recorded_at: new Date().toISOString(), completion_status: 'PASS',
  };
  const record = assertValidMetricRecord(input);
  input.completion_status = 'FAIL';
  assert.equal(record.completion_status, 'PASS');
});

test('derives an omitted hard limit from the effective soft limit', () => {
  assert.deepEqual(allocateContextBudget('small_ui', { soft_limit_tokens: 7000 }), {
    initial_tokens: 3000,
    soft_limit_tokens: 7000,
    hard_limit_tokens: 14000,
  });
  assert.deepEqual(allocateContextBudget('small_ui', { soft_limit_tokens: 7000, hard_limit_tokens: 15000 }), {
    initial_tokens: 3000,
    soft_limit_tokens: 7000,
    hard_limit_tokens: 15000,
  });
});

test('rejects an unsupported task type even with complete budget overrides', () => {
  assert.throws(
    () => allocateContextBudget('unsupported' as never, {
      initial_tokens: 1,
      soft_limit_tokens: 2,
      hard_limit_tokens: 4,
    }),
    /task type/i,
  );
});

test('returns a Task Capsule that does not alias mutable input state', () => {
  const boundaries = { allowed_paths: ['src'], forbidden_paths: ['private'] };
  const acceptance = ['tests pass'];
  const decisions = [{ source: 'ADR-001', summary: 'Keep the boundary local' }];
  const metadata = { labels: ['safe'] };
  const worktree = { root: '/repo', branch: 'main' };
  const capsule = createTaskCapsule({
    task_id: 'SAFE-001', goal: 'Create a safe capsule', task_type: 'small_code_fix',
    boundaries, acceptance, decisions, metadata,
  }, worktree);

  boundaries.allowed_paths[0] = '../outside';
  acceptance[0] = '';
  decisions[0]!.summary = 'changed';
  metadata.labels[0] = 'changed';
  worktree.root = '/other';

  assert.deepEqual(capsule.boundaries.allowed_paths, ['src']);
  assert.deepEqual(capsule.acceptance, ['tests pass']);
  assert.equal(capsule.decisions?.[0]?.summary, 'Keep the boundary local');
  assert.deepEqual(capsule.metadata, { labels: ['safe'] });
  assert.equal(capsule.worktree?.root, '/repo');
});

test('keeps exported budget defaults deeply immutable', () => {
  assert.equal(Object.isFrozen(experimentalBudgetDefaults), true);
  assert.equal(Object.isFrozen(experimentalBudgetDefaults.small_ui), true);
  const original = experimentalBudgetDefaults.small_ui.initial_tokens;
  try {
    assert.equal(Reflect.set(experimentalBudgetDefaults.small_ui, 'initial_tokens', 1), false);
  } finally {
    Reflect.set(experimentalBudgetDefaults.small_ui, 'initial_tokens', original);
  }
  assert.equal(allocateContextBudget('small_ui').initial_tokens, original);
});

test('validated handoffs and metrics do not alias their input objects', () => {
  const handoffInput = {
    schema_version: '0.1', task_id: 'SAFE-001', status: 'PASS', changed_files: ['src/index.ts'],
    tests: { passed: 1, failed: 0 }, risks: [], next_unblocked: [],
  };
  const metricInput = {
    schema_version: '0.1', task_id: 'SAFE-001', recorded_at: new Date().toISOString(),
    input_tokens: 100, estimated_fields: ['input_tokens'],
  };
  const handoff = assertValidHandoff(handoffInput);
  const metric = assertValidMetricRecord(metricInput);

  handoffInput.changed_files[0] = '../outside';
  metricInput.input_tokens = 999;

  assert.deepEqual(handoff.changed_files, ['src/index.ts']);
  assert.equal(metric.input_tokens, 100);
});

test('represents optional Git unavailability with the documented error code', () => {
  const error = new PrimeContextError('GIT_UNAVAILABLE', 'Git metadata is unavailable');
  assert.equal(error.code, 'GIT_UNAVAILABLE');
  assert.match(error.message, /^GIT_UNAVAILABLE:/);
});

test('escapes terminal control sequences in error messages while preserving structured details', () => {
  const rawDetail = 'bad\u001b[31m\nkey\u009b2J';
  const error = new PrimeContextError('VALIDATION_ERROR', 'invalid\rinput', [rawDetail]);
  assert.doesNotMatch(error.message, /[\u0000-\u001f\u007f-\u009f]/);
  assert.match(error.message, /invalid\\u000dinput/);
  assert.match(error.message, /bad\\u001b\[31m\\u000akey\\u009b2J/);
  assert.deepEqual(error.details, [rawDetail]);

  assert.throws(
    () => assertValidHandoff({
      schema_version: '0.1', task_id: 'SAFE-001', status: 'PASS', changed_files: [],
      tests: { passed: 1, failed: 0 }, risks: [], next_unblocked: [],
      ['unknown\u001b[2J']: true,
    }),
    (thrown: unknown) => {
      assert.ok(thrown instanceof PrimeContextError);
      assert.doesNotMatch(thrown.message, /[\u0000-\u001f\u007f-\u009f]/);
      assert.match(thrown.message, /unknown\\u001b\[2J/);
      return true;
    },
  );
});
