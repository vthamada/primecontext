import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { platform, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { validateRepoMap, validateTaskCapsule } from '@primecontext/schemas';
import {
  handoffValidateCommand,
  initCommand,
  inspectCommand,
  mapCommand,
  metricsCommand,
  parseConfig,
  recordMetricCommand,
  taskCommand,
} from './index.js';

async function repoFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'primecontext-cli-'));
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'cli-fixture' }));
  await writeFile(join(root, 'README.md'), '# fixture');
  return root;
}

test('init is idempotent and does not overwrite configuration', async () => {
  const root = await repoFixture();
  const first = await initCommand(root);
  const original = await readFile(first.config_path, 'utf8');
  await initCommand(root);
  const second = await readFile(first.config_path, 'utf8');
  assert.equal(second, original);
  assert.match(await readFile(join(root, '.gitignore'), 'utf8'), /\.primecontext\//);
});

test('map writes a schema-valid semantic repo map', async () => {
  const root = await repoFixture();
  await initCommand(root);
  const result = await mapCommand(root);
  const map = JSON.parse(await readFile(result.map_path, 'utf8')) as unknown;
  assert.equal(validateRepoMap(map).valid, true);
});

test('task generates a valid capsule using configured budget defaults', async () => {
  const root = await repoFixture();
  await initCommand(root);
  const taskFile = join(root, 'task.json');
  await writeFile(taskFile, JSON.stringify({
    task_id: 'MAXSOUND-PILOT-001', goal: 'Prepare a safe product module context', task_type: 'module_feature',
    boundaries: { allowed_paths: ['src'], forbidden_paths: ['private'] }, acceptance: ['Capsule validates'],
  }));
  const result = await taskCommand(root, 'MAXSOUND-PILOT-001', taskFile);
  const capsule = JSON.parse(await readFile(result.capsule_path, 'utf8')) as unknown;
  assert.equal(validateTaskCapsule(capsule).valid, true);
  assert.equal((capsule as { context_budget: { soft_limit_tokens: number } }).context_budget.soft_limit_tokens, 12000);
});

test('inspect rejects a corrupted stored capsule', async () => {
  const root = await repoFixture();
  const init = await initCommand(root);
  const capsuleDir = join(init.state_dir, 'capsules');
  await import('node:fs/promises').then(({ mkdir }) => mkdir(capsuleDir, { recursive: true }));
  await writeFile(join(capsuleDir, 'BAD.json'), '{"schema_version":"0.1"}');
  await assert.rejects(() => inspectCommand(root, 'BAD'), /VALIDATION_ERROR/);
});

test('handoff validate rejects malformed handoffs', async () => {
  const root = await repoFixture();
  const file = join(root, 'handoff.json');
  await writeFile(file, JSON.stringify({ schema_version: '0.1', task_id: 'X' }));
  await assert.rejects(() => handoffValidateCommand(file, root), /VALIDATION_ERROR/);
});

test('metrics returns an empty evidence summary when no records exist', async () => {
  const root = await repoFixture();
  await initCommand(root);
  const summary = await metricsCommand(root);
  assert.equal(summary.record_count, 0);
  assert.deepEqual(summary.totals, {});
});

test('task and inspect reject traversal task ids before any outside read or write', async () => {
  const root = await repoFixture();
  await initCommand(root);
  const outsideFile = join(dirname(root), 'primecontext-outside-sentinel.json');
  await writeFile(outsideFile, '{"sentinel":true}');
  const unsafeTaskId = '../../../primecontext-outside-sentinel';
  const taskFile = join(root, 'unsafe-task.json');
  await writeFile(taskFile, JSON.stringify({
    task_id: unsafeTaskId,
    goal: 'must be rejected',
    task_type: 'small_code_fix',
    boundaries: { allowed_paths: ['src'], forbidden_paths: [] },
    acceptance: ['No outside write'],
  }));

  await assert.rejects(() => taskCommand(root, unsafeTaskId, taskFile), /SECURITY_ERROR|VALIDATION_ERROR/);
  await assert.rejects(() => inspectCommand(root, unsafeTaskId), /SECURITY_ERROR|VALIDATION_ERROR/);
  assert.equal(await readFile(outsideFile, 'utf8'), '{"sentinel":true}');
});

test('task input cannot escape through an intermediate junction', async () => {
  const root = await repoFixture();
  await initCommand(root);
  const outside = await mkdtemp(join(tmpdir(), 'primecontext-cli-outside-'));
  await writeFile(join(outside, 'task.json'), JSON.stringify({
    task_id: 'SAFE-001', goal: 'outside input', task_type: 'small_code_fix',
    boundaries: { allowed_paths: ['src'], forbidden_paths: [] }, acceptance: ['Rejected'],
  }));
  await symlink(outside, join(root, 'linked-input'), platform() === 'win32' ? 'junction' : 'dir');

  await assert.rejects(() => taskCommand(root, 'SAFE-001', 'linked-input/task.json'), /SECURITY_ERROR/);
  await assert.rejects(() => taskCommand(root, 'SAFE-001', join(outside, 'task.json')), /SECURITY_ERROR/);
});

test('task output cannot escape through a junction inside generated state', async () => {
  const root = await repoFixture();
  const init = await initCommand(root);
  const outside = await mkdtemp(join(tmpdir(), 'primecontext-cli-output-'));
  const capsuleDir = join(init.state_dir, 'capsules');
  await rm(capsuleDir, { recursive: true });
  await symlink(outside, capsuleDir, platform() === 'win32' ? 'junction' : 'dir');
  const taskFile = join(root, 'safe-task.json');
  await writeFile(taskFile, JSON.stringify({
    task_id: 'SAFE-OUTPUT', goal: 'stay inside state', task_type: 'small_code_fix',
    boundaries: { allowed_paths: ['src'], forbidden_paths: [] }, acceptance: ['No linked write'],
  }));

  await assert.rejects(() => taskCommand(root, 'SAFE-OUTPUT', taskFile), /SECURITY_ERROR/);
  await assert.rejects(() => readFile(join(outside, 'SAFE-OUTPUT.json'), 'utf8'));
});

test('init rejects a configured state directory that is a junction', async () => {
  const root = await repoFixture();
  const outside = await mkdtemp(join(tmpdir(), 'primecontext-cli-state-'));
  const config = {
    schema_version: '0.1', state_dir: 'state', exclude: [],
    budgets: Object.fromEntries(['small_ui','small_code_fix','module_feature','integration','qa','orchestration'].map((type) => [type, {
      initial_tokens: 1, soft_limit_tokens: 2, hard_limit_tokens: 4,
    }])),
  };
  await writeFile(join(root, 'primecontext.config.json'), JSON.stringify(config));
  await symlink(outside, join(root, 'state'), platform() === 'win32' ? 'junction' : 'dir');

  await assert.rejects(() => initCommand(root), /SECURITY_ERROR/);
  await assert.rejects(() => access(join(outside, 'capsules')));
});

test('init classifies native state-directory failures as IO_ERROR', async () => {
  const root = await repoFixture();
  const config = {
    schema_version: '0.1', state_dir: 'occupied/child', exclude: [],
    budgets: Object.fromEntries(['small_ui','small_code_fix','module_feature','integration','qa','orchestration'].map((type) => [type, {
      initial_tokens: 1, soft_limit_tokens: 2, hard_limit_tokens: 4,
    }])),
  };
  await writeFile(join(root, 'primecontext.config.json'), JSON.stringify(config));
  await writeFile(join(root, 'occupied'), 'not a directory');
  await assert.rejects(() => initCommand(root), /IO_ERROR/);
});

test('configuration rejects unsafe state directories and unknown properties', () => {
  const config = {
    schema_version: '0.1',
    state_dir: '.primecontext',
    exclude: [],
    budgets: Object.fromEntries(['small_ui','small_code_fix','module_feature','integration','qa','orchestration'].map((type) => [type, {
      initial_tokens: 1, soft_limit_tokens: 2, hard_limit_tokens: 4,
    }])),
  };
  assert.throws(() => parseConfig({ ...config, state_dir: '..' }), /CONFIG_ERROR/);
  assert.throws(() => parseConfig({ ...config, state_dir: '.' }), /CONFIG_ERROR/);
  assert.throws(() => parseConfig({ ...config, state_dir: '.git' }), /CONFIG_ERROR/);
  for (const state_dir of ['.git.', '.git ', 'C:state', 'state:stream', 'CON', 'state/PRN.txt', 'state/COM¹.txt']) {
    assert.throws(() => parseConfig({ ...config, state_dir }), /CONFIG_ERROR/, state_dir);
  }
  assert.throws(() => parseConfig({ ...config, unexpected: true }), /CONFIG_ERROR/);
});

test('configuration loading uses the bounded structural JSON parser', async () => {
  const root = await repoFixture();
  let nested: Record<string, unknown> = {};
  for (let depth = 0; depth < 80; depth += 1) nested = { child: nested };
  await writeFile(join(root, 'primecontext.config.json'), JSON.stringify({ unexpected: nested }));
  await assert.rejects(() => mapCommand(root), /CONFIG_ERROR.*nesting depth/);
});

test('task definition rejects present optional fields with invalid types', async () => {
  const root = await repoFixture();
  await initCommand(root);
  const taskFile = join(root, 'invalid-optional.json');
  await writeFile(taskFile, JSON.stringify({
    task_id: 'SAFE-002', goal: 'reject invalid optional input', task_type: 'small_code_fix', module: 42,
    boundaries: { allowed_paths: ['src'], forbidden_paths: [] }, acceptance: ['Rejected'],
  }));
  await assert.rejects(() => taskCommand(root, 'SAFE-002', taskFile), /VALIDATION_ERROR/);
});

test('structured JSON inputs are rejected when nesting exceeds the bounded parser depth', async () => {
  const root = await repoFixture();
  await initCommand(root);
  let nested: Record<string, unknown> = {};
  for (let depth = 0; depth < 80; depth += 1) nested = { child: nested };
  const taskFile = join(root, 'deep-task.json');
  await writeFile(taskFile, JSON.stringify({
    task_id: 'SAFE-DEEP', goal: 'reject pathological nesting', task_type: 'small_code_fix', metadata: nested,
    boundaries: { allowed_paths: ['src'], forbidden_paths: [] }, acceptance: ['Rejected'],
  }));

  await assert.rejects(() => taskCommand(root, 'SAFE-DEEP', taskFile), /VALIDATION_ERROR.*nesting depth/);
});

test('metrics distinguishes missing evidence from I/O errors and can record validated evidence', async () => {
  const root = await repoFixture();
  const init = await initCommand(root);
  await mkdir(join(init.state_dir, 'metrics.jsonl'));
  await assert.rejects(() => metricsCommand(root), /IO_ERROR/);

  const secondRoot = await repoFixture();
  await initCommand(secondRoot);
  const metricFile = join(secondRoot, 'metric.json');
  await writeFile(metricFile, JSON.stringify({
    schema_version: '0.1', task_id: 'BENCH-001', recorded_at: '2026-08-11T12:00:00.000Z',
    arm: 'A', input_tokens: 100, test_status: 'PASS', review_status: 'PASS',
  }));
  await recordMetricCommand(secondRoot, metricFile);
  const summary = await metricsCommand(secondRoot);
  assert.equal(summary.record_count, 1);
  assert.equal(summary.totals.input_tokens, 100);
});

test('metrics rejects aggregate totals that exceed the safe integer range', async () => {
  const root = await repoFixture();
  const init = await initCommand(root);
  const record = JSON.stringify({
    schema_version: '0.1', task_id: 'BENCH-SAFE-MAX', recorded_at: '2026-08-11T12:00:00.000Z',
    input_tokens: Number.MAX_SAFE_INTEGER,
  });
  await writeFile(join(init.state_dir, 'metrics.jsonl'), `${record}\n${record}\n`);
  await assert.rejects(() => metricsCommand(root), /VALIDATION_ERROR.*safe integer/);
});

test('compiled CLI exposes help and returns non-zero for an invalid handoff', async () => {
  const root = await repoFixture();
  const bin = fileURLToPath(new URL('./bin.js', import.meta.url));
  const help = spawnSync(process.execPath, [bin, '--help'], { cwd: root, encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /primecontext handoff validate/);

  const handoff = join(root, 'invalid-handoff.json');
  await writeFile(handoff, '{"schema_version":"0.1"}');
  const invalid = spawnSync(process.execPath, [bin, 'handoff', 'validate', handoff], { cwd: root, encoding: 'utf8' });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /VALIDATION_ERROR/);
});

test('compiled CLI rejects unknown, extra, duplicate, and valueless arguments', async () => {
  const root = await repoFixture();
  const bin = fileURLToPath(new URL('./bin.js', import.meta.url));
  const run = (...args: string[]) => spawnSync(process.execPath, [bin, ...args], { cwd: root, encoding: 'utf8' });
  for (const args of [
    ['init', 'extra'],
    ['inspect', 'SAFE', 'extra'],
    ['task', 'SAFE', '--from'],
    ['task', 'SAFE', '--unknown', 'task.json'],
    ['benchmark', '--a', 'a.json', '--a', 'again.json', '--b', 'b.json'],
    ['metrics', 'unexpected'],
  ]) {
    const result = run(...args);
    assert.equal(result.status, 1, args.join(' '));
    assert.match(result.stderr, /VALIDATION_ERROR/, args.join(' '));
  }
});

test('compiled CLI completes the v0.1 vertical command flow', async () => {
  const root = await repoFixture();
  const bin = fileURLToPath(new URL('./bin.js', import.meta.url));
  const run = (...args: string[]) => spawnSync(process.execPath, [bin, ...args], { cwd: root, encoding: 'utf8' });

  assert.equal(run('init').status, 0);
  assert.equal(run('map').status, 0);

  await writeFile(join(root, 'task.json'), JSON.stringify({
    task_id: 'VERTICAL-001', goal: 'exercise the public CLI', task_type: 'small_code_fix',
    boundaries: { allowed_paths: ['src'], forbidden_paths: ['private'] }, acceptance: ['All commands succeed'],
  }));
  assert.equal(run('task', 'VERTICAL-001', '--from', 'task.json').status, 0);
  assert.equal(run('inspect', 'VERTICAL-001').status, 0);

  await writeFile(join(root, 'handoff.json'), JSON.stringify({
    schema_version: '0.1', task_id: 'VERTICAL-001', status: 'PASS', changed_files: [],
    tests: { passed: 1, failed: 0 }, risks: [], next_unblocked: [],
  }));
  assert.equal(run('handoff', 'validate', 'handoff.json').status, 0);

  const metricBase = {
    schema_version: '0.1', task_id: 'VERTICAL-001', recorded_at: '2026-08-11T12:00:00.000Z',
    input_tokens: 10, test_status: 'PASS', review_status: 'PASS',
  };
  await writeFile(join(root, 'arm-a.json'), JSON.stringify({ ...metricBase, arm: 'A' }));
  await writeFile(join(root, 'arm-b.json'), JSON.stringify({ ...metricBase, arm: 'B', input_tokens: 9 }));
  assert.equal(run('metrics', 'record', 'arm-a.json').status, 0);
  assert.equal(run('metrics').status, 0);
  assert.equal(run('benchmark', '--a', 'arm-a.json', '--b', 'arm-b.json').status, 0);
});
