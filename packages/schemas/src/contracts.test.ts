import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { platform, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  compactHandoffSchema,
  contextBudgetSchema,
  documentCatalogSchema,
  documentSearchQuerySchema,
  documentSearchResultSchema,
  metricRecordSchema,
  primeContextConfigSchema,
  repoMapSchema,
  taskCapsuleSchema,
} from './index.js';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const contractDirectory = join(packageRoot, 'contracts', 'v0.1');
const v02ContractDirectory = join(packageRoot, 'contracts', 'v0.2');
const expectedContracts = [
  ['compact-handoff.schema.json', compactHandoffSchema],
  ['context-budget.schema.json', contextBudgetSchema],
  ['metric-record.schema.json', metricRecordSchema],
  ['primecontext-config.schema.json', primeContextConfigSchema],
  ['semantic-repo-map.schema.json', repoMapSchema],
  ['task-capsule.schema.json', taskCapsuleSchema],
] as const;
const expectedV02Contracts = [
  ['document-catalog.schema.json', documentCatalogSchema],
  ['document-search-query.schema.json', documentSearchQuerySchema],
  ['document-search-result.schema.json', documentSearchResultSchema],
] as const;

test('ships deterministic v0.1 JSON contracts matching the exported schema objects', async () => {
  const physicalNames = (await readdir(contractDirectory))
    .filter((name) => name.endsWith('.schema.json'))
    .sort();
  assert.deepEqual(physicalNames, expectedContracts.map(([name]) => name));

  const ids = new Set<string>();
  for (const [name, exportedContract] of expectedContracts) {
    const contents = await readFile(join(contractDirectory, name), 'utf8');
    assert.equal(contents, `${JSON.stringify(exportedContract, null, 2)}\n`, `${name} must be deterministically generated`);

    const physicalContract = JSON.parse(contents) as { $id: string; $schema: string };
    assert.deepEqual(physicalContract, exportedContract);
    assert.equal(physicalContract.$schema, 'https://json-schema.org/draft/2020-12/schema');
    assert.equal(new URL(physicalContract.$id).pathname.endsWith(`/v0.1/${name}`), true);
    assert.equal(ids.has(physicalContract.$id), false, `${physicalContract.$id} must be unique`);
    ids.add(physicalContract.$id);
  }
});

test('exposes every physical contract through the schemas package manifest', async () => {
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as {
    files?: string[];
    exports?: Record<string, string>;
    scripts?: Record<string, string>;
  };
  assert.deepEqual(manifest.files, ['dist', 'contracts', 'scripts', '!dist/*.test.*']);
  for (const [name] of expectedContracts) {
    const subpath = `./contracts/v0.1/${name}`;
    assert.equal(manifest.exports?.[subpath], subpath);
  }
  assert.equal(manifest.scripts?.['contracts:generate'], 'node ./scripts/generate-contracts.mjs');
  assert.equal(manifest.scripts?.['contracts:check'], 'node ./scripts/generate-contracts.mjs --check');
});

test('ships deterministic v0.2 document contracts without changing the v0.1 contract set', async () => {
  const physicalNames = (await readdir(v02ContractDirectory))
    .filter((name) => name.endsWith('.schema.json'))
    .sort();
  assert.deepEqual(physicalNames, expectedV02Contracts.map(([name]) => name));

  const ids = new Set<string>();
  for (const [name, exportedContract] of expectedV02Contracts) {
    const contents = await readFile(join(v02ContractDirectory, name), 'utf8');
    assert.equal(contents, `${JSON.stringify(exportedContract, null, 2)}\n`, `${name} must be deterministically generated`);
    const physicalContract = JSON.parse(contents) as { $id: string; $schema: string };
    assert.deepEqual(physicalContract, exportedContract);
    assert.equal(physicalContract.$schema, 'https://json-schema.org/draft/2020-12/schema');
    assert.equal(new URL(physicalContract.$id).pathname.endsWith(`/v0.2/${name}`), true);
    assert.equal(ids.has(physicalContract.$id), false, `${physicalContract.$id} must be unique`);
    ids.add(physicalContract.$id);
  }

  const v01Names = (await readdir(contractDirectory))
    .filter((name) => name.endsWith('.schema.json'))
    .sort();
  assert.deepEqual(v01Names, expectedContracts.map(([name]) => name));
});

test('exposes every v0.2 document contract through the schemas package manifest', async () => {
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as {
    exports?: Record<string, string>;
  };
  for (const [name] of expectedV02Contracts) {
    const subpath = `./contracts/v0.2/${name}`;
    assert.equal(manifest.exports?.[subpath], subpath);
  }
});

test('contract generation rejects a linked output directory before overwriting outside files', async (t) => {
  const temporaryPackage = await mkdtemp(join(tmpdir(), 'primecontext-contract-generator-'));
  const outside = await mkdtemp(join(tmpdir(), 'primecontext-contract-generator-outside-'));
  t.after(async () => {
    await rm(temporaryPackage, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });
  await cp(join(packageRoot, 'dist'), join(temporaryPackage, 'dist'), { recursive: true });
  await cp(join(packageRoot, 'scripts'), join(temporaryPackage, 'scripts'), { recursive: true });
  await cp(join(packageRoot, 'contracts'), join(temporaryPackage, 'contracts'), { recursive: true });
  await rm(join(temporaryPackage, 'contracts', 'v0.2'), { recursive: true, force: true });
  const sentinel = join(outside, 'document-catalog.schema.json');
  await writeFile(sentinel, 'outside-sentinel\n');
  await symlink(outside, join(temporaryPackage, 'contracts', 'v0.2'), platform() === 'win32' ? 'junction' : 'dir');

  const result = spawnSync(process.execPath, [join(temporaryPackage, 'scripts', 'generate-contracts.mjs')], {
    cwd: temporaryPackage,
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.equal(await readFile(sentinel, 'utf8'), 'outside-sentinel\n');
});
