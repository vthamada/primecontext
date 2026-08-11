import assert from 'node:assert/strict';
import test from 'node:test';
import { compareBenchmarkArms } from './index.js';

const base = {
  schema_version: '0.1' as const,
  task_id: 'BENCH-1',
  recorded_at: '2026-08-11T12:00:00.000Z',
  test_status: 'PASS' as const,
  review_status: 'PASS' as const,
};

test('reports deterministic B minus A raw deltas and estimate propagation', () => {
  const result = compareBenchmarkArms(
    { ...base, arm: 'A', input_tokens: 2000, tool_calls: 10 },
    { ...base, arm: 'B', input_tokens: 1200, tool_calls: 6, estimated_fields: ['input_tokens'] },
  );
  assert.equal(result.deltas.input_tokens, -800);
  assert.equal(result.deltas.tool_calls, -4);
  assert.deepEqual(result.estimated_fields, ['input_tokens']);
  assert.equal(result.quality_gate, 'PASS');
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
});

test('unknown validation evidence remains inconclusive', () => {
  const result = compareBenchmarkArms(
    { ...base, arm: 'A', input_tokens: 2000 },
    { ...base, arm: 'B', input_tokens: 1000, review_status: 'UNKNOWN' },
  );
  assert.equal(result.quality_gate, 'UNKNOWN');
  assert.equal(result.interpretation, 'INSUFFICIENT_QUALITY_EVIDENCE');
});
