import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { validateRepoMap, validateTaskCapsule } from '@primecontext/schemas';
import {
  handoffValidateCommand,
  initCommand,
  inspectCommand,
  mapCommand,
  metricsCommand,
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
  await assert.rejects(() => handoffValidateCommand(file), /VALIDATION_ERROR/);
});

test('metrics returns an empty evidence summary when no records exist', async () => {
  const root = await repoFixture();
  await initCommand(root);
  const summary = await metricsCommand(root);
  assert.equal(summary.record_count, 0);
  assert.deepEqual(summary.totals, {});
});
