import assert from 'node:assert/strict';
import test from 'node:test';
import {
  validateCompactHandoff,
  validateMetricRecord,
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
