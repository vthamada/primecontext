import { lstat, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';
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
} from '../dist/index.js';

const packageRoot = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
const contractGroups = [
  {
    version: 'v0.1',
    contracts: [
      ['compact-handoff.schema.json', compactHandoffSchema],
      ['context-budget.schema.json', contextBudgetSchema],
      ['metric-record.schema.json', metricRecordSchema],
      ['primecontext-config.schema.json', primeContextConfigSchema],
      ['semantic-repo-map.schema.json', repoMapSchema],
      ['task-capsule.schema.json', taskCapsuleSchema],
    ],
  },
  {
    version: 'v0.2',
    contracts: [
      ['document-catalog.schema.json', documentCatalogSchema],
      ['document-search-query.schema.json', documentSearchQuerySchema],
      ['document-search-result.schema.json', documentSearchResultSchema],
    ],
  },
];
const checkOnly = process.argv.includes('--check');
let failed = false;

function reportFailure(message) {
  failed = true;
  process.stderr.write(`${message}\n`);
}

async function assertRegularPathComponents(path, allowMissingTail = false) {
  const resolvedPath = resolve(path);
  const relativePath = relative(packageRoot, resolvedPath);
  if (relativePath === '..' || relativePath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(relativePath)) {
    throw new Error('contract path escapes the package root');
  }

  const filesystemRoot = parse(packageRoot).root;
  const rootSegments = relative(filesystemRoot, packageRoot).split(/[\\/]/).filter(Boolean);
  const targetSegments = relativePath.split(/[\\/]/).filter(Boolean);
  let current = filesystemRoot;
  for (const segment of [...rootSegments, ...targetSegments]) {
    current = join(current, segment);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) throw new Error('symbolic-link contract path is blocked');
    } catch (error) {
      if (allowMissingTail && error?.code === 'ENOENT') return;
      throw error;
    }
  }
}

async function writeContractAtomically(path, expected) {
  await assertRegularPathComponents(dirname(path));
  await assertRegularPathComponents(path, true);
  const temporaryPath = `${path}.tmp-${process.pid}`;
  try {
    await assertRegularPathComponents(temporaryPath, true);
    await writeFile(temporaryPath, expected, { encoding: 'utf8', flag: 'wx', flush: true });
    await assertRegularPathComponents(dirname(path));
    await assertRegularPathComponents(temporaryPath);
    await assertRegularPathComponents(path, true);
    await rename(temporaryPath, path);
    await assertRegularPathComponents(path);
  } catch (error) {
    try { await unlink(temporaryPath); } catch { /* preserve the original failure */ }
    throw error;
  }
}

const allContracts = contractGroups.flatMap(({ version, contracts }) => contracts.map(([name, contract]) => ({ version, name, contract })));
for (const { version, name, contract } of allContracts) {
  if (contract.$schema !== 'https://json-schema.org/draft/2020-12/schema') {
    reportFailure(`${version}/${name}: unexpected JSON Schema draft`);
  }
  if (!new URL(contract.$id).pathname.endsWith(`/${version}/${name}`)) {
    reportFailure(`${version}/${name}: $id does not match its versioned artifact path`);
  }
}
if (new Set(allContracts.map(({ contract }) => contract.$id)).size !== allContracts.length) {
  reportFailure('Contract $id values must be unique');
}

for (const { version, contracts } of contractGroups) {
  const outputDirectory = join(packageRoot, 'contracts', version);
  const expectedNames = contracts.map(([name]) => name);
  const expectedNameSet = new Set(expectedNames);
  if (!checkOnly) {
    await assertRegularPathComponents(dirname(outputDirectory));
    await assertRegularPathComponents(outputDirectory, true);
    await mkdir(outputDirectory, { recursive: true });
    await assertRegularPathComponents(outputDirectory);
  }

  for (const [name, contract] of contracts) {
    const path = join(outputDirectory, name);
    const expected = `${JSON.stringify(contract, null, 2)}\n`;
    if (checkOnly) {
      try {
        const actual = await readFile(path, 'utf8');
        if (actual !== expected) reportFailure(`${version}/${name}: physical contract is missing or stale`);
      } catch {
        reportFailure(`${version}/${name}: physical contract is missing or unreadable`);
      }
    } else {
      await writeContractAtomically(path, expected);
    }
  }

  try {
    const unexpected = (await readdir(outputDirectory))
      .filter((name) => name.endsWith('.schema.json') && !expectedNameSet.has(name));
    for (const name of unexpected) reportFailure(`${version}/${name}: unexpected versioned contract`);
  } catch {
    reportFailure(`Unable to inspect ${outputDirectory}`);
  }
}

if (failed) {
  process.exitCode = 1;
} else {
  process.stdout.write(`${checkOnly ? 'Verified' : 'Generated'} ${allContracts.length} versioned schema contracts.\n`);
}
