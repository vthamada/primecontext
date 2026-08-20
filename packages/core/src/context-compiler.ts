import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import {
  validateAblationRequest,
  validateAblationResult,
  validateContextCandidate,
  validateContextEnvelope,
  validateContextPlanRequest,
  validateContextOutcomeInput,
  validateContextSourceFailures,
  validateExpansionDecision,
  validateExpansionRequest,
  validateOutcomeReceipt,
  validateReplayResult,
  validateSelectionReceipt,
} from '@primecontext/schemas';
import type {
  AblationRequestV03,
  AblationResultV03,
  ContextCandidateV03,
  ContextBudgetLimitsV03,
  ContextBudgetTierV03,
  ContextConflictV03,
  ContextDecisionReasonV03,
  ContextEnvelopeV03,
  ContextIncludeReasonV03,
  ContextOutcomeInputV03,
  ContextPlanRequestV03,
  ContextProviderV03,
  ContextScoreComponentsV03,
  ContextSelectionDecisionV03,
  ContextSourceFailureV03,
  ContextTruncationReasonV03,
  ExpansionDecisionV03,
  ExpansionRequestV03,
  OutcomeReceiptV03,
  ReplayResultV03,
  SelectedContextCandidateV03,
  SelectionReceiptV03,
  TaskContextPackageV03,
} from '@primecontext/schemas';
import { PrimeContextError, redactPublicErrorText } from './errors.js';
import { cloneValidatedJson } from './json.js';

const MAX_CANDIDATES = 2048;
const MAX_CANONICAL_JSON_BYTES = 128 * 1024 * 1024;
const MAX_SOURCE_FAILURE_MESSAGE_CHARACTERS = 4096;
const POLICY_COMPONENTS: ContextScoreComponentsV03 = Object.freeze({
  required_source: 10_000,
  applicable_policy: 9_000,
  hinted_path: 800,
  hinted_symbol: 700,
  required_terms: 120,
  query_terms: 80,
  graph_distance: 300,
  authority: 200,
  related_test: 100,
  live_freshness: 100,
});
const AUTHORITY_SCORES = new Map<string, number>([
  ['policy', 200], ['adr', 180], ['specification', 160], ['contract_schema', 140],
  ['roadmap', 100], ['implementation_note', 80], ['generated_summary', 0],
]);
const AUTHORITY_RANK = new Map<string, number>([
  'policy', 'adr', 'specification', 'contract_schema', 'configuration', 'source_code',
  'test', 'roadmap', 'implementation_note', 'history', 'repository_map', 'generated_summary',
].map((value, index) => [value, index]));
const PROVIDER_RANK = new Map<ContextProviderV03, number>(
  ['filesystem', 'documents', 'repo_map', 'git', 'fts', 'codegraph'].map((value, index) => [value as ContextProviderV03, index]),
);
const IMPLICIT_CRITERION_STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'de', 'do', 'e', 'em', 'for', 'from', 'is', 'it',
  'o', 'of', 'on', 'or', 'os', 'que', 'the', 'this', 'to', 'um', 'uma', 'with',
]);
const SECURITY_RELEVANT_TERMS = new Set([
  '2fa', 'advisories', 'advisory', 'apikey', 'apikeys', 'attack', 'attacks', 'audit', 'audits',
  'auth', 'authentication', 'authorization', 'credential', 'credentials', 'crypto', 'cryptographic',
  'cors', 'csrf', 'cve', 'ddos', 'deserialization', 'deserialize', 'deserialized', 'exploit', 'exploited', 'exploits',
  'harden', 'hardened', 'hardening', 'hardens', 'idor', 'jwks', 'jws', 'jwt', 'mfa',
  'mitigate', 'mitigated', 'mitigates', 'mitigating', 'mitigation',
  'permission', 'permissions', 'privilege', 'privileged', 'privileges',
  'decrypt', 'decrypted', 'decryption', 'encrypt', 'encrypted', 'encryption', 'login', 'oauth', 'oauth2',
  'passphrase', 'password', 'passwords', 'privacy', 'secret', 'secrets', 'security', 'sensitive', 'signin',
  'rbac', 'rce', 'redirect', 'redirected', 'redirection', 'redirects', 'sandbox', 'sandboxed', 'sandboxing',
  'secure', 'secured', 'secures', 'securing', 'sqli', 'ssl', 'ssrf', 'threat', 'threats', 'tls',
  'token', 'tokens', 'upload', 'uploaded', 'uploads', 'vulnerability', 'vulnerabilities', 'vulnerable',
  'webhook', 'webhooks', 'xss', 'xsrf', 'xxe',
]);
const DENIAL_OF_SERVICE_ACRONYM = /\b(?:DDoS|DoS|DOS)\b/u;
const INJECTION_OR_EXECUTION_TERMS = new Set(['execution', 'injection']);
const COMMAND_OR_CODE_TERMS = new Set(['code', 'command', 'commands']);
const INJECTION_CONTEXT_TERMS = new Set([
  'html', 'javascript', 'ldap', 'nosql', 'query', 'script', 'shell', 'sql', 'template', 'xpath', 'xml',
]);
const KEY_TERMS = new Set(['key', 'keys']);
const KEY_SECURITY_CONTEXT_TERMS = new Set([
  'api', 'credential', 'credentials', 'crypto', 'cryptographic', 'decrypt', 'decryption', 'encrypt',
  'encryption', 'jwt', 'oauth', 'private', 'public', 'rotate', 'rotated', 'rotation', 'secret', 'secrets',
  'sign', 'signed', 'signing',
]);
const SIGNATURE_TERMS = new Set(['signature', 'signatures', 'signed', 'signing']);
const SIGNATURE_SECURITY_CONTEXT_TERMS = new Set([
  'crypto', 'cryptographic', 'jwt', 'jwks', 'jws', 'key', 'keys', 'request', 'requests',
  'token', 'tokens', 'validate', 'validated', 'validation', 'verification', 'verified', 'verify',
  'webhook', 'webhooks',
]);
const TRAVERSAL_TERMS = new Set(['traversal', 'traverse']);
const TRAVERSAL_SECURITY_CONTEXT_TERMS = new Set([
  'directories', 'directory', 'file', 'files', 'filesystem', 'path', 'paths',
]);
const DEPENDENCY_CONTEXT_TERMS = new Set([
  'dependencies', 'dependency', 'lockfile', 'lockfiles', 'npm', 'package', 'packages', 'pnpm', 'yarn',
]);
const DEPENDENCY_SECURITY_TERMS = new Set([
  'advisories', 'advisory', 'audit', 'audits', 'cve', 'cvss', 'malware', 'supplychain',
]);

function ordinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort(ordinal);
}

interface CanonicalState {
  ancestors: Set<object>;
  remaining: number;
  remainingBytes: number;
}

function consumeCanonicalBytes(state: CanonicalState, bytes: number): void {
  state.remainingBytes -= bytes;
  if (state.remainingBytes < 0) {
    throw new PrimeContextError('VALIDATION_ERROR', 'Canonical JSON exceeds its byte limit');
  }
}

function canonicalJsonStringBytes(value: string, maximum: number): number {
  // Count escapes before serialization so one string cannot allocate beyond the aggregate budget.
  let bytes = 2;
  if (value.length + bytes > maximum) {
    throw new PrimeContextError('VALIDATION_ERROR', 'Canonical JSON exceeds its byte limit');
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (
      code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d
      || code === 0x22 || code === 0x5c
    ) {
      bytes += 2;
    } else if (code <= 0x1f) {
      bytes += 6;
    } else if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 6;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      bytes += 6;
    } else {
      bytes += 3;
    }
    if (bytes > maximum) {
      throw new PrimeContextError('VALIDATION_ERROR', 'Canonical JSON exceeds its byte limit');
    }
  }
  return bytes;
}

function consumeCanonicalString(state: CanonicalState, value: string): void {
  consumeCanonicalBytes(state, canonicalJsonStringBytes(value, state.remainingBytes));
}

function canonicalize(value: unknown, state: CanonicalState, depth = 0): unknown {
  state.remaining -= 1;
  if (state.remaining < 0 || depth > 64) {
    throw new PrimeContextError('VALIDATION_ERROR', 'Canonical JSON exceeds its structural limit');
  }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      throw new PrimeContextError('VALIDATION_ERROR', 'Canonical JSON arrays must be plain');
    }
    if (state.ancestors.has(value)) throw new PrimeContextError('VALIDATION_ERROR', 'Canonical JSON must not be cyclic');
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') {
        throw new PrimeContextError('VALIDATION_ERROR', 'Canonical JSON arrays must not contain symbol properties');
      }
      if (key !== 'length' && (
        !/^(0|[1-9][0-9]*)$/.test(key)
        || Number(key) >= value.length
        || Number(key) > 4_294_967_294
      )) {
        throw new PrimeContextError('VALIDATION_ERROR', 'Canonical JSON arrays must not contain extra array properties');
      }
    }
    state.ancestors.add(value);
    const result: unknown[] = [];
    consumeCanonicalBytes(state, 2);
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
        throw new PrimeContextError('VALIDATION_ERROR', 'Canonical JSON arrays must be dense data arrays');
      }
      if (index > 0) consumeCanonicalBytes(state, 1);
      result.push(canonicalize(descriptor.value, state, depth + 1));
    }
    state.ancestors.delete(value);
    return result;
  }
  if (typeof value === 'object' && value !== null) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new PrimeContextError('VALIDATION_ERROR', 'Canonical JSON objects must be plain');
    }
    if (state.ancestors.has(value)) throw new PrimeContextError('VALIDATION_ERROR', 'Canonical JSON must not be cyclic');
    state.ancestors.add(value);
    const output = Object.create(null) as Record<string, unknown>;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key !== 'string')) {
      throw new PrimeContextError('VALIDATION_ERROR', 'Canonical JSON objects must not contain symbol properties');
    }
    const stringKeys = ownKeys as string[];
    consumeCanonicalBytes(state, 2);
    for (const [index, key] of stringKeys.sort(ordinal).entries()) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
        throw new PrimeContextError('VALIDATION_ERROR', 'Canonical JSON objects must contain enumerable data properties');
      }
      if (index > 0) consumeCanonicalBytes(state, 1);
      consumeCanonicalString(state, key);
      consumeCanonicalBytes(state, 1);
      const item = descriptor.value;
      output[key] = canonicalize(item, state, depth + 1);
    }
    state.ancestors.delete(value);
    return output;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new PrimeContextError('VALIDATION_ERROR', 'Canonical JSON numbers must be finite');
  }
  if (value === undefined || typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol') {
    throw new PrimeContextError('VALIDATION_ERROR', 'Canonical JSON contains an unsupported value');
  }
  if (typeof value === 'string') {
    consumeCanonicalString(state, value);
  } else {
    consumeCanonicalBytes(state, Buffer.byteLength(JSON.stringify(value), 'utf8'));
  }
  return value;
}

export function hashContextJson(value: unknown): string {
  const canonical = canonicalize(value, {
    ancestors: new Set(), remaining: 100_000, remainingBytes: MAX_CANONICAL_JSON_BYTES,
  });
  const serialized = JSON.stringify(canonical);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_CANONICAL_JSON_BYTES) {
    throw new PrimeContextError('VALIDATION_ERROR', 'Canonical JSON exceeds its byte limit');
  }
  return `sha256:${createHash('sha256').update(serialized, 'utf8').digest('hex')}`;
}

export function hashContextText(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

export function createContextCandidateId(candidate: Omit<ContextCandidateV03, 'id'> | ContextCandidateV03): string {
  return hashContextJson({
    provider: candidate.provider, path: candidate.path,
    ...(candidate.line_start !== undefined ? { line_start: candidate.line_start } : {}),
    ...(candidate.line_end !== undefined ? { line_end: candidate.line_end } : {}),
    ...(candidate.symbol !== undefined ? { symbol: candidate.symbol } : {}),
    source_hash: candidate.source_hash,
    excerpt_hash: candidate.excerpt_hash,
  });
}

function validationFailure(label: string, errors: readonly string[]): never {
  throw new PrimeContextError('VALIDATION_ERROR', `${label} failed validation`, errors.slice(0, 32));
}

function publicSourceFailureMessage(value: string): string {
  const redacted = redactPublicErrorText(value);
  const characters = [...redacted];
  if (characters.length <= MAX_SOURCE_FAILURE_MESSAGE_CHARACTERS) return redacted;
  return `${characters.slice(0, MAX_SOURCE_FAILURE_MESSAGE_CHARACTERS - 1).join('')}…`;
}

function validatedSourceFailures(value: unknown): ContextSourceFailureV03[] {
  const validation = validateContextSourceFailures(value);
  if (!validation.valid) validationFailure('Context source failures', validation.errors);
  const failures = cloneValidatedJson(value as ContextSourceFailureV03[]).map((failure) => ({
    ...failure,
    message: publicSourceFailureMessage(failure.message),
  }));
  return failures.sort((left, right) => ordinal(left.provider, right.provider)
    || ordinal(left.code, right.code) || ordinal(left.message, right.message)
    || Number(left.security_control) - Number(right.security_control));
}

function validatedCandidateInputArray(value: unknown): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > MAX_CANDIDATES) {
    throw new PrimeContextError('VALIDATION_ERROR', `Context candidates must be a plain array of at most ${MAX_CANDIDATES} items`);
  }
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new PrimeContextError('VALIDATION_ERROR', 'Context candidates must be a dense JSON data array');
    }
    result.push(descriptor.value);
  }
  return result;
}

export function assertValidContextPlanRequest(value: unknown): ContextPlanRequestV03 {
  const validation = validateContextPlanRequest(value);
  if (!validation.valid) validationFailure('ContextPlanRequest', validation.errors);
  const request = cloneValidatedJson(value as ContextPlanRequestV03);
  request.task.acceptance_criteria.sort((left, right) => ordinal(left.id, right.id));
  for (const criterion of request.task.acceptance_criteria) {
    if (criterion.required_terms) criterion.required_terms = uniqueSorted(criterion.required_terms);
  }
  if (request.task.hints?.paths) request.task.hints.paths = uniqueSorted(request.task.hints.paths);
  if (request.task.hints?.symbols) request.task.hints.symbols = uniqueSorted(request.task.hints.symbols);
  if (request.task.hints?.terms) request.task.hints.terms = uniqueSorted(request.task.hints.terms);
  if (request.required_sources) request.required_sources = uniqueSorted(request.required_sources);
  return request;
}

export function assertValidContextCandidate(value: unknown): ContextCandidateV03 {
  const validation = validateContextCandidate(value);
  if (!validation.valid) validationFailure('ContextCandidate', validation.errors);
  const candidate = cloneValidatedJson(value as ContextCandidateV03);
  if (candidate.excerpt_hash !== hashContextText(candidate.excerpt)) {
    throw new PrimeContextError('FRESHNESS_ERROR', 'ContextCandidate excerpt hash does not match observed bytes');
  }
  if (candidate.id !== createContextCandidateId(candidate)) {
    throw new PrimeContextError('VALIDATION_ERROR', 'ContextCandidate id does not match its canonical identity');
  }
  candidate.authority_evidence = uniqueSorted(candidate.authority_evidence);
  candidate.discovery.matched_terms = uniqueSorted(candidate.discovery.matched_terms);
  candidate.discovery.criteria_ids = uniqueSorted(candidate.discovery.criteria_ids);
  if (candidate.discovery.truncation_reasons) {
    candidate.discovery.truncation_reasons = uniqueSorted(
      candidate.discovery.truncation_reasons,
    ) as ContextTruncationReasonV03[];
  }
  return candidate;
}

export function assertValidContextEnvelope(value: unknown): ContextEnvelopeV03 {
  const validation = validateContextEnvelope(value);
  if (!validation.valid) validationFailure('ContextEnvelope', validation.errors);
  const envelope = cloneValidatedJson(value as ContextEnvelopeV03);
  for (const selected of envelope.items) {
    const { mandatory: _mandatory, score: _score, score_components: _components, selection_reason: _reason, ...candidate } = selected;
    assertValidContextCandidate(candidate);
  }
  const { selection_digest: supplied, ...withoutDigest } = envelope;
  if (hashContextJson(withoutDigest) !== supplied) {
    throw new PrimeContextError('STATE_ERROR', 'ContextEnvelope selection digest does not match its content');
  }
  return envelope;
}

export function assertValidSelectionReceipt(value: unknown): SelectionReceiptV03 {
  const validation = validateSelectionReceipt(value);
  if (!validation.valid) validationFailure('SelectionReceipt', validation.errors);
  const receipt = cloneValidatedJson(value as SelectionReceiptV03);
  const { receipt_digest: supplied, ...withoutDigest } = receipt;
  if (hashContextJson(withoutDigest) !== supplied) {
    throw new PrimeContextError('STATE_ERROR', 'SelectionReceipt digest does not match its content');
  }
  return receipt;
}

export function assertValidTaskContextPackage(value: unknown): TaskContextPackageV03 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PrimeContextError('VALIDATION_ERROR', 'TaskContextPackage must be a JSON object');
  }
  const object = value as Record<string, unknown>;
  const envelope = assertValidContextEnvelope(object.envelope);
  const receipt = assertValidSelectionReceipt(object.receipt);
  if (receipt.task_id !== envelope.task_id || receipt.request_digest !== envelope.request_digest
      || receipt.selection_digest !== envelope.selection_digest
      || receipt.policy_version !== envelope.policy_version
      || receipt.budget_tier !== envelope.budget_tier) {
    throw new PrimeContextError('STATE_ERROR', 'TaskContextPackage envelope and receipt links do not match');
  }
  if (receipt.truncation.considered_candidates !== receipt.decisions.length
      || receipt.truncation.selected_candidates !== envelope.items.length) {
    throw new PrimeContextError('STATE_ERROR', 'TaskContextPackage decision counts do not match the envelope');
  }
  const included = receipt.decisions.filter((decision) => decision.status === 'INCLUDED');
  const itemsById = new Map(envelope.items.map((item) => [item.id, item]));
  if (included.length !== itemsById.size || included.some((decision) => {
    const item = itemsById.get(decision.candidate_id);
    return !item || decision.mandatory !== item.mandatory || decision.score !== item.score
      || decision.reason !== item.selection_reason
      || hashContextJson(decision.score_components) !== hashContextJson(item.score_components);
  })) {
    throw new PrimeContextError('STATE_ERROR', 'TaskContextPackage included decisions do not match envelope items');
  }
  if (hashContextJson(receipt.conflicts) !== hashContextJson(envelope.conflicts)
      || hashContextJson(receipt.source_failures) !== hashContextJson(envelope.source_failures)
      || hashContextJson(receipt.truncation) !== hashContextJson(envelope.truncation)) {
    throw new PrimeContextError('STATE_ERROR', 'TaskContextPackage receipt evidence does not match the envelope');
  }
  const budgetOmissions = receipt.decisions.filter((decision) => decision.reason.startsWith('OMIT_BUDGET'));
  const expectedBudgetStatus = budgetOmissions.some((decision) => decision.mandatory)
    ? 'EXHAUSTED' : budgetOmissions.length > 0 ? 'TRUNCATED' : 'WITHIN_BUDGET';
  if (envelope.budget_status !== expectedBudgetStatus) {
    throw new PrimeContextError('STATE_ERROR', 'TaskContextPackage budget_status does not match budget omission decisions');
  }
  const decisionIds = new Set(receipt.decisions.map((decision) => decision.candidate_id));
  if (receipt.conflicts.some((conflict) => conflict.candidate_ids.some((candidateId) => !decisionIds.has(candidateId)))) {
    throw new PrimeContextError('STATE_ERROR', 'TaskContextPackage conflict candidates must reference receipt decisions');
  }
  return { envelope, receipt };
}

export function assertValidOutcomeReceipt(value: unknown): OutcomeReceiptV03 {
  const validation = validateOutcomeReceipt(value);
  if (!validation.valid) validationFailure('OutcomeReceipt', validation.errors);
  const receipt = cloneValidatedJson(value as OutcomeReceiptV03);
  const { outcome_digest: supplied, ...withoutDigest } = receipt;
  if (hashContextJson(withoutDigest) !== supplied) {
    throw new PrimeContextError('STATE_ERROR', 'OutcomeReceipt digest does not match its content');
  }
  return receipt;
}

export function assertValidContextOutcomeInput(value: unknown): ContextOutcomeInputV03 {
  const validation = validateContextOutcomeInput(value);
  if (!validation.valid) validationFailure('Outcome declaration', validation.errors);
  return cloneValidatedJson(value as ContextOutcomeInputV03);
}

export function assertValidExpansionRequest(value: unknown): ExpansionRequestV03 {
  const validation = validateExpansionRequest(value);
  if (!validation.valid) validationFailure('ExpansionRequest', validation.errors);
  return cloneValidatedJson(value as ExpansionRequestV03);
}

export function assertValidExpansionDecision(value: unknown): ExpansionDecisionV03 {
  const validation = validateExpansionDecision(value);
  if (!validation.valid) validationFailure('ExpansionDecision', validation.errors);
  return cloneValidatedJson(value as ExpansionDecisionV03);
}

export function assertValidAblationRequest(value: unknown): AblationRequestV03 {
  const validation = validateAblationRequest(value);
  if (!validation.valid) validationFailure('AblationRequest', validation.errors);
  return cloneValidatedJson(value as AblationRequestV03);
}

export function assertValidAblationResult(value: unknown): AblationResultV03 {
  const validation = validateAblationResult(value);
  if (!validation.valid) validationFailure('AblationResult', validation.errors);
  return cloneValidatedJson(value as AblationResultV03);
}

export function assertValidReplayResult(value: unknown): ReplayResultV03 {
  const validation = validateReplayResult(value);
  if (!validation.valid) validationFailure('ReplayResult', validation.errors);
  const result = cloneValidatedJson(value as ReplayResultV03);
  const { replay_digest: supplied, ...withoutDigest } = result;
  if (hashContextJson(withoutDigest) !== supplied) {
    throw new PrimeContextError('STATE_ERROR', 'ReplayResult digest does not match its content');
  }
  return result;
}

interface PreparedCandidate {
  candidate: ContextCandidateV03;
  mandatory: boolean;
  retained: boolean;
  components: ContextScoreComponentsV03;
  score: number;
  criterionTerms: Map<string, Set<string>>;
  matchedQueryTerms: string[];
  expansionRequested: boolean;
  expansionMatchedTerms: string[];
  initialReason: ContextIncludeReasonV03;
}

function normalizedTokens(value: string): string[] {
  return value.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function termsFromText(value: string): string[] {
  return uniqueSorted(normalizedTokens(value)).slice(0, 64);
}

function prioritizedBoundedTerms(groups: readonly (readonly string[])[], limit = 64): string[] {
  const selected = new Set<string>();
  for (const group of groups) {
    for (const term of uniqueSorted(group)) {
      selected.add(term);
      if (selected.size === limit) return [...selected].sort(ordinal);
    }
  }
  return [...selected].sort(ordinal);
}

interface CriterionRequirement {
  id: string;
  matchMode: 'ALL' | 'AT_LEAST';
  requiredTerms: string[];
  minimumMatches: number;
}

function criterionRequirement(criterion: ContextPlanRequestV03['task']['acceptance_criteria'][number]): CriterionRequirement {
  if (criterion.required_terms !== undefined) {
    const requiredTerms = uniqueSorted(criterion.required_terms.flatMap(termsFromText)).slice(0, 64);
    return { id: criterion.id, matchMode: 'ALL', requiredTerms, minimumMatches: requiredTerms.length };
  }
  const requiredTerms = termsFromText(criterion.text).filter((term) => !IMPLICIT_CRITERION_STOPWORDS.has(term));
  return {
    id: criterion.id,
    matchMode: 'AT_LEAST',
    requiredTerms,
    minimumMatches: Math.min(2, Math.max(1, requiredTerms.length)),
  };
}

function criterionSatisfied(requirement: CriterionRequirement, matchedTerms: ReadonlySet<string>): boolean {
  if (requirement.matchMode === 'ALL') {
    return requirement.requiredTerms.length === 0
      ? matchedTerms.size > 0
      : requirement.requiredTerms.every((term) => matchedTerms.has(term));
  }
  return matchedTerms.size >= requirement.minimumMatches;
}

function hasRecognizedAuthority(candidate: ContextCandidateV03): boolean {
  if (candidate.provider !== 'documents' && candidate.provider !== 'filesystem') return false;
  const evidence = new Set(candidate.authority_evidence);
  const recognized = new Map<ContextCandidateV03['authority'], readonly string[]>([
    ['policy', [
      'convention:root-agents-file', 'convention:ancestor-agents-file',
      'convention:root-security-file', 'convention:root-code-of-conduct-file',
    ]],
    ['adr', ['convention:docs-adr-directory', 'docs-adr']],
    ['specification', ['convention:docs-specification-directory', 'docs-specification']],
    ['contract_schema', ['convention:docs-contract-schema-directory', 'docs-contract-schema']],
    ['roadmap', ['convention:roadmap-file', 'docs-roadmap']],
  ]);
  return (recognized.get(candidate.authority) ?? []).some((item) => evidence.has(item));
}

function requestIsSecurityRelevant(request: ContextPlanRequestV03): boolean {
  const values = [
    request.task.goal, request.task.query,
    ...request.task.acceptance_criteria.map((criterion) => criterion.text),
    ...(request.task.acceptance_criteria.flatMap((criterion) => criterion.required_terms ?? [])),
    ...(request.task.hints?.paths ?? []), ...(request.task.hints?.terms ?? []),
    ...(request.required_sources ?? []),
  ];
  const terms = new Set(values.flatMap(normalizedTokens));
  const hasAny = (vocabulary: ReadonlySet<string>): boolean => [...terms].some((term) => vocabulary.has(term));
  return hasAny(SECURITY_RELEVANT_TERMS)
    || values.some((value) => DENIAL_OF_SERVICE_ACRONYM.test(value))
    || (terms.has('cross') && terms.has('site') && terms.has('scripting'))
    || (terms.has('sql') && terms.has('injection'))
    || (hasAny(INJECTION_OR_EXECUTION_TERMS) && hasAny(COMMAND_OR_CODE_TERMS))
    || (terms.has('injection') && hasAny(INJECTION_CONTEXT_TERMS))
    || (hasAny(KEY_TERMS) && hasAny(KEY_SECURITY_CONTEXT_TERMS))
    || (terms.has('prototype') && terms.has('pollution'))
    || (terms.has('denial') && (terms.has('service') || terms.has('services')))
    || ((terms.has('buffer') || terms.has('stack')) && (terms.has('overflow') || terms.has('overflows')))
    || (terms.has('session') && terms.has('fixation'))
    || (hasAny(SIGNATURE_TERMS) && hasAny(SIGNATURE_SECURITY_CONTEXT_TERMS))
    || (hasAny(TRAVERSAL_TERMS) && hasAny(TRAVERSAL_SECURITY_CONTEXT_TERMS))
    || (hasAny(DEPENDENCY_CONTEXT_TERMS) && hasAny(DEPENDENCY_SECURITY_TERMS));
}

function applicablePolicyPaths(
  request: ContextPlanRequestV03,
  candidates: readonly ContextCandidateV03[],
): ReadonlySet<string> {
  const result = new Set<string>();
  const recognizedPolicies = candidates.filter((candidate) => candidate.authority === 'policy' && hasRecognizedAuthority(candidate));
  const agentsPolicyByScope = new Map<string, string>();
  for (const candidate of recognizedPolicies) {
    const slash = candidate.path.lastIndexOf('/');
    const fileName = candidate.path.slice(slash + 1);
    if (fileName.toLowerCase() !== 'agents.md') continue;
    const scope = slash < 0 ? '' : candidate.path.slice(0, slash);
    const current = agentsPolicyByScope.get(scope);
    const currentFileName = current?.slice(current.lastIndexOf('/') + 1);
    const candidateIsCanonical = fileName === 'AGENTS.md';
    const currentIsCanonical = currentFileName === 'AGENTS.md';
    if (current === undefined
        || (candidateIsCanonical && !currentIsCanonical)
        || (candidateIsCanonical === currentIsCanonical && ordinal(candidate.path, current) < 0)) {
      agentsPolicyByScope.set(scope, candidate.path);
    }
  }
  const rootAgentsPolicy = agentsPolicyByScope.get('');
  if (rootAgentsPolicy !== undefined) result.add(rootAgentsPolicy);
  let rootSecurityPolicy: string | undefined;
  for (const candidate of recognizedPolicies) {
    if (candidate.path.includes('/') || candidate.path.toLowerCase() !== 'security.md') continue;
    if (rootSecurityPolicy === undefined
        || (candidate.path === 'SECURITY.md' && rootSecurityPolicy !== 'SECURITY.md')
        || ((candidate.path === 'SECURITY.md') === (rootSecurityPolicy === 'SECURITY.md')
          && ordinal(candidate.path, rootSecurityPolicy) < 0)) {
      rootSecurityPolicy = candidate.path;
    }
  }
  if (requestIsSecurityRelevant(request) && rootSecurityPolicy !== undefined) result.add(rootSecurityPolicy);

  const physicalCandidatePaths = candidates
    .filter((candidate) => candidate.authority !== 'policy'
      && candidate.kind !== 'history' && candidate.kind !== 'repository_map')
    .map((candidate) => candidate.path);
  const physicalCandidatePathSet = new Set(physicalCandidatePaths);
  const targets = uniqueSorted([
    ...(request.task.hints?.paths ?? []), ...(request.required_sources ?? []), ...physicalCandidatePaths,
  ]);
  for (const target of targets) {
    const scopedPolicyPath = agentsPolicyByScope.get(target);
    if (!physicalCandidatePathSet.has(target) && scopedPolicyPath !== undefined) {
      result.add(scopedPolicyPath);
      continue;
    }
    let slash = target.lastIndexOf('/');
    while (slash >= 0) {
      const policyPath = agentsPolicyByScope.get(target.slice(0, slash));
      if (policyPath !== undefined) {
        result.add(policyPath);
        break;
      }
      slash = target.lastIndexOf('/', slash - 1);
    }
  }
  return result;
}

function candidateOrder(left: PreparedCandidate, right: PreparedCandidate): number {
  const providerDifference = (PROVIDER_RANK.get(left.candidate.provider) ?? 99) - (PROVIDER_RANK.get(right.candidate.provider) ?? 99);
  if (providerDifference !== 0) return providerDifference;
  const pathDifference = ordinal(left.candidate.path, right.candidate.path);
  if (pathDifference !== 0) return pathDifference;
  const lineDifference = (left.candidate.line_start ?? 0) - (right.candidate.line_start ?? 0);
  if (lineDifference !== 0) return lineDifference;
  const symbolDifference = ordinal(left.candidate.symbol ?? '', right.candidate.symbol ?? '');
  return symbolDifference || ordinal(left.candidate.id, right.candidate.id);
}

function duplicateOrder(left: PreparedCandidate, right: PreparedCandidate): number {
  const retainedDifference = Number(right.retained) - Number(left.retained);
  if (retainedDifference !== 0) return retainedDifference;
  const mandatoryDifference = Number(right.mandatory) - Number(left.mandatory);
  if (mandatoryDifference !== 0) return mandatoryDifference;
  const authorityDifference = (hasRecognizedAuthority(left.candidate) ? AUTHORITY_RANK.get(left.candidate.authority) ?? 99 : 99)
    - (hasRecognizedAuthority(right.candidate) ? AUTHORITY_RANK.get(right.candidate.authority) ?? 99 : 99);
  if (authorityDifference !== 0) return authorityDifference;
  const locatorLengthLeft = `${left.candidate.path}:${left.candidate.line_start ?? ''}:${left.candidate.symbol ?? ''}`.length;
  const locatorLengthRight = `${right.candidate.path}:${right.candidate.line_start ?? ''}:${right.candidate.symbol ?? ''}`.length;
  return locatorLengthLeft - locatorLengthRight || candidateOrder(left, right);
}

function prepareCandidate(
  request: ContextPlanRequestV03,
  candidate: ContextCandidateV03,
  retained: boolean,
  applicablePolicies: ReadonlySet<string>,
  expansion?: ExpansionRequestV03,
): PreparedCandidate {
  if (candidate.snapshot.repository_id !== request.snapshot.repository_id
      || candidate.snapshot.worktree_digest !== request.snapshot.worktree_digest
      || candidate.snapshot.head !== request.snapshot.head) {
    throw new PrimeContextError('FRESHNESS_ERROR', 'ContextCandidate snapshot does not match the requested repository snapshot');
  }
  if (candidate.freshness === 'unknown') {
    throw new PrimeContextError('FRESHNESS_ERROR', 'ContextCandidate freshness is unknown');
  }
  const requiredSources = request.required_sources ?? [];
  const requiredSource = requiredSources.includes(candidate.path);
  const applicablePolicy = applicablePolicies.has(candidate.path) && hasRecognizedAuthority(candidate);
  const mandatory = requiredSource || applicablePolicy;
  const visibleTerms = new Set(normalizedTokens([
    candidate.path,
    candidate.symbol ?? '',
    candidate.excerpt,
  ].join(' ')));
  const adapterMatchedTerms = new Set(
    candidate.discovery.matched_terms.flatMap(termsFromText).filter((term) => visibleTerms.has(term)),
  );
  const queryTerms = termsFromText(request.task.query);
  const matchedQueryTerms = queryTerms.filter((term) => visibleTerms.has(term)).slice(0, 64);
  const expansionMatchedTerms = expansion
    ? uniqueSorted(expansion.requested_terms.flatMap(termsFromText).filter((term) => visibleTerms.has(term))).slice(0, 64)
    : [];
  const expansionRequested = !retained && expansion !== undefined && (
    expansion.requested_paths.some((path) => candidate.path === path || candidate.path.startsWith(`${path}/`))
    || (candidate.symbol !== undefined && expansion.requested_symbols.includes(candidate.symbol))
    || expansionMatchedTerms.length > 0
  );
  const hints = request.task.hints;
  const hintedPath = (hints?.paths ?? []).includes(candidate.path);
  const hintedSymbol = candidate.symbol !== undefined && (hints?.symbols ?? []).includes(candidate.symbol);
  const criterionTerms = new Map<string, Set<string>>();
  const allMatchedRequiredTerms = new Set<string>();
  for (const criterion of request.task.acceptance_criteria.map(criterionRequirement)) {
    const matches = new Set(criterion.requiredTerms.filter((term) => visibleTerms.has(term)));
    if (matches.size > 0) criterionTerms.set(criterion.id, matches);
    matches.forEach((term) => allMatchedRequiredTerms.add(term));
  }
  candidate.discovery.matched_terms = prioritizedBoundedTerms([
    [...allMatchedRequiredTerms], expansionMatchedTerms, matchedQueryTerms, [...adapterMatchedTerms],
  ]);
  candidate.discovery.criteria_ids = uniqueSorted([...criterionTerms.keys()]);
  const graphDistance = candidate.discovery.graph_distance;
  const components: ContextScoreComponentsV03 = {
    required_source: requiredSource ? 10_000 : 0,
    applicable_policy: applicablePolicy ? 9_000 : 0,
    hinted_path: hintedPath ? 800 : 0,
    hinted_symbol: hintedSymbol ? 700 : 0,
    required_terms: Math.min(allMatchedRequiredTerms.size, 64) * 120,
    query_terms: Math.min(matchedQueryTerms.length, 64) * 80,
    graph_distance: graphDistance === undefined ? 0 : 300 - (50 * graphDistance),
    authority: hasRecognizedAuthority(candidate) ? AUTHORITY_SCORES.get(candidate.authority) ?? 0 : 0,
    related_test: candidate.kind === 'test' && (hintedPath || hintedSymbol) ? 100 : 0,
    live_freshness: candidate.freshness === 'live' ? 100 : 0,
  };
  const score = Object.values(components).reduce((sum, value) => sum + value, 0);
  const initialReason: ContextIncludeReasonV03 = requiredSource
    ? 'INCLUDE_REQUIRED_SOURCE'
    : applicablePolicy ? 'INCLUDE_APPLICABLE_POLICY'
      : criterionTerms.size > 0 ? 'INCLUDE_CRITERION_COVERAGE' : 'INCLUDE_RELEVANCE';
  return {
    candidate, mandatory, retained, components, score, criterionTerms, matchedQueryTerms,
    expansionRequested, expansionMatchedTerms, initialReason,
  };
}

function toSelected(prepared: PreparedCandidate, reason = prepared.initialReason): SelectedContextCandidateV03 {
  return { ...cloneValidatedJson(prepared.candidate), mandatory: prepared.mandatory, score: prepared.score, score_components: { ...prepared.components }, selection_reason: reason };
}

function fitReason(candidate: ContextCandidateV03, selected: readonly PreparedCandidate[], budget: ContextBudgetLimitsV03): ContextDecisionReasonV03 | undefined {
  if (selected.length + 1 > budget.max_items) return 'OMIT_BUDGET_ITEMS';
  if (selected.reduce((sum, item) => sum + item.candidate.excerpt_bytes, 0) + candidate.excerpt_bytes > budget.max_bytes) return 'OMIT_BUDGET_BYTES';
  if (selected.reduce((sum, item) => sum + item.candidate.estimated_tokens, 0) + candidate.estimated_tokens > budget.max_estimated_tokens) return 'OMIT_BUDGET_TOKENS';
  return undefined;
}

function coverageKeys(candidate: PreparedCandidate): string[] {
  return uniqueSorted([...candidate.criterionTerms.entries()].flatMap(([criterionId, terms]) => (
    [...terms].map((term) => `${criterionId}:${term}`)
  )));
}

function matchedTermsForCriterion(covered: ReadonlySet<string>, criterionId: string): Set<string> {
  const prefix = `${criterionId}:`;
  return new Set([...covered].filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length)));
}

function marginalCoverage(
  candidate: PreparedCandidate,
  covered: ReadonlySet<string>,
  requirements: ReadonlyMap<string, CriterionRequirement>,
): string[] {
  const marginal: string[] = [];
  for (const [criterionId, terms] of candidate.criterionTerms) {
    const requirement = requirements.get(criterionId);
    if (!requirement) continue;
    const alreadyMatched = matchedTermsForCriterion(covered, criterionId);
    if (criterionSatisfied(requirement, alreadyMatched)) continue;
    for (const term of terms) {
      const key = `${criterionId}:${term}`;
      if (!covered.has(key)) marginal.push(key);
    }
  }
  return uniqueSorted(marginal);
}

function allCriteriaSatisfied(
  covered: ReadonlySet<string>,
  requirements: ReadonlyMap<string, CriterionRequirement>,
): boolean {
  return [...requirements.values()].every((requirement) => (
    criterionSatisfied(requirement, matchedTermsForCriterion(covered, requirement.id))
  ));
}

function conflictGroups(candidates: readonly PreparedCandidate[]): ContextConflictV03[] {
  const byKey = new Map<string, PreparedCandidate[]>();
  const conflictAuthorities = new Set(['policy', 'adr', 'specification', 'contract_schema', 'roadmap']);
  for (const candidate of candidates) {
    if (!conflictAuthorities.has(candidate.candidate.authority) || !hasRecognizedAuthority(candidate.candidate)) continue;
    const locators = candidate.candidate.symbol
      ? [`symbol:${candidate.candidate.symbol}`]
      : candidate.candidate.kind === 'document' && candidate.criterionTerms.size > 0
        ? [...candidate.criterionTerms.keys()].sort(ordinal).map((criterionId) => `topic:criterion:${criterionId}`)
        : [`path:${candidate.candidate.path}:${candidate.candidate.line_start ?? 0}:${candidate.candidate.line_end ?? 0}`];
    for (const locator of locators) {
      const group = byKey.get(locator) ?? [];
      group.push(candidate);
      byKey.set(locator, group);
    }
  }
  return [...byKey.entries()]
    .filter(([, group]) => new Set(group.map((item) => item.candidate.source_hash)).size > 1)
    .map(([locator, group]) => ({
      conflict_key: `conflict-${hashContextText(locator).slice('sha256:'.length)}`,
      candidate_ids: uniqueSorted(group.map((item) => item.candidate.id)),
      criterion_ids: uniqueSorted(group.flatMap((item) => [...item.criterionTerms.keys()])),
      reason: 'AUTHORITATIVE_VARIANTS_REQUIRE_REVIEW' as const,
    }))
    .sort((left, right) => ordinal(left.conflict_key, right.conflict_key));
}

function compileContextInternal(
  requestValue: unknown,
  candidateValues: readonly unknown[],
  sourceFailures: readonly ContextSourceFailureV03[] = [],
  retainedCandidateIds: ReadonlySet<string> = new Set(),
  effectiveBudget?: ContextBudgetLimitsV03,
  budgetTier?: ContextBudgetTierV03,
  expansion?: ExpansionRequestV03,
  inheritedTruncation?: ContextEnvelopeV03['truncation'],
): TaskContextPackageV03 {
  const request = assertValidContextPlanRequest(requestValue);
  const selectionBudget = effectiveBudget ?? request.budget;
  const effectiveTier = request.progressive_budget ? budgetTier ?? 'INITIAL' : undefined;
  const candidateInputs = validatedCandidateInputArray(candidateValues);
  const failures = validatedSourceFailures(sourceFailures);
  const blockedRequiredFailure = failures.some((failure) => (
    failure.security_control && failure.code === 'REQUIRED_SOURCE_BLOCKED'
  ));
  if (failures.some((failure) => failure.security_control && failure.code !== 'REQUIRED_SOURCE_BLOCKED')) {
    throw new PrimeContextError('SECURITY_ERROR', 'A candidate-source security control failed closed');
  }
  const candidates = candidateInputs.map(assertValidContextCandidate);
  const ids = candidates.map((candidate) => candidate.id);
  if (new Set(ids).size !== ids.length) throw new PrimeContextError('VALIDATION_ERROR', 'A duplicate candidate id was supplied');
  const applicablePolicies = applicablePolicyPaths(request, candidates);
  let prepared = candidates.map((candidate) => prepareCandidate(
    request, candidate, retainedCandidateIds.has(candidate.id), applicablePolicies, expansion,
  ));
  const requirements = new Map(request.task.acceptance_criteria.map(criterionRequirement).map((item) => [item.id, item]));
  const duplicateGroups: SelectionReceiptV03['duplicate_groups'] = [];
  const duplicateDecisions: ContextSelectionDecisionV03[] = [];
  const duplicatePathsByRepresentative = new Map<string, string[]>();
  const byContent = new Map<string, PreparedCandidate[]>();
  for (const item of prepared) {
    const key = `${item.candidate.source_hash}:${item.candidate.excerpt_hash}`;
    const group = byContent.get(key) ?? [];
    group.push(item);
    byContent.set(key, group);
  }
  prepared = [];
  const normalizedDuplicateGroups: Array<{ representative: PreparedCandidate; duplicates: PreparedCandidate[] }> = [];
  for (const group of byContent.values()) {
    const sorted = [...group].sort(duplicateOrder);
    const retained = sorted.filter((item) => item.retained);
    if (expansion !== undefined && retained.length > 0) {
      const freshMandatory = sorted.filter((item) => !item.retained && item.mandatory);
      const freshNonMandatory = sorted.filter((item) => !item.retained && !item.mandatory);
      normalizedDuplicateGroups.push({ representative: retained[0] as PreparedCandidate, duplicates: freshNonMandatory });
      for (const retainedAlias of retained.slice(1)) {
        normalizedDuplicateGroups.push({ representative: retainedAlias, duplicates: [] });
      }
      if (freshMandatory.length > 0) {
        normalizedDuplicateGroups.push({
          representative: freshMandatory[0] as PreparedCandidate,
          duplicates: freshMandatory.slice(1),
        });
      }
    } else {
      normalizedDuplicateGroups.push({ representative: sorted[0] as PreparedCandidate, duplicates: sorted.slice(1) });
    }
  }
  normalizedDuplicateGroups.sort((left, right) => candidateOrder(left.representative, right.representative));
  for (const { representative, duplicates } of normalizedDuplicateGroups) {
    prepared.push(representative);
    if (duplicates.length > 0) {
      duplicateGroups.push({ representative_id: representative.candidate.id, duplicate_ids: duplicates.map((item) => item.candidate.id).sort(ordinal) });
      duplicatePathsByRepresentative.set(
        representative.candidate.id,
        uniqueSorted([representative.candidate.path, ...duplicates.map((item) => item.candidate.path)]),
      );
      for (const duplicate of duplicates) {
        duplicateDecisions.push({
          candidate_id: duplicate.candidate.id, status: 'OMITTED', reason: 'OMIT_DUPLICATE_CONTENT',
          mandatory: duplicate.mandatory, score: duplicate.score, score_components: duplicate.components,
          marginal_criteria_ids: [], marginal_terms: [], duplicate_of: representative.candidate.id,
        });
      }
    }
  }
  const conflicts = conflictGroups(prepared);
  const conflictIds = new Set(conflicts.flatMap((conflict) => conflict.candidate_ids));
  const selected: PreparedCandidate[] = [];
  const decisions = new Map<string, ContextSelectionDecisionV03>();
  let mandatoryExhausted = false;
  for (const item of prepared.filter((candidate) => candidate.retained).sort(candidateOrder)) {
    const reason = fitReason(item.candidate, selected, selectionBudget);
    if (reason) throw new PrimeContextError('CONTEXT_ERROR', 'Previously selected expansion evidence no longer fits its cumulative budget');
    selected.push(item);
    decisions.set(item.candidate.id, {
      candidate_id: item.candidate.id, status: 'INCLUDED', reason: item.initialReason, mandatory: item.mandatory,
      score: item.score, score_components: item.components,
      marginal_criteria_ids: [...item.criterionTerms.keys()].sort(ordinal),
      marginal_terms: uniqueSorted([...item.criterionTerms.values()].flatMap((terms) => [...terms])),
    });
  }
  for (const item of prepared.filter((candidate) => candidate.mandatory && !candidate.retained).sort(candidateOrder)) {
    const reason = fitReason(item.candidate, selected, selectionBudget);
    if (reason) {
      mandatoryExhausted = true;
      decisions.set(item.candidate.id, {
        candidate_id: item.candidate.id, status: 'OMITTED', reason, mandatory: true,
        score: item.score, score_components: item.components, marginal_criteria_ids: [], marginal_terms: [],
      });
    } else {
      selected.push(item);
      decisions.set(item.candidate.id, {
        candidate_id: item.candidate.id, status: 'INCLUDED', reason: item.initialReason, mandatory: true,
        score: item.score, score_components: item.components,
        marginal_criteria_ids: [...item.criterionTerms.keys()].sort(ordinal),
        marginal_terms: uniqueSorted([...item.criterionTerms.values()].flatMap((terms) => [...terms])),
      });
    }
  }
  const covered = new Set(selected.flatMap(coverageKeys));
  const remaining = prepared.filter((item) => !item.mandatory && !item.retained);
  let marginalEvaluations = 0;
  const maxMarginalEvaluations = (remaining.length * (remaining.length + 1)) / 2;
  while (remaining.length > 0) {
    let bestIndex = 0;
    let bestMarginal: string[] | undefined;
    for (let index = 0; index < remaining.length; index += 1) {
      const candidate = remaining[index] as PreparedCandidate;
      const candidateMarginal = marginalCoverage(candidate, covered, requirements);
      marginalEvaluations += 1;
      if (marginalEvaluations > maxMarginalEvaluations) {
        throw new PrimeContextError('STATE_ERROR', 'Context selection exceeded its deterministic marginal-evaluation bound');
      }
      if (bestMarginal === undefined) {
        bestIndex = index;
        bestMarginal = candidateMarginal;
        continue;
      }
      const best = remaining[bestIndex] as PreparedCandidate;
      const candidateWins = candidateMarginal.length > bestMarginal.length
        || (candidateMarginal.length === bestMarginal.length
          && (Number(conflictIds.has(candidate.candidate.id)) > Number(conflictIds.has(best.candidate.id))
            || (Number(conflictIds.has(candidate.candidate.id)) === Number(conflictIds.has(best.candidate.id))
              && (Number(candidate.expansionRequested) > Number(best.expansionRequested)
                || (Number(candidate.expansionRequested) === Number(best.expansionRequested)
                  && (candidate.score > best.score
                    || (candidate.score === best.score && candidateOrder(candidate, best) < 0)))))));
      if (candidateWins) {
        bestIndex = index;
        bestMarginal = candidateMarginal;
      }
    }
    const [item] = remaining.splice(bestIndex, 1) as [PreparedCandidate];
    const marginal = bestMarginal as string[];
    const conflictReview = conflictIds.has(item.candidate.id);
    if (marginal.length === 0 && !conflictReview && !item.expansionRequested) {
      const satisfiedRequiredPaths = new Set(selected.flatMap((selectedItem) => (
        duplicatePathsByRepresentative.get(selectedItem.candidate.id) ?? [selectedItem.candidate.path]
      )));
      const sufficient = allCriteriaSatisfied(covered, requirements)
        && (request.required_sources ?? []).every((path) => satisfiedRequiredPaths.has(path))
        && !blockedRequiredFailure && !mandatoryExhausted;
      for (const zeroMarginal of [item, ...remaining]) {
        decisions.set(zeroMarginal.candidate.id, {
          candidate_id: zeroMarginal.candidate.id, status: 'OMITTED',
          reason: sufficient ? 'OMIT_SUFFICIENT_EVIDENCE'
            : zeroMarginal.score === 0 ? 'OMIT_NO_MATCH' : 'OMIT_LOWER_MARGINAL_COVERAGE',
          mandatory: false, score: zeroMarginal.score, score_components: zeroMarginal.components,
          marginal_criteria_ids: [], marginal_terms: [],
        });
      }
      remaining.length = 0;
      break;
    }
    const reason = fitReason(item.candidate, selected, selectionBudget);
    if (reason) {
      const marginalCriteria = uniqueSorted(marginal.map((key) => key.slice(0, key.indexOf(':'))));
      decisions.set(item.candidate.id, {
        candidate_id: item.candidate.id, status: 'OMITTED', reason, mandatory: false,
        score: item.score, score_components: item.components, marginal_criteria_ids: marginalCriteria,
        marginal_terms: uniqueSorted(marginal.map((key) => key.slice(key.indexOf(':') + 1))),
      });
      continue;
    }
    selected.push(item);
    marginal.forEach((key) => covered.add(key));
    const marginalCriteria = uniqueSorted(marginal.map((key) => key.slice(0, key.indexOf(':'))));
    decisions.set(item.candidate.id, {
      candidate_id: item.candidate.id, status: 'INCLUDED',
      reason: marginal.length > 0 ? 'INCLUDE_CRITERION_COVERAGE' : 'INCLUDE_RELEVANCE', mandatory: false,
      score: item.score, score_components: item.components, marginal_criteria_ids: marginalCriteria,
      marginal_terms: uniqueSorted([
        ...marginal.map((key) => key.slice(key.indexOf(':') + 1)), ...item.expansionMatchedTerms,
      ]),
    });
  }
  for (const conflictId of conflictIds) {
    const decision = decisions.get(conflictId);
    if (decision?.status === 'OMITTED' && !decision.reason.startsWith('OMIT_BUDGET')) decision.reason = 'OMIT_CONFLICT_REVIEW';
  }
  const receiptDuplicateGroups = duplicateGroups.filter((group) => (
    decisions.get(group.representative_id)?.status === 'INCLUDED'
  ));
  const linkedDuplicateIds = new Set(receiptDuplicateGroups.flatMap((group) => group.duplicate_ids));
  const receiptDuplicateDecisions = duplicateDecisions.map((decision): ContextSelectionDecisionV03 => {
    if (linkedDuplicateIds.has(decision.candidate_id)) return decision;
    const representative = decision.duplicate_of === undefined ? undefined : decisions.get(decision.duplicate_of);
    if (!representative || representative.status !== 'OMITTED') {
      throw new PrimeContextError('STATE_ERROR', 'Duplicate decision is missing its omitted representative decision');
    }
    const { duplicate_of: _duplicateOf, ...unlinked } = decision;
    return { ...unlinked, reason: representative.reason };
  });
  const selectedItems = selected.map((item) => {
    const decision = decisions.get(item.candidate.id);
    if (!decision || decision.status !== 'INCLUDED') {
      throw new PrimeContextError('STATE_ERROR', 'Selected context candidate is missing its receipt decision');
    }
    return toSelected(item, decision.reason as ContextIncludeReasonV03);
  });
  const coverage = request.task.acceptance_criteria.map((criterion) => {
    const requirement = requirements.get(criterion.id) as CriterionRequirement;
    const matching = selected.filter((item) => item.criterionTerms.has(criterion.id));
    const candidateIds = uniqueSorted(matching.map((item) => item.candidate.id));
    const conflicted = conflicts.some((conflict) => conflict.criterion_ids.includes(criterion.id));
    const matchedTerms = uniqueSorted(matching.flatMap((item) => [...(item.criterionTerms.get(criterion.id) ?? [])]));
    const hasRequiredCoverage = criterionSatisfied(requirement, new Set(matchedTerms));
    return {
      criterion_id: criterion.id,
      match_mode: requirement.matchMode,
      ...(requirement.matchMode === 'AT_LEAST' ? { minimum_matches: requirement.minimumMatches } : {}),
      required_terms: requirement.requiredTerms,
      status: conflicted ? 'CONFLICTED' as const : hasRequiredCoverage ? 'COVERED' as const : 'MISSING' as const,
      candidate_ids: candidateIds,
      matched_terms: matchedTerms,
    };
  });
  const selectedPaths = new Set(selected.flatMap((item) => (
    duplicatePathsByRepresentative.get(item.candidate.id) ?? [item.candidate.path]
  )));
  const missingRequiredSources = uniqueSorted((request.required_sources ?? []).filter((path) => !selectedPaths.has(path)));
  const missingRequiredTerms = uniqueSorted(coverage.flatMap((criterion) => (
    criterion.status === 'COVERED' ? []
      : criterion.match_mode === 'AT_LEAST'
        ? criterion.required_terms.filter((term) => !criterion.matched_terms.includes(term))
          .slice(0, Math.max(0, (criterion.minimum_matches ?? 1) - criterion.matched_terms.length))
        : criterion.required_terms.filter((term) => !criterion.matched_terms.includes(term))
  )));
  const omittedCount = candidates.length - selected.length;
  const truncationReasons = uniqueSorted([
    ...(inheritedTruncation?.truncation_reasons ?? []),
    ...candidates.flatMap((candidate) => candidate.discovery.truncation_reasons ?? []),
  ]) as ContextTruncationReasonV03[];
  const truncation = {
    considered_candidates: candidates.length, selected_candidates: selected.length, omitted_candidates: omittedCount,
    source_truncated: inheritedTruncation?.source_truncated === true
      || candidates.some((candidate) => candidate.discovery.truncated),
    truncation_reasons: truncationReasons,
  };
  const hasBudgetOmission = [...decisions.values()].some((decision) => decision.reason.startsWith('OMIT_BUDGET'));
  const evidenceStatus = conflicts.length > 0
    ? 'CONFLICT' as const
    : mandatoryExhausted || blockedRequiredFailure || coverage.some((item) => item.status !== 'COVERED')
      || missingRequiredSources.length > 0 || missingRequiredTerms.length > 0
      ? 'INSUFFICIENT_EVIDENCE' as const : 'READY' as const;
  const budgetStatus = mandatoryExhausted ? 'EXHAUSTED' as const : hasBudgetOmission ? 'TRUNCATED' as const : 'WITHIN_BUDGET' as const;
  const requestDigest = hashContextJson(request);
  const envelopeWithoutDigest = {
    schema_version: '0.3' as const, task_id: request.task.task_id, request_digest: requestDigest,
    policy_version: request.policy_version, snapshot: request.snapshot,
    ...(request.capsule_digest ? { capsule_digest: request.capsule_digest } : {}),
    evidence_status: evidenceStatus, budget_status: budgetStatus,
    ...(effectiveTier ? { budget_tier: effectiveTier } : {}),
    budget: {
      ...selectionBudget, used_items: selected.length,
      used_bytes: selected.reduce((sum, item) => sum + item.candidate.excerpt_bytes, 0),
      used_estimated_tokens: selected.reduce((sum, item) => sum + item.candidate.estimated_tokens, 0),
    },
    items: selectedItems, criteria_coverage: coverage, missing_required_sources: missingRequiredSources,
    missing_required_terms: missingRequiredTerms, conflicts: cloneValidatedJson(conflicts),
    source_failures: cloneValidatedJson(failures), truncation: { ...truncation },
  };
  const selectionDigest = hashContextJson(envelopeWithoutDigest);
  const envelope: ContextEnvelopeV03 = { ...envelopeWithoutDigest, selection_digest: selectionDigest };
  const allDecisions = [...decisions.values(), ...receiptDuplicateDecisions]
    .sort((left, right) => ordinal(left.candidate_id, right.candidate_id));
  const receiptWithoutDigest = {
    schema_version: '0.3' as const, task_id: request.task.task_id, request_digest: requestDigest,
    selection_digest: selectionDigest, policy_version: request.policy_version,
    ...(effectiveTier ? { budget_tier: effectiveTier } : {}),
    policy_components: { ...POLICY_COMPONENTS }, decisions: cloneValidatedJson(allDecisions),
    duplicate_groups: cloneValidatedJson(receiptDuplicateGroups), conflicts: cloneValidatedJson(conflicts),
    source_failures: cloneValidatedJson(failures), truncation: { ...truncation },
  };
  const receipt: SelectionReceiptV03 = { ...receiptWithoutDigest, receipt_digest: hashContextJson(receiptWithoutDigest) };
  assertValidContextEnvelope(envelope);
  assertValidSelectionReceipt(receipt);
  return { envelope, receipt };
}

export function compileContext(
  requestValue: unknown,
  candidateValues: readonly unknown[],
  sourceFailures: readonly ContextSourceFailureV03[] = [],
): TaskContextPackageV03 {
  return compileContextInternal(requestValue, candidateValues, sourceFailures);
}

function remainingEvidence(envelope: ContextEnvelopeV03): string[] {
  return uniqueSorted([
    ...envelope.criteria_coverage.filter((item) => item.status !== 'COVERED').map((item) => item.criterion_id),
    ...envelope.missing_required_sources,
    ...envelope.missing_required_terms,
  ]);
}

function normalizeImportedTaskContextPackageSourceFailures(
  validatedPackage: TaskContextPackageV03,
): TaskContextPackageV03 {
  const sourceFailures = validatedSourceFailures(validatedPackage.envelope.source_failures);
  const { selection_digest: _selectionDigest, ...envelopeWithoutDigest } = validatedPackage.envelope;
  const normalizedEnvelopeWithoutDigest = {
    ...envelopeWithoutDigest,
    source_failures: cloneValidatedJson(sourceFailures),
  };
  const selectionDigest = hashContextJson(normalizedEnvelopeWithoutDigest);
  const envelope: ContextEnvelopeV03 = {
    ...normalizedEnvelopeWithoutDigest,
    selection_digest: selectionDigest,
  };
  const { receipt_digest: _receiptDigest, ...receiptWithoutDigest } = validatedPackage.receipt;
  const normalizedReceiptWithoutDigest = {
    ...receiptWithoutDigest,
    selection_digest: selectionDigest,
    source_failures: cloneValidatedJson(sourceFailures),
  };
  const receipt: SelectionReceiptV03 = {
    ...normalizedReceiptWithoutDigest,
    receipt_digest: hashContextJson(normalizedReceiptWithoutDigest),
  };
  return assertValidTaskContextPackage({ envelope, receipt });
}

function staleExpansionResult(
  validatedPackage: TaskContextPackageV03,
  expansion: ExpansionRequestV03,
): { package: TaskContextPackageV03; decision: ExpansionDecisionV03 } {
  const previous = validatedPackage.envelope;
  const decision: ExpansionDecisionV03 = {
    schema_version: '0.3', task_id: expansion.task_id,
    previous_selection_digest: expansion.previous_selection_digest,
    selection_digest: previous.selection_digest,
    status: 'DENIED', reason_codes: ['STALE_PARENT'], additions: [],
    ...(previous.budget_tier ? { budget_tier: previous.budget_tier } : {}),
    cumulative_budget: { ...previous.budget },
    remaining_missing_evidence: remainingEvidence(previous),
    snapshot: { ...previous.snapshot },
  };
  assertValidExpansionDecision(decision);
  return { package: validatedPackage, decision };
}

export function expandContext(
  previousPackage: TaskContextPackageV03,
  planRequestValue: unknown,
  expansionValue: unknown,
  candidateValues: readonly unknown[],
  sourceFailures: readonly ContextSourceFailureV03[] = [],
): { package: TaskContextPackageV03; decision: ExpansionDecisionV03 } {
  const request = assertValidContextPlanRequest(planRequestValue);
  const expansion = assertValidExpansionRequest(expansionValue);
  const importedPreviousPackage = assertValidTaskContextPackage(previousPackage);
  const importedPreviousSelectionDigest = importedPreviousPackage.envelope.selection_digest;
  const validatedPreviousPackage = normalizeImportedTaskContextPackageSourceFailures(importedPreviousPackage);
  const previous = validatedPreviousPackage.envelope;
  if (expansion.task_id !== previous.task_id) {
    throw new PrimeContextError('STATE_ERROR', 'Expansion request does not link the prior task');
  }
  if (expansion.previous_selection_digest !== importedPreviousSelectionDigest) {
    return staleExpansionResult(validatedPreviousPackage, expansion);
  }
  if (hashContextJson(request) !== previous.request_digest) {
    return staleExpansionResult(validatedPreviousPackage, expansion);
  }
  const known = new Set(expansion.known_candidate_ids);
  if (previous.items.some((item) => !known.has(item.id))) {
    return staleExpansionResult(validatedPreviousPackage, expansion);
  }
  let targetTier: ContextBudgetTierV03 | undefined;
  let tierCeiling = request.budget;
  if (request.progressive_budget) {
    const currentTier = previous.budget_tier ?? 'INITIAL';
    const requestedCumulative = {
      max_items: previous.budget.used_items + Math.min(expansion.additional_budget.max_items, 64),
      max_bytes: previous.budget.used_bytes + expansion.additional_budget.max_bytes,
      max_estimated_tokens: previous.budget.used_estimated_tokens + expansion.additional_budget.max_estimated_tokens,
    };
    const exceedsSoft = requestedCumulative.max_items > request.progressive_budget.soft.max_items
      || requestedCumulative.max_bytes > request.progressive_budget.soft.max_bytes
      || requestedCumulative.max_estimated_tokens > request.progressive_budget.soft.max_estimated_tokens;
    if (currentTier === 'HARD' || exceedsSoft) {
      targetTier = 'HARD';
    } else {
      targetTier = 'SOFT';
    }
    tierCeiling = targetTier === 'HARD' ? request.progressive_budget.hard : request.progressive_budget.soft;
  }
  const operationBudget = {
    max_items: Math.min(tierCeiling.max_items, Math.max(
      previous.budget.max_items,
      previous.budget.used_items + Math.min(expansion.additional_budget.max_items, 64),
    )),
    max_bytes: Math.min(tierCeiling.max_bytes, Math.max(
      previous.budget.max_bytes,
      previous.budget.used_bytes + expansion.additional_budget.max_bytes,
    )),
    max_estimated_tokens: Math.min(tierCeiling.max_estimated_tokens, Math.max(
      previous.budget.max_estimated_tokens,
      previous.budget.used_estimated_tokens + expansion.additional_budget.max_estimated_tokens,
    )),
  };
  const previousIds = new Set(previous.items.map((item) => item.id));
  const providedCandidates = validatedCandidateInputArray(candidateValues).map(assertValidContextCandidate);
  const freshCandidates = providedCandidates.filter((candidate) => !previousIds.has(candidate.id));
  const freshIds = freshCandidates.map((candidate) => candidate.id);
  if (new Set(freshIds).size !== freshIds.length) {
    throw new PrimeContextError('VALIDATION_ERROR', 'Expansion contains duplicate candidate ids');
  }
  const combinedCandidates = [
    ...previous.items.map(({ mandatory: _mandatory, score: _score, score_components: _components, selection_reason: _reason, ...candidate }) => candidate),
    ...freshCandidates,
  ];
  const next = compileContextInternal(
    request, combinedCandidates, sourceFailures, previousIds, operationBudget, targetTier, expansion,
    previous.truncation,
  );
  const additions = next.envelope.items.map((item) => item.id).filter((id) => !previousIds.has(id)).slice(0, 64).sort(ordinal);
  const remaining = remainingEvidence(next.envelope);
  const hardCeiling = request.progressive_budget?.hard ?? request.budget;
  const candidatesById = new Map(combinedCandidates.map((candidate) => [candidate.id, candidate]));
  const hardLimitReached = next.receipt.decisions.some((decision) => {
    if (!decision.reason.startsWith('OMIT_BUDGET')) return false;
    const candidate = candidatesById.get(decision.candidate_id);
    return candidate !== undefined && (
      next.envelope.budget.used_items + 1 > hardCeiling.max_items
      || next.envelope.budget.used_bytes + candidate.excerpt_bytes > hardCeiling.max_bytes
      || next.envelope.budget.used_estimated_tokens + candidate.estimated_tokens > hardCeiling.max_estimated_tokens
    );
  });
  const duplicateIds = new Set(next.receipt.duplicate_groups.flatMap((group) => group.duplicate_ids));
  const duplicateOnly = additions.length === 0 && providedCandidates.length > 0
    && providedCandidates.every((candidate) => previousIds.has(candidate.id) || duplicateIds.has(candidate.id));
  if (duplicateOnly) {
    const decision: ExpansionDecisionV03 = {
      schema_version: '0.3', task_id: expansion.task_id,
      previous_selection_digest: importedPreviousSelectionDigest, selection_digest: previous.selection_digest,
      status: 'DENIED', reason_codes: ['DUPLICATE_ONLY'], additions: [],
      ...(previous.budget_tier ? { budget_tier: previous.budget_tier } : {}),
      cumulative_budget: { ...previous.budget }, remaining_missing_evidence: remainingEvidence(previous),
      snapshot: { ...previous.snapshot },
    };
    assertValidExpansionDecision(decision);
    return { package: validatedPreviousPackage, decision };
  }
  if (additions.length === 0) {
    const decision: ExpansionDecisionV03 = {
      schema_version: '0.3', task_id: expansion.task_id,
      previous_selection_digest: importedPreviousSelectionDigest, selection_digest: previous.selection_digest,
      status: 'DENIED', reason_codes: hardLimitReached ? ['HARD_LIMIT_REACHED'] : ['NO_NEW_EVIDENCE'],
      ...(previous.budget_tier ? { budget_tier: previous.budget_tier } : {}),
      additions: [], cumulative_budget: { ...previous.budget },
      remaining_missing_evidence: remainingEvidence(previous), snapshot: { ...previous.snapshot },
    };
    assertValidExpansionDecision(decision);
    return { package: validatedPreviousPackage, decision };
  }
  const decision: ExpansionDecisionV03 = {
    schema_version: '0.3', task_id: expansion.task_id, previous_selection_digest: importedPreviousSelectionDigest,
    selection_digest: next.envelope.selection_digest,
    status: additions.length === 0 ? 'DENIED' : remaining.length > 0 || hardLimitReached ? 'PARTIAL' : 'ALLOWED',
    ...(targetTier ? { budget_tier: targetTier } : {}),
    reason_codes: additions.length > 0
      ? (hardLimitReached ? ['EVIDENCE_ADDED', 'HARD_LIMIT_REACHED'] : ['EVIDENCE_ADDED'])
      : ['NO_NEW_EVIDENCE'],
    additions, cumulative_budget: next.envelope.budget, remaining_missing_evidence: remaining, snapshot: next.envelope.snapshot,
  };
  assertValidExpansionDecision(decision);
  assertValidTaskContextPackage(next);
  return { package: next, decision };
}

export function recordContextOutcome(value: unknown): OutcomeReceiptV03 {
  const input = assertValidContextOutcomeInput(value);
  input.used_candidate_ids = uniqueSorted(input.used_candidate_ids);
  input.touched_paths = uniqueSorted(input.touched_paths);
  if (input.estimated_fields) {
    input.estimated_fields = uniqueSorted(input.estimated_fields) as NonNullable<ContextOutcomeInputV03['estimated_fields']>;
  }
  const receiptWithoutDigest = { ...input, causality: 'OBSERVATIONAL_ONLY' as const };
  const receipt: OutcomeReceiptV03 = { ...receiptWithoutDigest, outcome_digest: hashContextJson(receiptWithoutDigest) };
  const validation = validateOutcomeReceipt(receipt);
  if (!validation.valid) validationFailure('OutcomeReceipt', validation.errors);
  return assertValidOutcomeReceipt(receipt);
}

export function ablateContext(envelopeValue: unknown, requestValue: unknown): AblationResultV03 {
  const envelope = assertValidContextEnvelope(envelopeValue);
  const request = assertValidAblationRequest(requestValue);
  if (request.task_id !== envelope.task_id || request.selection_digest !== envelope.selection_digest) {
    throw new PrimeContextError('STATE_ERROR', 'Ablation request does not link the parent envelope');
  }
  const sourceFailures = validatedSourceFailures(envelope.source_failures);
  const preservedMissingCriteria = envelope.criteria_coverage
    .filter((criterion) => criterion.status !== 'COVERED')
    .map((criterion) => criterion.criterion_id).sort(ordinal);
  const preservedState = {
    missing_required_sources: [...envelope.missing_required_sources],
    budget_status: envelope.budget_status,
    source_failures: sourceFailures,
    conflicts: cloneValidatedJson(envelope.conflicts),
  };
  const item = envelope.items.find((candidate) => candidate.id === request.candidate_id);
  if (!item) {
    return assertValidAblationResult({
      schema_version: '0.3', task_id: request.task_id, parent_selection_digest: envelope.selection_digest,
      removed_candidate_id: request.candidate_id, decision: 'DENIED', reason: 'CANDIDATE_NOT_SELECTED',
      evidence_status: envelope.evidence_status, missing_criteria_ids: preservedMissingCriteria,
      missing_required_terms: [...envelope.missing_required_terms], ...preservedState,
      experimental: true, causal_claim: 'NONE',
    });
  }
  if (item.mandatory) {
    return assertValidAblationResult({
      schema_version: '0.3', task_id: request.task_id, parent_selection_digest: envelope.selection_digest,
      removed_candidate_id: request.candidate_id, decision: 'DENIED', reason: 'MANDATORY_CANDIDATE',
      evidence_status: envelope.evidence_status, missing_criteria_ids: preservedMissingCriteria,
      missing_required_terms: [...envelope.missing_required_terms], ...preservedState,
      experimental: true, causal_claim: 'NONE',
    });
  }
  const remaining = envelope.items.filter((candidate) => candidate.id !== item.id);
  const remainingById = new Map(remaining.map((candidate) => [candidate.id, candidate]));
  const ablatedCoverage = envelope.criteria_coverage.map((criterion) => {
    const survivingIds = criterion.candidate_ids.filter((id) => remainingById.has(id));
    const requiredTerms = new Set(criterion.required_terms);
    const survivingTerms = uniqueSorted(survivingIds.flatMap((id) => (
      remainingById.get(id)?.discovery.matched_terms.flatMap(termsFromText) ?? []
    )).filter((term) => requiredTerms.has(term)));
    const covered = criterion.required_terms.length === 0
      ? survivingIds.length > 0
      : criterion.match_mode === 'ALL'
        ? criterion.required_terms.every((term) => survivingTerms.includes(term))
        : criterion.match_mode === 'AT_LEAST'
          ? survivingTerms.length >= (criterion.minimum_matches ?? 1)
          : survivingTerms.length > 0;
    return { criterion, covered, survivingTerms };
  });
  const missingCriteria = ablatedCoverage.filter(({ covered }) => !covered)
    .map(({ criterion }) => criterion.criterion_id).sort(ordinal);
  const missingTerms = uniqueSorted(ablatedCoverage.flatMap(({ criterion, survivingTerms }) => (
    criterion.match_mode === 'AT_LEAST'
      ? criterion.required_terms.filter((term) => !survivingTerms.includes(term))
        .slice(0, Math.max(0, (criterion.minimum_matches ?? 1) - survivingTerms.length))
      : criterion.required_terms.filter((term) => !survivingTerms.includes(term))
  )));
  const ablatedDigest = hashContextJson({ parent_selection_digest: envelope.selection_digest, removed_candidate_id: item.id, remaining_candidate_ids: remaining.map((candidate) => candidate.id) });
  const survivingConflicts = envelope.conflicts.flatMap((conflict): ContextConflictV03[] => {
    if (!conflict.candidate_ids.includes(item.id)) return [conflict];
    const remainingConflictIds = conflict.candidate_ids.filter((candidateId) => candidateId !== item.id);
    if (remainingConflictIds.length < 2) return [];
    const remainingConflictItems = remainingConflictIds.map((candidateId) => remainingById.get(candidateId));
    if (remainingConflictItems.every((candidate) => candidate !== undefined)
        && new Set(remainingConflictItems.map((candidate) => candidate.source_hash)).size < 2) return [];
    return [{ ...conflict, candidate_ids: remainingConflictIds }];
  });
  const hasOtherInsufficiency = missingCriteria.length > 0 || missingTerms.length > 0
    || envelope.missing_required_sources.length > 0 || sourceFailures.length > 0
    || envelope.budget_status !== 'WITHIN_BUDGET' || envelope.evidence_status === 'INSUFFICIENT_EVIDENCE';
  return assertValidAblationResult({
    schema_version: '0.3', task_id: request.task_id, parent_selection_digest: envelope.selection_digest,
    ablated_selection_digest: ablatedDigest, removed_candidate_id: item.id, decision: 'DERIVED',
    reason: 'NON_MANDATORY_REMOVED',
    evidence_status: survivingConflicts.length > 0 ? 'CONFLICT'
      : hasOtherInsufficiency ? 'INSUFFICIENT_EVIDENCE' : 'READY',
    missing_criteria_ids: missingCriteria, missing_required_terms: missingTerms,
    missing_required_sources: [...envelope.missing_required_sources], budget_status: envelope.budget_status,
    source_failures: sourceFailures, conflicts: cloneValidatedJson(survivingConflicts),
    experimental: true, causal_claim: 'NONE',
  });
}

export function compareContextReplay(
  previousEnvelopeValue: unknown,
  currentPackage: TaskContextPackageV03 | undefined,
  sourceFailures: readonly ContextSourceFailureV03[] = [],
): ReplayResultV03 {
  const previous = assertValidContextEnvelope(previousEnvelopeValue);
  const current = currentPackage ? assertValidTaskContextPackage(currentPackage).envelope : undefined;
  const failures = validatedSourceFailures(sourceFailures);
  const previousIds = new Set(previous.items.map((item) => item.id));
  const currentIds = new Set(current?.items.map((item) => item.id) ?? []);
  const status = current === undefined ? 'UNREPLAYABLE' as const
    : current.selection_digest === previous.selection_digest ? 'IDENTICAL' as const : 'DRIFTED' as const;
  const withoutDigest = {
    schema_version: '0.3' as const, task_id: previous.task_id, status,
    old_selection_digest: previous.selection_digest,
    ...(current ? { new_selection_digest: current.selection_digest } : {}),
    old_snapshot: previous.snapshot, ...(current ? { new_snapshot: current.snapshot } : {}),
    added_candidate_ids: uniqueSorted([...currentIds].filter((id) => !previousIds.has(id))),
    removed_candidate_ids: uniqueSorted([...previousIds].filter((id) => !currentIds.has(id))),
    source_failures: failures,
    freshness: current === undefined ? 'UNAVAILABLE' as const
      : current.snapshot.worktree_digest === previous.snapshot.worktree_digest ? 'MATCHED' as const : 'CHANGED' as const,
  };
  const result: ReplayResultV03 = { ...withoutDigest, replay_digest: hashContextJson(withoutDigest) };
  const validation = validateReplayResult(result);
  if (!validation.valid) validationFailure('ReplayResult', validation.errors);
  return assertValidReplayResult(result);
}
