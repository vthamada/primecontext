import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PrimeContextError } from '@primecontext/core';
import {
  assertValidLocalCodeGraphV03,
  DEFAULT_CODEGRAPH_LIMITS_V03,
  NodeCodeGraphAdapter,
  type LocalCodeGraphV03,
} from './codegraph.js';
import { windowsShortNameFor } from './windows-short-name.test-helper.js';

async function fixture(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'primecontext-codegraph-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'src'), { recursive: true });
  return root;
}

function edgeKinds(graph: LocalCodeGraphV03): string[] {
  return [...new Set(graph.edges.map((edge) => edge.kind))].sort();
}

function sourceHash(content: string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

function binding(path: string, content: string) {
  return {
    snapshot: {
      repository_id: 'codegraph-fixture',
      worktree_digest: `sha256:${'a'.repeat(64)}`,
    },
    accepted_sources: [{ path, source_hash: sourceHash(content) }],
  };
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
  assert.match(first.toolchain.typescript_version, /^\d+\.\d+/);
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

  const tamperedToolchain = structuredClone(first);
  tamperedToolchain.toolchain.typescript_version = `${first.toolchain.typescript_version}-tampered`;
  assert.throws(
    () => assertValidLocalCodeGraphV03(tamperedToolchain),
    /digest does not match/i,
    'the graph digest must bind the active TypeScript toolchain identity',
  );
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

test('binding collection uses only the accepted-source observation and does not rediscover files', async (t) => {
  const root = await fixture(t);
  const accepted = 'export const accepted = true;\n';
  await writeFile(join(root, 'src', 'accepted.ts'), accepted);
  await writeFile(join(root, 'src', 'unobserved.ts'), 'export const unobserved = true;\n');

  const graph = await new NodeCodeGraphAdapter().collect(root, binding('src/accepted.ts', accepted));

  assert.deepEqual(graph.files.map((file) => file.path), ['src/accepted.ts']);
  assert.deepEqual(graph.binding.accepted_sources, binding('src/accepted.ts', accepted).accepted_sources);
  assert.equal(graph.summary.discovered_path_count, 1);
  assert.equal(graph.summary.candidate_file_count, 1);
  assert.equal(graph.summary.excluded_path_count, 0);
  assert.equal(graph.summary.omitted_oversize_count, 0);
  assert.equal(graph.summary.omitted_parse_error_count, 0);
  assert.equal(graph.summary.omitted_sensitive_count, 0);
});

test('binding collection reapplies configured excludes before reading accepted sources', async (t) => {
  const root = await fixture(t);
  const excluded = 'export const excludedMarker = "DO-NOT-MATERIALIZE-EXCLUDED";\n';
  const accepted = 'export const accepted = true;\n';
  await mkdir(join(root, 'benchmarks'), { recursive: true });
  await writeFile(join(root, 'benchmarks', 'internal.ts'), excluded);
  await writeFile(join(root, 'src', 'accepted.ts'), accepted);

  let optionalRuntimeLoaded = false;
  const adapter = new NodeCodeGraphAdapter(['benchmarks'], {}, {
    loadTypeScript: async () => {
      optionalRuntimeLoaded = true;
      return import('typescript');
    },
  });
  await assert.rejects(
    adapter.collect(root, binding('benchmarks/internal.ts', excluded)),
    (error: unknown) => {
      assert.equal(error instanceof PrimeContextError, true);
      assert.equal((error as PrimeContextError).code, 'SECURITY_ERROR');
      assert.doesNotMatch((error as Error).message, /benchmarks|internal\.ts|DO-NOT-MATERIALIZE/i);
      return true;
    },
  );
  assert.equal(optionalRuntimeLoaded, false);

  const graph = await adapter.collect(root, binding('src/accepted.ts', accepted));
  assert.equal(optionalRuntimeLoaded, true);
  assert.deepEqual(graph.files.map((file) => file.path), ['src/accepted.ts']);
});

test('binding collection blocks Windows case and Unicode aliases of configured excludes before loading the optional runtime', {
  skip: platform() === 'win32' ? false : 'Windows path aliases are case-insensitive',
}, async (t) => {
  const root = await fixture(t);
  const excluded = 'export const caseAliasMarker = "DO-NOT-MATERIALIZE-CASE-ALIAS";\n';
  const unicodeExcluded = 'export const unicodeAliasMarker = "DO-NOT-MATERIALIZE-UNICODE-ALIAS";\n';
  const accepted = 'export const acceptedCaseControl = true;\n';
  const sibling = 'export const siblingPrefixControl = true;\n';
  const decomposed = 'export const decomposedUnicodeControl = true;\n';
  await mkdir(join(root, 'blocked'), { recursive: true });
  await mkdir(join(root, 'ı-private'), { recursive: true });
  await mkdir(join(root, 'blocked-sibling'), { recursive: true });
  await mkdir(join(root, 'café'), { recursive: true });
  await writeFile(join(root, 'blocked', 'internal.ts'), excluded);
  await writeFile(join(root, 'ı-private', 'internal.ts'), unicodeExcluded);
  await writeFile(join(root, 'blocked-sibling', 'control.ts'), sibling);
  await writeFile(join(root, 'café', 'control.ts'), decomposed);
  await writeFile(join(root, 'src', 'accepted-case-control.ts'), accepted);

  let optionalRuntimeLoadCount = 0;
  const adapter = new NodeCodeGraphAdapter(['blocked', 'ı-private', 'café'], {}, {
    loadTypeScript: async () => {
      optionalRuntimeLoadCount += 1;
      return import('typescript');
    },
  });
  for (const [relativePath, content] of [
    ['blocked/internal.ts', excluded],
    ['BLOCKED/internal.ts', excluded],
    ['ı-private/internal.ts', unicodeExcluded],
    ['I-PRIVATE/internal.ts', unicodeExcluded],
  ] as const) {
    await assert.rejects(
      adapter.collect(root, binding(relativePath, content)),
      (error: unknown) => {
        assert.equal(error instanceof PrimeContextError, true);
        assert.equal((error as PrimeContextError).code, 'SECURITY_ERROR');
        assert.doesNotMatch((error as Error).message, /blocked|private|internal\.ts|(?:CASE|UNICODE)-ALIAS/i);
        return true;
      },
      relativePath,
    );
  }
  assert.equal(optionalRuntimeLoadCount, 0);

  for (const [relativePath, content] of [
    ['blocked-sibling/control.ts', sibling],
    ['café/control.ts', decomposed],
    ['src/accepted-case-control.ts', accepted],
  ] as const) {
    const graph = await adapter.collect(root, binding(relativePath, content));
    assert.deepEqual(graph.files.map((file) => file.path), [relativePath]);
  }
  assert.equal(optionalRuntimeLoadCount, 3);
});

test('binding collection resolves Windows DOS short names before blocked-path checks and runtime loading', {
  skip: platform() === 'win32' ? false : 'Windows DOS short names are platform-specific',
}, async (t) => {
  const root = await fixture(t);
  const excluded = 'export const excludedShortNameMarker = true;\n';
  const sensitive = 'export const sensitiveShortNameMarker = true;\n';
  const accepted = 'export const acceptedShortNameControl = true;\n';
  await mkdir(join(root, 'docs', 'private-material'), { recursive: true });
  await mkdir(join(root, 'docs', '.obsidian'), { recursive: true });
  await mkdir(join(root, 'docs', 'public-material'), { recursive: true });
  await writeFile(join(root, 'docs', 'private-material', 'hidden.ts'), excluded);
  await writeFile(join(root, 'docs', '.obsidian', 'hidden.ts'), sensitive);
  await writeFile(join(root, 'docs', 'public-material', 'visible.ts'), accepted);

  const excludedShortName = windowsShortNameFor(join(root, 'docs'), 'private-material');
  const sensitiveShortName = windowsShortNameFor(join(root, 'docs'), '.obsidian');
  const acceptedShortName = windowsShortNameFor(join(root, 'docs'), 'public-material');
  if (!excludedShortName || !sensitiveShortName || !acceptedShortName) {
    t.skip('The test volume does not expose DOS short names');
    return;
  }

  let optionalRuntimeLoadCount = 0;
  const adapter = new NodeCodeGraphAdapter(['docs/private-material'], {}, {
    loadTypeScript: async () => {
      optionalRuntimeLoadCount += 1;
      return import('typescript');
    },
  });
  for (const [relativePath, content] of [
    ['docs/private-material/hidden.ts', excluded],
    [`docs/${excludedShortName}/hidden.ts`, excluded],
    ['docs/.obsidian/hidden.ts', sensitive],
    [`docs/${sensitiveShortName}/hidden.ts`, sensitive],
  ] as const) {
    await assert.rejects(
      adapter.collect(root, binding(relativePath, content)),
      (error: unknown) => {
        assert.equal(error instanceof PrimeContextError, true);
        assert.equal(['SECURITY_ERROR', 'VALIDATION_ERROR'].includes((error as PrimeContextError).code), true);
        return true;
      },
      relativePath,
    );
  }
  assert.equal(optionalRuntimeLoadCount, 0);

  const acceptedPath = `docs/${acceptedShortName}/visible.ts`;
  const graph = await adapter.collect(root, binding(acceptedPath, accepted));
  assert.deepEqual(graph.files.map((file) => file.path), [acceptedPath]);
  assert.equal(graph.nodes.some((node) => node.name === 'acceptedShortNameControl'), true);
  assert.equal(optionalRuntimeLoadCount, 1);
});

test('binding collection retains the CodeGraph source-extension gate', async (t) => {
  const root = await fixture(t);
  const content = 'export const disguisedAsCode = true;\n';
  await mkdir(join(root, 'notes'), { recursive: true });
  await writeFile(join(root, 'notes', 'disguised.txt'), content);

  await assert.rejects(
    new NodeCodeGraphAdapter().collect(root, binding('notes/disguised.txt', content)),
    (error: unknown) => error instanceof PrimeContextError && error.code === 'VALIDATION_ERROR',
  );
});

test('binding collection fails closed when an accepted source is missing, changed, or omitted', async (t) => {
  const root = await fixture(t);
  const original = 'export const accepted = true;\n';
  const adapter = new NodeCodeGraphAdapter();

  await assert.rejects(adapter.collect(root, binding('src/missing.ts', original)), (error: unknown) => {
    assert.equal(error instanceof PrimeContextError, true);
    assert.equal((error as PrimeContextError).code, 'FRESHNESS_ERROR');
    return true;
  });

  await writeFile(join(root, 'src', 'changed.ts'), 'export const changed = true;\n');
  await assert.rejects(adapter.collect(root, binding('src/changed.ts', original)), (error: unknown) => {
    assert.equal(error instanceof PrimeContextError, true);
    assert.equal((error as PrimeContextError).code, 'FRESHNESS_ERROR');
    return true;
  });

  const invalid = 'export function broken( {\n';
  await writeFile(join(root, 'src', 'invalid-bound.ts'), invalid);
  await assert.rejects(adapter.collect(root, binding('src/invalid-bound.ts', invalid)), (error: unknown) => {
    assert.equal(error instanceof PrimeContextError, true);
    assert.equal((error as PrimeContextError).code, 'FRESHNESS_ERROR');
    return true;
  });
});

test('binding collection re-screens accepted content before graph construction', async (t) => {
  const root = await fixture(t);
  const accepted = 'export const safe = true;\n';
  await writeFile(join(root, 'src', 'accepted.ts'), [
    'export const material = `-----BEGIN ENCRYPTED PRIVATE KEY-----',
    'DO-NOT-EXPOSE`;',
    '',
  ].join('\n'));

  await assert.rejects(
    new NodeCodeGraphAdapter().collect(root, binding('src/accepted.ts', accepted)),
    (error: unknown) => {
      assert.equal(error instanceof PrimeContextError, true);
      assert.equal((error as PrimeContextError).code, 'SECURITY_ERROR');
      assert.doesNotMatch((error as Error).message, /DO-NOT-EXPOSE|accepted\.ts/i);
      return true;
    },
  );
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

test('CodeGraph collection honors a pre-aborted cooperative cancellation signal', async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, 'src', 'entry.ts'), 'export const value = 1;\n');
  let loaded = false;
  const adapter = new NodeCodeGraphAdapter([], {}, {
    loadTypeScript: async () => {
      loaded = true;
      return import('typescript');
    },
  });
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(adapter.collect(root, undefined, { signal: controller.signal }), /cancel/i);
  assert.equal(loaded, false);
});
