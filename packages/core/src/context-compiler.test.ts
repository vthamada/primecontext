import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ablateContext,
  assertValidContextEnvelope,
  assertValidSelectionReceipt,
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
  assert.equal(first.envelope.budget_status, 'WITHIN_BUDGET');
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
    kind: 'document', provider: 'documents', authority: 'specification', authority_evidence: ['docs-specification'], symbol: 'compileContext',
  });
  const b = candidate('b', 'docs/spec-b.md', ['AC-1'], ['receipt'], {
    kind: 'document', provider: 'documents', authority: 'specification', authority_evidence: ['docs-specification'], symbol: 'compileContext',
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
    reason: 'AUTHORITATIVE_VARIANTS_REQUIRE_REVIEW',
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

test('redacts imported package failures before every denied expansion return and preserves lineage', () => {
  const compiler = candidate('a', 'compiler.ts', ['AC-1'], ['receipt']);
  const rawFailures = [
    {
      provider: 'filesystem' as const,
      code: 'REQUIRED_SOURCE_BLOCKED',
      message: 'Authorization: Basic dXNlcjpwYXNz',
      security_control: true,
    },
    {
      provider: 'fts' as const,
      code: 'OPTIONAL_SOURCE_UNAVAILABLE',
      message: 'upstream authentication failed with Bearer tiny7',
      security_control: false,
    },
    {
      provider: 'codegraph' as const,
      code: 'OPTIONAL_SOURCE_UNAVAILABLE',
      message: 'upstream rejected PrimeContextOpaqueFailure123456789',
      security_control: false,
    },
    {
      provider: 'documents' as const,
      code: 'OPTIONAL_SOURCE_UNAVAILABLE',
      message: 'Document catalog unavailable',
      security_control: false,
    },
  ];
  const compiled = compileContext(request, [compiler], rawFailures);
  const importedPackage = structuredClone(compiled);
  importedPackage.envelope.source_failures = structuredClone(rawFailures);
  const { selection_digest: _selectionDigest, ...envelopeWithoutDigest } = importedPackage.envelope;
  importedPackage.envelope.selection_digest = hashContextJson(envelopeWithoutDigest);
  importedPackage.receipt.selection_digest = importedPackage.envelope.selection_digest;
  importedPackage.receipt.source_failures = structuredClone(rawFailures);
  const { receipt_digest: _receiptDigest, ...receiptWithoutDigest } = importedPackage.receipt;
  importedPackage.receipt.receipt_digest = hashContextJson(receiptWithoutDigest);
  assert.doesNotThrow(() => assertValidTaskContextPackage(importedPackage));
  const inputSnapshot = structuredClone(importedPackage);
  const linkedExpansion = {
    schema_version: '0.3' as const,
    task_id: request.task.task_id,
    previous_selection_digest: importedPackage.envelope.selection_digest,
    known_candidate_ids: importedPackage.envelope.items.map((item) => item.id),
    reason: 'MISSING_TERM' as const,
    requested_paths: [],
    requested_symbols: [],
    requested_terms: ['absent'],
    additional_budget: { max_items: 1, max_bytes: 100, max_estimated_tokens: 25 },
  };
  const staleExpansion = { ...linkedExpansion, previous_selection_digest: hash('d') };

  const stale = expandContext(importedPackage, request, staleExpansion, []);
  const duplicate = expandContext(importedPackage, request, linkedExpansion, [compiler]);
  const noNewEvidence = expandContext(importedPackage, request, linkedExpansion, []);

  assert.deepEqual(stale.decision.reason_codes, ['STALE_PARENT']);
  assert.deepEqual(duplicate.decision.reason_codes, ['DUPLICATE_ONLY']);
  assert.deepEqual(noNewEvidence.decision.reason_codes, ['NO_NEW_EVIDENCE']);
  assert.equal(stale.decision.previous_selection_digest, staleExpansion.previous_selection_digest);
  assert.equal(duplicate.decision.previous_selection_digest, importedPackage.envelope.selection_digest);
  assert.equal(noNewEvidence.decision.previous_selection_digest, importedPackage.envelope.selection_digest);
  for (const result of [stale, duplicate, noNewEvidence]) {
    assert.doesNotThrow(() => assertValidTaskContextPackage(result.package));
    assert.equal(result.decision.selection_digest, result.package.envelope.selection_digest);
    assert.equal(result.package.receipt.selection_digest, result.package.envelope.selection_digest);
    const publicText = JSON.stringify(result);
    for (const credential of ['dXNlcjpwYXNz', 'tiny7', 'PrimeContextOpaqueFailure123456789']) {
      assert.doesNotMatch(publicText, new RegExp(credential));
    }
    assert.match(publicText, /\[REDACTED\]/);
    assert.notEqual(result.package.envelope.selection_digest, importedPackage.envelope.selection_digest);
    assert.notStrictEqual(result.package.envelope.source_failures, importedPackage.envelope.source_failures);
    assert.notStrictEqual(result.package.receipt.source_failures, importedPackage.receipt.source_failures);
    assert.notStrictEqual(result.package.envelope.source_failures, result.package.receipt.source_failures);
    assert.equal(result.package.envelope.source_failures.find((failure) => (
      failure.provider === 'documents'
    ))?.message, 'Document catalog unavailable');
    for (const raw of rawFailures) {
      const normalized = result.package.envelope.source_failures.find((failure) => failure.provider === raw.provider);
      assert.equal(normalized?.code, raw.code);
      assert.equal(normalized?.security_control, raw.security_control);
      assert.notStrictEqual(normalized, raw);
    }
  }
  assert.deepEqual(expandContext(importedPackage, request, linkedExpansion, []), noNewEvidence);
  assert.deepEqual(stale.package, duplicate.package);
  assert.deepEqual(duplicate.package, noNewEvidence.package);
  assert.deepEqual(importedPackage, inputSnapshot);

  stale.package.envelope.source_failures[0]!.message = 'mutated result';
  assert.deepEqual(importedPackage, inputSnapshot);
  assert.notEqual(duplicate.package.envelope.source_failures[0]?.message, 'mutated result');
  assert.notEqual(stale.package.receipt.source_failures[0]?.message, 'mutated result');
});

test('preserves retained evidence when an exact duplicate becomes a required expansion source', () => {
  const expansionRequest: ContextPlanRequestV03 = {
    ...request,
    task: {
      task_id: 'CTX-001', task_type: 'module_feature', goal: 'Compile a receipt', query: 'compiler receipt',
      acceptance_criteria: [{ id: 'AC-1', text: 'receipt', required_terms: ['receipt'] }],
    },
    required_sources: ['new.ts'],
    budget: { max_items: 3, max_bytes: 300, max_estimated_tokens: 75 },
  };
  const retained = candidate('a', 'old.ts', ['AC-1'], ['receipt']);
  const requiredDuplicate = candidate('b', 'new.ts', ['AC-1'], ['receipt'], {
    source_hash: retained.source_hash,
  });
  const initial = compileContext(expansionRequest, [retained]);
  const expanded = expandContext(initial, expansionRequest, {
    schema_version: '0.3', task_id: expansionRequest.task.task_id,
    previous_selection_digest: initial.envelope.selection_digest,
    known_candidate_ids: initial.envelope.items.map((item) => item.id), reason: 'MISSING_REQUIRED_SOURCE',
    requested_paths: ['new.ts'], requested_symbols: [], requested_terms: ['receipt'],
    additional_budget: { max_items: 1, max_bytes: 100, max_estimated_tokens: 25 },
  }, [requiredDuplicate]);

  assert.equal(expanded.decision.status, 'ALLOWED');
  assert.deepEqual(expanded.decision.additions, [requiredDuplicate.id]);
  assert.deepEqual(expanded.package.envelope.items.map((item) => item.id).sort(), [retained.id, requiredDuplicate.id].sort());
  assert.deepEqual(expanded.package.envelope.missing_required_sources, []);
  assert.equal(expanded.package.envelope.evidence_status, 'READY');
  assert.ok(initial.envelope.items.every((item) => expanded.package.envelope.items.some((next) => next.id === item.id)));

  const details = candidate('c', 'details.ts', [], ['details']);
  const followup = expandContext(expanded.package, expansionRequest, {
    schema_version: '0.3', task_id: expansionRequest.task.task_id,
    previous_selection_digest: expanded.package.envelope.selection_digest,
    known_candidate_ids: expanded.package.envelope.items.map((item) => item.id), reason: 'MISSING_TERM',
    requested_paths: ['details.ts'], requested_symbols: [], requested_terms: ['details'],
    additional_budget: { max_items: 1, max_bytes: 100, max_estimated_tokens: 25 },
  }, [details]);
  assert.deepEqual(followup.decision.additions, [details.id]);
  assert.deepEqual(
    followup.package.envelope.items.map((item) => item.id).sort(),
    [retained.id, requiredDuplicate.id, details.id].sort(),
  );
});

test('keeps retained evidence and insufficiency when a required duplicate cannot fit', () => {
  const boundedRequest: ContextPlanRequestV03 = {
    ...request,
    task: {
      task_id: 'CTX-001', task_type: 'module_feature', goal: 'Compile a receipt', query: 'compiler receipt',
      acceptance_criteria: [{ id: 'AC-1', text: 'receipt', required_terms: ['receipt'] }],
    },
    required_sources: ['new.ts'],
    budget: { max_items: 1, max_bytes: 100, max_estimated_tokens: 25 },
  };
  const retained = candidate('a', 'old.ts', ['AC-1'], ['receipt']);
  const requiredDuplicate = candidate('b', 'new.ts', ['AC-1'], ['receipt'], {
    source_hash: retained.source_hash,
  });
  const initial = compileContext(boundedRequest, [retained]);
  const expanded = expandContext(initial, boundedRequest, {
    schema_version: '0.3', task_id: boundedRequest.task.task_id,
    previous_selection_digest: initial.envelope.selection_digest,
    known_candidate_ids: initial.envelope.items.map((item) => item.id), reason: 'MISSING_REQUIRED_SOURCE',
    requested_paths: ['new.ts'], requested_symbols: [], requested_terms: ['receipt'],
    additional_budget: { max_items: 1, max_bytes: 100, max_estimated_tokens: 25 },
  }, [requiredDuplicate]);

  assert.equal(expanded.decision.status, 'DENIED');
  assert.deepEqual(expanded.package.envelope.items.map((item) => item.id), [retained.id]);
  assert.deepEqual(expanded.package.envelope.missing_required_sources, ['new.ts']);
  assert.equal(expanded.package.envelope.evidence_status, 'INSUFFICIENT_EVIDENCE');
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

test('ablation preserves the implicit two-term minimum', () => {
  const anyRequest: ContextPlanRequestV03 = {
    ...request,
    task: { ...request.task, acceptance_criteria: [{ id: 'AC-1', text: 'alpha beta' }] },
  };
  const alpha = candidate('a', 'alpha.ts', ['AC-1'], ['alpha']);
  const beta = candidate('b', 'beta.ts', ['AC-1'], ['beta']);
  const compiled = compileContext(anyRequest, [alpha, beta]);
  assert.equal(compiled.envelope.criteria_coverage[0]?.match_mode, 'AT_LEAST');
  assert.equal(compiled.envelope.criteria_coverage[0]?.minimum_matches, 2);
  assert.deepEqual(compiled.envelope.criteria_coverage[0]?.required_terms, ['alpha', 'beta']);

  const ablation = ablateContext(compiled.envelope, {
    schema_version: '0.3', task_id: anyRequest.task.task_id,
    selection_digest: compiled.envelope.selection_digest, candidate_id: alpha.id,
  });
  assert.deepEqual(ablation.missing_criteria_ids, ['AC-1']);
  assert.deepEqual(ablation.missing_required_terms, ['alpha']);
  assert.equal(ablation.evidence_status, 'INSUFFICIENT_EVIDENCE');
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
  assert.equal(compiled.receipt.decisions.find((item) => item.candidate_id === forged.id)?.mandatory, false);
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
  assert.equal(compiled.envelope.items.some((item) => item.id === forged.id), false);
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

test('expands progressive budgets through soft and hard tiers without exceeding hard', () => {
  const progressiveRequest: ContextPlanRequestV03 = {
    ...request,
    task: {
      ...request.task,
      acceptance_criteria: [{ id: 'AC-1', text: 'alpha beta gamma', required_terms: ['alpha', 'beta', 'gamma'] }],
    },
    budget: { max_items: 1, max_bytes: 100, max_estimated_tokens: 25 },
    progressive_budget: {
      soft: { max_items: 2, max_bytes: 200, max_estimated_tokens: 50 },
      hard: { max_items: 3, max_bytes: 300, max_estimated_tokens: 75 },
    },
  };
  const alpha = candidate('a', 'alpha.ts', ['AC-1'], ['alpha']);
  const beta = candidate('b', 'beta.ts', ['AC-1'], ['beta']);
  const gamma = candidate('c', 'gamma.ts', ['AC-1'], ['gamma']);
  const initial = compileContext(progressiveRequest, [alpha, beta, gamma]);
  assert.equal(initial.envelope.budget_tier, 'INITIAL');
  assert.equal(initial.envelope.items.length, 1);

  const soft = expandContext(initial, progressiveRequest, {
    schema_version: '0.3', task_id: request.task.task_id,
    previous_selection_digest: initial.envelope.selection_digest,
    known_candidate_ids: initial.envelope.items.map((item) => item.id), reason: 'MISSING_TERM',
    requested_paths: ['beta.ts'], requested_symbols: [], requested_terms: ['beta'],
    additional_budget: { max_items: 1, max_bytes: 100, max_estimated_tokens: 25 },
  }, [beta, gamma]);
  assert.equal(soft.package.envelope.budget_tier, 'SOFT');
  assert.equal(soft.decision.budget_tier, 'SOFT');
  assert.equal(soft.package.envelope.items.length, 2);
  assert.equal(soft.decision.reason_codes.includes('HARD_LIMIT_REACHED'), false);

  const hard = expandContext(soft.package, progressiveRequest, {
    schema_version: '0.3', task_id: request.task.task_id,
    previous_selection_digest: soft.package.envelope.selection_digest,
    known_candidate_ids: soft.package.envelope.items.map((item) => item.id), reason: 'MISSING_TERM',
    requested_paths: ['gamma.ts'], requested_symbols: [], requested_terms: ['gamma'],
    additional_budget: { max_items: 1, max_bytes: 100, max_estimated_tokens: 25 },
  }, [gamma]);
  assert.equal(hard.package.envelope.budget_tier, 'HARD');
  assert.equal(hard.decision.budget_tier, 'HARD');
  assert.equal(hard.package.envelope.items.length, 3);
  assert.equal(hard.package.envelope.evidence_status, 'READY');
  assert.ok(hard.package.envelope.budget.used_items <= progressiveRequest.progressive_budget!.hard.max_items);
});

test('keeps repeated expansions in the soft tier until their cumulative budget exceeds it', () => {
  const progressiveRequest: ContextPlanRequestV03 = {
    ...request,
    task: {
      ...request.task,
      acceptance_criteria: [{
        id: 'AC-1', text: 'alpha beta gamma delta', required_terms: ['alpha', 'beta', 'delta', 'gamma'],
      }],
    },
    budget: { max_items: 1, max_bytes: 100, max_estimated_tokens: 25 },
    progressive_budget: {
      soft: { max_items: 3, max_bytes: 300, max_estimated_tokens: 75 },
      hard: { max_items: 4, max_bytes: 400, max_estimated_tokens: 100 },
    },
  };
  const alpha = candidate('a', 'alpha.ts', ['AC-1'], ['alpha']);
  const beta = candidate('b', 'beta.ts', ['AC-1'], ['beta']);
  const gamma = candidate('c', 'gamma.ts', ['AC-1'], ['gamma']);
  const delta = candidate('d', 'delta.ts', ['AC-1'], ['delta']);
  const initial = compileContext(progressiveRequest, [alpha]);
  const expand = (previous: ReturnType<typeof compileContext>, requested: ContextCandidateV03) => expandContext(
    previous,
    progressiveRequest,
    {
      schema_version: '0.3', task_id: progressiveRequest.task.task_id,
      previous_selection_digest: previous.envelope.selection_digest,
      known_candidate_ids: previous.envelope.items.map((item) => item.id), reason: 'MISSING_TERM',
      requested_paths: [requested.path], requested_symbols: [], requested_terms: requested.discovery.matched_terms,
      additional_budget: { max_items: 1, max_bytes: 100, max_estimated_tokens: 25 },
    },
    [requested],
  );

  const first = expand(initial, beta);
  const second = expand(first.package, gamma);
  const third = expand(second.package, delta);
  assert.equal(first.package.envelope.budget_tier, 'SOFT');
  assert.equal(second.package.envelope.budget_tier, 'SOFT');
  assert.equal(second.package.envelope.budget.used_items, 3);
  assert.equal(third.package.envelope.budget_tier, 'HARD');
  assert.equal(third.package.envelope.budget.used_items, 4);
});

test('does not report HARD_LIMIT while the absolute hard tier can still admit omitted evidence', () => {
  const progressiveRequest: ContextPlanRequestV03 = {
    ...request,
    task: {
      ...request.task,
      acceptance_criteria: [{
        id: 'AC-1', text: 'alpha beta gamma delta', required_terms: ['alpha', 'beta', 'delta', 'gamma'],
      }],
    },
    budget: { max_items: 1, max_bytes: 100, max_estimated_tokens: 25 },
    progressive_budget: {
      soft: { max_items: 2, max_bytes: 200, max_estimated_tokens: 50 },
      hard: { max_items: 4, max_bytes: 400, max_estimated_tokens: 100 },
    },
  };
  const alpha = candidate('a', 'alpha.ts', ['AC-1'], ['alpha']);
  const beta = candidate('b', 'beta.ts', ['AC-1'], ['beta']);
  const gamma = candidate('c', 'gamma.ts', ['AC-1'], ['gamma']);
  const delta = candidate('d', 'delta.ts', ['AC-1'], ['delta']);
  const initial = compileContext(progressiveRequest, [alpha]);
  const soft = expandContext(initial, progressiveRequest, {
    schema_version: '0.3', task_id: progressiveRequest.task.task_id,
    previous_selection_digest: initial.envelope.selection_digest,
    known_candidate_ids: initial.envelope.items.map((item) => item.id), reason: 'MISSING_TERM',
    requested_paths: [beta.path], requested_symbols: [], requested_terms: ['beta'],
    additional_budget: { max_items: 1, max_bytes: 100, max_estimated_tokens: 25 },
  }, [beta]);
  const partialHard = expandContext(soft.package, progressiveRequest, {
    schema_version: '0.3', task_id: progressiveRequest.task.task_id,
    previous_selection_digest: soft.package.envelope.selection_digest,
    known_candidate_ids: soft.package.envelope.items.map((item) => item.id), reason: 'MISSING_TERM',
    requested_paths: [delta.path, gamma.path].sort(), requested_symbols: [], requested_terms: ['delta', 'gamma'],
    additional_budget: { max_items: 1, max_bytes: 100, max_estimated_tokens: 25 },
  }, [delta, gamma]);

  assert.equal(partialHard.package.envelope.budget_tier, 'HARD');
  assert.equal(partialHard.package.envelope.budget.used_items, 3);
  assert.deepEqual(partialHard.decision.reason_codes, ['EVIDENCE_ADDED']);
  assert.equal(partialHard.decision.status, 'PARTIAL');
});

test('reports HARD_LIMIT only when omitted evidence cannot fit the absolute hard tier', () => {
  const progressiveRequest: ContextPlanRequestV03 = {
    ...request,
    task: {
      ...request.task,
      acceptance_criteria: [{
        id: 'AC-1', text: 'alpha beta gamma delta', required_terms: ['alpha', 'beta', 'delta', 'gamma'],
      }],
    },
    budget: { max_items: 1, max_bytes: 100, max_estimated_tokens: 25 },
    progressive_budget: {
      soft: { max_items: 2, max_bytes: 200, max_estimated_tokens: 50 },
      hard: { max_items: 3, max_bytes: 300, max_estimated_tokens: 75 },
    },
  };
  const alpha = candidate('a', 'alpha.ts', ['AC-1'], ['alpha']);
  const beta = candidate('b', 'beta.ts', ['AC-1'], ['beta']);
  const gamma = candidate('c', 'gamma.ts', ['AC-1'], ['gamma']);
  const delta = candidate('d', 'delta.ts', ['AC-1'], ['delta']);
  const initial = compileContext(progressiveRequest, [alpha]);
  const soft = expandContext(initial, progressiveRequest, {
    schema_version: '0.3', task_id: progressiveRequest.task.task_id,
    previous_selection_digest: initial.envelope.selection_digest,
    known_candidate_ids: initial.envelope.items.map((item) => item.id), reason: 'MISSING_TERM',
    requested_paths: [beta.path], requested_symbols: [], requested_terms: ['beta'],
    additional_budget: { max_items: 1, max_bytes: 100, max_estimated_tokens: 25 },
  }, [beta]);
  const hard = expandContext(soft.package, progressiveRequest, {
    schema_version: '0.3', task_id: progressiveRequest.task.task_id,
    previous_selection_digest: soft.package.envelope.selection_digest,
    known_candidate_ids: soft.package.envelope.items.map((item) => item.id), reason: 'MISSING_TERM',
    requested_paths: [delta.path, gamma.path].sort(), requested_symbols: [], requested_terms: ['delta', 'gamma'],
    additional_budget: { max_items: 2, max_bytes: 200, max_estimated_tokens: 50 },
  }, [delta, gamma]);

  assert.equal(hard.package.envelope.budget.used_items, 3);
  assert.deepEqual(hard.decision.reason_codes, ['EVIDENCE_ADDED', 'HARD_LIMIT_REACHED']);
  assert.equal(hard.decision.status, 'PARTIAL');
});

test('stops after mechanical sufficiency and does not report source bounding as budget truncation', () => {
  const sufficientRequest: ContextPlanRequestV03 = {
    ...request,
    task: { ...request.task, acceptance_criteria: [{ id: 'AC-1', text: 'receipt', required_terms: ['receipt'] }] },
    budget: { max_items: 3, max_bytes: 800, max_estimated_tokens: 200 },
  };
  const evidence = candidate('a', 'receipt.ts', ['AC-1'], ['receipt'], {
    discovery: {
      matched_terms: ['receipt'], criteria_ids: ['AC-1'], truncated: true,
      truncation_reasons: ['EXCERPT_BOUND', 'PROVIDER_RESULT_LIMIT'],
    },
  });
  const generic = candidate('b', 'fresh.ts', [], ['compiler'], {
    discovery: {
      matched_terms: ['compiler'], criteria_ids: [], truncated: true,
      truncation_reasons: ['SOURCE_COLLECTION_LIMIT'],
    },
  });
  const result = compileContext(sufficientRequest, [generic, evidence]);
  assert.deepEqual(result.envelope.items.map((item) => item.id), [evidence.id]);
  assert.equal(result.envelope.budget_status, 'WITHIN_BUDGET');
  assert.equal(result.envelope.truncation.source_truncated, true);
  assert.deepEqual(result.envelope.truncation.truncation_reasons, [
    'EXCERPT_BOUND', 'PROVIDER_RESULT_LIMIT', 'SOURCE_COLLECTION_LIMIT',
  ]);
  assert.deepEqual(result.receipt.truncation, result.envelope.truncation);
  assert.equal(result.receipt.decisions.find((item) => item.candidate_id === generic.id)?.reason, 'OMIT_SUFFICIENT_EVIDENCE');
});

test('preserves source truncation reasons across expansion without reporting a hard budget limit', () => {
  const progressiveRequest: ContextPlanRequestV03 = {
    ...request,
    task: {
      ...request.task,
      acceptance_criteria: [{ id: 'AC-1', text: 'alpha beta', required_terms: ['alpha', 'beta'] }],
    },
    budget: { max_items: 1, max_bytes: 100, max_estimated_tokens: 25 },
    progressive_budget: {
      soft: { max_items: 2, max_bytes: 200, max_estimated_tokens: 50 },
      hard: { max_items: 2, max_bytes: 200, max_estimated_tokens: 50 },
    },
  };
  const alpha = candidate('a', 'alpha.ts', ['AC-1'], ['alpha'], {
    discovery: {
      matched_terms: ['alpha'], criteria_ids: ['AC-1'], truncated: true,
      truncation_reasons: ['CANDIDATE_SET_LIMIT'],
    },
  });
  const beta = candidate('b', 'beta.ts', ['AC-1'], ['beta']);
  const initial = compileContext(progressiveRequest, [alpha]);
  const expanded = expandContext(initial, progressiveRequest, {
    schema_version: '0.3', task_id: progressiveRequest.task.task_id,
    previous_selection_digest: initial.envelope.selection_digest,
    known_candidate_ids: initial.envelope.items.map((item) => item.id), reason: 'MISSING_TERM',
    requested_paths: [beta.path], requested_symbols: [], requested_terms: ['beta'],
    additional_budget: { max_items: 1, max_bytes: 100, max_estimated_tokens: 25 },
  }, [beta]);

  assert.deepEqual(expanded.package.envelope.truncation.truncation_reasons, ['CANDIDATE_SET_LIMIT']);
  assert.equal(expanded.package.envelope.truncation.source_truncated, true);
  assert.equal(expanded.package.envelope.budget_status, 'WITHIN_BUDGET');
  assert.deepEqual(expanded.decision.reason_codes, ['EVIDENCE_ADDED']);
});

test('accepts a legacy linked package whose truncation objects omit explicit reasons', () => {
  const compiled = compileContext(request, [candidate('a', 'receipt.ts', ['AC-1'], ['receipt'])]);
  const legacy = structuredClone(compiled);
  delete legacy.envelope.truncation.truncation_reasons;
  const { selection_digest: _selectionDigest, ...envelopeWithoutDigest } = legacy.envelope;
  legacy.envelope.selection_digest = hashContextJson(envelopeWithoutDigest);
  legacy.receipt.selection_digest = legacy.envelope.selection_digest;
  delete legacy.receipt.truncation.truncation_reasons;
  const { receipt_digest: _receiptDigest, ...receiptWithoutDigest } = legacy.receipt;
  legacy.receipt.receipt_digest = hashContextJson(receiptWithoutDigest);

  assert.doesNotThrow(() => assertValidTaskContextPackage(legacy));
});

test('deduplicates payload bytes while satisfying every equivalent required path', () => {
  const duplicateRequest: ContextPlanRequestV03 = {
    ...request,
    task: { ...request.task, acceptance_criteria: [{ id: 'AC-1', text: 'receipt', required_terms: ['receipt'] }] },
    required_sources: ['a.ts', 'b.ts'],
    budget: { max_items: 1, max_bytes: 100, max_estimated_tokens: 25 },
  };
  const a = candidate('a', 'a.ts', ['AC-1'], ['receipt']);
  const b = candidate('b', 'b.ts', ['AC-1'], ['receipt'], { source_hash: a.source_hash });
  const result = compileContext(duplicateRequest, [b, a]);
  assert.equal(result.envelope.items.length, 1);
  assert.deepEqual(result.envelope.missing_required_sources, []);
  assert.equal(result.envelope.evidence_status, 'READY');
  const duplicateDecision = result.receipt.decisions.find((decision) => decision.reason === 'OMIT_DUPLICATE_CONTENT');
  assert.equal(duplicateDecision?.mandatory, true);
});

test('receipt duplicate links are complete, disjoint, non-self, and point to an included representative', () => {
  const duplicateRequest: ContextPlanRequestV03 = {
    ...request,
    task: { ...request.task, acceptance_criteria: [{ id: 'AC-1', text: 'receipt', required_terms: ['receipt'] }] },
    required_sources: ['a.ts', 'b.ts'],
    budget: { max_items: 1, max_bytes: 100, max_estimated_tokens: 25 },
  };
  const representativeCandidate = candidate('a', 'a.ts', ['AC-1'], ['receipt']);
  const duplicateCandidate = candidate('b', 'b.ts', ['AC-1'], ['receipt'], {
    source_hash: representativeCandidate.source_hash,
  });
  const compiled = compileContext(duplicateRequest, [duplicateCandidate, representativeCandidate]);
  assert.doesNotThrow(() => assertValidSelectionReceipt(compiled.receipt));
  const group = compiled.receipt.duplicate_groups[0]!;
  const duplicateId = group.duplicate_ids[0]!;

  const orphan = structuredClone(compiled.receipt);
  orphan.duplicate_groups = [];
  {
    const { receipt_digest: _digest, ...withoutDigest } = orphan;
    orphan.receipt_digest = hashContextJson(withoutDigest);
  }
  assert.throws(() => assertValidSelectionReceipt(orphan), /duplicate/i);

  const omittedRepresentative = structuredClone(compiled.receipt);
  const representativeDecision = omittedRepresentative.decisions.find((decision) => decision.candidate_id === group.representative_id)!;
  representativeDecision.status = 'OMITTED';
  representativeDecision.reason = 'OMIT_NO_MATCH';
  representativeDecision.marginal_criteria_ids = [];
  representativeDecision.marginal_terms = [];
  omittedRepresentative.truncation.selected_candidates -= 1;
  omittedRepresentative.truncation.omitted_candidates += 1;
  {
    const { receipt_digest: _digest, ...withoutDigest } = omittedRepresentative;
    omittedRepresentative.receipt_digest = hashContextJson(withoutDigest);
  }
  assert.throws(() => assertValidSelectionReceipt(omittedRepresentative), /representative|duplicate/i);

  const selfLinked = structuredClone(compiled.receipt);
  selfLinked.duplicate_groups[0] = { representative_id: duplicateId, duplicate_ids: [duplicateId] };
  selfLinked.decisions.find((decision) => decision.candidate_id === duplicateId)!.duplicate_of = duplicateId;
  {
    const { receipt_digest: _digest, ...withoutDigest } = selfLinked;
    selfLinked.receipt_digest = hashContextJson(withoutDigest);
  }
  assert.throws(() => assertValidSelectionReceipt(selfLinked), /representative|itself|duplicate/i);

  const overlapping = structuredClone(compiled.receipt);
  overlapping.duplicate_groups.push(structuredClone(overlapping.duplicate_groups[0]!));
  {
    const { receipt_digest: _digest, ...withoutDigest } = overlapping;
    overlapping.receipt_digest = hashContextJson(withoutDigest);
  }
  assert.throws(() => assertValidSelectionReceipt(overlapping), /overlap|duplicate/i);
});

test('does not emit duplicate links whose representative was omitted', () => {
  const boundedRequest: ContextPlanRequestV03 = {
    ...request,
    task: { ...request.task, acceptance_criteria: [{ id: 'AC-1', text: 'receipt', required_terms: ['receipt'] }] },
    budget: { max_items: 1, max_bytes: 1, max_estimated_tokens: 1 },
  };
  const first = candidate('a', 'a.ts', ['AC-1'], ['receipt']);
  const second = candidate('b', 'b.ts', ['AC-1'], ['receipt'], { source_hash: first.source_hash });
  const compiled = compileContext(boundedRequest, [first, second]);

  assert.deepEqual(compiled.receipt.duplicate_groups, []);
  assert.ok(compiled.receipt.decisions.every((decision) => decision.duplicate_of === undefined));
  assert.ok(compiled.receipt.decisions.every((decision) => decision.reason !== 'OMIT_DUPLICATE_CONTENT'));
  assert.doesNotThrow(() => assertValidSelectionReceipt(compiled.receipt));
});

test('deduplication prefers recognized effective authority over a forged optional-provider claim', () => {
  const duplicateRequest: ContextPlanRequestV03 = {
    ...request,
    task: { ...request.task, acceptance_criteria: [{ id: 'AC-1', text: 'receipt', required_terms: ['receipt'] }] },
    budget: { max_items: 1, max_bytes: 100, max_estimated_tokens: 25 },
  };
  const trusted = candidate('a', 'docs/specification/trusted.md', ['AC-1'], ['receipt'], {
    kind: 'document', provider: 'documents', authority: 'specification',
    authority_evidence: ['convention:docs-specification-directory'], source_hash: hash('d'),
  });
  const forged = candidate('b', 'a.md', ['AC-1'], ['receipt'], {
    kind: 'document', provider: 'fts', authority: 'policy',
    authority_evidence: ['convention:root-agents-file'], source_hash: trusted.source_hash,
  });

  const result = compileContext(duplicateRequest, [forged, trusted]);
  assert.deepEqual(result.envelope.items.map((item) => item.id), [trusted.id]);
  assert.equal(
    result.receipt.decisions.find((decision) => decision.candidate_id === forged.id)?.duplicate_of,
    trusted.id,
  );
});

test('requires at least two discriminative terms for implicit criteria', () => {
  const implicitRequest: ContextPlanRequestV03 = {
    ...request,
    task: { ...request.task, acceptance_criteria: [{ id: 'AC-1', text: 'The receipt is deterministic and bounded' }] },
  };
  const oneGenericMatch = candidate('a', 'receipt.ts', ['AC-1'], ['receipt']);
  const partial = compileContext(implicitRequest, [oneGenericMatch]);
  assert.equal(partial.envelope.criteria_coverage[0]?.match_mode, 'AT_LEAST');
  assert.equal(partial.envelope.criteria_coverage[0]?.minimum_matches, 2);
  assert.deepEqual(partial.envelope.criteria_coverage[0]?.required_terms, ['bounded', 'deterministic', 'receipt']);
  assert.equal(partial.envelope.evidence_status, 'INSUFFICIENT_EVIDENCE');

  const deterministic = candidate('b', 'deterministic.ts', ['AC-1'], ['deterministic']);
  const covered = compileContext(implicitRequest, [oneGenericMatch, deterministic]);
  assert.equal(covered.envelope.evidence_status, 'READY');
});

test('does not grant authority score or conflict power to forged optional-provider claims', () => {
  const authorityRequest: ContextPlanRequestV03 = {
    ...request,
    task: { ...request.task, acceptance_criteria: [{ id: 'AC-1', text: 'receipt', required_terms: ['receipt'] }] },
    budget: { max_items: 2, max_bytes: 800, max_estimated_tokens: 200 },
  };
  const first = candidate('a', 'docs/first.md', ['AC-1'], ['receipt'], {
    kind: 'document', provider: 'fts', authority: 'specification', authority_evidence: ['docs-specification'],
    symbol: 'compileContext', source_hash: hash('a'),
  });
  const second = candidate('b', 'docs/second.md', ['AC-1'], ['receipt'], {
    kind: 'document', provider: 'fts', authority: 'specification', authority_evidence: ['docs-specification'],
    symbol: 'compileContext', source_hash: hash('b'),
  });
  const result = compileContext(authorityRequest, [first, second]);
  assert.deepEqual(result.envelope.conflicts, []);
  assert.ok(result.envelope.items.every((item) => item.score_components.authority === 0));
});

test('emits potential authoritative variants for review and accepts the legacy conflict reason', () => {
  const conflictRequest: ContextPlanRequestV03 = {
    ...request,
    task: { ...request.task, acceptance_criteria: [{ id: 'AC-1', text: 'receipt', required_terms: ['receipt'] }] },
    budget: { max_items: 2, max_bytes: 800, max_estimated_tokens: 200 },
  };
  const first = candidate('a', 'docs/specification/first.md', ['AC-1'], ['receipt'], {
    kind: 'document', provider: 'documents', authority: 'specification',
    authority_evidence: ['convention:docs-specification-directory'], symbol: 'compileContext', source_hash: hash('a'),
  });
  const second = candidate('b', 'docs/specification/second.md', ['AC-1'], ['receipt'], {
    kind: 'document', provider: 'documents', authority: 'specification',
    authority_evidence: ['convention:docs-specification-directory'], symbol: 'compileContext', source_hash: hash('b'),
  });
  const result = compileContext(conflictRequest, [first, second]);
  assert.equal(result.envelope.conflicts[0]?.reason, 'AUTHORITATIVE_VARIANTS_REQUIRE_REVIEW');
  const legacy = structuredClone(result.envelope);
  legacy.conflicts[0]!.reason = 'AUTHORITATIVE_SOURCES_DISAGREE';
  const { selection_digest: _digest, ...withoutDigest } = legacy;
  legacy.selection_digest = hashContextJson(withoutDigest);
  assert.doesNotThrow(() => assertValidContextEnvelope(legacy));
});

test('ablation cannot clear a conflict into READY while required evidence remains missing', () => {
  const conflictRequest: ContextPlanRequestV03 = {
    ...request,
    task: { ...request.task, acceptance_criteria: [{ id: 'AC-1', text: 'receipt', required_terms: ['receipt'] }] },
    required_sources: ['missing.ts'], budget: { max_items: 2, max_bytes: 800, max_estimated_tokens: 200 },
  };
  const first = candidate('a', 'docs/specification/first.md', ['AC-1'], ['receipt'], {
    kind: 'document', provider: 'documents', authority: 'specification',
    authority_evidence: ['convention:docs-specification-directory'], symbol: 'compileContext', source_hash: hash('a'),
  });
  const second = candidate('b', 'docs/specification/second.md', ['AC-1'], ['receipt'], {
    kind: 'document', provider: 'documents', authority: 'specification',
    authority_evidence: ['convention:docs-specification-directory'], symbol: 'compileContext', source_hash: hash('b'),
  });
  const compiled = compileContext(conflictRequest, [first, second]);
  const ablation = ablateContext(compiled.envelope, {
    schema_version: '0.3', task_id: conflictRequest.task.task_id,
    selection_digest: compiled.envelope.selection_digest, candidate_id: first.id,
  });
  assert.equal(ablation.evidence_status, 'INSUFFICIENT_EVIDENCE');
  assert.deepEqual(ablation.missing_required_sources, ['missing.ts']);
  assert.deepEqual(ablation.source_failures, []);
});

test('receipt validation recomputes decision score totals', () => {
  const compiled = compileContext(request, [
    candidate('a', 'receipt.ts', ['AC-1'], ['receipt']),
    candidate('b', 'security.ts', ['AC-2'], ['security']),
  ]);
  const tampered = structuredClone(compiled.receipt);
  tampered.decisions[0]!.score += 1;
  const { receipt_digest: _digest, ...withoutDigest } = tampered;
  tampered.receipt_digest = hashContextJson(withoutDigest);
  assert.throws(() => assertValidSelectionReceipt(tampered), /score.*components/i);
});

test('bounds deterministic marginal work for the 2048-candidate public limit', () => {
  const boundedRequest: ContextPlanRequestV03 = {
    ...request,
    task: { ...request.task, acceptance_criteria: [{ id: 'AC-1', text: 'receipt', required_terms: ['receipt'] }] },
    budget: { max_items: 1, max_bytes: 100, max_estimated_tokens: 25 },
  };
  const candidates = Array.from({ length: 2048 }, (_, index) => candidate(
    'a', `src/candidate-${index.toString().padStart(4, '0')}.ts`, ['AC-1'], ['receipt'],
    { source_hash: hashContextText(`source-${index}`) },
  ));
  const compiled = compileContext(boundedRequest, candidates);
  assert.equal(compiled.envelope.items.length, 1);
  assert.equal(compiled.receipt.decisions.length, 2048);
  assert.equal(compiled.receipt.decisions.filter((decision) => decision.reason === 'OMIT_SUFFICIENT_EVIDENCE').length, 2047);
});

test('applies root and nearest AGENTS policy without default SECURITY or governance tax', () => {
  const policyRequest: ContextPlanRequestV03 = {
    ...request,
    task: {
      ...request.task, goal: 'Compile a receipt', query: 'compiler receipt',
      acceptance_criteria: [{ id: 'AC-1', text: 'receipt', required_terms: ['receipt'] }],
      hints: { paths: ['packages/core/src'], symbols: [], terms: [] },
    },
    budget: { max_items: 3, max_bytes: 800, max_estimated_tokens: 200 },
  };
  const root = candidate('a', 'AGENTS.md', [], ['instructions'], {
    kind: 'document', provider: 'documents', authority: 'policy', authority_evidence: ['convention:root-agents-file'],
  });
  const broad = candidate('b', 'packages/AGENTS.md', [], ['broad'], {
    kind: 'document', provider: 'documents', authority: 'policy', authority_evidence: ['convention:ancestor-agents-file'],
  });
  const nearest = candidate('c', 'packages/core/AGENTS.md', [], ['nearest'], {
    kind: 'document', provider: 'documents', authority: 'policy', authority_evidence: ['convention:ancestor-agents-file'],
  });
  const security = candidate('d', 'SECURITY.md', [], ['security'], {
    kind: 'document', provider: 'documents', authority: 'policy', authority_evidence: ['convention:root-security-file'],
  });
  const governance = candidate('e', 'CODE_OF_CONDUCT.md', [], ['conduct'], {
    kind: 'document', provider: 'documents', authority: 'policy', authority_evidence: ['convention:root-code-of-conduct-file'],
  });
  const receipt = candidate('f', 'receipt.ts', ['AC-1'], ['receipt']);
  const compiled = compileContext(policyRequest, [governance, security, broad, nearest, root, receipt]);
  assert.deepEqual(compiled.envelope.items.map((item) => item.path).sort(), ['AGENTS.md', 'packages/core/AGENTS.md', 'receipt.ts']);
  assert.equal(compiled.receipt.decisions.find((item) => item.candidate_id === broad.id)?.mandatory, false);
  assert.equal(compiled.receipt.decisions.find((item) => item.candidate_id === security.id)?.mandatory, false);
  assert.equal(compiled.receipt.decisions.find((item) => item.candidate_id === governance.id)?.mandatory, false);
});

test('applies nearest AGENTS policy when a hint targets its directory exactly', () => {
  const policyRequest: ContextPlanRequestV03 = {
    ...request,
    task: {
      ...request.task, goal: 'Compile a receipt', query: 'compiler receipt',
      acceptance_criteria: [{ id: 'AC-1', text: 'receipt', required_terms: ['receipt'] }],
      hints: { paths: ['packages/core'], symbols: [], terms: [] },
    },
    budget: { max_items: 3, max_bytes: 800, max_estimated_tokens: 200 },
  };
  const root = candidate('a', 'AGENTS.md', [], ['instructions'], {
    kind: 'document', provider: 'documents', authority: 'policy', authority_evidence: ['convention:root-agents-file'],
  });
  const broad = candidate('b', 'packages/AGENTS.md', [], ['broad'], {
    kind: 'document', provider: 'documents', authority: 'policy', authority_evidence: ['convention:ancestor-agents-file'],
  });
  const nearest = candidate('c', 'packages/core/AGENTS.md', [], ['nearest'], {
    kind: 'document', provider: 'documents', authority: 'policy', authority_evidence: ['convention:ancestor-agents-file'],
  });
  const child = candidate('d', 'packages/core/src/AGENTS.md', [], ['child'], {
    kind: 'document', provider: 'documents', authority: 'policy', authority_evidence: ['convention:ancestor-agents-file'],
  });
  const receipt = candidate('e', 'receipt.ts', ['AC-1'], ['receipt']);

  const compiled = compileContext(policyRequest, [child, broad, receipt, nearest, root]);
  assert.deepEqual(compiled.envelope.items.map((item) => item.path).sort(), [
    'AGENTS.md', 'packages/core/AGENTS.md', 'receipt.ts',
  ]);
  assert.equal(compiled.receipt.decisions.find((item) => item.candidate_id === nearest.id)?.mandatory, true);
  assert.equal(compiled.receipt.decisions.find((item) => item.candidate_id === broad.id)?.mandatory, false);
  assert.equal(compiled.receipt.decisions.find((item) => item.candidate_id === child.id)?.mandatory, false);
});

test('applies nearest AGENTS policy when an exact directory hint has a trailing slash', () => {
  const policyRequest: ContextPlanRequestV03 = {
    ...request,
    task: {
      ...request.task, goal: 'Compile a receipt', query: 'compiler receipt',
      acceptance_criteria: [{ id: 'AC-1', text: 'receipt', required_terms: ['receipt'] }],
      hints: { paths: ['packages/core/'], symbols: [], terms: [] },
    },
    budget: { max_items: 3, max_bytes: 800, max_estimated_tokens: 200 },
  };
  const root = candidate('a', 'AGENTS.md', [], ['instructions'], {
    kind: 'document', provider: 'documents', authority: 'policy', authority_evidence: ['convention:root-agents-file'],
  });
  const broad = candidate('b', 'packages/AGENTS.md', [], ['broad'], {
    kind: 'document', provider: 'documents', authority: 'policy', authority_evidence: ['convention:ancestor-agents-file'],
  });
  const nearest = candidate('c', 'packages/core/AGENTS.md', [], ['nearest'], {
    kind: 'document', provider: 'documents', authority: 'policy', authority_evidence: ['convention:ancestor-agents-file'],
  });
  const receipt = candidate('d', 'receipt.ts', ['AC-1'], ['receipt']);

  const compiled = compileContext(policyRequest, [broad, receipt, nearest, root]);
  assert.deepEqual(compiled.envelope.items.map((item) => item.path).sort(), [
    'AGENTS.md', 'packages/core/AGENTS.md', 'receipt.ts',
  ]);
  assert.equal(compiled.receipt.decisions.find((item) => item.candidate_id === nearest.id)?.mandatory, true);
  assert.equal(compiled.receipt.decisions.find((item) => item.candidate_id === broad.id)?.mandatory, false);
});

test('applies nearest AGENTS policy when a required source names its directory exactly', () => {
  const policyRequest: ContextPlanRequestV03 = {
    ...request,
    task: {
      ...request.task, goal: 'Compile a receipt', query: 'compiler receipt',
      acceptance_criteria: [{ id: 'AC-1', text: 'receipt', required_terms: ['receipt'] }],
      hints: { paths: [], symbols: [], terms: [] },
    },
    required_sources: ['packages/core'],
    budget: { max_items: 3, max_bytes: 800, max_estimated_tokens: 200 },
  };
  const root = candidate('a', 'AGENTS.md', [], ['instructions'], {
    kind: 'document', provider: 'documents', authority: 'policy', authority_evidence: ['convention:root-agents-file'],
  });
  const broad = candidate('b', 'packages/AGENTS.md', [], ['broad'], {
    kind: 'document', provider: 'documents', authority: 'policy', authority_evidence: ['convention:ancestor-agents-file'],
  });
  const nearest = candidate('c', 'packages/core/AGENTS.md', [], ['nearest'], {
    kind: 'document', provider: 'documents', authority: 'policy', authority_evidence: ['convention:ancestor-agents-file'],
  });
  const receipt = candidate('d', 'receipt.ts', ['AC-1'], ['receipt']);

  const compiled = compileContext(policyRequest, [broad, receipt, nearest, root]);
  assert.equal(compiled.receipt.decisions.find((item) => item.candidate_id === nearest.id)?.mandatory, true);
  assert.equal(compiled.receipt.decisions.find((item) => item.candidate_id === broad.id)?.mandatory, false);
  assert.deepEqual(compiled.envelope.missing_required_sources, ['packages/core']);
});

test('does not treat an extensionless physical file hint as a policy directory', () => {
  const policyRequest: ContextPlanRequestV03 = {
    ...request,
    task: {
      ...request.task, goal: 'Compile a receipt', query: 'compiler receipt',
      acceptance_criteria: [{ id: 'AC-1', text: 'receipt', required_terms: ['receipt'] }],
      hints: { paths: ['packages/core/README'], symbols: [], terms: [] },
    },
    budget: { max_items: 3, max_bytes: 800, max_estimated_tokens: 200 },
  };
  const root = candidate('a', 'AGENTS.md', [], ['instructions'], {
    kind: 'document', provider: 'documents', authority: 'policy', authority_evidence: ['convention:root-agents-file'],
  });
  const nearest = candidate('b', 'packages/core/AGENTS.md', [], ['nearest'], {
    kind: 'document', provider: 'documents', authority: 'policy', authority_evidence: ['convention:ancestor-agents-file'],
  });
  const falseChild = candidate('c', 'packages/core/README/AGENTS.md', [], ['false-child'], {
    kind: 'document', provider: 'documents', authority: 'policy', authority_evidence: ['convention:ancestor-agents-file'],
  });
  const readme = candidate('d', 'packages/core/README', ['AC-1'], ['receipt']);

  const compiled = compileContext(policyRequest, [falseChild, readme, nearest, root]);
  assert.deepEqual(compiled.envelope.items.map((item) => item.path).sort(), [
    'AGENTS.md', 'packages/core/AGENTS.md', 'packages/core/README',
  ]);
  assert.equal(compiled.receipt.decisions.find((item) => item.candidate_id === nearest.id)?.mandatory, true);
  assert.equal(compiled.receipt.decisions.find((item) => item.candidate_id === falseChild.id)?.mandatory, false);
});

test('applies lowercase root and nested AGENTS policies without rewriting their paths', () => {
  const policyRequest: ContextPlanRequestV03 = {
    ...request,
    task: {
      ...request.task, goal: 'Compile a receipt', query: 'compiler receipt',
      acceptance_criteria: [{ id: 'AC-1', text: 'receipt', required_terms: ['receipt'] }],
      hints: { paths: ['packages/core'], symbols: [], terms: [] },
    },
    budget: { max_items: 3, max_bytes: 800, max_estimated_tokens: 200 },
  };
  const root = candidate('a', 'agents.md', [], ['lower-root'], {
    kind: 'document', provider: 'filesystem', authority: 'policy', authority_evidence: ['convention:root-agents-file'],
  });
  const nested = candidate('b', 'packages/core/agents.md', [], ['lower-nested'], {
    kind: 'document', provider: 'filesystem', authority: 'policy', authority_evidence: ['convention:ancestor-agents-file'],
  });
  const receipt = candidate('c', 'receipt.ts', ['AC-1'], ['receipt']);

  const compiled = compileContext(policyRequest, [nested, receipt, root]);
  assert.deepEqual(compiled.envelope.items.map((item) => item.path).sort(), [
    'agents.md', 'packages/core/agents.md', 'receipt.ts',
  ]);
  assert.equal(compiled.receipt.decisions.find((item) => item.candidate_id === root.id)?.mandatory, true);
  assert.equal(compiled.receipt.decisions.find((item) => item.candidate_id === nested.id)?.mandatory, true);
});

test('selects one canonical AGENTS policy when filename case variants share a scope', () => {
  const policyRequest: ContextPlanRequestV03 = {
    ...request,
    task: {
      ...request.task, goal: 'Compile a receipt', query: 'compiler receipt',
      acceptance_criteria: [{ id: 'AC-1', text: 'receipt', required_terms: ['receipt'] }],
      hints: { paths: ['packages/core'], symbols: [], terms: [] },
    },
    budget: { max_items: 3, max_bytes: 800, max_estimated_tokens: 200 },
  };
  const canonicalRoot = candidate('a', 'AGENTS.md', [], ['canonical-root'], {
    kind: 'document', provider: 'documents', authority: 'policy', authority_evidence: ['convention:root-agents-file'],
  });
  const lowercaseRoot = candidate('b', 'agents.md', [], ['lower-root'], {
    kind: 'document', provider: 'filesystem', authority: 'policy', authority_evidence: ['convention:root-agents-file'],
  });
  const canonicalNested = candidate('c', 'packages/core/AGENTS.md', [], ['canonical-nested'], {
    kind: 'document', provider: 'documents', authority: 'policy', authority_evidence: ['convention:ancestor-agents-file'],
  });
  const lowercaseNested = candidate('d', 'packages/core/agents.md', [], ['lower-nested'], {
    kind: 'document', provider: 'filesystem', authority: 'policy', authority_evidence: ['convention:ancestor-agents-file'],
  });
  const receipt = candidate('e', 'receipt.ts', ['AC-1'], ['receipt']);

  const candidates = [lowercaseNested, lowercaseRoot, receipt, canonicalNested, canonicalRoot];
  const compiled = compileContext(policyRequest, candidates);
  assert.deepEqual(compileContext(policyRequest, [...candidates].reverse()), compiled);
  assert.deepEqual(compiled.envelope.items.map((item) => item.path).sort(), [
    'AGENTS.md', 'packages/core/AGENTS.md', 'receipt.ts',
  ]);
  assert.equal(compiled.receipt.decisions.find((item) => item.candidate_id === lowercaseRoot.id)?.mandatory, false);
  assert.equal(compiled.receipt.decisions.find((item) => item.candidate_id === lowercaseNested.id)?.mandatory, false);
});

test('activates root and nearest AGENTS policy from discovered physical candidate paths without hints', () => {
  const policyRequest: ContextPlanRequestV03 = {
    ...request,
    task: {
      task_id: 'CTX-001', task_type: 'module_feature', goal: 'Compile a receipt', query: 'compiler receipt',
      acceptance_criteria: [{ id: 'AC-1', text: 'receipt', required_terms: ['receipt'] }],
    },
    budget: { max_items: 3, max_bytes: 800, max_estimated_tokens: 200 },
  };
  const root = candidate('a', 'AGENTS.md', [], ['instructions'], {
    kind: 'document', provider: 'documents', authority: 'policy', authority_evidence: ['convention:root-agents-file'],
  });
  const broad = candidate('b', 'packages/AGENTS.md', [], ['broad'], {
    kind: 'document', provider: 'documents', authority: 'policy', authority_evidence: ['convention:ancestor-agents-file'],
  });
  const nearest = candidate('c', 'packages/core/AGENTS.md', [], ['nearest'], {
    kind: 'document', provider: 'documents', authority: 'policy', authority_evidence: ['convention:ancestor-agents-file'],
  });
  const target = candidate('d', 'packages/core/src/compiler.ts', ['AC-1'], ['compiler', 'receipt']);

  const first = compileContext(policyRequest, [broad, target, root, nearest]);
  const second = compileContext(policyRequest, [nearest, root, target, broad]);
  assert.deepEqual(first, second);
  assert.deepEqual(first.envelope.items.map((item) => item.path).sort(), [
    'AGENTS.md', 'packages/core/AGENTS.md', 'packages/core/src/compiler.ts',
  ]);
  assert.equal(first.receipt.decisions.find((item) => item.candidate_id === broad.id)?.mandatory, false);
  assert.equal(first.envelope.evidence_status, 'READY');
});

test('recognizes bounded and common security concepts without taxing unrelated dependency work', () => {
  const security = candidate('a', 'SECURITY.md', [], ['security'], {
    kind: 'document', provider: 'documents', authority: 'policy', authority_evidence: ['convention:root-security-file'],
  });
  const evidence = candidate('b', 'receipt.ts', ['AC-1'], ['receipt']);
  const securityGoals = [
    'Add an OAuth callback',
    'Repair the login flow',
    'Rotate application credentials',
    'Review package permissions',
    'Encrypt stored configuration',
    'Audit npm dependencies for advisories',
    'Prevent SQL injection in account lookup',
    'Add CSRF protection',
    'Require MFA for administrators',
    'Verify a JWT signature',
    'Rotate API keys',
    'Patch CVE-2026-1234',
    'Fix XSS in the preview',
    'Prevent cross-site scripting',
    'Prevent command injection',
    'Block path traversal',
    'Prevent SSRF in callbacks',
    'Enforce RBAC roles',
    'Fix an IDOR',
    'Patch remote code execution',
    'Restrict administrator privileges',
    'Review an exploit and threat model',
    'Sandbox unsafe deserialization',
    'Secure file uploads',
    'Validate webhook redirects',
    'Fix XXE in XML parsing',
    'Harden TLS certificate validation',
    'Prevent prototype pollution',
    'Mitigate denial of service',
    'Fix CORS configuration',
    'Add secure cookie flags',
    'Patch buffer overflow',
    'Fix a stack overflow',
    'Prevent session fixation',
    'Stop a DDoS attack',
    'Stop a DoS attack',
    `${Array.from({ length: 80 }, (_, index) => `alpha${index.toString().padStart(3, '0')}`).join(' ')} oauth`,
  ];

  for (const goal of securityGoals) {
    const securityRequest: ContextPlanRequestV03 = {
      ...request,
      task: {
        task_id: 'CTX-001', task_type: 'module_feature', goal, query: 'compiler receipt',
        acceptance_criteria: [{ id: 'AC-1', text: 'receipt', required_terms: ['receipt'] }],
      },
      budget: { max_items: 2, max_bytes: 800, max_estimated_tokens: 200 },
    };
    const compiled = compileContext(securityRequest, [evidence, security]);
    assert.equal(
      compiled.receipt.decisions.find((item) => item.candidate_id === security.id)?.mandatory,
      true,
      goal,
    );
    assert.equal(compiled.envelope.items.some((item) => item.id === security.id), true, goal);
  }

  for (const goal of [
    'Update npm dependencies for compatibility',
    'Refactor a TypeScript function signature',
    'Configure dependency injection for service construction',
    'Implement syntax tree traversal',
    'Rename an object key',
    'Edit prose about Basic concepts',
    'Atualizar nomes dos módulos',
  ]) {
    const unrelatedRequest: ContextPlanRequestV03 = {
      ...request,
      task: {
        task_id: 'CTX-001', task_type: 'module_feature', goal,
        query: 'compiler receipt',
        acceptance_criteria: [{ id: 'AC-1', text: 'receipt', required_terms: ['receipt'] }],
      },
      budget: { max_items: 2, max_bytes: 800, max_estimated_tokens: 200 },
    };
    const unrelated = compileContext(unrelatedRequest, [security, evidence]);
    assert.equal(
      unrelated.receipt.decisions.find((item) => item.candidate_id === security.id)?.mandatory,
      false,
      goal,
    );
    assert.equal(unrelated.envelope.items.some((item) => item.id === security.id), false, goal);
  }
});

test('applies case-insensitive root SECURITY policies only to security-relevant work without rewriting paths', () => {
  const evidence = candidate('e', 'receipt.ts', ['AC-1'], ['receipt']);
  for (const [index, path] of ['security.md', 'SeCuRiTy.Md'].entries()) {
    const security = candidate(index === 0 ? 'a' : 'b', path, [], ['security'], {
      kind: 'document', provider: 'filesystem', authority: 'policy', authority_evidence: ['convention:root-security-file'],
    });
    const securityRequest: ContextPlanRequestV03 = {
      ...request,
      task: {
        task_id: 'CTX-001', task_type: 'module_feature', goal: 'Prevent cross-site scripting', query: 'compiler receipt',
        acceptance_criteria: [{ id: 'AC-1', text: 'receipt', required_terms: ['receipt'] }],
      },
      budget: { max_items: 2, max_bytes: 800, max_estimated_tokens: 200 },
    };
    const securityCompiled = compileContext(securityRequest, [evidence, security]);
    assert.equal(securityCompiled.receipt.decisions.find((item) => item.candidate_id === security.id)?.mandatory, true, path);
    assert.equal(securityCompiled.envelope.items.some((item) => item.path === path), true, path);

    const unrelatedRequest: ContextPlanRequestV03 = {
      ...securityRequest,
      task: { ...securityRequest.task, goal: 'Update npm dependencies for compatibility' },
    };
    const unrelatedCompiled = compileContext(unrelatedRequest, [security, evidence]);
    assert.equal(unrelatedCompiled.receipt.decisions.find((item) => item.candidate_id === security.id)?.mandatory, false, path);
    assert.equal(unrelatedCompiled.envelope.items.some((item) => item.path === path), false, path);
  }
});

test('preserves canonical SECURITY policy when filename case variants share the root scope', () => {
  const securityRequest: ContextPlanRequestV03 = {
    ...request,
    task: {
      task_id: 'CTX-001', task_type: 'module_feature', goal: 'Prevent cross-site scripting', query: 'compiler receipt',
      acceptance_criteria: [{ id: 'AC-1', text: 'receipt', required_terms: ['receipt'] }],
    },
    budget: { max_items: 2, max_bytes: 800, max_estimated_tokens: 200 },
  };
  const canonical = candidate('a', 'SECURITY.md', [], ['canonical'], {
    kind: 'document', provider: 'documents', authority: 'policy', authority_evidence: ['convention:root-security-file'],
  });
  const lowercase = candidate('b', 'security.md', [], ['lowercase'], {
    kind: 'document', provider: 'filesystem', authority: 'policy', authority_evidence: ['convention:root-security-file'],
  });
  const mixed = candidate('c', 'SeCuRiTy.Md', [], ['mixed'], {
    kind: 'document', provider: 'filesystem', authority: 'policy', authority_evidence: ['convention:root-security-file'],
  });
  const evidence = candidate('d', 'receipt.ts', ['AC-1'], ['receipt']);
  const candidates = [lowercase, evidence, mixed, canonical];

  const compiled = compileContext(securityRequest, candidates);
  assert.deepEqual(compileContext(securityRequest, [...candidates].reverse()), compiled);
  assert.deepEqual(compiled.envelope.items.map((item) => item.path).sort(), ['SECURITY.md', 'receipt.ts']);
  assert.equal(compiled.receipt.decisions.find((item) => item.candidate_id === canonical.id)?.mandatory, true);
  assert.equal(compiled.receipt.decisions.find((item) => item.candidate_id === lowercase.id)?.mandatory, false);
  assert.equal(compiled.receipt.decisions.find((item) => item.candidate_id === mixed.id)?.mandatory, false);
});

test('reports a sanitized blocked required-source failure without compiling unsafe evidence', () => {
  const blockedRequest: ContextPlanRequestV03 = {
    ...request,
    task: { ...request.task, acceptance_criteria: [{ id: 'AC-1', text: 'receipt', required_terms: ['receipt'] }] },
    required_sources: ['private/required.ts'],
  };
  const compiled = compileContext(blockedRequest, [candidate('a', 'receipt.ts', ['AC-1'], ['receipt'])], [{
    provider: 'filesystem', code: 'REQUIRED_SOURCE_BLOCKED', message: 'Required source was blocked by screening', security_control: true,
  }]);
  assert.equal(compiled.envelope.evidence_status, 'INSUFFICIENT_EVIDENCE');
  assert.deepEqual(compiled.envelope.missing_required_sources, ['private/required.ts']);
  assert.deepEqual(compiled.envelope.source_failures, [{
    provider: 'filesystem', code: 'REQUIRED_SOURCE_BLOCKED', message: 'Required source was blocked by screening', security_control: true,
  }]);
});

test('redacts credentials from every public source-failure artifact without mutating benign input', () => {
  const blockedBasic = 'Authorization: Basic dXNlcjpwYXNz';
  const optionalBearer = 'upstream authentication failed with Bearer tiny7';
  const optionalOpaque = 'upstream rejected PrimeContextOpaqueFailure123456789';
  const benignMessage = 'FTS index unavailable';
  const sourceFailures = [
    {
      provider: 'filesystem' as const,
      code: 'REQUIRED_SOURCE_BLOCKED',
      message: blockedBasic,
      security_control: true,
    },
    {
      provider: 'fts' as const,
      code: 'OPTIONAL_SOURCE_UNAVAILABLE',
      message: optionalBearer,
      security_control: false,
    },
    {
      provider: 'codegraph' as const,
      code: 'OPTIONAL_SOURCE_UNAVAILABLE',
      message: optionalOpaque,
      security_control: false,
    },
    {
      provider: 'documents' as const,
      code: 'OPTIONAL_SOURCE_UNAVAILABLE',
      message: benignMessage,
      security_control: false,
    },
  ];

  const compiled = compileContext(request, [], sourceFailures);
  assert.doesNotThrow(() => assertValidTaskContextPackage(compiled));
  const publicText = JSON.stringify(compiled);
  const replayText = JSON.stringify(compareContextReplay(compiled.envelope, compiled, sourceFailures));
  for (const credential of ['dXNlcjpwYXNz', 'tiny7', 'PrimeContextOpaqueFailure123456789']) {
    assert.doesNotMatch(publicText, new RegExp(credential));
    assert.doesNotMatch(replayText, new RegExp(credential));
  }
  assert.match(publicText, /\[REDACTED\]/);
  assert.match(replayText, /\[REDACTED\]/);
  assert.equal(compiled.envelope.source_failures.every((failure) => (
    compiled.receipt.source_failures.some((receiptFailure) => (
      receiptFailure.provider === failure.provider
      && receiptFailure.code === failure.code
      && receiptFailure.message === failure.message
      && receiptFailure.security_control === failure.security_control
    ))
  )), true);
  assert.equal(compiled.envelope.source_failures.find((failure) => (
    failure.provider === 'documents'
  ))?.message, benignMessage);
  assert.equal(compiled.envelope.source_failures.find((failure) => (
    failure.provider === 'filesystem'
  ))?.security_control, true);
  assert.equal(compiled.envelope.source_failures.find((failure) => (
    failure.provider === 'filesystem'
  ))?.code, 'REQUIRED_SOURCE_BLOCKED');
  assert.notStrictEqual(compiled.envelope.source_failures, compiled.receipt.source_failures);
  assert.notStrictEqual(compiled.envelope.source_failures[0], compiled.receipt.source_failures[0]);
  assert.deepEqual(sourceFailures.map((failure) => failure.message), [
    blockedBasic, optionalBearer, optionalOpaque, benignMessage,
  ]);
  const receiptMessage = compiled.receipt.source_failures[0]?.message;
  compiled.envelope.source_failures[0]!.message = 'mutated';
  assert.equal(compiled.receipt.source_failures[0]?.message, receiptMessage);
  assert.equal(sourceFailures.some((failure) => failure.message === 'mutated'), false);
});

test('redacts imported envelope failures before public ablation artifacts without aliasing input', () => {
  const compiler = candidate('a', 'packages/core/src/compiler.ts', ['AC-1'], ['compiler', 'receipt']);
  const security = candidate('b', 'SECURITY.md', ['AC-2'], ['security'], {
    kind: 'document', provider: 'filesystem', authority: 'policy', authority_evidence: ['convention:root-security-file'],
  });
  const rawFailures = [
    {
      provider: 'filesystem' as const,
      code: 'REQUIRED_SOURCE_BLOCKED',
      message: 'Authorization: Basic dXNlcjpwYXNz',
      security_control: true,
    },
    {
      provider: 'fts' as const,
      code: 'OPTIONAL_SOURCE_UNAVAILABLE',
      message: 'upstream authentication failed with Bearer tiny7',
      security_control: false,
    },
    {
      provider: 'codegraph' as const,
      code: 'OPTIONAL_SOURCE_UNAVAILABLE',
      message: 'upstream rejected PrimeContextOpaqueFailure123456789',
      security_control: false,
    },
    {
      provider: 'documents' as const,
      code: 'OPTIONAL_SOURCE_UNAVAILABLE',
      message: 'Document catalog unavailable',
      security_control: false,
    },
  ];
  const compiled = compileContext(request, [compiler, security], rawFailures);
  const importedEnvelope = structuredClone(compiled.envelope);
  importedEnvelope.source_failures = structuredClone(rawFailures);
  const { selection_digest: _selectionDigest, ...envelopeWithoutDigest } = importedEnvelope;
  importedEnvelope.selection_digest = hashContextJson(envelopeWithoutDigest);
  assert.doesNotThrow(() => assertValidContextEnvelope(importedEnvelope));
  const inputSnapshot = structuredClone(importedEnvelope);

  const deniedRequest = {
    schema_version: '0.3' as const,
    task_id: request.task.task_id,
    selection_digest: importedEnvelope.selection_digest,
    candidate_id: hash('9'),
  };
  const derivedRequest = { ...deniedRequest, candidate_id: compiler.id };
  const denied = ablateContext(importedEnvelope, deniedRequest);
  const derived = ablateContext(importedEnvelope, derivedRequest);
  const replay = compareContextReplay(importedEnvelope, undefined, rawFailures);

  assert.deepEqual(ablateContext(importedEnvelope, deniedRequest), denied);
  assert.deepEqual(ablateContext(importedEnvelope, derivedRequest), derived);
  assert.deepEqual(importedEnvelope, inputSnapshot);
  assert.equal(denied.parent_selection_digest, importedEnvelope.selection_digest);
  assert.equal(derived.parent_selection_digest, importedEnvelope.selection_digest);
  assert.notStrictEqual(denied.source_failures, importedEnvelope.source_failures);
  assert.notStrictEqual(derived.source_failures, importedEnvelope.source_failures);
  for (const result of [denied, derived, replay]) {
    const resultFailures = result.source_failures ?? [];
    const publicText = JSON.stringify(result);
    for (const credential of ['dXNlcjpwYXNz', 'tiny7', 'PrimeContextOpaqueFailure123456789']) {
      assert.doesNotMatch(publicText, new RegExp(credential));
    }
    assert.match(publicText, /\[REDACTED\]/);
    assert.equal(resultFailures.find((failure) => failure.provider === 'documents')?.message, 'Document catalog unavailable');
    for (const raw of rawFailures) {
      const normalized = resultFailures.find((failure) => failure.provider === raw.provider);
      assert.equal(normalized?.code, raw.code);
      assert.equal(normalized?.security_control, raw.security_control);
      assert.notStrictEqual(normalized, raw);
    }
  }

  denied.source_failures![0]!.message = 'mutated result';
  assert.deepEqual(importedEnvelope, inputSnapshot);
  assert.notEqual(derived.source_failures?.[0]?.message, 'mutated result');
});

test('keeps maximally sized source-failure messages schema-valid after redaction expansion', () => {
  const maximumMessage = `${'Bearer a '.repeat(455)}x`;
  assert.equal([...maximumMessage].length, 4096);

  const compiled = compileContext(request, [], [{
    provider: 'fts', code: 'OPTIONAL_SOURCE_UNAVAILABLE', message: maximumMessage, security_control: false,
  }]);
  const message = compiled.envelope.source_failures[0]?.message ?? '';
  assert.ok([...message].length <= 4096);
  assert.doesNotMatch(message, /Bearer a(?:\s|$)/u);
  assert.doesNotThrow(() => assertValidTaskContextPackage(compiled));
});

test('keeps source-failure artifacts deterministic when distinct credentials redact identically', () => {
  const blocked = {
    provider: 'filesystem' as const,
    code: 'REQUIRED_SOURCE_BLOCKED',
    message: 'Authorization: Bearer alpha1',
    security_control: true,
  };
  const optional = {
    provider: 'filesystem' as const,
    code: 'REQUIRED_SOURCE_BLOCKED',
    message: 'Authorization: Bearer beta2',
    security_control: false,
  };

  const first = compileContext(request, [], [blocked, optional]);
  const second = compileContext(request, [], [optional, blocked]);
  assert.deepEqual(first, second);
});

test('treats explicitly requested expansion evidence as marginal without changing request identity', () => {
  const expansionRequest: ContextPlanRequestV03 = {
    ...request,
    task: { ...request.task, acceptance_criteria: [{ id: 'AC-1', text: 'receipt', required_terms: ['receipt'] }] },
    budget: { max_items: 2, max_bytes: 800, max_estimated_tokens: 200 },
  };
  const receipt = candidate('a', 'receipt.ts', ['AC-1'], ['receipt']);
  const requested = candidate('b', 'details.ts', [], ['requested', 'detail']);
  const initial = compileContext(expansionRequest, [receipt]);
  const expanded = expandContext(initial, expansionRequest, {
    schema_version: '0.3', task_id: expansionRequest.task.task_id,
    previous_selection_digest: initial.envelope.selection_digest,
    known_candidate_ids: initial.envelope.items.map((item) => item.id), reason: 'MISSING_TERM',
    requested_paths: ['details.ts'], requested_symbols: [], requested_terms: ['requested'],
    additional_budget: { max_items: 1, max_bytes: 100, max_estimated_tokens: 25 },
  }, [requested]);
  assert.equal(expanded.decision.status, 'ALLOWED');
  assert.deepEqual(expanded.decision.additions, [requested.id]);
  assert.equal(expanded.package.envelope.request_digest, initial.envelope.request_digest);
  assert.equal(expanded.package.envelope.items.some((item) => item.id === requested.id), true);
});

test('matches a normalized required term beyond the first 64 visible vocabulary entries', () => {
  const richRequest: ContextPlanRequestV03 = {
    ...request,
    task: { ...request.task, acceptance_criteria: [{ id: 'AC-1', text: 'deepneedle', required_terms: ['deepneedle'] }] },
  };
  const rich = candidate('a', 'rich.ts', ['AC-1'], ['placeholder']);
  rich.excerpt = `${Array.from({ length: 80 }, (_, index) => `alpha${index.toString().padStart(3, '0')}`).join(' ')} ＤｅｅｐＮｅｅｄｌｅ`;
  rich.excerpt_bytes = new TextEncoder().encode(rich.excerpt).byteLength;
  rich.estimated_tokens = Math.ceil(rich.excerpt_bytes / 4);
  rich.excerpt_hash = hashContextText(rich.excerpt);
  rich.discovery.matched_terms = ['deepneedle'];
  rich.id = createContextCandidateId(rich);
  const compiled = compileContext(richRequest, [rich]);
  assert.equal(compiled.envelope.evidence_status, 'READY');
  assert.deepEqual(compiled.envelope.criteria_coverage[0]?.matched_terms, ['deepneedle']);
});

test('bounds emitted matched terms while retaining required evidence from a rich visible vocabulary', () => {
  const richRequest: ContextPlanRequestV03 = {
    ...request,
    task: { ...request.task, acceptance_criteria: [{ id: 'AC-1', text: 'deepneedle', required_terms: ['deepneedle'] }] },
    budget: { max_items: 2, max_bytes: 4096, max_estimated_tokens: 1024 },
  };
  const phrases = Array.from(
    { length: 80 },
    (_, index) => `alpha${index.toString().padStart(3, '0')} beta${index.toString().padStart(3, '0')}`,
  );
  const rich = candidate('a', 'rich.ts', ['AC-1'], ['placeholder']);
  rich.excerpt = `${phrases.join(' ')} ＤｅｅｐＮｅｅｄｌｅ`;
  rich.excerpt_bytes = new TextEncoder().encode(rich.excerpt).byteLength;
  rich.estimated_tokens = Math.ceil(rich.excerpt_bytes / 4);
  rich.excerpt_hash = hashContextText(rich.excerpt);
  rich.discovery.matched_terms = phrases;
  rich.id = createContextCandidateId(rich);

  const compiled = compileContext(richRequest, [rich]);
  assert.equal(compiled.envelope.evidence_status, 'READY');
  assert.equal(compiled.envelope.items[0]?.discovery.matched_terms.length, 64);
  assert.equal(compiled.envelope.items[0]?.discovery.matched_terms.includes('deepneedle'), true);
});

test('rejects AT_LEAST COVERED status when no discriminative term satisfies its minimum', () => {
  const stopwordRequest: ContextPlanRequestV03 = {
    ...request,
    task: { ...request.task, acceptance_criteria: [{ id: 'AC-1', text: 'the and' }] },
    required_sources: ['required.ts'],
  };
  const required = candidate('a', 'required.ts', [], ['unrelated']);
  const compiled = compileContext(stopwordRequest, [required]);
  assert.deepEqual(compiled.envelope.criteria_coverage[0]?.required_terms, []);

  const tampered = structuredClone(compiled.envelope);
  const coverage = tampered.criteria_coverage[0]!;
  coverage.status = 'COVERED';
  coverage.candidate_ids = [required.id];
  tampered.evidence_status = 'READY';
  const { selection_digest: _digest, ...withoutDigest } = tampered;
  tampered.selection_digest = hashContextJson(withoutDigest);
  assert.throws(() => assertValidContextEnvelope(tampered), /cannot be COVERED.*match_mode/i);
});

test('package validation links budget status to budget omission decisions', () => {
  const boundedRequest: ContextPlanRequestV03 = {
    ...request,
    task: {
      ...request.task,
      acceptance_criteria: [{ id: 'AC-1', text: 'alpha beta', required_terms: ['alpha', 'beta'] }],
    },
    budget: { max_items: 1, max_bytes: 800, max_estimated_tokens: 200 },
  };
  const compiled = compileContext(boundedRequest, [
    candidate('a', 'alpha.ts', ['AC-1'], ['alpha']),
    candidate('b', 'beta.ts', ['AC-1'], ['beta']),
  ]);
  assert.equal(compiled.envelope.budget_status, 'TRUNCATED');

  const tampered = structuredClone(compiled);
  tampered.envelope.budget_status = 'WITHIN_BUDGET';
  const { selection_digest: _selectionDigest, ...envelopeWithoutDigest } = tampered.envelope;
  tampered.envelope.selection_digest = hashContextJson(envelopeWithoutDigest);
  tampered.receipt.selection_digest = tampered.envelope.selection_digest;
  const { receipt_digest: _receiptDigest, ...receiptWithoutDigest } = tampered.receipt;
  tampered.receipt.receipt_digest = hashContextJson(receiptWithoutDigest);
  assert.throws(() => assertValidTaskContextPackage(tampered), /budget_status/i);
});

test('package validation requires every conflict candidate to reference a receipt decision', () => {
  const conflictRequest: ContextPlanRequestV03 = {
    ...request,
    task: { ...request.task, acceptance_criteria: [{ id: 'AC-1', text: 'receipt', required_terms: ['receipt'] }] },
    budget: { max_items: 2, max_bytes: 800, max_estimated_tokens: 200 },
  };
  const compiled = compileContext(conflictRequest, [
    candidate('a', 'docs/specification/first.md', ['AC-1'], ['receipt'], {
      kind: 'document', provider: 'documents', authority: 'specification',
      authority_evidence: ['convention:docs-specification-directory'], symbol: 'compileContext', source_hash: hash('a'),
    }),
    candidate('b', 'docs/specification/second.md', ['AC-1'], ['receipt'], {
      kind: 'document', provider: 'documents', authority: 'specification',
      authority_evidence: ['convention:docs-specification-directory'], symbol: 'compileContext', source_hash: hash('b'),
    }),
  ]);
  const tampered = structuredClone(compiled);
  tampered.envelope.conflicts[0]!.candidate_ids[0] = hash('e');
  tampered.envelope.conflicts[0]!.candidate_ids.sort();
  const { selection_digest: _selectionDigest, ...envelopeWithoutDigest } = tampered.envelope;
  tampered.envelope.selection_digest = hashContextJson(envelopeWithoutDigest);
  tampered.receipt.selection_digest = tampered.envelope.selection_digest;
  tampered.receipt.conflicts = structuredClone(tampered.envelope.conflicts);
  const { receipt_digest: _receiptDigest, ...receiptWithoutDigest } = tampered.receipt;
  tampered.receipt.receipt_digest = hashContextJson(receiptWithoutDigest);
  assert.throws(() => assertValidTaskContextPackage(tampered), /conflict.*decision/i);
});
