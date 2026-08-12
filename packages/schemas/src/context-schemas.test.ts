import assert from 'node:assert/strict';
import test from 'node:test';
import {
  contextCandidateSchema,
  contextEnvelopeSchema,
  contextPlanRequestSchema,
  outcomeDeclarationSchema,
  outcomeReceiptSchema,
  selectionReceiptSchema,
  validateContextCandidate,
  validateContextEnvelope,
  validateContextOutcomeInput,
  validateContextPlanRequest,
  validateOutcomeReceipt,
  validateSelectionReceipt,
} from './index.js';

const hash = (character: string): string => `sha256:${character.repeat(64)}`;

const request = {
  schema_version: '0.3',
  task: {
    task_id: 'CTX-001', task_type: 'module_feature', goal: 'Compile evidence', query: 'compiler receipt',
    acceptance_criteria: [{ id: 'AC-1', text: 'A receipt is emitted', required_terms: ['receipt'] }],
  },
  budget: { max_items: 4, max_bytes: 4096, max_estimated_tokens: 1024 },
  snapshot: { repository_id: 'primecontext', head: 'abc123', worktree_digest: hash('f') },
  policy_version: '0.3-default',
};

const candidate = {
  schema_version: '0.3', id: hash('a'), kind: 'code', provider: 'codegraph',
  path: 'packages/core/src/index.ts', symbol: 'compileContext', source_hash: hash('b'),
  excerpt_hash: hash('c'), snapshot: { repository_id: 'primecontext', head: 'abc123', worktree_digest: hash('f') },
  authority: 'source_code', authority_evidence: ['typescript-declaration'], freshness: 'live',
  observed_size_bytes: 128, excerpt: 'export function compileContext() {}', excerpt_bytes: 35, estimated_tokens: 9,
  discovery: { matched_terms: ['compiler', 'receipt'], criteria_ids: ['AC-1'], graph_distance: 0, truncated: false },
};

const outcome = {
  schema_version: '0.3', run_id: 'RUN-001', task_id: 'CTX-001', selection_digest: hash('d'),
  snapshot: request.snapshot,
  started_at: '2026-08-12T12:00:00.000Z', recorded_at: '2026-08-12T12:01:00.000Z',
  used_candidate_ids: [hash('a')], touched_paths: ['packages/core/src/index.ts'],
  test_status: 'PASS', review_status: 'PASS', completion_status: 'PASS', metrics: {}, source: 'human',
};

test('exports versioned v0.3 context compiler schemas', () => {
  assert.match(contextPlanRequestSchema.$id, /\/v0\.3\/context-plan-request\.schema\.json$/);
  assert.match(contextCandidateSchema.$id, /\/v0\.3\/context-candidate\.schema\.json$/);
  assert.match(contextEnvelopeSchema.$id, /\/v0\.3\/context-envelope\.schema\.json$/);
  assert.match(selectionReceiptSchema.$id, /\/v0\.3\/selection-receipt\.schema\.json$/);
});

test('accepts bounded plan requests and candidates', () => {
  assert.deepEqual(validateContextPlanRequest(request), { valid: true, errors: [] });
  assert.deepEqual(validateContextCandidate(candidate), { valid: true, errors: [] });
});

test('publishes UTF-8 byte ceilings on every v0.3 byte-bounded text field', () => {
  const taskProperties = contextPlanRequestSchema.properties.task.properties;
  const criterionProperties = taskProperties.acceptance_criteria.items.properties;

  assert.equal(taskProperties.goal['x-primecontext-max-utf8-bytes'], 4096);
  assert.equal(taskProperties.query['x-primecontext-max-utf8-bytes'], 4096);
  assert.equal(criterionProperties.text['x-primecontext-max-utf8-bytes'], 1024);
  assert.equal(outcomeDeclarationSchema.properties.notes['x-primecontext-max-utf8-bytes'], 4096);
  assert.equal(outcomeReceiptSchema.properties.notes['x-primecontext-max-utf8-bytes'], 4096);
});

test('enforces v0.3 text ceilings in UTF-8 bytes for multibyte input', () => {
  const twoByte = 'é';
  const at4096Bytes = twoByte.repeat(2048);
  const over4096Bytes = twoByte.repeat(2049);
  const at1024Bytes = twoByte.repeat(512);
  const over1024Bytes = twoByte.repeat(513);

  assert.equal(validateContextPlanRequest({
    ...request,
    task: { ...request.task, goal: at4096Bytes, query: at4096Bytes },
  }).valid, true);
  assert.equal(validateContextPlanRequest({
    ...request,
    task: { ...request.task, goal: over4096Bytes },
  }).valid, false);
  assert.equal(validateContextPlanRequest({
    ...request,
    task: { ...request.task, query: over4096Bytes },
  }).valid, false);
  assert.equal(validateContextPlanRequest({
    ...request,
    task: {
      ...request.task,
      acceptance_criteria: [{ ...request.task.acceptance_criteria[0], text: at1024Bytes }],
    },
  }).valid, true);
  assert.equal(validateContextPlanRequest({
    ...request,
    task: {
      ...request.task,
      acceptance_criteria: [{ ...request.task.acceptance_criteria[0], text: over1024Bytes }],
    },
  }).valid, false);

  assert.equal(validateContextOutcomeInput({ ...outcome, notes: at4096Bytes }).valid, true);
  assert.equal(validateContextOutcomeInput({ ...outcome, notes: over4096Bytes }).valid, false);
  assert.equal(validateOutcomeReceipt({
    ...outcome, notes: at4096Bytes, outcome_digest: hash('e'), causality: 'OBSERVATIONAL_ONLY',
  }).valid, true);
  assert.equal(validateOutcomeReceipt({
    ...outcome, notes: over4096Bytes, outcome_digest: hash('e'), causality: 'OBSERVATIONAL_ONLY',
  }).valid, false);
});

test('rejects unsafe or internally inconsistent compiler values', () => {
  assert.equal(validateContextPlanRequest({ ...request, budget: { ...request.budget, max_items: 0 } }).valid, false);
  assert.equal(validateContextPlanRequest({ ...request, extra: true }).valid, false);
  assert.equal(validateContextCandidate({ ...candidate, id: 'not-a-hash' }).valid, false);
  assert.equal(validateContextCandidate({ ...candidate, excerpt: 'x' }).valid, false);
  assert.equal(validateContextCandidate({ ...candidate, mandatory: true }).valid, false);
  assert.equal(validateContextCandidate({ ...candidate, provider_score: 100 }).valid, false);
});

test('enforces the ContextCandidate excerpt byte and source-line bounds', () => {
  const validateExcerpt = (excerpt: string) => validateContextCandidate({
    ...candidate,
    excerpt,
    excerpt_bytes: new TextEncoder().encode(excerpt).byteLength,
    estimated_tokens: Math.ceil(new TextEncoder().encode(excerpt).byteLength / 4),
  });

  assert.equal(validateExcerpt('x'.repeat(32 * 1024)).valid, true);
  assert.equal(validateExcerpt('x'.repeat((32 * 1024) + 1)).valid, false);
  assert.equal(validateExcerpt(Array.from({ length: 400 }, () => 'x').join('\n')).valid, true);
  assert.equal(validateExcerpt(Array.from({ length: 401 }, () => 'x').join('\n')).valid, false);
});

test('accepts a minimal deterministic envelope and receipt', () => {
  const envelope = {
    schema_version: '0.3', task_id: 'CTX-001', request_digest: hash('c'), selection_digest: hash('d'),
    policy_version: '0.3-default', snapshot: request.snapshot,
    evidence_status: 'READY', budget_status: 'WITHIN_BUDGET',
    budget: { ...request.budget, used_items: 1, used_bytes: 35, used_estimated_tokens: 9 },
    items: [{
      ...candidate, mandatory: false, score: 1300,
      score_components: { required_source: 0, applicable_policy: 0, hinted_path: 0, hinted_symbol: 0, required_terms: 120, query_terms: 160, graph_distance: 300, authority: 0, related_test: 0, live_freshness: 100 },
      selection_reason: 'INCLUDE_CRITERION_COVERAGE',
    }],
    criteria_coverage: [{
      criterion_id: 'AC-1', match_mode: 'ALL', required_terms: ['receipt'], status: 'COVERED',
      candidate_ids: [hash('a')], matched_terms: ['receipt'],
    }],
    missing_required_sources: [], missing_required_terms: [], conflicts: [], source_failures: [],
    truncation: { considered_candidates: 1, selected_candidates: 1, omitted_candidates: 0, source_truncated: false },
  };
  const receipt = {
    schema_version: '0.3', task_id: 'CTX-001', request_digest: hash('c'), selection_digest: hash('d'), receipt_digest: hash('e'),
    policy_version: '0.3-default',
    policy_components: { required_source: 10000, applicable_policy: 9000, hinted_path: 800, hinted_symbol: 700, required_terms: 120, query_terms: 80, graph_distance: 300, authority: 200, related_test: 100, live_freshness: 100 },
    decisions: [{ candidate_id: hash('a'), status: 'INCLUDED', reason: 'INCLUDE_CRITERION_COVERAGE', mandatory: false, score: 1300,
      score_components: { required_source: 0, applicable_policy: 0, hinted_path: 0, hinted_symbol: 0, required_terms: 120, query_terms: 160, graph_distance: 300, authority: 0, related_test: 0, live_freshness: 100 },
      marginal_criteria_ids: ['AC-1'], marginal_terms: ['receipt'] }],
    duplicate_groups: [], conflicts: [], source_failures: [],
    truncation: { considered_candidates: 1, selected_candidates: 1, omitted_candidates: 0, source_truncated: false },
  };
  assert.equal(validateContextEnvelope(envelope).valid, true);
  assert.equal(validateSelectionReceipt(receipt).valid, true);
});

test('rejects accessors and sparse arrays at the public validation boundary', () => {
  const malicious = { ...request } as Record<string, unknown>;
  Object.defineProperty(malicious, 'policy_version', { enumerable: true, get: () => '0.3-default' });
  assert.equal(validateContextPlanRequest(malicious).valid, false);

  const sparse = new Array(1);
  assert.equal(validateContextPlanRequest({ ...request, task: { ...request.task, acceptance_criteria: sparse } }).valid, false);
});

test('rejects hostile repository paths, unsorted sets, and adapter-controlled scoring fields', () => {
  for (const path of ['/absolute.ts', '../escape.ts', 'safe/../escape.ts', 'CON', 'safe/trailing.']) {
    assert.equal(validateContextCandidate({ ...candidate, path }).valid, false, path);
  }
  assert.equal(validateContextPlanRequest({
    ...request,
    task: { ...request.task, hints: { terms: ['zeta', 'alpha'] } },
  }).valid, false);
  assert.equal(validateContextCandidate({
    ...candidate,
    discovery: { ...candidate.discovery, matched_terms: ['receipt', 'compiler'] },
  }).valid, false);
  assert.equal(validateContextCandidate({ ...candidate, mandatory: true, score: 99 }).valid, false);
});
