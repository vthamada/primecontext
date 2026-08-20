import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const npm = process.platform === 'win32'
  ? { command: process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe', arguments: ['/d', '/s', '/c', 'npm.cmd pack --dry-run --json --workspaces'] }
  : { command: 'npm', arguments: ['pack', '--dry-run', '--json', '--workspaces'] };
const cache = await mkdtemp(join(tmpdir(), 'primecontext-npm-pack-'));
let packed;
try {
  packed = spawnSync(npm.command, npm.arguments, {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, NPM_CONFIG_CACHE: cache },
    maxBuffer: 16 * 1024 * 1024,
  });
} finally {
  await rm(cache, { recursive: true, force: true });
}

if (packed.status !== 0) {
  const failure = [packed.error?.message, packed.stderr, packed.stdout]
    .filter((part) => typeof part === 'string' && part.trim() !== '')
    .join('\n');
  process.stderr.write(`${failure || 'npm pack --dry-run failed'}\n`);
  process.exit(1);
}

let manifests;
try {
  manifests = JSON.parse(packed.stdout);
} catch {
  process.stderr.write('npm pack --dry-run did not return valid JSON\n');
  process.exit(1);
}

if (!Array.isArray(manifests) || manifests.length !== 6) {
  process.stderr.write(`Expected six workspace tarball manifests, received ${Array.isArray(manifests) ? manifests.length : 'invalid'}\n`);
  process.exit(1);
}

const forbidden = /(?:^|\/)(?:\.env(?:\.|$)|\.git|\.primecontext|node_modules|src)(?:\/|$)|(?:\.test\.|\.tsbuildinfo$|\.tmp(?:-|$)|\.log$|credentials|secrets|tokens|passwords)/iu;
const violations = [];
let fileCount = 0;

const rootManifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const workspaceDirectories = (await readdir(join(root, 'packages'), { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
const sourceManifests = [
  { path: 'package.json', value: rootManifest },
  ...await Promise.all(workspaceDirectories.map(async (directory) => ({
    path: `packages/${directory}/package.json`,
    value: JSON.parse(await readFile(join(root, 'packages', directory, 'package.json'), 'utf8')),
  }))),
];
for (const manifest of sourceManifests) {
  if (manifest.value.private !== true) violations.push(`${manifest.path}: private must remain true`);
  if (Object.hasOwn(manifest.value, 'license')) violations.push(`${manifest.path}: license crosses an unresolved human gate`);
  if (Object.hasOwn(manifest.value, 'publishConfig')) violations.push(`${manifest.path}: publishConfig crosses an unresolved human gate`);
}

for (const manifest of manifests) {
  if (!manifest || typeof manifest.name !== 'string' || !Array.isArray(manifest.files)) {
    violations.push('Malformed npm pack manifest');
    continue;
  }
  for (const file of manifest.files) {
    const path = typeof file?.path === 'string' ? file.path.replaceAll('\\', '/') : '';
    fileCount += 1;
    if (path === '' || forbidden.test(path)) violations.push(`${manifest.name}: ${path || '<invalid path>'}`);
  }
}

const schemas = manifests.find((manifest) => manifest.name === '@primecontext/schemas');
const cli = manifests.find((manifest) => manifest.name === '@primecontext/cli');
const schemaContracts = schemas?.files?.filter((file) => /^contracts\/v[0-9.]+\/[^/]+\.schema\.json$/u.test(file.path)) ?? [];
const cliHasBinary = cli?.files?.some((file) => file.path === 'dist/bin.js') ?? false;
if (schemaContracts.length < 21) violations.push(`@primecontext/schemas: expected at least 21 physical contracts, received ${schemaContracts.length}`);
if (!cliHasBinary) violations.push('@primecontext/cli: dist/bin.js is missing');

if (violations.length > 0) {
  process.stderr.write(`${violations.join('\n')}\n`);
  process.exit(1);
}

process.stdout.write(`${JSON.stringify({
  status: 'PASS',
  workspace_package_count: manifests.length,
  packaged_file_count: fileCount,
  physical_contract_count: schemaContracts.length,
  cli_binary_present: true,
  private_manifest_count: sourceManifests.length,
  publication_metadata_absent: true,
})}\n`);
