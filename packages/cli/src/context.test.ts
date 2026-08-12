import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  validateContextEnvelope,
  validateOutcomeReceipt,
  validateSelectionReceipt,
} from '@primecontext/schemas';
import { hashContextJson } from '@primecontext/core';
import {
  contextAblateCommand,
  contextExpandCommand,
  contextIndexCommand,
  contextInspectCommand,
  contextOutcomeCommand,
  contextPlanCommand,
  contextReplayCommand,
  defaultConfig,
  initCommand,
} from './index.js';

async function contextFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'primecontext-context-'));
  await mkdir(join(root, 'docs'), { recursive: true });
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'context-fixture', type: 'module' }));
  await writeFile(join(root, 'README.md'), '# Context Fixture\n\nProof-carrying context compiler.');
  await writeFile(join(root, 'docs', 'security.md'), '# Security policy\n\nThe compiler emits a selection receipt.');
  await writeFile(join(root, 'src', 'compiler.ts'), [
    'export interface Receipt { digest: string }',
    'export function compileContext(): Receipt {',
    "  return { digest: 'deterministic' };",
    '}',
  ].join('\n'));
  return root;
}

function requestValue(
  worktreeDigest = `sha256:${'a'.repeat(64)}`,
  repositoryId = 'context-fixture',
) {
  return {
    schema_version: '0.3',
    task: {
      task_id: 'CTX-VERTICAL-001',
      task_type: 'module_feature',
      goal: 'Compile proof-carrying context',
      query: 'compiler selection receipt security',
      acceptance_criteria: [
        { id: 'AC-1', text: 'Compiler evidence is selected', required_terms: ['compiler'] },
        { id: 'AC-2', text: 'A selection receipt is represented', required_terms: ['receipt'] },
      ],
      hints: { paths: ['src/compiler.ts'], symbols: ['compileContext'], terms: ['security'] },
    },
    budget: { max_items: 8, max_bytes: 32_768, max_estimated_tokens: 8_192 },
    snapshot: { repository_id: repositoryId, worktree_digest: worktreeDigest },
    policy_version: '0.3-default',
  };
}

test('indexes local documents and TypeScript structure, then compiles an inspectable envelope', async () => {
  const root = await contextFixture();
  await initCommand(root);
  const indexed = await contextIndexCommand(root);
  assert.match(indexed.index_path, /\.primecontext\/context\/index\.sqlite$/);
  assert.ok(indexed.indexed_source_count >= 2);
  assert.ok(indexed.code_symbol_count >= 2);
  assert.match(indexed.index_digest, /^sha256:[0-9a-f]{64}$/);

  const requestPath = 'context-request.json';
  const request = requestValue(indexed.worktree_digest, indexed.repository_id);
  request.task.acceptance_criteria.push({
    id: 'AC-3', text: 'Repository structure is represented', required_terms: ['repository'],
  });
  await writeFile(join(root, requestPath), JSON.stringify(request));
  const planned = await contextPlanCommand(root, requestPath);
  assert.equal(planned.task_id, 'CTX-VERTICAL-001');
  assert.match(planned.selection_digest, /^sha256:[0-9a-f]{64}$/);

  const inspected = await contextInspectCommand(root, 'CTX-VERTICAL-001');
  assert.equal(validateContextEnvelope(inspected.envelope).valid, true);
  assert.equal(validateSelectionReceipt(inspected.receipt).valid, true);
  assert.equal(inspected.envelope.selection_digest, inspected.receipt.selection_digest);
  assert.ok(inspected.envelope.items.some((item) => item.provider === 'codegraph'));
  assert.ok(inspected.envelope.items.some((item) => item.provider === 'fts'));
  assert.ok(inspected.envelope.items.some((item) => item.provider === 'repo_map'));
  const ftsItem = inspected.envelope.items.find((item) => item.provider === 'fts');
  assert.equal(ftsItem?.freshness, 'live');
  assert.equal(ftsItem?.authority_evidence.includes('safe-live-source-reread'), true);
  assert.equal(inspected.envelope.items.find((item) => item.provider === 'codegraph')?.freshness, 'snapshot');
});

test('excludes a configured non-default state directory from indexing and selection', async () => {
  const root = await contextFixture();
  const stateDirectory = '.prime-cache';
  await writeFile(join(root, 'primecontext.config.json'), JSON.stringify({
    ...defaultConfig(),
    state_dir: stateDirectory,
  }));
  await initCommand(root);
  const before = await contextIndexCommand(root);
  const sentinelPath = join(stateDirectory, 'private-context.md');
  const sentinel = 'state-only-sentinel-9284';
  await writeFile(join(root, sentinelPath), `# Private context\n\n${sentinel}\n`);

  const after = await contextIndexCommand(root);
  assert.equal(after.document_source_count, before.document_source_count);
  assert.equal(after.indexed_source_count, before.indexed_source_count);
  assert.equal(after.worktree_digest, before.worktree_digest);

  const requestPath = 'state-exclusion-request.json';
  const request = {
    ...requestValue(after.worktree_digest, after.repository_id),
    task: {
      ...requestValue(after.worktree_digest, after.repository_id).task,
      query: sentinel,
      hints: { paths: [sentinelPath.replaceAll('\\', '/')], symbols: [], terms: [sentinel] },
      acceptance_criteria: [{ id: 'AC-STATE', text: 'State-only sentinel', required_terms: [sentinel] }],
    },
    required_sources: [sentinelPath.replaceAll('\\', '/')],
  };
  await writeFile(join(root, requestPath), JSON.stringify(request));
  await contextPlanCommand(root, requestPath);
  const inspected = await contextInspectCommand(root, 'CTX-VERTICAL-001');
  assert.equal(inspected.envelope.items.some((item) => item.path === sentinelPath.replaceAll('\\', '/')), false);
});

test('records observational outcome and creates a non-causal ablation linked to the selection', async () => {
  const root = await contextFixture();
  await initCommand(root);
  const requestPath = 'context-request.json';
  const indexed = await contextIndexCommand(root);
  await writeFile(join(root, requestPath), JSON.stringify(requestValue(indexed.worktree_digest, indexed.repository_id)));
  await contextPlanCommand(root, requestPath);
  const inspected = await contextInspectCommand(root, 'CTX-VERTICAL-001');
  const candidateId = inspected.envelope.items[0]?.id as string;

  const outcomePath = 'outcome.json';
  await writeFile(join(root, outcomePath), JSON.stringify({
    schema_version: '0.3', run_id: 'RUN-001', task_id: 'CTX-VERTICAL-001',
    selection_digest: inspected.envelope.selection_digest, snapshot: inspected.envelope.snapshot,
    started_at: '2026-08-12T11:59:00.000Z', recorded_at: '2026-08-12T12:00:00.000Z', used_candidate_ids: [candidateId],
    touched_paths: ['src/compiler.ts'], test_status: 'PASS', review_status: 'NOT_RUN',
    completion_status: 'PASS', metrics: { duration_ms: 100, input_tokens: 200, output_tokens: 50 }, source: 'tool',
  }));
  const outcome = await contextOutcomeCommand(root, 'CTX-VERTICAL-001', outcomePath);
  assert.equal(validateOutcomeReceipt(outcome.receipt).valid, true);
  assert.equal(outcome.receipt.causality, 'OBSERVATIONAL_ONLY');

  const ablation = await contextAblateCommand(root, 'CTX-VERTICAL-001', candidateId);
  assert.equal(ablation.experimental, true);
  assert.equal(ablation.causal_claim, 'NONE');
  assert.notEqual(ablation.ablated_selection_digest, inspected.envelope.selection_digest);
});

test('links bounded expansion and deterministic replay to the stored selection', async () => {
  const root = await contextFixture();
  await initCommand(root);
  await writeFile(join(root, 'docs', 'later-one.md'), '# Later one\n\nuniquefirstexpansion evidence.');
  await writeFile(join(root, 'docs', 'later-two.md'), '# Later two\n\nuniquesecondexpansion evidence.');
  const indexed = await contextIndexCommand(root);
  const requestPath = 'context-request.json';
  const request = requestValue(indexed.worktree_digest, indexed.repository_id);
  request.task.query = 'compiler';
  request.task.acceptance_criteria = [{ ...request.task.acceptance_criteria[0]! }];
  request.task.hints = { paths: ['src/compiler.ts'], symbols: ['compileContext'], terms: [] };
  request.budget = { max_items: 32, max_bytes: 1_048_576, max_estimated_tokens: 262_144 };
  await writeFile(join(root, requestPath), JSON.stringify(request));
  await contextPlanCommand(root, requestPath);
  const before = await contextInspectCommand(root, 'CTX-VERTICAL-001');
  const expansionPath = 'expansion.json';
  await writeFile(join(root, expansionPath), JSON.stringify({
    schema_version: '0.3', task_id: 'CTX-VERTICAL-001',
    previous_selection_digest: before.envelope.selection_digest,
    known_candidate_ids: before.envelope.items.map((item) => item.id),
    reason: 'MISSING_TERM', requested_paths: [], requested_symbols: [], requested_terms: ['uniquefirstexpansion'],
    additional_budget: { max_items: 2, max_bytes: 4096, max_estimated_tokens: 1024 },
  }));
  const expanded = await contextExpandCommand(root, 'CTX-VERTICAL-001', expansionPath);
  assert.ok(['ALLOWED', 'PARTIAL'].includes(expanded.decision.status));
  assert.equal(expanded.decision.previous_selection_digest, before.envelope.selection_digest);
  assert.deepEqual(await contextExpandCommand(root, 'CTX-VERTICAL-001', expansionPath), expanded);

  const afterFirst = await contextInspectCommand(root, 'CTX-VERTICAL-001');
  const secondExpansionPath = 'expansion-second.json';
  await writeFile(join(root, secondExpansionPath), JSON.stringify({
    schema_version: '0.3', task_id: 'CTX-VERTICAL-001',
    previous_selection_digest: afterFirst.envelope.selection_digest,
    known_candidate_ids: afterFirst.envelope.items.map((item) => item.id),
    reason: 'MISSING_TERM', requested_paths: [], requested_symbols: [], requested_terms: ['uniquesecondexpansion'],
    additional_budget: { max_items: 2, max_bytes: 4096, max_estimated_tokens: 1024 },
  }));
  const second = await contextExpandCommand(root, 'CTX-VERTICAL-001', secondExpansionPath);
  assert.ok(['ALLOWED', 'PARTIAL'].includes(second.decision.status));
  const staleRetry = await contextExpandCommand(root, 'CTX-VERTICAL-001', expansionPath);
  assert.equal(staleRetry.decision.status, 'DENIED');
  assert.deepEqual(staleRetry.decision.reason_codes, ['STALE_PARENT']);

  const replay = await contextReplayCommand(root, 'CTX-VERTICAL-001');
  assert.equal(replay.status, 'IDENTICAL');
  assert.equal(replay.freshness, 'MATCHED');
  assert.match(replay.replay_digest, /^sha256:[0-9a-f]{64}$/);
});

test('compiled CLI exposes strict v0.3 context commands without weakening prior help', async () => {
  const root = await contextFixture();
  const bin = fileURLToPath(new URL('./bin.js', import.meta.url));
  const run = (...args: string[]) => spawnSync(process.execPath, [bin, ...args], { cwd: root, encoding: 'utf8' });
  const help = run('--help');
  assert.equal(help.status, 0);
  assert.match(help.stdout, /primecontext context index/);
  assert.match(help.stdout, /primecontext docs search/);

  for (const args of [
    ['context'],
    ['context', 'index', 'extra'],
    ['context', 'plan'],
    ['context', 'plan', '--from'],
    ['context', 'inspect', '../escape'],
    ['context', 'outcome', 'CTX', '--from'],
    ['context', 'ablate', 'CTX', '--candidate'],
    ['context', 'unknown'],
  ]) {
    const result = run(...args);
    assert.equal(result.status, 1, args.join(' '));
    assert.match(result.stderr, /VALIDATION_ERROR|SECURITY_ERROR/, args.join(' '));
  }
});

test('invalid plan input is rejected before optional index I/O', async () => {
  const root = await contextFixture();
  await initCommand(root);
  const invalid = 'invalid-context-request.json';
  await writeFile(join(root, invalid), JSON.stringify({ ...requestValue(), budget: { max_items: 0 } }));
  await assert.rejects(() => contextPlanCommand(root, invalid), /VALIDATION_ERROR/);
});

test('outcome ledger rejects a previously tampered digest before replacement', async () => {
  const root = await contextFixture();
  await initCommand(root);
  const indexed = await contextIndexCommand(root);
  const requestPath = 'context-request.json';
  await writeFile(join(root, requestPath), JSON.stringify(requestValue(indexed.worktree_digest, indexed.repository_id)));
  await contextPlanCommand(root, requestPath);
  const inspected = await contextInspectCommand(root, 'CTX-VERTICAL-001');
  const candidateId = inspected.envelope.items[0]?.id as string;
  const outcomePath = 'outcome.json';
  const declaration = {
    schema_version: '0.3', run_id: 'RUN-TAMPER', task_id: 'CTX-VERTICAL-001',
    selection_digest: inspected.envelope.selection_digest, snapshot: inspected.envelope.snapshot,
    started_at: '2026-08-12T11:59:00.000Z', recorded_at: '2026-08-12T12:00:00.000Z',
    used_candidate_ids: [candidateId], touched_paths: ['src/compiler.ts'], test_status: 'PASS',
    review_status: 'NOT_RUN', completion_status: 'PASS', metrics: {}, source: 'tool',
  };
  await writeFile(join(root, outcomePath), JSON.stringify(declaration));
  const first = await contextOutcomeCommand(root, 'CTX-VERTICAL-001', outcomePath);
  const ledgerPath = join(root, first.outcome_path.replaceAll('/', '\\'));
  const record = JSON.parse((await readFile(ledgerPath, 'utf8')).trim()) as Record<string, unknown>;
  record.outcome_digest = `sha256:${'0'.repeat(64)}`;
  await writeFile(ledgerPath, `${JSON.stringify(record)}\n`);
  await assert.rejects(
    () => contextOutcomeCommand(root, 'CTX-VERTICAL-001', outcomePath),
    /OutcomeReceipt digest|STATE_ERROR/,
  );
});

test('safe filesystem fallback indexes non-TypeScript sources and binds them to freshness', async () => {
  const root = await contextFixture();
  await writeFile(join(root, 'src', 'worker.py'), 'def unique_python_worker():\n    return "python-proof"\n');
  await initCommand(root);
  const indexed = await contextIndexCommand(root);
  const requestPath = 'python-request.json';
  const request = requestValue(indexed.worktree_digest, indexed.repository_id);
  request.task.query = 'unique python worker';
  request.task.hints = { paths: ['src/worker.py'], symbols: [], terms: ['python-proof'] };
  request.task.acceptance_criteria = [{ id: 'AC-PY', text: 'Python worker', required_terms: ['python'] }];
  await writeFile(join(root, requestPath), JSON.stringify(request));
  await contextPlanCommand(root, requestPath);
  const inspected = await contextInspectCommand(root, 'CTX-VERTICAL-001');
  assert.ok(inspected.envelope.items.some((item) => item.provider === 'filesystem' && item.path === 'src/worker.py'));

  await writeFile(join(root, 'src', 'worker.py'), 'def unique_python_worker():\n    return "changed"\n');
  const changed = await contextIndexCommand(root);
  assert.notEqual(changed.worktree_digest, indexed.worktree_digest);
});

test('outcome must use the stored snapshot and selected candidate ids', async () => {
  const root = await contextFixture();
  await initCommand(root);
  const indexed = await contextIndexCommand(root);
  const requestPath = 'context-request.json';
  await writeFile(join(root, requestPath), JSON.stringify(requestValue(indexed.worktree_digest, indexed.repository_id)));
  await contextPlanCommand(root, requestPath);
  const inspected = await contextInspectCommand(root, 'CTX-VERTICAL-001');
  const outcomePath = 'bad-outcome.json';
  await writeFile(join(root, outcomePath), JSON.stringify({
    schema_version: '0.3', run_id: 'RUN-BAD', task_id: 'CTX-VERTICAL-001',
    selection_digest: inspected.envelope.selection_digest,
    snapshot: { ...inspected.envelope.snapshot, worktree_digest: `sha256:${'f'.repeat(64)}` },
    started_at: '2026-08-12T11:59:00.000Z', recorded_at: '2026-08-12T12:00:00.000Z',
    used_candidate_ids: [`sha256:${'e'.repeat(64)}`], touched_paths: [], metrics: {},
    test_status: 'PASS', review_status: 'NOT_RUN', completion_status: 'PASS', source: 'tool',
  }));
  await assert.rejects(() => contextOutcomeCommand(root, 'CTX-VERTICAL-001', outcomePath), /stored context selection/i);
});

test('expansion retries are idempotent and a ninth unique request is rejected', async () => {
  const root = await contextFixture();
  await initCommand(root);
  const indexed = await contextIndexCommand(root);
  const requestPath = 'context-request.json';
  await writeFile(join(root, requestPath), JSON.stringify(requestValue(indexed.worktree_digest, indexed.repository_id)));
  await contextPlanCommand(root, requestPath);
  let inspected = await contextInspectCommand(root, 'CTX-VERTICAL-001');
  let firstDecision: Awaited<ReturnType<typeof contextExpandCommand>> | undefined;
  for (let index = 0; index < 8; index += 1) {
    const path = `expansion-${index}.json`;
    await writeFile(join(root, path), JSON.stringify({
      schema_version: '0.3', task_id: 'CTX-VERTICAL-001',
      previous_selection_digest: inspected.envelope.selection_digest,
      known_candidate_ids: inspected.envelope.items.map((item) => item.id), reason: 'MISSING_TERM',
      requested_paths: [], requested_symbols: [], requested_terms: [`missing${index}`],
      additional_budget: { max_items: 1, max_bytes: 1024, max_estimated_tokens: 256 },
    }));
    const decision = await contextExpandCommand(root, 'CTX-VERTICAL-001', path);
    if (index === 0) {
      firstDecision = decision;
      assert.deepEqual(await contextExpandCommand(root, 'CTX-VERTICAL-001', path), decision);
    }
    inspected = await contextInspectCommand(root, 'CTX-VERTICAL-001');
  }
  assert.ok(firstDecision);
  const ninth = 'expansion-9.json';
  await writeFile(join(root, ninth), JSON.stringify({
    schema_version: '0.3', task_id: 'CTX-VERTICAL-001',
    previous_selection_digest: inspected.envelope.selection_digest,
    known_candidate_ids: inspected.envelope.items.map((item) => item.id), reason: 'MISSING_TERM',
    requested_paths: [], requested_symbols: [], requested_terms: ['ninth'],
    additional_budget: { max_items: 1, max_bytes: 1024, max_estimated_tokens: 256 },
  }));
  await assert.rejects(() => contextExpandCommand(root, 'CTX-VERTICAL-001', ninth), /expansion count limit/i);
});

test('replay rejects a tampered expansion ledger instead of hiding corrupt state', async () => {
  const root = await contextFixture();
  await initCommand(root);
  const indexed = await contextIndexCommand(root);
  const requestPath = 'context-request.json';
  await writeFile(join(root, requestPath), JSON.stringify(requestValue(indexed.worktree_digest, indexed.repository_id)));
  await contextPlanCommand(root, requestPath);
  const stored = await contextInspectCommand(root, 'CTX-VERTICAL-001');
  const expansionPath = 'tamper-expansion.json';
  await writeFile(join(root, expansionPath), JSON.stringify({
    schema_version: '0.3', task_id: 'CTX-VERTICAL-001', previous_selection_digest: stored.envelope.selection_digest,
    known_candidate_ids: stored.envelope.items.map((item) => item.id), reason: 'MISSING_TERM',
    requested_paths: [], requested_symbols: [], requested_terms: ['absent'],
    additional_budget: { max_items: 1, max_bytes: 1024, max_estimated_tokens: 256 },
  }));
  await contextExpandCommand(root, 'CTX-VERTICAL-001', expansionPath);
  const ledger = join(root, '.primecontext', 'context', 'plans', 'CTX-VERTICAL-001', 'expansions.jsonl');
  const record = JSON.parse((await readFile(ledger, 'utf8')).trim()) as Record<string, unknown>;
  record.record_digest = `sha256:${'0'.repeat(64)}`;
  await writeFile(ledger, `${JSON.stringify(record)}\n`);
  await assert.rejects(() => contextReplayCommand(root, 'CTX-VERTICAL-001'), /STATE_ERROR|expansion ledger/i);
});

test('expansion retry rejects a coherently rehashed ledger that is not anchored to the stored plan', async () => {
  const root = await contextFixture();
  await initCommand(root);
  const indexed = await contextIndexCommand(root);
  const requestPath = 'context-request.json';
  await writeFile(join(root, requestPath), JSON.stringify(requestValue(indexed.worktree_digest, indexed.repository_id)));
  await contextPlanCommand(root, requestPath);
  const stored = await contextInspectCommand(root, 'CTX-VERTICAL-001');
  const expansionPath = 'anchored-expansion.json';
  const expansion = {
    schema_version: '0.3', task_id: 'CTX-VERTICAL-001', previous_selection_digest: stored.envelope.selection_digest,
    known_candidate_ids: stored.envelope.items.map((item) => item.id), reason: 'MISSING_TERM',
    requested_paths: [], requested_symbols: [], requested_terms: ['originally-absent'],
    additional_budget: { max_items: 1, max_bytes: 1024, max_estimated_tokens: 256 },
  };
  await writeFile(join(root, expansionPath), JSON.stringify(expansion));
  await contextExpandCommand(root, 'CTX-VERTICAL-001', expansionPath);

  const ledger = join(root, '.primecontext', 'context', 'plans', 'CTX-VERTICAL-001', 'expansions.jsonl');
  const record = JSON.parse((await readFile(ledger, 'utf8')).trim()) as {
    schema_version: '0.3'; request: typeof expansion; decision: Record<string, unknown>; record_digest: string;
  };
  record.request.requested_terms = ['coherently-forged'];
  record.record_digest = hashContextJson({
    schema_version: '0.3', request: record.request, decision: record.decision,
  });
  await writeFile(ledger, `${JSON.stringify(record)}\n`);
  const forgedPath = 'forged-expansion.json';
  await writeFile(join(root, forgedPath), JSON.stringify(record.request));

  await assert.rejects(
    () => contextExpandCommand(root, 'CTX-VERTICAL-001', forgedPath),
    /STATE_ERROR|ledger.*anchor|ledger.*digest/i,
  );
});

test('replay is unavailable when the stored snapshot requires a Git head but Git metadata disappears', async () => {
  const root = await contextFixture();
  for (const args of [
    ['init', '-q'],
    ['config', 'user.email', 'primecontext@example.invalid'],
    ['config', 'user.name', 'PrimeContext Test'],
    ['add', '.'],
    ['commit', '-qm', 'fixture'],
  ]) {
    const git = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(git.status, 0, git.stderr);
  }
  await initCommand(root);
  const indexed = await contextIndexCommand(root);
  assert.ok(indexed.head);
  const base = requestValue(indexed.worktree_digest, indexed.repository_id);
  const request = { ...base, snapshot: { ...base.snapshot, head: indexed.head } };
  const requestPath = 'headed-request.json';
  await writeFile(join(root, requestPath), JSON.stringify(request));
  await contextPlanCommand(root, requestPath);
  await rm(join(root, '.git'), { recursive: true, force: true });

  const replay = await contextReplayCommand(root, 'CTX-VERTICAL-001');
  assert.equal(replay.status, 'UNREPLAYABLE');
  assert.equal(replay.freshness, 'UNAVAILABLE');
  assert.ok(replay.source_failures.some((failure) => (
    failure.provider === 'git' && failure.code === 'REPLAY_HEAD_UNAVAILABLE'
  )));
});

test('index rebuild lock preserves a valid index and manifest while reporting fallback', async () => {
  const root = await contextFixture();
  await initCommand(root);
  await contextIndexCommand(root);
  const indexPath = join(root, '.primecontext', 'context', 'index.sqlite');
  const manifestPath = join(root, '.primecontext', 'context', 'index-manifest.json');
  const beforeIndex = await readFile(indexPath);
  const beforeManifest = await readFile(manifestPath, 'utf8');
  const lockPath = `${indexPath}.lock`;
  await writeFile(lockPath, 'held by concurrent test');

  const fallback = await contextIndexCommand(root) as Awaited<ReturnType<typeof contextIndexCommand>> & {
    fallback_used?: boolean;
    source_failures?: Array<{ provider: string; code: string }>;
  };
  assert.deepEqual(await readFile(indexPath), beforeIndex);
  assert.equal(await readFile(manifestPath, 'utf8'), beforeManifest);
  assert.equal(fallback.fallback_used, true);
  assert.ok(fallback.source_failures?.some((failure) => (
    failure.provider === 'fts' && failure.code === 'OPTIONAL_SOURCE_UNAVAILABLE'
  )));
  await rm(lockPath, { force: true });
});

test('manifest publication failure rolls the FTS database back to the prior valid bytes', {
  skip: process.platform !== 'win32' && 'Windows read-only replacement semantics are required for this fault injection',
}, async () => {
  const root = await contextFixture();
  await initCommand(root);
  await contextIndexCommand(root);
  const indexPath = join(root, '.primecontext', 'context', 'index.sqlite');
  const manifestPath = join(root, '.primecontext', 'context', 'index-manifest.json');
  const beforeIndex = await readFile(indexPath);
  const beforeManifest = await readFile(manifestPath, 'utf8');
  await writeFile(join(root, 'src', 'compiler.ts'), 'export const changedAfterIndex = true;\n');
  await chmod(manifestPath, 0o444);
  try {
    await assert.rejects(() => contextIndexCommand(root), /IO_ERROR|replace repository file atomically/i);
    assert.deepEqual(await readFile(indexPath), beforeIndex);
    assert.equal(await readFile(manifestPath, 'utf8'), beforeManifest);
  } finally {
    await chmod(manifestPath, 0o666);
  }
});

test('document candidate cap prioritizes required sources and exposes provider truncation', async () => {
  const root = await contextFixture();
  await mkdir(join(root, 'docs', 'generated'), { recursive: true });
  for (let index = 0; index < 1_025; index += 1) {
    await writeFile(
      join(root, 'docs', 'generated', `bulk-${String(index).padStart(4, '0')}.md`),
      `# Bulk ${index}\n\nsharedneedle evidence ${index}.`,
    );
  }
  await writeFile(join(root, 'docs', 'z-required.md'), '# Required\n\nsharedneedle required proof.');
  await initCommand(root);
  const indexed = await contextIndexCommand(root);
  const base = requestValue(indexed.worktree_digest, indexed.repository_id);
  const request = {
    ...base,
    task: {
      ...base.task,
      query: 'sharedneedle',
      acceptance_criteria: [{ id: 'AC-DOC', text: 'Shared document evidence', required_terms: ['sharedneedle'] }],
      hints: { paths: [], symbols: [], terms: ['sharedneedle'] },
    },
    required_sources: ['docs/z-required.md'],
    budget: { max_items: 8, max_bytes: 32_768, max_estimated_tokens: 8_192 },
  };
  const requestPath = 'document-cap-request.json';
  await writeFile(join(root, requestPath), JSON.stringify(request));
  await contextPlanCommand(root, requestPath);
  const stored = await contextInspectCommand(root, 'CTX-VERTICAL-001');
  assert.ok(stored.envelope.items.some((item) => item.path === 'docs/z-required.md'));
  assert.equal(stored.envelope.missing_required_sources.includes('docs/z-required.md'), false);
  assert.equal(stored.envelope.truncation.source_truncated, true);
  assert.ok(stored.envelope.truncation.considered_candidates <= 2_048);
});

test('replanning a task invalidates its prior expansion chain', async () => {
  const root = await contextFixture();
  await initCommand(root);
  const indexed = await contextIndexCommand(root);
  const requestPath = 'context-request.json';
  const firstRequest = requestValue(indexed.worktree_digest, indexed.repository_id);
  await writeFile(join(root, requestPath), JSON.stringify(firstRequest));
  await contextPlanCommand(root, requestPath);
  const first = await contextInspectCommand(root, 'CTX-VERTICAL-001');
  const expansionPath = 'old-expansion.json';
  const oldExpansion = {
    schema_version: '0.3', task_id: 'CTX-VERTICAL-001', previous_selection_digest: first.envelope.selection_digest,
    known_candidate_ids: first.envelope.items.map((item) => item.id), reason: 'MISSING_TERM',
    requested_paths: [], requested_symbols: [], requested_terms: ['absent'],
    additional_budget: { max_items: 1, max_bytes: 1024, max_estimated_tokens: 256 },
  };
  await writeFile(join(root, expansionPath), JSON.stringify(oldExpansion));
  await contextExpandCommand(root, 'CTX-VERTICAL-001', expansionPath);
  await writeFile(join(root, requestPath), JSON.stringify({ ...firstRequest, policy_version: '0.3-replanned' }));
  await contextPlanCommand(root, requestPath);
  const retried = await contextExpandCommand(root, 'CTX-VERTICAL-001', expansionPath);
  assert.equal(retried.decision.status, 'DENIED');
  assert.deepEqual(retried.decision.reason_codes, ['STALE_PARENT']);
});

test('fallback excerpt is bounded around a relevant term beyond line 400', async () => {
  const root = await contextFixture();
  const lines = Array.from({ length: 1_000 }, (_value, index) => index === 899 ? 'deepneedle proof' : `safe line ${index}`);
  await writeFile(join(root, 'src', 'deep.py'), lines.join('\n'));
  await initCommand(root);
  const indexed = await contextIndexCommand(root);
  await rm(join(root, '.primecontext', 'context', 'index.sqlite'));
  const requestPath = 'deep-request.json';
  const request = requestValue(indexed.worktree_digest, indexed.repository_id);
  request.task.query = 'deepneedle';
  request.task.acceptance_criteria = [{ id: 'AC-DEEP', text: 'Deep evidence', required_terms: ['deepneedle'] }];
  request.task.hints = { paths: ['src/deep.py'], symbols: [], terms: ['deepneedle'] };
  await writeFile(join(root, requestPath), JSON.stringify(request));
  await contextPlanCommand(root, requestPath);
  const stored = await contextInspectCommand(root, 'CTX-VERTICAL-001');
  const selected = stored.envelope.items.find((item) => item.path === 'src/deep.py');
  assert.ok(selected);
  assert.match(selected.excerpt, /deepneedle/);
  assert.ok(selected.excerpt.split(/\r?\n/u).length <= 400);
});
