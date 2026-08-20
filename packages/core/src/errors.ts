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

const REDACTED = '[REDACTED]';
const AUTHORIZATION_SCHEME_SECRET = /(\bauthorization(?:\s+header)?\b["'`*_]{0,4}\s*(?::|=)\s*)(?:basic|bearer)\s+[A-Za-z0-9._~+/=-]+/giu;
const AUTHENTICATION_FAILURE_SCHEME_SECRET = /(\bauthentication\s+(?:failed|failure)\b(?:\s+with)?\s*(?::|=)?\s*)(?:basic|bearer)\s+[A-Za-z0-9._~+/=-]+/giu;
const BASIC_SCHEME_CANDIDATE = /(\bbasic\s+)([A-Za-z0-9+/]+={0,2})(?=$|[\s"'`,;:.!?\(\)\[\]\{\}<>\\])/giu;
const LABELED_SECRET = /(\b(?:api[-_. ]?key|access[-_. ]?token|refresh[-_. ]?token|client[-_. ]?secret|password|authorization)\b["'`*_]{0,4}\s*(?::|=)\s*)(?:"[^"]*"|'[^']*'|`[^`]*`|[^\s,;)\]}]+)/giu;
const BEARER_SECRET = /(\bbearer\s+)[A-Za-z0-9._~+/=-]+/giu;
const PREFIXED_SECRET = /\b(?:sk|pk)[-_](?:live|test)[-_][A-Za-z0-9_-]{8,}\b/giu;
const OPAQUE_SECRET_CANDIDATE = /\b[A-Za-z0-9._~+/=-]{24,}\b/gu;
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function isCanonicalBasicCredential(value: string): boolean {
  if (value.length < 4 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) return false;
  let hasUserPasswordSeparator = false;
  for (let offset = 0; offset < value.length; offset += 4) {
    const first = BASE64_ALPHABET.indexOf(value.charAt(offset));
    const second = BASE64_ALPHABET.indexOf(value.charAt(offset + 1));
    const thirdCharacter = value.charAt(offset + 2);
    const fourthCharacter = value.charAt(offset + 3);
    if (first < 0 || second < 0) return false;

    const firstByte = (first << 2) | (second >> 4);
    if (firstByte === 0x3a) hasUserPasswordSeparator = true;
    if (thirdCharacter === '=') {
      if (offset !== value.length - 4 || fourthCharacter !== '=' || (second & 0x0f) !== 0) return false;
      continue;
    }

    const third = BASE64_ALPHABET.indexOf(thirdCharacter);
    if (third < 0) return false;
    const secondByte = ((second & 0x0f) << 4) | (third >> 2);
    if (secondByte === 0x3a) hasUserPasswordSeparator = true;
    if (fourthCharacter === '=') {
      if (offset !== value.length - 4 || (third & 0x03) !== 0) return false;
      continue;
    }

    const fourth = BASE64_ALPHABET.indexOf(fourthCharacter);
    if (fourth < 0) return false;
    const thirdByte = ((third & 0x03) << 6) | fourth;
    if (thirdByte === 0x3a) hasUserPasswordSeparator = true;
  }
  return hasUserPasswordSeparator;
}

function isOpaqueSecretCandidate(value: string): boolean {
  let hasLetter = false;
  let hasDigit = false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    hasLetter ||= (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
    hasDigit ||= code >= 0x30 && code <= 0x39;
    if (hasLetter && hasDigit) return true;
  }
  return false;
}

export function redactPublicErrorText(value: string): string {
  return sanitizeTerminalText(value)
    .replace(AUTHORIZATION_SCHEME_SECRET, `$1${REDACTED}`)
    .replace(AUTHENTICATION_FAILURE_SCHEME_SECRET, `$1${REDACTED}`)
    .replace(BASIC_SCHEME_CANDIDATE, (match, prefix: string, credential: string) => (
      isCanonicalBasicCredential(credential) ? `${prefix}${REDACTED}` : match
    ))
    .replace(LABELED_SECRET, `$1${REDACTED}`)
    .replace(BEARER_SECRET, `$1${REDACTED}`)
    .replace(PREFIXED_SECRET, REDACTED)
    .replace(OPAQUE_SECRET_CANDIDATE, (candidate) => (
      isOpaqueSecretCandidate(candidate) ? REDACTED : candidate
    ));
}

export class PrimeContextError extends Error {
  public readonly code: PrimeContextErrorCode;
  public readonly details: string[];

  constructor(code: PrimeContextErrorCode, message: string, details: readonly string[] = []) {
    const safeCode = sanitizeTerminalText(code);
    const safeMessage = redactPublicErrorText(message);
    const safeDetails = details.map((detail) => redactPublicErrorText(detail));
    super(`${safeCode}: ${safeMessage}${safeDetails.length ? ` (${safeDetails.join('; ')})` : ''}`);
    this.name = 'PrimeContextError';
    this.code = code;
    this.details = safeDetails;
  }
}
