import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const binary = join(workspace, 'packages', 'cli', 'dist', 'bin.js');
const demoParent = await mkdtemp(join(tmpdir(), 'primecontext demo '));
const demoRoot = join(demoParent, 'primecontext-demo');
let summary;

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
  await writeFile(join(demoRoot, 'docs', 'security.md'), '# Security\n\nEvidence retains provenance and freshness.\n');
  await writeFile(join(demoRoot, 'src', 'compiler.ts'), [
    'export interface Receipt { selectionDigest: string }',
    'export function compileEvidence(): Receipt {',
    "  return { selectionDigest: 'deterministic' };",
    '}',
    '',
  ].join('\n'));

  const prepared = run([
    'prepare', 'Inspect the synthetic proof-carrying context flow',
    '--accept', 'Compiler evidence is selected',
    '--accept', 'Security evidence is inspectable',
    '--path', 'docs/security.md',
    '--path', 'src/compiler.ts',
    '--term', 'compiler',
    '--term', 'security',
  ]);
  summary = {
    status: 'PASS',
    task_id: prepared.request.task.task_id,
    evidence_status: prepared.envelope.evidence_status,
    budget_status: prepared.envelope.budget_status,
    selected_count: prepared.envelope.items.length,
    selection_digest: prepared.envelope.selection_digest,
    protocol: 'process-json',
    zero_config: true,
    index_status: prepared.automation.index.status,
  };
} finally {
  await rm(demoParent, { recursive: true, force: true });
}
process.stdout.write(`${JSON.stringify({ ...summary, temporary_repository_removed: true }, null, 2)}\n`);
