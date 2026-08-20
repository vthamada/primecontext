import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const binary = join(workspace, 'packages', 'cli', 'dist', 'bin.js');
const demoParent = await mkdtemp(join(tmpdir(), 'primecontext demo '));
const demoRoot = join(demoParent, 'primecontext-demo');
let summary;

const prepareArguments = [
  'prepare', 'Inspect compiler evidence and security provenance',
  '--accept', 'compiler evidence',
  '--accept', 'security provenance',
  '--path', 'docs/security.md',
  '--path', 'src/compiler.ts',
  '--term', 'compiler',
  '--term', 'evidence',
  '--term', 'security',
  '--term', 'provenance',
];

function run(args, input) {
  const result = spawnSync(process.execPath, [binary, ...args], {
    cwd: demoRoot,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    ...(input === undefined ? {} : { input }),
  });
  if (result.status !== 0) {
    const message = result.stderr.trim() || 'PrimeContext demo command failed';
    throw new Error(message);
  }
  return JSON.parse(result.stdout);
}

try {
  await mkdir(demoRoot, { recursive: true });
  await mkdir(join(demoRoot, 'docs'), { recursive: true });
  await mkdir(join(demoRoot, 'src'), { recursive: true });
  await writeFile(join(demoRoot, 'package.json'), `${JSON.stringify({
    name: 'primecontext-disposable-demo', private: true, type: 'module',
  }, null, 2)}\n`);
  await writeFile(join(demoRoot, 'README.md'), '# PrimeContext demo\n\nA synthetic proof-carrying context example.\n');
  await writeFile(join(demoRoot, 'docs', 'security.md'), '# Security\n\nSecurity provenance is inspectable evidence.\n');
  await writeFile(join(demoRoot, 'src', 'compiler.ts'), [
    '// Compiler evidence is selected deterministically.',
    'export interface Receipt { selectionDigest: string }',
    'export function compileEvidence(): Receipt {',
    "  return { selectionDigest: 'deterministic' };",
    '}',
    '',
  ].join('\n'));

  const prepared = run([...prepareArguments, '--full']);
  assert.equal(prepared.request.task.task_id, prepared.envelope.task_id);
  assert.equal(prepared.receipt.task_id, prepared.envelope.task_id);
  assert.equal(prepared.request.schema_version, '0.3');
  assert.equal(prepared.envelope.schema_version, '0.3');
  assert.equal(prepared.receipt.schema_version, '0.3');
  assert.equal(prepared.envelope.request_digest, prepared.receipt.request_digest);
  assert.equal(prepared.envelope.selection_digest, prepared.receipt.selection_digest);
  assert.match(prepared.envelope.selection_digest, /^sha256:[a-f0-9]{64}$/u);
  assert.match(prepared.receipt.receipt_digest, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(prepared.envelope.evidence_status, 'READY');
  assert.equal(prepared.envelope.budget_status, 'WITHIN_BUDGET');
  assert.equal(prepared.automation.collection.observations, 1);
  assert.equal(prepared.receipt.decisions.filter((decision) => decision.status === 'INCLUDED').length, prepared.envelope.items.length);
  const selectedPaths = new Set(prepared.envelope.items.map((item) => item.path));
  assert.equal(selectedPaths.has('docs/security.md'), true);
  assert.equal(selectedPaths.has('src/compiler.ts'), true);
  assert.equal(prepared.automation.index.fallback_used, prepared.automation.index.status === 'UNAVAILABLE');

  const compact = run(prepareArguments);
  assert.equal(Object.hasOwn(compact, 'request'), false);
  assert.equal(Object.hasOwn(compact, 'receipt'), false);
  assert.equal(compact.task_id, prepared.envelope.task_id);
  assert.equal(compact.selection_digest, prepared.envelope.selection_digest);
  assert.equal(compact.receipt_summary.receipt_digest, prepared.receipt.receipt_digest);
  assert.equal(compact.envelope.selection_digest, prepared.envelope.selection_digest);
  assert.ok(Buffer.byteLength(JSON.stringify(compact), 'utf8') <= compact.output_ceiling_bytes);

  const repeated = run([...prepareArguments, '--full']);
  assert.equal(repeated.envelope.selection_digest, prepared.envelope.selection_digest);
  assert.equal(repeated.receipt.receipt_digest, prepared.receipt.receipt_digest);
  if (repeated.automation.index.status === 'READY') assert.equal(repeated.automation.index.reused, true);

  summary = {
    status: 'PASS',
    task_id: prepared.request.task.task_id,
    evidence_status: prepared.envelope.evidence_status,
    budget_status: prepared.envelope.budget_status,
    selected_count: prepared.envelope.items.length,
    selection_digest_verified: true,
    protocol: 'process-json',
    zero_config: true,
    index_status: prepared.automation.index.status,
    index_reused: repeated.automation.index.reused,
    compact_output_verified: true,
    linkage_verified: true,
  };
} finally {
  await rm(demoParent, { recursive: true, force: true });
}
let removed = false;
try {
  await access(demoParent);
} catch (error) {
  if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') removed = true;
  else throw error;
}
assert.equal(removed, true);
process.stdout.write(`${JSON.stringify({ ...summary, temporary_repository_removed: removed }, null, 2)}\n`);
