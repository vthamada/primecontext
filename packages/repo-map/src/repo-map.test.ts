import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { NodeFileSystemAdapter } from '@primecontext/adapters';
import { generateRepoMap } from './index.js';

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
