export type PrimeContextErrorCode =
  | 'CONFIG_ERROR' | 'VALIDATION_ERROR' | 'SECURITY_ERROR' | 'IO_ERROR' | 'GIT_UNAVAILABLE'
  | 'BENCHMARK_ERROR' | 'CATALOG_ERROR' | 'FRESHNESS_ERROR' | 'CONTEXT_ERROR'
  | 'STATE_ERROR' | 'CAPABILITY_ERROR';

export function sanitizeTerminalText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, (character) => {
    const codePoint = character.codePointAt(0) as number;
    return `\\u${codePoint.toString(16).padStart(4, '0')}`;
  });
}

export class PrimeContextError extends Error {
  public readonly code: PrimeContextErrorCode;
  public readonly details: string[];

  constructor(code: PrimeContextErrorCode, message: string, details: readonly string[] = []) {
    const safeCode = sanitizeTerminalText(code);
    const safeMessage = sanitizeTerminalText(message);
    const safeDetails = details.map((detail) => sanitizeTerminalText(detail));
    super(`${safeCode}: ${safeMessage}${safeDetails.length ? ` (${safeDetails.join('; ')})` : ''}`);
    this.name = 'PrimeContextError';
    this.code = code;
    this.details = [...details];
  }
}
