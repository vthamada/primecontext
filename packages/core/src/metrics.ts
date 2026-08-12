import { validateMetricRecord } from '@primecontext/schemas';
import { PrimeContextError } from './errors.js';
import { cloneValidatedJson } from './json.js';
import type { MetricRecord } from './types.js';

export function assertValidMetricRecord(value: unknown): MetricRecord {
  const validation = validateMetricRecord(value);
  if (!validation.valid) throw new PrimeContextError('VALIDATION_ERROR', 'Invalid MetricRecord', validation.errors);
  return cloneValidatedJson(value as MetricRecord);
}
