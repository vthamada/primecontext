export type PrimeContextErrorCode = 'CONFIG_ERROR' | 'VALIDATION_ERROR' | 'SECURITY_ERROR' | 'IO_ERROR' | 'BENCHMARK_ERROR';

export class PrimeContextError extends Error {
  constructor(public readonly code: PrimeContextErrorCode, message: string, public readonly details: string[] = []) {
    super(`${code}: ${message}${details.length ? ` (${details.join('; ')})` : ''}`);
    this.name = 'PrimeContextError';
  }
}
