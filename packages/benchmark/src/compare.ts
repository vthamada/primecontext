import { assertValidMetricRecord, PrimeContextError, type MetricNumericField, type MetricRecord } from '@primecontext/core';

const numericFields: readonly MetricNumericField[] = [
  'input_tokens', 'cached_input_tokens', 'output_tokens', 'tool_calls', 'file_reads',
  'codegraph_calls', 'context_expansions', 'duration_ms', 'selected_context_tokens', 'rework_count',
];

export interface BenchmarkComparison {
  task_id: string;
  deltas: Partial<Record<MetricNumericField, number>>;
  estimated_fields: MetricNumericField[];
  measurement_gaps: Array<'completion_status'>;
  quality_gate: 'PASS' | 'FAIL' | 'UNKNOWN';
  interpretation: 'COMPARABLE_EVIDENCE' | 'QUALITY_REGRESSION' | 'INSUFFICIENT_QUALITY_EVIDENCE';
}

function qualityGate(a: MetricRecord, b: MetricRecord): BenchmarkComparison['quality_gate'] {
  if (b.test_status === 'FAIL' || b.review_status === 'FAIL' || b.completion_status === 'FAIL') return 'FAIL';
  if (a.test_status === 'FAIL' || a.review_status === 'FAIL' || a.completion_status === 'FAIL') return 'UNKNOWN';
  if (a.completion_status === 'UNKNOWN' || b.completion_status === 'UNKNOWN') return 'UNKNOWN';
  if (a.test_status !== 'PASS' || b.test_status !== 'PASS' || a.review_status !== 'PASS' || b.review_status !== 'PASS') return 'UNKNOWN';
  return 'PASS';
}

export function compareBenchmarkArms(armAInput: MetricRecord, armBInput: MetricRecord): BenchmarkComparison {
  const armA = assertValidMetricRecord(armAInput);
  const armB = assertValidMetricRecord(armBInput);
  if (armA.task_id !== armB.task_id) throw new PrimeContextError('BENCHMARK_ERROR', 'Arm A and Arm B must reference the same task_id');
  if (armA.arm !== 'A' || armB.arm !== 'B') throw new PrimeContextError('BENCHMARK_ERROR', 'Expected records labeled arm A and arm B');

  const deltas: Partial<Record<MetricNumericField, number>> = {};
  for (const field of numericFields) {
    const a = armA[field];
    const b = armB[field];
    if (typeof a === 'number' && typeof b === 'number') deltas[field] = b - a;
  }

  const comparableFields = new Set(Object.keys(deltas) as MetricNumericField[]);
  const estimated = new Set<MetricNumericField>(
    [...(armA.estimated_fields ?? []), ...(armB.estimated_fields ?? [])].filter((field) => comparableFields.has(field)),
  );
  const quality = qualityGate(armA, armB);
  const gate = quality === 'PASS' && comparableFields.size === 0 ? 'UNKNOWN' : quality;
  return {
    task_id: armA.task_id,
    deltas,
    estimated_fields: [...estimated].sort(),
    measurement_gaps: armA.completion_status === undefined || armB.completion_status === undefined
      ? ['completion_status']
      : [],
    quality_gate: gate,
    interpretation: gate === 'FAIL' ? 'QUALITY_REGRESSION' : gate === 'PASS' ? 'COMPARABLE_EVIDENCE' : 'INSUFFICIENT_QUALITY_EVIDENCE',
  };
}
