import { validateCompactHandoff } from '@primecontext/schemas';
import { PrimeContextError } from './errors.js';
import { cloneValidatedJson } from './json.js';
import type { CompactHandoff } from './types.js';

export function assertValidHandoff(value: unknown): CompactHandoff {
  const validation = validateCompactHandoff(value);
  if (!validation.valid) throw new PrimeContextError('VALIDATION_ERROR', 'Invalid Compact Handoff', validation.errors);
  return cloneValidatedJson(value as CompactHandoff);
}
