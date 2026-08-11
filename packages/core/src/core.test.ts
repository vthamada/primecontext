import assert from 'node:assert/strict';
import test from 'node:test';
import {
  allocateContextBudget,
  assertValidHandoff,
  assertValidMetricRecord,
  createTaskCapsule,
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
