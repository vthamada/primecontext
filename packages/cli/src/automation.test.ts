import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';
import {
  PrimeContextError,
} from '@primecontext/core';
import {
  validateContextEnvelope,
  validateContextPlanRequest,
  validateSelectionReceipt,
  type ContextEnvelopeV03,
  type ContextPlanRequestV03,
  type SelectionReceiptV03,
} from '@primecontext/schemas';
import {
  defaultConfig,
  prepareGoalCommand,
  setupCommand,
  type PrimeContextCapabilitiesV03,
  type PrimeContextDoctorV03,
} from './index.js';
import { optionalIndexErrorForAutomation } from './automation.js';

interface SetupResult {
  schema_version: '0.3';
  status: 'READY';
  config_path: string;
  state_dir: string;
  created_config: boolean;
  gitignore_updated: boolean;
  diagnostics: PrimeContextDoctorV03;
  capabilities: PrimeContextCapabilitiesV03;
}

interface AutomatedPrepareResult {
  request: ContextPlanRequestV03;
  envelope: ContextEnvelopeV03;
  receipt: SelectionReceiptV03;
  plan_path: string;
  automation: {
    setup: SetupResult;
    index: {
      attempted: true;
      status: 'READY' | 'UNAVAILABLE';
      fallback_used: boolean;
      error_code?: string;
    };
  };
}

async function automationFixture(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'primecontext-automation-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(join(root, 'docs'), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({
    name: 'primecontext-automation-fixture',
    private: true,
    type: 'module',
  }));
  await writeFile(join(root, 'README.md'), '# Automation fixture\n\nLocal proof-carrying context.\n');
  await writeFile(join(root, 'docs', 'requirements.md'), '# Requirements\n\nKeep preparation deterministic.\n');
  await writeFile(join(root, 'src', 'alpha.ts'), [
    'export function compileAlpha(): string {',
    "  return 'deterministic alpha proof';",
    '}',
  ].join('\n'));
  await writeFile(join(root, 'src', 'beta.ts'), [
    "import { compileAlpha } from './alpha.js';",
    'export const beta = compileAlpha();',
  ].join('\n'));
  return root;
}

function runCli(root: string, args: string[]): SpawnSyncReturns<string> {
  const bin = fileURLToPath(new URL('./bin.js', import.meta.url));
  return spawnSync(process.execPath, [bin, ...args], { cwd: root, encoding: 'utf8' });
}

function parseSuccessfulJson(run: SpawnSyncReturns<string>, label: string): unknown {
  assert.equal(run.status, 0, `${label}: ${run.stderr}`);
  assert.equal(run.stderr, '', label);
  assert.ok(run.stdout.trim().length > 0, label);
  return JSON.parse(run.stdout) as unknown;
}

function assertJsonFailure(run: SpawnSyncReturns<string>, label: string): void {
  assert.equal(run.status, 1, `${label}: ${run.stderr}`);
  assert.equal(run.stdout, '', label);
  const failure = JSON.parse(run.stderr) as { error?: { code?: unknown; message?: unknown } };
  assert.equal(typeof failure.error?.code, 'string', label);
  assert.equal(typeof failure.error?.message, 'string', label);
  assert.ok((failure.error?.message as string).length > 0, label);
}

function asSetup(value: Awaited<ReturnType<typeof setupCommand>>): SetupResult {
  return value as SetupResult;
}

function asPrepared(value: Awaited<ReturnType<typeof prepareGoalCommand>> | unknown): AutomatedPrepareResult {
  assert.equal(typeof value, 'object');
  assert.notEqual(value, null);
  return value as AutomatedPrepareResult;
}

function assertValidPrepared(value: AutomatedPrepareResult): void {
  assert.equal(validateContextPlanRequest(value.request).valid, true);
  assert.equal(validateContextEnvelope(value.envelope).valid, true);
  assert.equal(validateSelectionReceipt(value.receipt).valid, true);
  assert.equal(value.request.task.task_id, value.envelope.task_id);
  assert.equal(value.request.task.task_id, value.receipt.task_id);
  assert.equal(value.envelope.request_digest, value.receipt.request_digest);
  assert.equal(value.envelope.selection_digest, value.receipt.selection_digest);
  assert.ok(value.plan_path.length > 0);
}

test('automation fallback accepts only optional provider failures and an active state writer', () => {
  assert.equal(
    optionalIndexErrorForAutomation(new PrimeContextError('CAPABILITY_ERROR', 'SQLite is unavailable')),
    'CAPABILITY_ERROR',
  );
  assert.equal(
    optionalIndexErrorForAutomation(new PrimeContextError('CATALOG_ERROR', 'Optional index is stale')),
    'CATALOG_ERROR',
  );
  assert.equal(
    optionalIndexErrorForAutomation(new PrimeContextError('STATE_ERROR', 'Context state already has an active writer')),
    'STATE_ERROR',
  );
  assert.equal(
    optionalIndexErrorForAutomation(new PrimeContextError('STATE_ERROR', 'Unable to restore index rollback')),
    undefined,
  );
  assert.equal(
    optionalIndexErrorForAutomation(new PrimeContextError('FRESHNESS_ERROR', 'Repository snapshot changed')),
    undefined,
  );
  assert.equal(
    optionalIndexErrorForAutomation(new PrimeContextError('IO_ERROR', 'State write failed')),
    undefined,
  );
});

test('setup creates safe defaults once and is byte-idempotent thereafter', async (t) => {
  const root = await automationFixture(t);

  const first = asSetup(await setupCommand(root));
  const firstConfigBytes = await readFile(join(root, 'primecontext.config.json'));
  const firstIgnoreBytes = await readFile(join(root, '.gitignore'));
  const second = asSetup(await setupCommand(root));

  assert.equal(first.schema_version, '0.3');
  assert.equal(first.status, 'READY');
  assert.equal(first.created_config, true);
  assert.equal(first.gitignore_updated, true);
  assert.equal(first.diagnostics.status, 'READY');
  assert.equal(first.diagnostics.repository.config_valid, true);
  assert.equal(first.diagnostics.repository.state_dir_ignored, true);
  assert.equal(first.capabilities.capabilities.context_prepare, true);
  assert.equal(first.capabilities.capabilities.zero_config_setup, true);
  assert.equal(first.capabilities.capabilities.human_prepare, true);
  assert.deepEqual(first.capabilities.input_modes, ['argv', 'repository_file', 'stdin']);
  assert.equal(first.capabilities.network_required, false);
  assert.deepEqual(JSON.parse(firstConfigBytes.toString('utf8')), defaultConfig());
  assert.equal(firstIgnoreBytes.toString('utf8'), '.primecontext/\n');
  assert.equal((await stat(join(root, '.primecontext'))).isDirectory(), true);
  assert.equal((await stat(join(root, '.primecontext', 'capsules'))).isDirectory(), true);
  assert.equal((await stat(join(root, '.primecontext', 'tasks'))).isDirectory(), true);

  assert.equal(second.schema_version, '0.3');
  assert.equal(second.status, 'READY');
  assert.equal(second.created_config, false);
  assert.equal(second.gitignore_updated, false);
  assert.equal(second.diagnostics.status, 'READY');
  assert.deepEqual(await readFile(join(root, 'primecontext.config.json')), firstConfigBytes);
  assert.deepEqual(await readFile(join(root, '.gitignore')), firstIgnoreBytes);
});

test('setup preserves a valid custom config byte-for-byte and appends its state directory once', async (t) => {
  const root = await automationFixture(t);
  const custom = {
    ...defaultConfig(),
    state_dir: '.prime-cache',
    exclude: ['fixtures/generated/**'],
  };
  const customBytes = Buffer.from(`${JSON.stringify(custom, null, 4)}\n`, 'utf8');
  await writeFile(join(root, 'primecontext.config.json'), customBytes);
  await writeFile(join(root, '.gitignore'), 'node_modules/\n');

  const first = asSetup(await setupCommand(root));
  const second = asSetup(await setupCommand(root));
  const ignore = await readFile(join(root, '.gitignore'), 'utf8');

  assert.equal(first.created_config, false);
  assert.equal(first.gitignore_updated, true);
  assert.equal(second.created_config, false);
  assert.equal(second.gitignore_updated, false);
  assert.deepEqual(await readFile(join(root, 'primecontext.config.json')), customBytes);
  assert.equal(ignore, 'node_modules/\n.prime-cache/\n');
  assert.equal(ignore.split(/\r?\n/).filter((line) => line === '.prime-cache/').length, 1);
});

test('setup rejects an invalid existing config without replacing or repairing it silently', async (t) => {
  const root = await automationFixture(t);
  const invalidBytes = Buffer.from('{"schema_version":"0.1","owner":"human"}\n', 'utf8');
  await writeFile(join(root, 'primecontext.config.json'), invalidBytes);

  await assert.rejects(() => setupCommand(root), /CONFIG_ERROR|Invalid PrimeContext configuration/i);
  assert.deepEqual(await readFile(join(root, 'primecontext.config.json')), invalidBytes);
  await assert.rejects(() => stat(join(root, '.primecontext')), /ENOENT/);
});

test('prepare <goal> bootstraps zero-config defaults and is deterministic without JSON input', async (t) => {
  const root = await automationFixture(t);
  const goal = 'Compile deterministic alpha context';

  const first = asPrepared(await prepareGoalCommand(root, goal));
  const second = asPrepared(await prepareGoalCommand(root, goal));

  assertValidPrepared(first);
  assertValidPrepared(second);
  assert.match(first.request.task.task_id, /^AUTO-[0-9A-F]{16}$/);
  assert.equal(first.request.task.task_id, second.request.task.task_id);
  assert.equal(first.request.task.task_type, 'small_code_fix');
  assert.equal(first.request.task.goal, goal);
  assert.equal(first.request.task.query, goal);
  assert.deepEqual(first.request.task.acceptance_criteria, [{ id: 'AC-001', text: goal }]);
  assert.equal(first.request.task.hints, undefined);
  assert.deepEqual(second.request, first.request);
  assert.equal(second.envelope.selection_digest, first.envelope.selection_digest);
  assert.equal(second.receipt.receipt_digest, first.receipt.receipt_digest);
  assert.equal(first.automation.setup.created_config, true);
  assert.equal(second.automation.setup.created_config, false);
  assert.equal(first.automation.index.attempted, true);
  assert.ok(['READY', 'UNAVAILABLE'].includes(first.automation.index.status));
  assert.equal(first.automation.index.fallback_used, first.automation.index.status === 'UNAVAILABLE');
  assert.deepEqual(JSON.parse(await readFile(join(root, 'primecontext.config.json'), 'utf8')), defaultConfig());
  assert.match(await readFile(join(root, '.gitignore'), 'utf8'), /(?:^|\n)\.primecontext\/(?:\n|$)/);
  const absolutePlanPath = resolve(root, first.plan_path);
  const relativePlanPath = relative(root, absolutePlanPath).replaceAll('\\', '/');
  assert.match(relativePlanPath, /^\.primecontext\/context\/plans\//);
  assert.equal(relativePlanPath.startsWith('../'), false);
  const rootEntries = await readdir(root);
  assert.equal(rootEntries.some((entry) => /intent.*\.json$/i.test(entry)), false);
});

test('prepare validates human input before setup or index state is written', async (t) => {
  const root = await automationFixture(t);

  await assert.rejects(
    () => prepareGoalCommand(root, 'x'.repeat(4_097)),
    /VALIDATION_ERROR|exceeds 4096 UTF-8 bytes/i,
  );
  await assert.rejects(() => stat(join(root, 'primecontext.config.json')), /ENOENT/);
  await assert.rejects(() => stat(join(root, '.primecontext')), /ENOENT/);
});

test('prepare can use repository-local Obsidian-compatible Markdown without indexing vault settings', async (t) => {
  const root = await automationFixture(t);
  await mkdir(join(root, 'knowledge', '.obsidian'), { recursive: true });
  await writeFile(
    join(root, 'knowledge', '.obsidian', 'app.json'),
    '{"obsidianproofterm":"private-vault-setting"}\n',
  );
  await writeFile(
    join(root, 'knowledge', 'architecture-note.md'),
    '# Architecture note\n\nThe obsidianproofterm establishes the bounded compiler boundary.\n',
  );

  const prepared = asPrepared(await prepareGoalCommand(
    root,
    'Find the obsidianproofterm architecture evidence',
    { paths: ['knowledge/architecture-note.md'], terms: ['obsidianproofterm'] },
  ));

  assertValidPrepared(prepared);
  assert.ok(prepared.envelope.items.some((item) => item.path === 'knowledge/architecture-note.md'));
  assert.equal(prepared.envelope.items.some((item) => item.path.includes('/.obsidian/')), false);
});

test('prepare accepts repeatable human flags and canonicalizes unordered discovery hints', async (t) => {
  const root = await automationFixture(t);
  const goal = 'Trace alpha into beta';
  const run = runCli(root, [
    'prepare', goal,
    '--accept', 'Alpha evidence is selected',
    '--accept', 'Beta usage is selected',
    '--path', 'src/beta.ts',
    '--path', 'src/alpha.ts',
    '--term', 'beta',
    '--term', 'alpha',
  ]);
  const prepared = asPrepared(parseSuccessfulJson(run, 'prepare with repeatable flags'));

  assertValidPrepared(prepared);
  assert.equal(prepared.request.task.goal, goal);
  assert.deepEqual(
    prepared.request.task.acceptance_criteria.map(({ text }) => text),
    ['Alpha evidence is selected', 'Beta usage is selected'],
  );
  assert.deepEqual(prepared.request.task.hints?.paths, ['src/alpha.ts', 'src/beta.ts']);
  assert.deepEqual(prepared.request.task.hints?.terms, ['alpha', 'beta']);
  assert.equal(prepared.automation.index.attempted, true);
});

test('prepare reports an unavailable auto-index but still compiles with safe fallback evidence', async (t) => {
  const root = await automationFixture(t);
  await setupCommand(root);
  await mkdir(join(root, '.primecontext', 'context'), { recursive: true });
  const heldIndexLock = join(root, '.primecontext', 'context', 'index-state.lock');
  await writeFile(heldIndexLock, 'held by automation RED test\n');

  const prepared = asPrepared(await prepareGoalCommand(
    root,
    'Compile alpha context while the optional index is busy',
    { paths: ['src/alpha.ts'], terms: ['alpha'] },
  ));

  assertValidPrepared(prepared);
  assert.equal(prepared.automation.index.attempted, true);
  assert.equal(prepared.automation.index.status, 'UNAVAILABLE');
  assert.equal(prepared.automation.index.fallback_used, true);
  assert.equal(prepared.automation.index.error_code, 'STATE_ERROR');
  assert.ok(prepared.envelope.items.some((item) => (
    item.provider === 'filesystem' && item.path === 'src/alpha.ts'
  )));
  assert.equal((await stat(heldIndexLock)).isFile(), true);
});

test('zero-config CLI grammar is strict and every success or failure is one machine JSON document', async (t) => {
  const root = await automationFixture(t);

  const help = runCli(root, ['--help']);
  assert.equal(help.status, 0);
  assert.equal(help.stderr, '');
  assert.match(help.stdout, /primecontext setup/);
  assert.match(help.stdout, /primecontext prepare <goal>/);

  const setup = parseSuccessfulJson(runCli(root, ['setup']), 'setup');
  assert.equal((setup as { status?: unknown; diagnostics?: { status?: unknown } }).status, 'READY');
  assert.equal((setup as { diagnostics?: { status?: unknown } }).diagnostics?.status, 'READY');
  const prepared = asPrepared(parseSuccessfulJson(
    runCli(root, ['prepare', 'Compile alpha', '--accept', 'Alpha is selected']),
    'prepare',
  ));
  assertValidPrepared(prepared);

  for (const args of [
    ['setup', 'extra'],
    ['prepare'],
    ['prepare', ''],
    ['prepare', '--accept', 'criterion without a goal'],
    ['prepare', 'goal', 'extra positional value'],
    ['prepare', 'goal', '--unknown', 'value'],
    ['prepare', 'goal', '--accept'],
    ['prepare', 'goal', '--path'],
    ['prepare', 'goal', '--term'],
    ['prepare', 'goal', '--accept', '--term', 'alpha'],
    ['prepare', 'goal', '--accept', ''],
    ['prepare', 'goal', '--accept', 'same', '--accept', 'same'],
  ]) {
    assertJsonFailure(runCli(root, args), args.join(' '));
  }
});
