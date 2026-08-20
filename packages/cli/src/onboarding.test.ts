import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';
import {
  validateContextEnvelope,
  validateContextPlanRequest,
  validateSelectionReceipt,
  type ContextEnvelopeV03,
  type ContextIntentV03,
  type ContextPlanRequestV03,
  type SelectionReceiptV03,
} from '@primecontext/schemas';
import {
  capabilitiesCommand,
  contextPrepareCommand,
  defaultConfig,
  doctorCommand,
  initCommand,
} from './index.js';

interface PreparedContextResult {
  request: ContextPlanRequestV03;
  envelope: ContextEnvelopeV03;
  receipt: SelectionReceiptV03;
  plan_path: string;
}

async function onboardingFixture(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'primecontext-onboarding-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'docs'), { recursive: true });
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({
    name: 'onboarding-fixture',
    private: true,
    type: 'module',
  }));
  await writeFile(join(root, 'README.md'), '# Onboarding fixture\n\nProof-carrying context compiler.\n');
  await writeFile(join(root, 'docs', 'security.md'), '# Security\n\nSelections include provenance and freshness.\n');
  await writeFile(join(root, 'src', 'compiler.ts'), [
    'export interface SelectionReceipt { selection_digest: string }',
    'export function compileContext(): SelectionReceipt {',
    "  return { selection_digest: 'deterministic' };",
    '}',
  ].join('\n'));
  return root;
}

function intent(taskId = 'ONBOARD-001'): ContextIntentV03 {
  return {
    schema_version: '0.3',
    task_id: taskId,
    task_type: 'module_feature',
    goal: 'Compile inspectable proof-carrying context',
    acceptance: [
      'Compiler evidence is selected',
      'A linked selection receipt is emitted',
    ],
    paths: ['src/compiler.ts'],
    symbols: ['compileContext'],
    terms: ['compiler', 'receipt'],
    required_sources: ['docs/security.md'],
  };
}

function asPrepared(value: unknown): PreparedContextResult {
  assert.equal(typeof value, 'object');
  assert.notEqual(value, null);
  return value as PreparedContextResult;
}

function absolutePlanPath(root: string, planPath: string): string {
  return isAbsolute(planPath) ? planPath : resolve(root, planPath);
}

function assertPreparedResult(root: string, value: unknown, expectedIntent: ContextIntentV03): PreparedContextResult {
  const prepared = asPrepared(value);
  assert.equal(validateContextPlanRequest(prepared.request).valid, true);
  assert.equal(validateContextEnvelope(prepared.envelope).valid, true);
  assert.equal(validateSelectionReceipt(prepared.receipt).valid, true);
  assert.equal(prepared.request.task.task_id, expectedIntent.task_id);
  assert.equal(prepared.request.task.task_type, expectedIntent.task_type);
  assert.equal(prepared.request.task.goal, expectedIntent.goal);
  assert.deepEqual(
    prepared.request.task.acceptance_criteria.map((criterion) => criterion.text),
    expectedIntent.acceptance,
  );
  assert.ok(prepared.request.task.query.length > 0);
  assert.match(prepared.request.snapshot.worktree_digest, /^sha256:[0-9a-f]{64}$/);
  assert.ok(prepared.request.snapshot.repository_id.length > 0);
  assert.ok(prepared.request.policy_version.length > 0);
  assert.ok(prepared.request.budget.max_items > 0);
  assert.ok(prepared.request.budget.max_bytes > 0);
  assert.ok(prepared.request.budget.max_estimated_tokens > 0);
  assert.deepEqual(prepared.request.required_sources, expectedIntent.required_sources);
  assert.equal(prepared.envelope.task_id, expectedIntent.task_id);
  assert.equal(prepared.receipt.task_id, expectedIntent.task_id);
  assert.equal(prepared.envelope.request_digest, prepared.receipt.request_digest);
  assert.equal(prepared.envelope.selection_digest, prepared.receipt.selection_digest);
  assert.ok(prepared.plan_path.length > 0);
  assert.equal(absolutePlanPath(root, prepared.plan_path).startsWith(resolve(root)), true);
  return prepared;
}

function runCli(root: string, args: string[], input?: string): SpawnSyncReturns<string> {
  const bin = fileURLToPath(new URL('./bin.js', import.meta.url));
  return spawnSync(process.execPath, [bin, ...args], {
    cwd: root,
    encoding: 'utf8',
    ...(input === undefined ? {} : { input }),
  });
}

function parseSuccessfulJson(run: SpawnSyncReturns<string>, label: string): unknown {
  assert.equal(run.status, 0, `${label}: ${run.stderr}`);
  assert.equal(run.stderr, '', label);
  assert.ok(run.stdout.trim().length > 0, label);
  return JSON.parse(run.stdout) as unknown;
}

function assertJsonFailure(run: SpawnSyncReturns<string>, label: string): void {
  assert.equal(run.status, 1, label);
  assert.equal(run.stdout, '', label);
  const failure = JSON.parse(run.stderr) as { error?: { code?: unknown; message?: unknown } };
  assert.equal(typeof failure.error?.code, 'string', label);
  assert.equal(typeof failure.error?.message, 'string', label);
  assert.ok((failure.error?.message as string).length > 0, label);
}

test('exports machine-readable capabilities and repository diagnostics', async (t) => {
  const root = await onboardingFixture(t);
  await initCommand(root);

  const capabilities = await capabilitiesCommand(root);
  const diagnostics = await doctorCommand(root);
  const serializedCapabilities = JSON.stringify(capabilities);
  const serializedDiagnostics = JSON.stringify(diagnostics);

  assert.doesNotThrow(() => JSON.parse(serializedCapabilities));
  assert.doesNotThrow(() => JSON.parse(serializedDiagnostics));
  assert.match(serializedCapabilities, /capabilit/i);
  assert.match(serializedCapabilities, /context.{0,4}prepare/i);
  assert.match(serializedDiagnostics, /status/i);
  assert.deepEqual(diagnostics.next_actions, ['Run primecontext prepare "<goal>"']);
});

test('doctor reports the initialization action without mutating an untouched repository', async (t) => {
  const root = await onboardingFixture(t);
  const before = await readdir(root, { recursive: true });
  const diagnostics = await doctorCommand(root);
  const after = await readdir(root, { recursive: true });
  assert.equal(diagnostics.status, 'BLOCKED');
  assert.equal(diagnostics.repository.initialized, false);
  assert.ok(diagnostics.next_actions.includes('Run primecontext setup'));
  assert.deepEqual(after, before);
});

test('doctor and context prepare fail closed when the local state directory is not ignored', async (t) => {
  const root = await onboardingFixture(t);
  await initCommand(root);
  await rm(join(root, '.gitignore'));
  await rm(join(root, '.primecontext'), { recursive: true, force: true });
  const requestedIntent = intent('ONBOARD-UNIGNORED');
  await writeFile(join(root, 'intent.json'), JSON.stringify(requestedIntent));

  const diagnostics = await doctorCommand(root);
  assert.equal(diagnostics.status, 'BLOCKED');
  assert.equal(diagnostics.repository.initialized, true);
  assert.equal(diagnostics.repository.config_valid, true);
  assert.equal(diagnostics.repository.state_dir_ignored, false);
  assert.ok(diagnostics.next_actions.includes('Run primecontext setup to protect the local state directory'));

  await assert.rejects(
    () => contextPrepareCommand(root, 'intent.json'),
    /SECURITY_ERROR.*state_dir must be ignored/i,
  );
  await assert.rejects(() => readdir(join(root, '.primecontext')), /ENOENT/);
});

test('doctor and context prepare fail closed when Git rules re-include the local state directory', async (t) => {
  const root = await onboardingFixture(t);
  await initCommand(root);
  await writeFile(join(root, '.gitignore'), [
    '.primecontext/',
    '!.primecontext/',
    '!.primecontext/**',
    '',
  ].join('\n'));
  await rm(join(root, '.primecontext'), { recursive: true, force: true });
  const requestedIntent = intent('ONBOARD-REINCLUDED');
  await writeFile(join(root, 'intent.json'), JSON.stringify(requestedIntent));

  const diagnostics = await doctorCommand(root);
  assert.equal(diagnostics.status, 'BLOCKED');
  assert.equal(diagnostics.repository.initialized, true);
  assert.equal(diagnostics.repository.config_valid, true);
  assert.equal(diagnostics.repository.state_dir_ignored, false);
  assert.ok(diagnostics.next_actions.includes('Run primecontext setup to protect the local state directory'));

  await assert.rejects(
    () => contextPrepareCommand(root, 'intent.json'),
    /SECURITY_ERROR.*state_dir must be ignored/i,
  );
  await assert.rejects(() => readdir(join(root, '.primecontext')), /ENOENT/);
});

test('initialization escapes Git control characters at the start of a configured state directory', async (t) => {
  for (const [stateDirectory, ignoreEntry] of [
    ['!prime-cache', '\\!prime-cache/'],
    ['#prime-cache', '\\#prime-cache/'],
  ]) {
    const root = await onboardingFixture(t);
    await writeFile(join(root, 'primecontext.config.json'), JSON.stringify({
      ...defaultConfig(),
      state_dir: stateDirectory,
    }));

    await initCommand(root);
    assert.equal(await readFile(join(root, '.gitignore'), 'utf8'), `${ignoreEntry}\n`);
    const diagnostics = await doctorCommand(root);
    assert.equal(diagnostics.status, 'READY');
    assert.equal(diagnostics.repository.state_dir_ignored, true);
  }
});

test('prepares, validates, links, and persists a complete context package from a small intent', async (t) => {
  const root = await onboardingFixture(t);
  await initCommand(root);
  const requestedIntent = intent();
  await writeFile(join(root, 'intent.json'), JSON.stringify(requestedIntent));

  const prepared = assertPreparedResult(
    root,
    await contextPrepareCommand(root, 'intent.json'),
    requestedIntent,
  );
  const stored = JSON.parse(await readFile(absolutePlanPath(root, prepared.plan_path), 'utf8')) as {
    request?: unknown;
    envelope?: unknown;
    receipt?: unknown;
  };

  assert.deepEqual(stored.request, prepared.request);
  assert.deepEqual(stored.envelope, prepared.envelope);
  assert.deepEqual(stored.receipt, prepared.receipt);

  const fromStdin = asPrepared(parseSuccessfulJson(
    runCli(root, ['context', 'prepare', '--from', '-'], JSON.stringify(requestedIntent)),
    'same intent from stdin',
  ));
  assert.deepEqual(fromStdin.request, prepared.request);
  assert.equal(fromStdin.envelope.selection_digest, prepared.envelope.selection_digest);
  assert.equal(fromStdin.receipt.receipt_digest, prepared.receipt.receipt_digest);
});

test('compiled CLI discovers onboarding commands and emits one JSON document on success', async (t) => {
  const root = await onboardingFixture(t);
  await initCommand(root);

  const help = runCli(root, ['--help']);
  assert.equal(help.status, 0);
  assert.equal(help.stderr, '');
  assert.match(help.stdout, /primecontext capabilities/);
  assert.match(help.stdout, /primecontext doctor/);
  assert.match(help.stdout, /primecontext context prepare --from <intent\.json\|-> \[--compact\]/);

  parseSuccessfulJson(runCli(root, ['capabilities']), 'capabilities');
  parseSuccessfulJson(runCli(root, ['doctor']), 'doctor');

  const requestedIntent = intent('ONBOARD-FILE');
  await writeFile(join(root, 'intent.json'), JSON.stringify(requestedIntent));
  const prepared = parseSuccessfulJson(
    runCli(root, ['context', 'prepare', '--from', 'intent.json']),
    'context prepare file',
  );
  assertPreparedResult(root, prepared, requestedIntent);

  const compactRun = runCli(root, ['context', 'prepare', '--compact', '--from', 'intent.json']);
  const compact = parseSuccessfulJson(compactRun, 'compact context prepare') as {
    schema_version?: unknown;
    task_id?: unknown;
    envelope?: ContextEnvelopeV03;
    receipt_summary?: { receipt_digest?: unknown };
    receipt_ref?: { path?: unknown; json_pointer?: unknown };
    request?: unknown;
    receipt?: unknown;
    output_ceiling_bytes?: unknown;
  };
  assert.equal(compact.schema_version, '0.3');
  assert.equal(compact.task_id, requestedIntent.task_id);
  assert.equal(validateContextEnvelope(compact.envelope).valid, true);
  assert.equal(typeof compact.receipt_summary?.receipt_digest, 'string');
  assert.equal(typeof compact.receipt_ref?.path, 'string');
  assert.equal(compact.receipt_ref?.json_pointer, '/receipt');
  assert.equal(compact.request, undefined);
  assert.equal(compact.receipt, undefined);
  assert.equal(typeof compact.output_ceiling_bytes, 'number');
  assert.ok(Buffer.byteLength(compactRun.stdout, 'utf8') <= (compact.output_ceiling_bytes as number));
});

test('context prepare accepts bounded strict JSON from stdin without contaminating stdout', async (t) => {
  const root = await onboardingFixture(t);
  await initCommand(root);
  const requestedIntent = intent('ONBOARD-STDIN');

  const prepared = parseSuccessfulJson(
    runCli(root, ['context', 'prepare', '--from', '-'], JSON.stringify(requestedIntent)),
    'context prepare stdin',
  );
  assertPreparedResult(root, prepared, requestedIntent);

  const request = asPrepared(prepared).request;
  const planned = parseSuccessfulJson(
    runCli(root, ['context', 'plan', '--from', '-'], JSON.stringify(request)),
    'context plan stdin',
  ) as { selection_digest?: unknown };
  assert.equal(planned.selection_digest, asPrepared(prepared).envelope.selection_digest);
});

test('generic, Codex, and Claude templates use the same agent-neutral protocol', async () => {
  const workspace = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
  const instructionPaths = [
    'integrations/generic/AGENT.md',
    'integrations/codex/AGENTS.md.template',
    'integrations/claude-code/CLAUDE.md.template',
    'docs/agent-integration-v0.3.md',
  ];
  for (const path of instructionPaths) {
    const content = await readFile(join(workspace, path), 'utf8');
    assert.match(content, /<primecontext> capabilities/);
    assert.match(content, /<primecontext> doctor/);
    assert.match(content, /<primecontext> context prepare --from - --compact/);
    assert.match(content, /ContextIntent/);
    assert.doesNotMatch(content, /https?:\/\//i);
  }

  const claudeCommand = await readFile(
    join(workspace, 'integrations/claude-code/commands/primecontext.md'),
    'utf8',
  );
  assert.match(claudeCommand, /ContextIntent/);
  assert.match(claudeCommand, /<primecontext> context prepare --from - --compact/);
  assert.doesNotMatch(claudeCommand, /https?:\/\//i);

  const capabilities = capabilitiesCommand(workspace);
  assert.equal(capabilities.contracts.context_intent, 'v0.3/context-intent.schema.json');
});

test('disposable human demo is repeatable and reports cleanup only after success', () => {
  const workspace = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
  const script = join(workspace, 'scripts', 'demo.mjs');
  const first = spawnSync(process.execPath, [script], { cwd: workspace, encoding: 'utf8' });
  const second = spawnSync(process.execPath, [script], { cwd: workspace, encoding: 'utf8' });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(first.stderr, '');
  assert.equal(second.stderr, '');
  assert.equal(second.stdout, first.stdout);
  const result = JSON.parse(first.stdout) as { status?: unknown; temporary_repository_removed?: unknown };
  assert.equal(result.status, 'PASS');
  assert.equal(result.temporary_repository_removed, true);
});

test('context prepare rejects malformed and oversized stdin with JSON stderr only', async (t) => {
  const root = await onboardingFixture(t);
  await initCommand(root);

  assertJsonFailure(
    runCli(root, ['context', 'prepare', '--from', '-'], '{"schema_version":"0.3"'),
    'malformed stdin',
  );
  assertJsonFailure(
    runCli(
      root,
      ['context', 'prepare', '--from', '-'],
      JSON.stringify({ ...intent('ONBOARD-OVERSIZE'), goal: 'x'.repeat((1024 * 1024) + 1) }),
    ),
    'oversized stdin',
  );
  const bin = fileURLToPath(new URL('./bin.js', import.meta.url));
  assertJsonFailure(
    spawnSync(process.execPath, [bin, 'context', 'prepare', '--from', '-'], {
      cwd: root,
      encoding: 'utf8',
      input: Buffer.from([0xff, 0xfe, 0xfd]),
    }),
    'invalid UTF-8 stdin',
  );
});

test('onboarding CLI grammar is strict and failures remain machine-readable', async (t) => {
  const root = await onboardingFixture(t);
  await initCommand(root);

  for (const args of [
    ['capabilities', 'extra'],
    ['doctor', 'extra'],
    ['context', 'prepare'],
    ['context', 'prepare', '--from'],
    ['context', 'prepare', '--unknown', 'intent.json'],
    ['context', 'prepare', '--compact', '--compact', '--from', 'intent.json'],
    ['context', 'prepare', '--from', 'intent.md'],
    ['context', 'prepare', '--from', '-', 'extra'],
  ]) {
    assertJsonFailure(runCli(root, args), args.join(' '));
  }
});
