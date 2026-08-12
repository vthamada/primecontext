import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PrimeContextError } from '@primecontext/core';
import {
  DEFAULT_CODEGRAPH_LIMITS_V03,
  NodeCodeGraphAdapter,
  type LocalCodeGraphV03,
} from './codegraph.js';

async function fixture(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'primecontext-codegraph-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'src'), { recursive: true });
  return root;
}

function edgeKinds(graph: LocalCodeGraphV03): string[] {
  return [...new Set(graph.edges.map((edge) => edge.kind))].sort();
}

test('exposes the bounded v0.3 CodeGraph source and graph caps', () => {
  assert.deepEqual(DEFAULT_CODEGRAPH_LIMITS_V03, {
    maxFiles: 16_384,
    maxFileBytes: 1024 * 1024,
    maxTotalBytes: 256 * 1024 * 1024,
    maxNodes: 100_000,
    maxEdges: 250_000,
  });
});

test('collects a deterministic bounded TypeScript/JavaScript graph without executing modules', async (t) => {
  const root = await fixture(t);
  delete (globalThis as Record<string, unknown>).__primecontextExecuted;
  await writeFile(join(root, 'src', 'math.ts'), [
    'export function twice(value: number): number {',
    '  return value * 2;',
    '}',
    'function local(value: number): number { return twice(value); }',
    'export class Calculator { run(value: number): number { return local(value); } }',
    '(globalThis as any).__primecontextExecuted = true;',
    '',
  ].join('\n'));
  await writeFile(join(root, 'src', 'consumer.js'), [
    "import { twice } from './math.js';",
    'export const answer = () => twice(21);',
    '',
  ].join('\n'));
  await writeFile(join(root, 'src', 'secrets.ts'), 'export const shouldNeverBeRead = true;\n');
  await writeFile(join(root, 'src', 'private-material-example.ts'), [
    'export const material = `-----BEGIN ENCRYPTED PRIVATE KEY-----',
    'DO-NOT-EXPOSE`;',
    '',
  ].join('\n'));

  const adapter = new NodeCodeGraphAdapter();
  const first = await adapter.collect(root);
  const second = await adapter.collect(root);

  assert.equal((globalThis as Record<string, unknown>).__primecontextExecuted, undefined);
  assert.deepEqual(first, second);
  assert.equal(first.schema_version, '0.3');
  assert.match(first.source_digest, /^sha256:[0-9a-f]{64}$/);
  assert.match(first.graph_digest, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(first.files.map((file) => file.path), ['src/consumer.js', 'src/math.ts']);
  assert.equal(first.summary.excluded_path_count >= 1, true);
  assert.equal(first.summary.omitted_sensitive_count, 1);
  assert.deepEqual(edgeKinds(first), ['calls', 'contains', 'exports', 'imports']);

  const twice = first.nodes.find((node) => node.name === 'twice' && node.kind === 'function');
  const run = first.nodes.find((node) => node.name === 'run' && node.kind === 'method');
  assert.ok(twice);
  assert.ok(run);
  assert.equal(twice.locator.path, 'src/math.ts');
  assert.equal(twice.locator.start_line, 1);
  assert.equal(twice.locator.start_column, 1);
  assert.equal(first.edges.some((edge) => edge.kind === 'calls' && edge.to_id === twice.id), true);
  assert.equal(first.edges.some((edge) => edge.kind === 'contains' && edge.to_id === run.id), true);
  assert.equal(first.nodes.every((node) => !node.excerpt.includes('__primecontextExecuted')), true);
  assert.equal(JSON.stringify(first).includes('DO-NOT-EXPOSE'), false);
  assert.equal(JSON.stringify(first).includes('private-material-example.ts'), false);
});

test('does not falsely resolve property calls to unrelated bare symbols', async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, 'src', 'calls.ts'), [
    'export function run() { return 1; }',
    'declare const client: { run(): number };',
    'export function invoke() { return client.run(); }',
    '',
  ].join('\n'));

  const graph = await new NodeCodeGraphAdapter().collect(root);
  const propertyCall = graph.edges.find((edge) => edge.kind === 'calls' && edge.target === 'client.run');
  assert.ok(propertyCall);
  assert.equal(propertyCall.to_id, undefined);
});

test('does not resolve a lexically shadowed bare call to an unrelated global declaration', async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, 'src', 'a.ts'), 'export function run() { return 1; }\n');
  await writeFile(join(root, 'src', 'b.ts'), [
    'export function invoke(run: () => number) {',
    '  return run();',
    '}',
    '',
  ].join('\n'));

  const graph = await new NodeCodeGraphAdapter().collect(root);
  const exportedRun = graph.nodes.find((node) => node.locator.path === 'src/a.ts' && node.name === 'run');
  const shadowedCall = graph.edges.find((edge) => (
    edge.kind === 'calls' && edge.locator.path === 'src/b.ts' && edge.target === 'run'
  ));
  assert.ok(exportedRun);
  assert.ok(shadowedCall);
  assert.equal(shadowedCall.to_id, undefined);
  assert.notEqual(shadowedCall.to_id, exportedRun.id);
});

test('omits syntax-invalid and oversized files while enforcing global graph limits', async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, 'src', 'valid.ts'), 'export function valid() { return 1; }\n');
  await writeFile(join(root, 'src', 'invalid.ts'), 'export function broken( {\n');
  await writeFile(join(root, 'src', 'large.ts'), `export const large = '${'x'.repeat(300)}';\n`);

  const bounded = new NodeCodeGraphAdapter([], {
    maxFiles: 8,
    maxFileBytes: 128,
    maxTotalBytes: 1_024,
    maxNodes: 32,
    maxEdges: 64,
  });
  const graph = await bounded.collect(root);
  assert.deepEqual(graph.files.map((file) => file.path), ['src/valid.ts']);
  assert.equal(graph.summary.omitted_parse_error_count, 1);
  assert.equal(graph.summary.omitted_oversize_count, 1);

  const tooSmall = new NodeCodeGraphAdapter([], { maxFiles: 1 });
  await assert.rejects(tooSmall.collect(root), /file count limit/i);
});

test('reports an unavailable optional TypeScript capability only when collection is requested', async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, 'src', 'entry.ts'), 'export const value = 1;\n');
  const adapter = new NodeCodeGraphAdapter([], {}, {
    loadTypeScript: async () => {
      throw new Error('MODULE_NOT_FOUND: C:\\private\\typescript');
    },
  });

  await assert.rejects(adapter.collect(root), (error: unknown) => {
    assert.equal(error instanceof PrimeContextError, true);
    assert.equal((error as PrimeContextError).code, 'CAPABILITY_ERROR');
    assert.match((error as Error).message, /TypeScript CodeGraph capability is unavailable/i);
    assert.doesNotMatch((error as Error).message, /private|MODULE_NOT_FOUND/i);
    return true;
  });
});

test('uses a monotonic cooperative deadline while traversing CodeGraph work', async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, 'src', 'entry.ts'), 'export function value() { return 1; }\n');
  let clockCalls = 0;
  const adapter = new NodeCodeGraphAdapter([], {}, {
    monotonicNow: () => {
      clockCalls += 1;
      return clockCalls < 10 ? 100 : 30_101;
    },
  });

  await assert.rejects(adapter.collect(root), (error: unknown) => {
    assert.equal(error instanceof PrimeContextError, true);
    assert.equal((error as PrimeContextError).code, 'CAPABILITY_ERROR');
    assert.match((error as Error).message, /cooperative.*deadline/i);
    return true;
  });
  assert.equal(clockCalls >= 10, true);
});
