import { performance } from 'node:perf_hooks';
import { PrimeContextError } from '@primecontext/core';

export type MonotonicNowV03 = () => number;

export const systemMonotonicNowV03: MonotonicNowV03 = () => performance.now();

export function createCooperativeDeadlineV03(
  monotonicNow: MonotonicNowV03,
  maximumMilliseconds: number,
  capability: string,
): () => void {
  const startedAt = monotonicNow();
  if (!Number.isFinite(startedAt) || startedAt < 0
    || !Number.isSafeInteger(maximumMilliseconds) || maximumMilliseconds < 1) {
    throw new PrimeContextError('CONFIG_ERROR', 'Optional-adapter monotonic deadline configuration is invalid');
  }
  const expiresAt = startedAt + maximumMilliseconds;
  let lastObserved = startedAt;
  return (): void => {
    const observed = monotonicNow();
    if (!Number.isFinite(observed) || observed < lastObserved) {
      throw new PrimeContextError('CONFIG_ERROR', 'Optional-adapter monotonic clock is invalid');
    }
    lastObserved = observed;
    if (observed > expiresAt) {
      throw new PrimeContextError(
        'CAPABILITY_ERROR',
        `${capability} cooperative processing deadline exceeded`,
      );
    }
  };
}
