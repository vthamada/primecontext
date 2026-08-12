import { createHash } from 'node:crypto';
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
  ExpansionDecisionV03,
  ExpansionRequestV03,
  OutcomeReceiptV03,
  ReplayResultV03,
  SelectedContextCandidateV03,
  SelectionReceiptV03,
  TaskContextPackageV03,
} from '@primecontext/schemas';
import { PrimeContextError } from './errors.js';
import { cloneValidatedJson } from './json.js';

const MAX_CANDIDATES = 2048;
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

function ordinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort(ordinal);
}

interface CanonicalState {
  ancestors: Set<object>;
  remaining: number;
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
    state.ancestors.add(value);
    const result: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
        throw new PrimeContextError('VALIDATION_ERROR', 'Canonical JSON arrays must be dense data arrays');
      }
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
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort(ordinal)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
        throw new PrimeContextError('VALIDATION_ERROR', 'Canonical JSON objects must contain data properties');
      }
      const item = descriptor.value;
      if (item !== undefined) output[key] = canonicalize(item, state, depth + 1);
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
  return value;
}

export function hashContextJson(value: unknown): string {
  const canonical = canonicalize(value, { ancestors: new Set(), remaining: 100_000 });
  return `sha256:${createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex')}`;
}

export function hashContextText(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

export function createContextCandidateId(candidate: Omit<ContextCandidateV03, 'id'> | ContextCandidateV03): string {
  return hashContextJson({
    provider: candidate.provider, path: candidate.path, line_start: candidate.line_start,
    line_end: candidate.line_end, symbol: candidate.symbol, source_hash: candidate.source_hash,
    excerpt_hash: candidate.excerpt_hash,
  });
}

function validationFailure(label: string, errors: readonly string[]): never {
  throw new PrimeContextError('VALIDATION_ERROR', `${label} failed validation`, errors.slice(0, 32));
}

function validatedSourceFailures(value: unknown): ContextSourceFailureV03[] {
  const validation = validateContextSourceFailures(value);
  if (!validation.valid) validationFailure('Context source failures', validation.errors);
  const failures = cloneValidatedJson(value as ContextSourceFailureV03[]);
  return failures.sort((left, right) => ordinal(left.provider, right.provider)
    || ordinal(left.code, right.code) || ordinal(left.message, right.message));
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
      || receipt.policy_version !== envelope.policy_version) {
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
  initialReason: ContextIncludeReasonV03;
}

function termsFromText(value: string): string[] {
  return uniqueSorted(value.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, 64);
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
  const mandatoryDifference = Number(right.mandatory) - Number(left.mandatory);
  if (mandatoryDifference !== 0) return mandatoryDifference;
  const retainedDifference = Number(right.retained) - Number(left.retained);
  if (retainedDifference !== 0) return retainedDifference;
  const authorityDifference = (AUTHORITY_RANK.get(left.candidate.authority) ?? 99) - (AUTHORITY_RANK.get(right.candidate.authority) ?? 99);
  if (authorityDifference !== 0) return authorityDifference;
  const locatorLengthLeft = `${left.candidate.path}:${left.candidate.line_start ?? ''}:${left.candidate.symbol ?? ''}`.length;
  const locatorLengthRight = `${right.candidate.path}:${right.candidate.line_start ?? ''}:${right.candidate.symbol ?? ''}`.length;
  return locatorLengthLeft - locatorLengthRight || candidateOrder(left, right);
}

function prepareCandidate(request: ContextPlanRequestV03, candidate: ContextCandidateV03, retained: boolean): PreparedCandidate {
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
  const policyRules = new Map<string, string>([
    ['AGENTS.md', 'convention:root-agents-file'],
    ['SECURITY.md', 'convention:root-security-file'],
    ['CODE_OF_CONDUCT.md', 'convention:root-code-of-conduct-file'],
  ]);
  const expectedPolicyEvidence = policyRules.get(candidate.path);
  const applicablePolicy = candidate.authority === 'policy'
    && (candidate.provider === 'filesystem' || candidate.provider === 'documents')
    && expectedPolicyEvidence !== undefined
    && candidate.authority_evidence.includes(expectedPolicyEvidence);
  const mandatory = requiredSource || applicablePolicy;
  const visibleTerms = new Set(termsFromText([
    candidate.path,
    candidate.symbol ?? '',
    candidate.excerpt,
  ].join(' ')));
  const adapterMatchedTerms = new Set(
    candidate.discovery.matched_terms.flatMap(termsFromText).filter((term) => visibleTerms.has(term)),
  );
  const queryTerms = termsFromText(request.task.query);
  const matchedQueryTerms = queryTerms.filter((term) => visibleTerms.has(term)).slice(0, 64);
  const hints = request.task.hints;
  const hintedPath = (hints?.paths ?? []).includes(candidate.path);
  const hintedSymbol = candidate.symbol !== undefined && (hints?.symbols ?? []).includes(candidate.symbol);
  const criterionTerms = new Map<string, Set<string>>();
  const allMatchedRequiredTerms = new Set<string>();
  for (const criterion of request.task.acceptance_criteria) {
    const requiredTerms = uniqueSorted((criterion.required_terms ?? [criterion.text]).flatMap(termsFromText));
    const matches = new Set(requiredTerms.filter((term) => visibleTerms.has(term)));
    if (matches.size > 0) criterionTerms.set(criterion.id, matches);
    matches.forEach((term) => allMatchedRequiredTerms.add(term));
  }
  candidate.discovery.matched_terms = uniqueSorted([
    ...adapterMatchedTerms,
    ...matchedQueryTerms,
    ...allMatchedRequiredTerms,
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
    authority: AUTHORITY_SCORES.get(candidate.authority) ?? 0,
    related_test: candidate.kind === 'test' && (hintedPath || hintedSymbol) ? 100 : 0,
    live_freshness: candidate.freshness === 'live' ? 100 : 0,
  };
  const score = Object.values(components).reduce((sum, value) => sum + value, 0);
  const initialReason: ContextIncludeReasonV03 = requiredSource
    ? 'INCLUDE_REQUIRED_SOURCE'
    : applicablePolicy ? 'INCLUDE_APPLICABLE_POLICY'
      : criterionTerms.size > 0 ? 'INCLUDE_CRITERION_COVERAGE' : 'INCLUDE_RELEVANCE';
  return { candidate, mandatory, retained, components, score, criterionTerms, matchedQueryTerms, initialReason };
}

function toSelected(prepared: PreparedCandidate, reason = prepared.initialReason): SelectedContextCandidateV03 {
  return { ...cloneValidatedJson(prepared.candidate), mandatory: prepared.mandatory, score: prepared.score, score_components: { ...prepared.components }, selection_reason: reason };
}

function fitReason(candidate: ContextCandidateV03, selected: readonly PreparedCandidate[], budget: ContextPlanRequestV03['budget']): ContextDecisionReasonV03 | undefined {
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

function marginalCoverage(candidate: PreparedCandidate, covered: ReadonlySet<string>): string[] {
  return coverageKeys(candidate).filter((key) => !covered.has(key));
}

function conflictGroups(candidates: readonly PreparedCandidate[]): ContextConflictV03[] {
  const byKey = new Map<string, PreparedCandidate[]>();
  const conflictAuthorities = new Set(['policy', 'adr', 'specification', 'contract_schema', 'roadmap', 'implementation_note']);
  for (const candidate of candidates) {
    if (!conflictAuthorities.has(candidate.candidate.authority)) continue;
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
      reason: 'AUTHORITATIVE_SOURCES_DISAGREE' as const,
    }))
    .sort((left, right) => ordinal(left.conflict_key, right.conflict_key));
}

function compileContextInternal(
  requestValue: unknown,
  candidateValues: readonly unknown[],
  sourceFailures: readonly ContextSourceFailureV03[] = [],
  retainedCandidateIds: ReadonlySet<string> = new Set(),
): TaskContextPackageV03 {
  const request = assertValidContextPlanRequest(requestValue);
  const candidateInputs = validatedCandidateInputArray(candidateValues);
  const failures = validatedSourceFailures(sourceFailures);
  if (failures.some((failure) => failure.security_control)) {
    throw new PrimeContextError('SECURITY_ERROR', 'A candidate-source security control failed closed');
  }
  const candidates = candidateInputs.map(assertValidContextCandidate);
  const ids = candidates.map((candidate) => candidate.id);
  if (new Set(ids).size !== ids.length) throw new PrimeContextError('VALIDATION_ERROR', 'A duplicate candidate id was supplied');
  let prepared = candidates.map((candidate) => prepareCandidate(request, candidate, retainedCandidateIds.has(candidate.id)));
  const duplicateGroups: SelectionReceiptV03['duplicate_groups'] = [];
  const duplicateDecisions: ContextSelectionDecisionV03[] = [];
  const byContent = new Map<string, PreparedCandidate[]>();
  for (const item of prepared) {
    const key = `${item.candidate.source_hash}:${item.candidate.excerpt_hash}`;
    const group = byContent.get(key) ?? [];
    group.push(item);
    byContent.set(key, group);
  }
  prepared = [];
  const normalizedDuplicateGroups = [...byContent.values()].map((group) => {
    const sorted = [...group].sort(duplicateOrder);
    return { representative: sorted[0] as PreparedCandidate, duplicates: sorted.slice(1) };
  }).sort((left, right) => candidateOrder(left.representative, right.representative));
  for (const { representative, duplicates } of normalizedDuplicateGroups) {
    prepared.push(representative);
    if (duplicates.length > 0) {
      duplicateGroups.push({ representative_id: representative.candidate.id, duplicate_ids: duplicates.map((item) => item.candidate.id).sort(ordinal) });
      for (const duplicate of duplicates) {
        duplicateDecisions.push({
          candidate_id: duplicate.candidate.id, status: 'OMITTED', reason: 'OMIT_DUPLICATE_CONTENT',
          mandatory: false, score: duplicate.score, score_components: duplicate.components,
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
    const reason = fitReason(item.candidate, selected, request.budget);
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
    const reason = fitReason(item.candidate, selected, request.budget);
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
  while (remaining.length > 0) {
    remaining.sort((left, right) => {
      const marginalDifference = marginalCoverage(right, covered).length - marginalCoverage(left, covered).length;
      return marginalDifference || right.score - left.score || candidateOrder(left, right);
    });
    const item = remaining.shift() as PreparedCandidate;
    const marginal = marginalCoverage(item, covered);
    const reason = fitReason(item.candidate, selected, request.budget);
    if (reason) {
      const marginalCriteria = uniqueSorted(marginal.map((key) => key.slice(0, key.indexOf(':'))));
      decisions.set(item.candidate.id, {
        candidate_id: item.candidate.id, status: 'OMITTED', reason, mandatory: false,
        score: item.score, score_components: item.components, marginal_criteria_ids: marginalCriteria,
        marginal_terms: uniqueSorted(marginal.map((key) => key.slice(key.indexOf(':') + 1))),
      });
      continue;
    }
    if (item.score === 0 && marginal.length === 0) {
      decisions.set(item.candidate.id, {
        candidate_id: item.candidate.id, status: 'OMITTED', reason: 'OMIT_NO_MATCH', mandatory: false,
        score: item.score, score_components: item.components, marginal_criteria_ids: [], marginal_terms: [],
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
      marginal_terms: uniqueSorted(marginal.map((key) => key.slice(key.indexOf(':') + 1))),
    });
  }
  for (const conflictId of conflictIds) {
    const decision = decisions.get(conflictId);
    if (decision?.status === 'OMITTED' && !decision.reason.startsWith('OMIT_BUDGET')) decision.reason = 'OMIT_CONFLICT_REVIEW';
  }
  const selectedItems = selected.map((item) => {
    const decision = decisions.get(item.candidate.id);
    if (!decision || decision.status !== 'INCLUDED') {
      throw new PrimeContextError('STATE_ERROR', 'Selected context candidate is missing its receipt decision');
    }
    return toSelected(item, decision.reason as ContextIncludeReasonV03);
  });
  const coverage = request.task.acceptance_criteria.map((criterion) => {
    const matching = selected.filter((item) => item.criterionTerms.has(criterion.id));
    const candidateIds = uniqueSorted(matching.map((item) => item.candidate.id));
    const conflicted = conflicts.some((conflict) => conflict.criterion_ids.includes(criterion.id));
    const matchedTerms = uniqueSorted(matching.flatMap((item) => [...(item.criterionTerms.get(criterion.id) ?? [])]));
    const matchMode = criterion.required_terms === undefined ? 'ANY' as const : 'ALL' as const;
    const requiredTerms = uniqueSorted((criterion.required_terms ?? [criterion.text]).flatMap(termsFromText));
    const hasRequiredCoverage = requiredTerms.length === 0
      ? candidateIds.length > 0
      : matchMode === 'ALL'
        ? requiredTerms.every((term) => matchedTerms.includes(term))
        : matchedTerms.length > 0;
    return {
      criterion_id: criterion.id,
      match_mode: matchMode,
      required_terms: requiredTerms,
      status: conflicted ? 'CONFLICTED' as const : hasRequiredCoverage ? 'COVERED' as const : 'MISSING' as const,
      candidate_ids: candidateIds,
      matched_terms: matchedTerms,
    };
  });
  const selectedPaths = new Set(selected.map((item) => item.candidate.path));
  const missingRequiredSources = uniqueSorted((request.required_sources ?? []).filter((path) => !selectedPaths.has(path)));
  const missingRequiredTerms = uniqueSorted(coverage.flatMap((criterion) => (
    criterion.match_mode === 'ALL'
      ? criterion.required_terms.filter((term) => !criterion.matched_terms.includes(term))
      : []
  )));
  const omittedCount = candidates.length - selected.length;
  const truncation = {
    considered_candidates: candidates.length, selected_candidates: selected.length, omitted_candidates: omittedCount,
    source_truncated: candidates.some((candidate) => candidate.discovery.truncated),
  };
  const hasBudgetOmission = [...decisions.values()].some((decision) => decision.reason.startsWith('OMIT_BUDGET'));
  const evidenceStatus = conflicts.length > 0
    ? 'CONFLICT' as const
    : mandatoryExhausted || coverage.some((item) => item.status !== 'COVERED') || missingRequiredSources.length > 0 || missingRequiredTerms.length > 0
      ? 'INSUFFICIENT_EVIDENCE' as const : 'READY' as const;
  const budgetStatus = mandatoryExhausted ? 'EXHAUSTED' as const : hasBudgetOmission || truncation.source_truncated ? 'TRUNCATED' as const : 'WITHIN_BUDGET' as const;
  const requestDigest = hashContextJson(request);
  const envelopeWithoutDigest = {
    schema_version: '0.3' as const, task_id: request.task.task_id, request_digest: requestDigest,
    policy_version: request.policy_version, snapshot: request.snapshot,
    ...(request.capsule_digest ? { capsule_digest: request.capsule_digest } : {}),
    evidence_status: evidenceStatus, budget_status: budgetStatus,
    budget: {
      ...request.budget, used_items: selected.length,
      used_bytes: selected.reduce((sum, item) => sum + item.candidate.excerpt_bytes, 0),
      used_estimated_tokens: selected.reduce((sum, item) => sum + item.candidate.estimated_tokens, 0),
    },
    items: selectedItems, criteria_coverage: coverage, missing_required_sources: missingRequiredSources,
    missing_required_terms: missingRequiredTerms, conflicts: cloneValidatedJson(conflicts),
    source_failures: cloneValidatedJson(failures), truncation: { ...truncation },
  };
  const selectionDigest = hashContextJson(envelopeWithoutDigest);
  const envelope: ContextEnvelopeV03 = { ...envelopeWithoutDigest, selection_digest: selectionDigest };
  const allDecisions = [...decisions.values(), ...duplicateDecisions].sort((left, right) => ordinal(left.candidate_id, right.candidate_id));
  const receiptWithoutDigest = {
    schema_version: '0.3' as const, task_id: request.task.task_id, request_digest: requestDigest,
    selection_digest: selectionDigest, policy_version: request.policy_version,
    policy_components: { ...POLICY_COMPONENTS }, decisions: cloneValidatedJson(allDecisions),
    duplicate_groups: cloneValidatedJson(duplicateGroups), conflicts: cloneValidatedJson(conflicts),
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
  const validatedPreviousPackage = assertValidTaskContextPackage(previousPackage);
  const previous = validatedPreviousPackage.envelope;
  if (expansion.task_id !== previous.task_id) {
    throw new PrimeContextError('STATE_ERROR', 'Expansion request does not link the prior task');
  }
  if (expansion.previous_selection_digest !== previous.selection_digest) {
    return staleExpansionResult(validatedPreviousPackage, expansion);
  }
  if (hashContextJson(request) !== previous.request_digest) {
    return staleExpansionResult(validatedPreviousPackage, expansion);
  }
  const known = new Set(expansion.known_candidate_ids);
  if (previous.items.some((item) => !known.has(item.id))) {
    return staleExpansionResult(validatedPreviousPackage, expansion);
  }
  const operationBudget = {
    max_items: Math.min(request.budget.max_items, previous.budget.used_items + Math.min(expansion.additional_budget.max_items, 64)),
    max_bytes: Math.min(request.budget.max_bytes, previous.budget.used_bytes + expansion.additional_budget.max_bytes),
    max_estimated_tokens: Math.min(request.budget.max_estimated_tokens, previous.budget.used_estimated_tokens + expansion.additional_budget.max_estimated_tokens),
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
  const next = compileContextInternal({ ...request, budget: operationBudget }, combinedCandidates, sourceFailures, previousIds);
  next.envelope.budget.max_items = previous.budget.max_items;
  next.envelope.budget.max_bytes = previous.budget.max_bytes;
  next.envelope.budget.max_estimated_tokens = previous.budget.max_estimated_tokens;
  if (next.envelope.request_digest !== previous.request_digest) {
    next.envelope.request_digest = previous.request_digest;
    const { selection_digest: _oldSelectionDigest, ...envelopeWithoutDigest } = next.envelope;
    next.envelope.selection_digest = hashContextJson(envelopeWithoutDigest);
    next.receipt.request_digest = previous.request_digest;
    next.receipt.selection_digest = next.envelope.selection_digest;
    const { receipt_digest: _oldReceiptDigest, ...receiptWithoutDigest } = next.receipt;
    next.receipt.receipt_digest = hashContextJson(receiptWithoutDigest);
  }
  const additions = next.envelope.items.map((item) => item.id).filter((id) => !previousIds.has(id)).slice(0, 64).sort(ordinal);
  const remaining = remainingEvidence(next.envelope);
  const hardLimitReached = next.envelope.budget_status !== 'WITHIN_BUDGET';
  const duplicateIds = new Set(next.receipt.duplicate_groups.flatMap((group) => group.duplicate_ids));
  const duplicateOnly = additions.length === 0 && providedCandidates.length > 0
    && providedCandidates.every((candidate) => previousIds.has(candidate.id) || duplicateIds.has(candidate.id));
  if (duplicateOnly) {
    const decision: ExpansionDecisionV03 = {
      schema_version: '0.3', task_id: expansion.task_id,
      previous_selection_digest: previous.selection_digest, selection_digest: previous.selection_digest,
      status: 'DENIED', reason_codes: ['DUPLICATE_ONLY'], additions: [],
      cumulative_budget: { ...previous.budget }, remaining_missing_evidence: remainingEvidence(previous),
      snapshot: { ...previous.snapshot },
    };
    assertValidExpansionDecision(decision);
    return { package: validatedPreviousPackage, decision };
  }
  if (additions.length === 0) {
    const decision: ExpansionDecisionV03 = {
      schema_version: '0.3', task_id: expansion.task_id,
      previous_selection_digest: previous.selection_digest, selection_digest: previous.selection_digest,
      status: 'DENIED', reason_codes: hardLimitReached ? ['HARD_LIMIT_REACHED'] : ['NO_NEW_EVIDENCE'],
      additions: [], cumulative_budget: { ...previous.budget },
      remaining_missing_evidence: remainingEvidence(previous), snapshot: { ...previous.snapshot },
    };
    assertValidExpansionDecision(decision);
    return { package: validatedPreviousPackage, decision };
  }
  const decision: ExpansionDecisionV03 = {
    schema_version: '0.3', task_id: expansion.task_id, previous_selection_digest: previous.selection_digest,
    selection_digest: next.envelope.selection_digest,
    status: additions.length === 0 ? 'DENIED' : remaining.length > 0 || hardLimitReached ? 'PARTIAL' : 'ALLOWED',
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
  const item = envelope.items.find((candidate) => candidate.id === request.candidate_id);
  if (!item) {
    return assertValidAblationResult({
      schema_version: '0.3', task_id: request.task_id, parent_selection_digest: envelope.selection_digest,
      removed_candidate_id: request.candidate_id, decision: 'DENIED', reason: 'CANDIDATE_NOT_SELECTED',
      evidence_status: envelope.evidence_status, missing_criteria_ids: [], missing_required_terms: [],
      experimental: true, causal_claim: 'NONE',
    });
  }
  if (item.mandatory) {
    return assertValidAblationResult({
      schema_version: '0.3', task_id: request.task_id, parent_selection_digest: envelope.selection_digest,
      removed_candidate_id: request.candidate_id, decision: 'DENIED', reason: 'MANDATORY_CANDIDATE',
      evidence_status: envelope.evidence_status, missing_criteria_ids: [], missing_required_terms: [],
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
        : survivingTerms.length > 0;
    return { criterion, covered, survivingTerms };
  });
  const missingCriteria = ablatedCoverage.filter(({ covered }) => !covered)
    .map(({ criterion }) => criterion.criterion_id).sort(ordinal);
  const missingTerms = uniqueSorted(ablatedCoverage.flatMap(({ criterion, survivingTerms }) => (
    criterion.match_mode === 'ALL'
      ? criterion.required_terms.filter((term) => !survivingTerms.includes(term))
      : []
  )));
  const ablatedDigest = hashContextJson({ parent_selection_digest: envelope.selection_digest, removed_candidate_id: item.id, remaining_candidate_ids: remaining.map((candidate) => candidate.id) });
  const survivingConflict = envelope.conflicts.some((conflict) => (
    !conflict.candidate_ids.includes(item.id)
      || (() => {
        const remainingConflictIds = conflict.candidate_ids.filter((candidateId) => candidateId !== item.id);
        if (remainingConflictIds.length < 2) return false;
        const remainingConflictItems = remainingConflictIds.map((candidateId) => remainingById.get(candidateId));
        if (remainingConflictItems.some((candidate) => candidate === undefined)) return true;
        return new Set(remainingConflictItems.map((candidate) => candidate?.source_hash)).size > 1;
      })()
  ));
  return assertValidAblationResult({
    schema_version: '0.3', task_id: request.task_id, parent_selection_digest: envelope.selection_digest,
    ablated_selection_digest: ablatedDigest, removed_candidate_id: item.id, decision: 'DERIVED',
    reason: 'NON_MANDATORY_REMOVED',
    evidence_status: missingCriteria.length > 0 || missingTerms.length > 0
      ? 'INSUFFICIENT_EVIDENCE'
      : survivingConflict ? 'CONFLICT' : envelope.evidence_status === 'CONFLICT' ? 'READY' : envelope.evidence_status,
    missing_criteria_ids: missingCriteria, missing_required_terms: missingTerms, experimental: true, causal_claim: 'NONE',
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
