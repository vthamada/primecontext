import {
  assertValidMetricRecord,
  PrimeContextError,
  type MetricNumericField,
  type MetricRecord,
  type MetricRunEnvironment,
} from '@primecontext/core';

const numericFields: readonly MetricNumericField[] = [
  'input_tokens', 'cached_input_tokens', 'output_tokens', 'tool_calls', 'file_reads',
  'codegraph_calls', 'context_expansions', 'duration_ms', 'selected_context_tokens',
  'agent_output_tokens', 'rework_count',
];

export interface BenchmarkComparison {
  task_id: string;
  deltas: Partial<Record<MetricNumericField, number>>;
  estimated_fields: MetricNumericField[];
  measurement_gaps: Array<'completion_status'>;
  measurement_gate: 'COMPARABLE' | 'MISSING';
  environment_gate: 'MATCHED' | 'MISSING' | 'MISMATCH';
  environment_mismatches: Array<keyof MetricRunEnvironment | 'run_environment'>;
  quality_gate: 'PASS' | 'FAIL' | 'UNKNOWN';
  interpretation:
    | 'COMPARABLE_EVIDENCE'
    | 'QUALITY_REGRESSION'
    | 'INSUFFICIENT_QUALITY_EVIDENCE'
    | 'INSUFFICIENT_ENVIRONMENT_EVIDENCE'
    | 'INSUFFICIENT_MEASUREMENT_EVIDENCE';
}

const environmentFields: readonly (keyof MetricRunEnvironment)[] = [
  'agent',
  'commit',
  'lockfile_hash',
  'model',
  'permissions',
  'reasoning_effort',
  'rubric',
  'runtime',
  'test_command',
  'time_limit_ms',
  'worktree_digest',
];

function compareEnvironments(
  armA: MetricRunEnvironment | undefined,
  armB: MetricRunEnvironment | undefined,
): Pick<BenchmarkComparison, 'environment_gate' | 'environment_mismatches'> {
  if (armA === undefined || armB === undefined) {
    return { environment_gate: 'MISSING', environment_mismatches: ['run_environment'] };
  }
  const mismatches = environmentFields.filter((field) => armA[field] !== armB[field]);
  return {
    environment_gate: mismatches.length === 0 ? 'MATCHED' : 'MISMATCH',
    environment_mismatches: mismatches,
  };
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
  const measurementGate: BenchmarkComparison['measurement_gate'] = comparableFields.size === 0 ? 'MISSING' : 'COMPARABLE';
  const environment = compareEnvironments(armA.run_environment, armB.run_environment);
  const interpretation: BenchmarkComparison['interpretation'] = quality === 'FAIL'
    ? 'QUALITY_REGRESSION'
    : quality !== 'PASS'
      ? 'INSUFFICIENT_QUALITY_EVIDENCE'
      : environment.environment_gate !== 'MATCHED'
        ? 'INSUFFICIENT_ENVIRONMENT_EVIDENCE'
        : measurementGate === 'MISSING'
          ? 'INSUFFICIENT_MEASUREMENT_EVIDENCE'
          : 'COMPARABLE_EVIDENCE';
  return {
    task_id: armA.task_id,
    deltas,
    estimated_fields: [...estimated].sort(),
    measurement_gaps: armA.completion_status === undefined || armB.completion_status === undefined
      ? ['completion_status']
      : [],
    measurement_gate: measurementGate,
    ...environment,
    quality_gate: quality,
    interpretation,
  };
}
