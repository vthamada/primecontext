import assert from 'node:assert/strict';
import test from 'node:test';
import { compareBenchmarkArms } from './index.js';

const base = {
  schema_version: '0.1' as const,
  task_id: 'BENCH-1',
  recorded_at: '2026-08-11T12:00:00.000Z',
  test_status: 'PASS' as const,
  review_status: 'PASS' as const,
  run_environment: {
    commit: '80bf4f08',
    worktree_digest: `sha256:${'1'.repeat(64)}`,
    agent: 'codex',
    model: 'gpt-5',
    reasoning_effort: 'high',
    permissions: 'workspace-write;network-denied',
    runtime: 'node=24.0.0;platform=linux-x64',
    lockfile_hash: `sha256:${'2'.repeat(64)}`,
    time_limit_ms: 600_000,
    test_command: 'npm test',
    rubric: 'rubric-v1',
  },
};

test('reports deterministic B minus A raw deltas and estimate propagation', () => {
  const result = compareBenchmarkArms(
    { ...base, arm: 'A', input_tokens: 2000, tool_calls: 10, agent_output_tokens: 900 },
    {
      ...base,
      arm: 'B',
      input_tokens: 1200,
      tool_calls: 6,
      agent_output_tokens: 300,
      estimated_fields: ['agent_output_tokens', 'input_tokens'],
    },
  );
  assert.equal(result.deltas.input_tokens, -800);
  assert.equal(result.deltas.tool_calls, -4);
  assert.equal(result.deltas.agent_output_tokens, -600);
  assert.deepEqual(result.estimated_fields, ['agent_output_tokens', 'input_tokens']);
  assert.deepEqual(result.measurement_gaps, ['completion_status']);
  assert.equal(result.quality_gate, 'PASS');
  assert.equal(result.environment_gate, 'MATCHED');
  assert.equal(result.measurement_gate, 'COMPARABLE');
  assert.deepEqual(result.environment_mismatches, []);
  assert.equal(result.interpretation, 'COMPARABLE_EVIDENCE');
});

test('quality regression blocks favorable efficiency interpretation', () => {
  const result = compareBenchmarkArms(
    { ...base, arm: 'A', input_tokens: 2000 },
    { ...base, arm: 'B', input_tokens: 1000, test_status: 'FAIL' },
  );
  assert.equal(result.deltas.input_tokens, -1000);
  assert.equal(result.quality_gate, 'FAIL');
  assert.equal(result.interpretation, 'QUALITY_REGRESSION');
  assert.deepEqual(result.measurement_gaps, ['completion_status']);
});

test('an available completion failure in arm B blocks a favorable verdict', () => {
  const result = compareBenchmarkArms(
    { ...base, arm: 'A', input_tokens: 2000, completion_status: 'PASS' },
    { ...base, arm: 'B', input_tokens: 1000, completion_status: 'FAIL' },
  );
  assert.equal(result.quality_gate, 'FAIL');
  assert.equal(result.interpretation, 'QUALITY_REGRESSION');
  assert.deepEqual(result.measurement_gaps, []);
});

test('unknown validation evidence remains inconclusive', () => {
  const result = compareBenchmarkArms(
    { ...base, arm: 'A', input_tokens: 2000 },
    { ...base, arm: 'B', input_tokens: 1000, review_status: 'UNKNOWN' },
  );
  assert.equal(result.quality_gate, 'UNKNOWN');
  assert.equal(result.interpretation, 'INSUFFICIENT_QUALITY_EVIDENCE');
});

test('passing quality statuses are insufficient without any comparable numeric evidence', () => {
  const result = compareBenchmarkArms(
    { ...base, arm: 'A' },
    { ...base, arm: 'B' },
  );
  assert.deepEqual(result.deltas, {});
  assert.equal(result.quality_gate, 'PASS');
  assert.equal(result.measurement_gate, 'MISSING');
  assert.equal(result.interpretation, 'INSUFFICIENT_MEASUREMENT_EVIDENCE');
});

test('refuses comparable evidence when the pre-registered environment is absent', () => {
  const { run_environment: _environment, ...withoutEnvironment } = base;
  const result = compareBenchmarkArms(
    { ...withoutEnvironment, arm: 'A', input_tokens: 2000 },
    { ...withoutEnvironment, arm: 'B', input_tokens: 1000 },
  );
  assert.equal(result.quality_gate, 'PASS');
  assert.equal(result.environment_gate, 'MISSING');
  assert.deepEqual(result.environment_mismatches, ['run_environment']);
  assert.equal(result.interpretation, 'INSUFFICIENT_ENVIRONMENT_EVIDENCE');
});

test('reports exact environment fields that differ between benchmark arms', () => {
  const result = compareBenchmarkArms(
    { ...base, arm: 'A', input_tokens: 2000 },
    {
      ...base,
      arm: 'B',
      input_tokens: 1000,
      run_environment: { ...base.run_environment, model: 'different-model', time_limit_ms: 300_000 },
    },
  );
  assert.equal(result.quality_gate, 'PASS');
  assert.equal(result.environment_gate, 'MISMATCH');
  assert.deepEqual(result.environment_mismatches, ['model', 'time_limit_ms']);
  assert.equal(result.interpretation, 'INSUFFICIENT_ENVIRONMENT_EVIDENCE');
});

test('rejects mismatched tasks and mislabeled arms with benchmark errors', () => {
  assert.throws(() => compareBenchmarkArms(
    { ...base, arm: 'A' },
    { ...base, task_id: 'OTHER', arm: 'B' },
  ), /BENCHMARK_ERROR/);
  assert.throws(() => compareBenchmarkArms(
    { ...base, arm: 'B' },
    { ...base, arm: 'A' },
  ), /BENCHMARK_ERROR/);
});
