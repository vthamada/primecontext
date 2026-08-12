import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ablateContext,
  assertValidContextEnvelope,
  assertValidTaskContextPackage,
  compareContextReplay,
  compileContext,
  createContextCandidateId,
  expandContext,
  hashContextText,
  hashContextJson,
  recordContextOutcome,
  type ContextCandidateV03,
  type ContextPlanRequestV03,
} from './index.js';

const hash = (character: string): string => `sha256:${character.repeat(64)}`;

const request: ContextPlanRequestV03 = {
  schema_version: '0.3',
  task: {
    task_id: 'CTX-001', task_type: 'module_feature', goal: 'Compile proof carrying context',
    query: 'compiler receipt security',
    acceptance_criteria: [
      { id: 'AC-1', text: 'Compiler returns a receipt', required_terms: ['receipt'] },
      { id: 'AC-2', text: 'Security policy is represented', required_terms: ['security'] },
    ],
    hints: { paths: ['packages/core'], symbols: ['compileContext'], terms: ['deterministic'] },
  },
  budget: { max_items: 2, max_bytes: 800, max_estimated_tokens: 200 },
  snapshot: { repository_id: 'primecontext', head: 'abc123', worktree_digest: hash('f') },
  policy_version: '0.3-default',
};

function candidate(
  id: string,
  path: string,
  criteria: string[],
  terms: string[],
  options: Partial<ContextCandidateV03> = {},
): ContextCandidateV03 {
  const result: ContextCandidateV03 = {
    schema_version: '0.3', id: hash(id), kind: 'code', provider: 'codegraph', path,
    source_hash: hash(id), excerpt_hash: hashContextText(`evidence ${terms.join(' ')}`),
    snapshot: { repository_id: 'primecontext', head: 'abc123', worktree_digest: hash('f') },
    authority: 'source_code', authority_evidence: ['typescript-source'], freshness: 'live',
    observed_size_bytes: 100, excerpt: `evidence ${terms.join(' ')}`,
    excerpt_bytes: new TextEncoder().encode(`evidence ${terms.join(' ')}`).byteLength,
    estimated_tokens: Math.ceil(new TextEncoder().encode(`evidence ${terms.join(' ')}`).byteLength / 4),
    discovery: { matched_terms: [...terms].sort(), criteria_ids: [...criteria].sort(), truncated: false },
    ...options,
  };
  result.id = createContextCandidateId(result);
  return result;
}

test('compiles deterministic proof-carrying context independent of candidate order', () => {
  const compiler = candidate('a', 'packages/core/src/compiler.ts', ['AC-1'], ['compiler', 'receipt']);
  const security = candidate('b', 'SECURITY.md', ['AC-2'], ['security'], {
    kind: 'document', provider: 'filesystem', authority: 'policy', authority_evidence: ['convention:root-security-file'],
  });
  const noise = candidate('c', 'notes.md', [], ['compiler'], { kind: 'document', authority: 'implementation_note' });

  const first = compileContext(request, [noise, security, compiler]);
  const second = compileContext(request, [compiler, noise, security]);

  assert.deepEqual(first, second);
  assert.equal(first.envelope.evidence_status, 'READY');
  assert.equal(first.envelope.budget_status, 'TRUNCATED');
  assert.deepEqual(first.envelope.items.map((item) => item.id), [security.id, compiler.id]);
  assert.deepEqual(first.envelope.criteria_coverage.filter((item) => item.status === 'MISSING'), []);
  assert.equal(first.receipt.decisions.find((item) => item.candidate_id === noise.id)?.status, 'OMITTED');
  assert.match(first.envelope.selection_digest, /^sha256:[0-9a-f]{64}$/);
  assert.match(first.receipt.receipt_digest, /^sha256:[0-9a-f]{64}$/);
});

test('uses ordinal candidate id as the final tie-break and never exceeds a hard budget', () => {
  const left = candidate('a', 'same.ts', ['AC-1'], ['receipt', 'alpha'], { source_hash: hash('c') });
  const right = candidate('b', 'same.ts', ['AC-1'], ['receipt', 'bravo'], { source_hash: hash('c') });
  const bounded = { ...request, budget: { max_items: 1, max_bytes: 100, max_estimated_tokens: 25 } };
  const result = compileContext(bounded, [right, left]);
  assert.equal(result.envelope.items[0]?.id, [left.id, right.id].sort()[0]);
  assert.equal(result.envelope.budget.used_items, 1);
  assert.equal(result.envelope.evidence_status, 'INSUFFICIENT_EVIDENCE');
});

test('reports authority conflicts instead of silently resolving them', () => {
  const a = candidate('a', 'docs/spec-a.md', ['AC-1'], ['receipt'], {
    kind: 'document', authority: 'specification', authority_evidence: ['docs-specification'], symbol: 'compileContext',
  });
  const b = candidate('b', 'docs/spec-b.md', ['AC-1'], ['receipt'], {
    kind: 'document', authority: 'specification', authority_evidence: ['docs-specification'], symbol: 'compileContext',
  });
  const result = compileContext(request, [a, b]);
  assert.equal(result.envelope.evidence_status, 'CONFLICT');
  assert.deepEqual(result.envelope.conflicts[0]?.candidate_ids, [a.id, b.id].sort());
});

test('reports thematic authority conflicts across distinct documents without symbols', () => {
  const a = candidate('a', 'docs/spec-a.md', ['FORGED'], ['receipt', 'alpha'], {
    kind: 'document', provider: 'documents', authority: 'specification', authority_evidence: ['docs-specification'],
  });
  const b = candidate('b', 'docs/spec-b.md', [], ['receipt', 'bravo'], {
    kind: 'document', provider: 'documents', authority: 'specification', authority_evidence: ['docs-specification'],
  });
  a.discovery.matched_terms = [];
  a.discovery.criteria_ids = [];
  b.discovery.matched_terms = [];
  b.discovery.criteria_ids = [];
  const result = compileContext(request, [a, b]);

  assert.equal(result.envelope.evidence_status, 'CONFLICT');
  assert.deepEqual(result.envelope.conflicts, [{
    conflict_key: `conflict-${hashContextText('topic:criterion:AC-1').slice('sha256:'.length)}`,
    candidate_ids: [a.id, b.id].sort(),
    criterion_ids: ['AC-1'],
    reason: 'AUTHORITATIVE_SOURCES_DISAGREE',
  }]);
  assert.equal(result.envelope.criteria_coverage.find((criterion) => criterion.criterion_id === 'AC-1')?.status, 'CONFLICTED');
  assert.ok(result.envelope.items.every((item) => item.discovery.matched_terms.includes('receipt')));
});

test('fails closed on duplicate candidate ids and snapshot mismatches', () => {
  const a = candidate('a', 'a.ts', ['AC-1'], ['receipt']);
  assert.throws(() => compileContext(request, [a, a]), /duplicate candidate/i);
  const stale = candidate('b', 'b.ts', ['AC-2'], ['security']);
  stale.snapshot.worktree_digest = hash('e');
  assert.throws(() => compileContext(request, [stale]), /snapshot/i);
});

test('expands only from the linked digest and records the decision', () => {
  const compiler = candidate('a', 'compiler.ts', ['AC-1'], ['receipt']);
  const security = candidate('b', 'SECURITY.md', ['AC-2'], ['security'], {
    kind: 'document', provider: 'filesystem', authority: 'policy', authority_evidence: ['convention:root-security-file'],
  });
  const initial = compileContext(request, [compiler]);
  const expansion = expandContext(initial, request, {
    schema_version: '0.3', task_id: 'CTX-001', previous_selection_digest: initial.envelope.selection_digest,
    known_candidate_ids: initial.envelope.items.map((item) => item.id), reason: 'MISSING_CRITERION',
    requested_paths: ['SECURITY.md'], requested_symbols: [], requested_terms: ['security'],
    additional_budget: { max_items: 1, max_bytes: 100, max_estimated_tokens: 25 },
  }, [security]);
  assert.equal(expansion.decision.status, 'ALLOWED');
  assert.deepEqual(expansion.decision.additions, [security.id]);
  assert.equal(expansion.package.envelope.evidence_status, 'READY');
  const stale = expandContext(initial, request, {
    schema_version: '0.3', task_id: 'CTX-001', previous_selection_digest: hash('d'),
    known_candidate_ids: [], reason: 'MISSING_CRITERION', requested_paths: [], requested_symbols: [], requested_terms: [],
    additional_budget: { max_items: 1, max_bytes: 100, max_estimated_tokens: 25 },
  }, [security]);
  assert.equal(stale.decision.status, 'DENIED');
  assert.deepEqual(stale.decision.reason_codes, ['STALE_PARENT']);
  assert.equal(stale.decision.previous_selection_digest, hash('d'));
  assert.equal(stale.decision.selection_digest, initial.envelope.selection_digest);
  assert.deepEqual(stale.package, initial);
});

test('reports duplicate-only expansions without consuming context budget', () => {
  const compiler = candidate('a', 'compiler.ts', ['AC-1'], ['receipt']);
  const initial = compileContext(request, [compiler]);
  const duplicate = candidate('b', 'duplicate.ts', ['AC-1'], ['receipt'], {
    source_hash: compiler.source_hash,
  });
  const result = expandContext(initial, request, {
    schema_version: '0.3', task_id: 'CTX-001', previous_selection_digest: initial.envelope.selection_digest,
    known_candidate_ids: initial.envelope.items.map((item) => item.id), reason: 'MISSING_CRITERION',
    requested_paths: ['duplicate.ts'], requested_symbols: [], requested_terms: ['receipt'],
    additional_budget: { max_items: 1, max_bytes: 100, max_estimated_tokens: 25 },
  }, [duplicate]);
  assert.equal(result.decision.status, 'DENIED');
  assert.deepEqual(result.decision.reason_codes, ['DUPLICATE_ONLY']);
  assert.deepEqual(result.decision.additions, []);
  assert.equal(result.package.envelope.selection_digest, initial.envelope.selection_digest);
  assert.deepEqual(result.package.envelope.budget, initial.envelope.budget);
});

test('records non-causal outcomes and produces experimental ablations', () => {
  const compiler = candidate('a', 'compiler.ts', ['AC-1'], ['receipt']);
  const security = candidate('b', 'SECURITY.md', ['AC-2'], ['security'], {
    kind: 'document', provider: 'filesystem', authority: 'policy', authority_evidence: ['convention:root-security-file'],
  });
  const compiled = compileContext(request, [compiler, security]);
  const outcome = recordContextOutcome({
    schema_version: '0.3', run_id: 'RUN-1', task_id: 'CTX-001', selection_digest: compiled.envelope.selection_digest,
    snapshot: request.snapshot, started_at: '2026-08-12T11:59:00.000Z', recorded_at: '2026-08-12T12:00:00.000Z',
    used_candidate_ids: [compiler.id], touched_paths: ['packages/core/src/compiler.ts'],
    test_status: 'PASS', review_status: 'NOT_RUN', completion_status: 'PASS', source: 'tool',
    metrics: { duration_ms: 100, input_tokens: 200, output_tokens: 50 },
  });
  assert.equal(outcome.causality, 'OBSERVATIONAL_ONLY');
  assert.match(outcome.outcome_digest, /^sha256:/);

  const ablation = ablateContext(compiled.envelope, {
    schema_version: '0.3', task_id: 'CTX-001', selection_digest: compiled.envelope.selection_digest,
    candidate_id: security.id,
  });
  assert.equal(ablation.experimental, true);
  assert.equal(ablation.causal_claim, 'NONE');
  assert.equal(ablation.evidence_status, 'READY');
  assert.equal(ablation.decision, 'DENIED');
  assert.equal(ablation.reason, 'MANDATORY_CANDIDATE');
});

test('ablation recomputes multi-source criterion term coverage', () => {
  const splitRequest: ContextPlanRequestV03 = {
    ...request,
    task: { ...request.task, acceptance_criteria: [{ id: 'AC-1', text: 'Both terms', required_terms: ['alpha', 'beta'] }] },
  };
  const alpha = candidate('a', 'alpha.ts', ['AC-1'], ['alpha']);
  const beta = candidate('b', 'beta.ts', ['AC-1'], ['beta']);
  const compiled = compileContext(splitRequest, [alpha, beta]);
  assert.equal(compiled.envelope.evidence_status, 'READY');
  assert.equal(compiled.envelope.criteria_coverage[0]?.match_mode, 'ALL');
  assert.deepEqual(compiled.envelope.criteria_coverage[0]?.required_terms, ['alpha', 'beta']);
  const ablation = ablateContext(compiled.envelope, {
    schema_version: '0.3', task_id: splitRequest.task.task_id,
    selection_digest: compiled.envelope.selection_digest, candidate_id: alpha.id,
  });
  assert.deepEqual(ablation.missing_criteria_ids, ['AC-1']);
  assert.deepEqual(ablation.missing_required_terms, ['alpha']);
  assert.equal(ablation.evidence_status, 'INSUFFICIENT_EVIDENCE');
});

test('ablation preserves implicit criterion coverage when any canonical text term survives', () => {
  const anyRequest: ContextPlanRequestV03 = {
    ...request,
    task: { ...request.task, acceptance_criteria: [{ id: 'AC-1', text: 'alpha beta' }] },
  };
  const alpha = candidate('a', 'alpha.ts', ['AC-1'], ['alpha']);
  const beta = candidate('b', 'beta.ts', ['AC-1'], ['beta']);
  const compiled = compileContext(anyRequest, [alpha, beta]);
  assert.equal(compiled.envelope.criteria_coverage[0]?.match_mode, 'ANY');
  assert.deepEqual(compiled.envelope.criteria_coverage[0]?.required_terms, ['alpha', 'beta']);

  const ablation = ablateContext(compiled.envelope, {
    schema_version: '0.3', task_id: anyRequest.task.task_id,
    selection_digest: compiled.envelope.selection_digest, candidate_id: alpha.id,
  });
  assert.deepEqual(ablation.missing_criteria_ids, []);
  assert.deepEqual(ablation.missing_required_terms, []);
  assert.equal(ablation.evidence_status, 'READY');
});

test('ablation clears a three-source conflict when the only divergent hash is removed', () => {
  const conflictRequest: ContextPlanRequestV03 = {
    ...request,
    task: { ...request.task, acceptance_criteria: [{ id: 'AC-1', text: 'receipt', required_terms: ['receipt'] }] },
    budget: { max_items: 3, max_bytes: 800, max_estimated_tokens: 200 },
  };
  const left = candidate('a', 'docs/left.md', ['AC-1'], ['receipt', 'left'], {
    kind: 'document', provider: 'documents', authority: 'specification', authority_evidence: ['docs-specification'],
    symbol: 'compileContext', source_hash: hash('a'),
  });
  const right = candidate('b', 'docs/right.md', ['AC-1'], ['receipt', 'right'], {
    kind: 'document', provider: 'documents', authority: 'specification', authority_evidence: ['docs-specification'],
    symbol: 'compileContext', source_hash: hash('a'),
  });
  const divergent = candidate('c', 'docs/divergent.md', ['AC-1'], ['receipt', 'divergent'], {
    kind: 'document', provider: 'documents', authority: 'specification', authority_evidence: ['docs-specification'],
    symbol: 'compileContext', source_hash: hash('b'),
  });
  const compiled = compileContext(conflictRequest, [divergent, right, left]);
  assert.equal(compiled.envelope.evidence_status, 'CONFLICT');
  assert.equal(compiled.envelope.items.length, 3);

  const ablation = ablateContext(compiled.envelope, {
    schema_version: '0.3', task_id: conflictRequest.task.task_id,
    selection_digest: compiled.envelope.selection_digest, candidate_id: divergent.id,
  });
  assert.equal(ablation.evidence_status, 'READY');
});

test('ablation never clears an unrelated authority conflict', () => {
  const conflictRequest: ContextPlanRequestV03 = {
    ...request,
    task: { ...request.task, acceptance_criteria: [{ id: 'AC-1', text: 'receipt', required_terms: ['receipt'] }] },
    budget: { max_items: 4, max_bytes: 800, max_estimated_tokens: 200 },
  };
  const removable = candidate('a', 'src/removable.ts', ['AC-1'], ['receipt']);
  const first = candidate('b', 'docs/first.md', ['AC-1'], ['receipt', 'first'], {
    kind: 'document', provider: 'documents', authority: 'specification', authority_evidence: ['docs-specification'],
    symbol: 'unrelatedTopic', source_hash: hash('b'),
  });
  const second = candidate('c', 'docs/second.md', ['AC-1'], ['receipt', 'second'], {
    kind: 'document', provider: 'documents', authority: 'specification', authority_evidence: ['docs-specification'],
    symbol: 'unrelatedTopic', source_hash: hash('c'),
  });
  const compiled = compileContext(conflictRequest, [removable, first, second]);
  assert.equal(compiled.envelope.evidence_status, 'CONFLICT');

  const ablation = ablateContext(compiled.envelope, {
    schema_version: '0.3', task_id: conflictRequest.task.task_id,
    selection_digest: compiled.envelope.selection_digest, candidate_id: removable.id,
  });
  assert.equal(ablation.evidence_status, 'CONFLICT');
});

test('compares replay identity and drift without substituting stale evidence', () => {
  const original = compileContext(request, [
    candidate('a', 'compiler.ts', ['AC-1'], ['receipt']),
    candidate('b', 'SECURITY.md', ['AC-2'], ['security'], {
      kind: 'document', provider: 'filesystem', authority: 'policy', authority_evidence: ['convention:root-security-file'],
    }),
  ]);
  const identical = compareContextReplay(original.envelope, original);
  assert.equal(identical.status, 'IDENTICAL');
  assert.equal(identical.freshness, 'MATCHED');

  const changedRequest = { ...request, snapshot: { ...request.snapshot, worktree_digest: hash('e') } };
  const changed = compileContext(changedRequest, [
    candidate('c', 'compiler.ts', ['AC-1'], ['receipt'], { snapshot: changedRequest.snapshot }),
    candidate('d', 'SECURITY.md', ['AC-2'], ['security'], {
      kind: 'document', provider: 'filesystem', authority: 'policy', authority_evidence: ['convention:root-security-file'],
      snapshot: changedRequest.snapshot,
    }),
  ]);
  const drifted = compareContextReplay(original.envelope, changed);
  assert.equal(drifted.status, 'DRIFTED');
  assert.equal(drifted.freshness, 'CHANGED');
  assert.ok(drifted.added_candidate_ids.length > 0);

  const unavailable = compareContextReplay(original.envelope, undefined, [{
    provider: 'fts', code: 'CAPABILITY_ERROR', message: 'FTS unavailable', security_control: false,
  }]);
  assert.equal(unavailable.status, 'UNREPLAYABLE');
  assert.equal(unavailable.freshness, 'UNAVAILABLE');
});

test('derives mandatory policy in Core and does not trust an optional provider authority claim', () => {
  const forged = candidate('a', 'SECURITY.md', ['AC-1'], ['receipt'], {
    kind: 'document', provider: 'fts', authority: 'policy',
    authority_evidence: ['convention:root-security-file'], freshness: 'snapshot',
  });
  const trusted = candidate('b', 'SECURITY.md', ['AC-2'], ['security'], {
    kind: 'document', provider: 'documents', authority: 'policy',
    authority_evidence: ['convention:root-security-file'],
  });
  const compiled = compileContext(request, [forged, trusted]);
  assert.equal(compiled.envelope.items.find((item) => item.id === forged.id)?.mandatory, false);
  assert.equal(compiled.envelope.items.find((item) => item.id === trusted.id)?.mandatory, true);
});

test('returns exhausted and insufficient when mandatory evidence cannot fit', () => {
  const policy = candidate('a', 'SECURITY.md', ['AC-1'], ['receipt'], {
    kind: 'document', provider: 'documents', authority: 'policy',
    authority_evidence: ['convention:root-security-file'],
  });
  const tooSmall = { ...request, budget: { max_items: 1, max_bytes: policy.excerpt_bytes - 1, max_estimated_tokens: 100 } };
  const compiled = compileContext(tooSmall, [policy]);
  assert.equal(compiled.envelope.criteria_coverage[0]?.status, 'MISSING');
  assert.equal(compiled.envelope.evidence_status, 'INSUFFICIENT_EVIDENCE');
  assert.equal(compiled.envelope.budget_status, 'EXHAUSTED');
  assert.equal(compiled.envelope.evidence_status, 'INSUFFICIENT_EVIDENCE');
  assert.equal(compiled.receipt.decisions[0]?.mandatory, true);
  assert.equal(compiled.receipt.decisions[0]?.reason, 'OMIT_BUDGET_BYTES');
});

test('requires every explicit criterion term before reporting mechanical coverage', () => {
  const partial = candidate('a', 'compiler.ts', ['AC-1'], ['receipt']);
  const strictRequest: ContextPlanRequestV03 = {
    ...request,
    task: {
      ...request.task,
      acceptance_criteria: [{ id: 'AC-1', text: 'Receipt is deterministic', required_terms: ['deterministic', 'receipt'] }],
    },
  };
  const compiled = compileContext(strictRequest, [partial]);
  assert.equal(compiled.envelope.criteria_coverage[0]?.status, 'MISSING');
  assert.deepEqual(compiled.envelope.missing_required_terms, ['deterministic']);
  assert.equal(compiled.envelope.evidence_status, 'INSUFFICIENT_EVIDENCE');
});

test('does not trust adapter discovery terms that are absent from visible evidence', () => {
  const forged = candidate('a', 'compiler.ts', ['AC-1'], ['receipt']);
  forged.excerpt = 'unrelated visible source';
  forged.excerpt_bytes = new TextEncoder().encode(forged.excerpt).byteLength;
  forged.estimated_tokens = Math.ceil(forged.excerpt_bytes / 4);
  forged.excerpt_hash = hashContextText(forged.excerpt);
  forged.id = createContextCandidateId(forged);
  const compiled = compileContext(request, [forged]);
  assert.equal(compiled.envelope.criteria_coverage[0]?.status, 'MISSING');
  assert.equal(compiled.envelope.evidence_status, 'INSUFFICIENT_EVIDENCE');
  assert.equal(compiled.envelope.items[0]?.discovery.matched_terms.includes('receipt'), false);
});

test('rejects sparse candidate arrays, security-control failures, and persisted digest tampering', () => {
  const sparse = new Array(1);
  assert.throws(() => compileContext(request, sparse), /dense JSON data array/i);
  assert.throws(() => compileContext(request, [], [{
    provider: 'filesystem', code: 'SCREENING_FAILED', message: 'screening failed', security_control: true,
  }]), /SECURITY_ERROR/);
  const compiled = compileContext(request, [candidate('a', 'compiler.ts', ['AC-1'], ['receipt'])]);
  const optional = compileContext(request, [], [{
    provider: 'fts', code: 'OPTIONAL_FAILED', message: 'optional source failed', security_control: false,
  }]);
  assert.equal(optional.envelope.source_failures[0]?.code, 'OPTIONAL_FAILED');
  const tampered = structuredClone(compiled.envelope);
  tampered.policy_version = 'tampered';
  assert.throws(() => assertValidContextEnvelope(tampered), /digest/i);
  const semanticTamper = structuredClone(compiled.envelope);
  const coveredCriterion = semanticTamper.criteria_coverage.find((criterion) => criterion.required_terms.length === 1);
  assert.ok(coveredCriterion);
  coveredCriterion.match_mode = coveredCriterion.match_mode === 'ALL' ? 'ANY' : 'ALL';
  assert.throws(() => assertValidContextEnvelope(semanticTamper), /digest/i);

  const mismatched = structuredClone(compiled);
  const included = mismatched.receipt.decisions.find((decision) => decision.status === 'INCLUDED');
  assert.ok(included);
  included.candidate_id = hash('d');
  const { receipt_digest: _digest, ...withoutDigest } = mismatched.receipt;
  mismatched.receipt.receipt_digest = hashContextJson(withoutDigest);
  assert.throws(() => assertValidTaskContextPackage(mismatched), /decisions.*envelope/i);
});

test('canonical hashing rejects cycles and accessors without invoking hostile code', () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.throws(() => hashContextJson(cyclic), /cyclic/i);
  let invoked = false;
  const hostile = {} as Record<string, unknown>;
  Object.defineProperty(hostile, 'secret', { enumerable: true, get: () => { invoked = true; return 'value'; } });
  assert.throws(() => hashContextJson(hostile), /data properties/i);
  assert.equal(invoked, false);
});

test('prioritizes the only candidate that closes missing required-term coverage', () => {
  const strictRequest: ContextPlanRequestV03 = {
    ...request,
    task: {
      ...request.task,
      acceptance_criteria: [{ id: 'AC-1', text: 'alpha beta gamma', required_terms: ['alpha', 'beta', 'gamma'] }],
    },
    required_sources: ['required.ts'],
    budget: { max_items: 2, max_bytes: 800, max_estimated_tokens: 200 },
  };
  const mandatory = candidate('a', 'required.ts', ['AC-1'], ['alpha', 'gamma']);
  const closesCoverage = candidate('b', 'beta.ts', ['AC-1'], ['beta']);
  const redundant = candidate('c', 'redundant.ts', ['AC-1'], ['alpha', 'gamma'], {
    authority: 'contract_schema', kind: 'document', provider: 'documents',
  });
  const compiled = compileContext(strictRequest, [redundant, closesCoverage, mandatory]);
  assert.deepEqual(compiled.envelope.items.map((item) => item.path).sort(), ['beta.ts', 'required.ts']);
  assert.equal(compiled.envelope.evidence_status, 'READY');
});

test('serializes omitted marginal term coverage with contract-safe criterion ids', () => {
  const boundedRequest: ContextPlanRequestV03 = {
    ...request,
    task: {
      ...request.task,
      acceptance_criteria: [{ id: 'AC-1', text: 'alpha beta', required_terms: ['alpha', 'beta'] }],
    },
    budget: { max_items: 1, max_bytes: 800, max_estimated_tokens: 200 },
  };
  const alpha = candidate('a', 'alpha.ts', ['AC-1'], ['alpha']);
  const beta = candidate('b', 'beta.ts', ['AC-1'], ['beta']);

  const compiled = compileContext(boundedRequest, [alpha, beta]);
  const omitted = compiled.receipt.decisions.find((decision) => decision.status === 'OMITTED');
  assert.deepEqual(omitted?.marginal_criteria_ids, ['AC-1']);
  assert.equal(omitted?.marginal_terms.length, 1);
  assert.ok(['alpha', 'beta'].includes(omitted?.marginal_terms[0] ?? ''));
});

test('requires exact optional HEAD freshness when the request binds a commit', () => {
  const wrongHead = candidate('a', 'compiler.ts', ['AC-1'], ['receipt']);
  wrongHead.snapshot.head = 'different-head';
  wrongHead.id = createContextCandidateId(wrongHead);
  assert.throws(() => compileContext(request, [wrongHead]), /snapshot/i);
});

test('denied expansions keep the stored package and cumulative budget unchanged', () => {
  const compiler = candidate('a', 'compiler.ts', ['AC-1'], ['receipt']);
  const initial = compileContext(request, [compiler]);
  const denied = expandContext(initial, request, {
    schema_version: '0.3', task_id: request.task.task_id,
    previous_selection_digest: initial.envelope.selection_digest,
    known_candidate_ids: initial.envelope.items.map((item) => item.id), reason: 'MISSING_TERM',
    requested_paths: [], requested_symbols: [], requested_terms: ['absent'],
    additional_budget: { max_items: 1, max_bytes: 1, max_estimated_tokens: 1 },
  }, []);
  assert.equal(denied.decision.status, 'DENIED');
  assert.equal(denied.package.envelope.selection_digest, initial.envelope.selection_digest);
  assert.deepEqual(denied.decision.cumulative_budget, initial.envelope.budget);
});
