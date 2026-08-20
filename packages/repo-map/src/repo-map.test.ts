import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { NodeFileSystemAdapter } from '@primecontext/adapters';
import { hashContextJson } from '@primecontext/core';
import { generateRepoMap, generateRepoMapFromObservation } from './index.js';

async function fixtureRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'primecontext-map-'));
  await mkdir(join(root, 'packages', 'core'), { recursive: true });
  await mkdir(join(root, 'docs'));
  await mkdir(join(root, 'tests'));
  await mkdir(join(root, 'config'));
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fixture', workspaces: ['packages/*'] }));
  await writeFile(join(root, 'packages', 'core', 'package.json'), JSON.stringify({ name: '@fixture/core', description: 'Core domain boundary' }));
  await writeFile(join(root, 'docs', 'architecture.md'), '# Architecture');
  await writeFile(join(root, 'tests', 'smoke.test.ts'), '');
  await writeFile(join(root, 'config', 'defaults.json'), '{}');
  await writeFile(join(root, '.env'), 'SHOULD_NOT_APPEAR=true');
  return root;
}

test('generates evidence-backed semantic modules without exposing secrets', async () => {
  const root = await fixtureRepo();
  const map = await generateRepoMap(root, new NodeFileSystemAdapter(), { inspect: async () => undefined });

  const core = map.modules.find((module) => module.path === 'packages/core');
  assert.equal(core?.kind, 'workspace_package');
  assert.equal(core?.role, 'Core domain boundary');
  assert.ok(core?.evidence.some((item) => item.includes('@fixture/core')));

  assert.equal(map.modules.find((module) => module.path === 'docs')?.kind, 'documentation');
  assert.equal(map.modules.find((module) => module.path === 'tests')?.kind, 'tests');
  assert.equal(map.modules.find((module) => module.path === 'config')?.kind, 'configuration');
  assert.equal(JSON.stringify(map).includes('.env'), false);
  assert.ok(map.summary.excluded_path_count >= 1);
});

test('includes Git/worktree metadata when the Git port provides it', async () => {
  const root = await fixtureRepo();
  const map = await generateRepoMap(root, new NodeFileSystemAdapter(), {
    inspect: async () => ({ branch: 'feat/context', head: 'abc123' }),
  });
  assert.equal(map.repository.branch, 'feat/context');
  assert.equal(map.repository.head, 'abc123');
});

test('sorts modules by ordinal path order instead of host locale', async () => {
  const root = await mkdtemp(join(tmpdir(), 'primecontext-map-order-'));
  await mkdir(join(root, 'alpha'));
  await mkdir(join(root, 'Zeta'));
  await writeFile(join(root, 'alpha', 'package.json'), JSON.stringify({ name: 'alpha' }));
  await writeFile(join(root, 'Zeta', 'package.json'), JSON.stringify({ name: 'zeta' }));

  const map = await generateRepoMap(root, new NodeFileSystemAdapter(), { inspect: async () => undefined });
  assert.deepEqual(map.modules.map((module) => module.path), ['Zeta', 'alpha']);
});

test('builds from one accepted repository observation without walking or inspecting Git again', async () => {
  const root = await fixtureRepo();
  const reader = new NodeFileSystemAdapter();
  const observed = await reader.walk(root, { capacityLimitBehavior: 'truncate' });
  let walkCalls = 0;
  const map = await generateRepoMapFromObservation(
    root,
    {
      walk: async () => {
        walkCalls += 1;
        throw new Error('walk must not be called');
      },
      readText: reader.readText.bind(reader),
    },
    {
      walk: observed,
      git: { branch: 'main', head: 'observed-head' },
    },
  );

  assert.equal(walkCalls, 0);
  assert.equal(map.repository.branch, 'main');
  assert.equal(map.repository.head, 'observed-head');
  assert.equal(map.summary.discovered_path_count, observed.paths.length);
  assert.equal(map.modules.some((module) => module.path === 'packages/core'), true);
});

test('keeps a contract-valid package role hashable above the context excerpt limit', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'primecontext-map-role-boundary-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const description = 'x'.repeat((32 * 1024) + 1);
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'role-boundary', description }));

  const map = await generateRepoMap(root, new NodeFileSystemAdapter(), { inspect: async () => undefined });
  const rootModule = map.modules.find((module) => module.path === '.');

  assert.equal(Buffer.byteLength(rootModule?.role ?? '', 'utf8'), Buffer.byteLength(description, 'utf8'));
  assert.doesNotThrow(() => hashContextJson(map));
});
