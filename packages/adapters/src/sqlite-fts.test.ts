import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { PrimeContextError } from '@primecontext/core';
import {
  DEFAULT_SQLITE_FTS_LIMITS_V03,
  NodeSqliteFtsAdapter,
  type HybridIndexSourceV03,
} from './sqlite-fts.js';

const digest = (value: string): string => `sha256:${createHash('sha256').update(value).digest('hex')}`;

test('exposes the bounded v0.3 SQLite/FTS source caps', () => {
  assert.deepEqual(DEFAULT_SQLITE_FTS_LIMITS_V03, {
    maxSources: 16_384,
    maxSourceBytes: 1024 * 1024,
    maxTotalBytes: 256 * 1024 * 1024,
  });
});

test('keeps the adapters package importable when node:sqlite is disabled and reports a sanitized capability error on use', async (t) => {
  const root = await fixture(t);
  const adaptersUrl = new URL('./index.js', import.meta.url).href;
  const script = `
    const adapters = await import(${JSON.stringify(adaptersUrl)});
    const adapter = new adapters.NodeSqliteFtsAdapter();
    const worktreeDigest = 'sha256:${'0'.repeat(64)}';
    const operations = [
      () => adapter.rebuild(
        ${JSON.stringify(root)},
        '.primecontext/no-sqlite.sqlite',
        [],
        { repository_id: 'primecontext-no-sqlite-smoke', worktree_digest: worktreeDigest },
      ),
      () => adapter.search(
        ${JSON.stringify(root)},
        '.primecontext/no-sqlite.sqlite',
        'compiler',
        { expected_worktree_digest: worktreeDigest },
      ),
    ];
    const errors = [];
    for (const operation of operations) {
      try {
        await operation();
        errors.push({ unexpected_success: true });
        process.exitCode = 3;
      } catch (error) {
        errors.push({
          name: error?.name,
          code: error?.code,
          message: error?.message,
          details: error?.details,
        });
      }
    }
    process.stdout.write(JSON.stringify({ imported: true, errors }));
  `;
  const result = spawnSync(process.execPath, [
    '--no-experimental-sqlite',
    '--input-type=module',
    '--eval',
    script,
  ], { encoding: 'utf8' });

  assert.equal(result.status, 0, `child stderr: ${result.stderr}`);
  assert.deepEqual(JSON.parse(result.stdout), {
    imported: true,
    errors: [
      {
        name: 'PrimeContextError',
        code: 'CAPABILITY_ERROR',
        message: 'CAPABILITY_ERROR: SQLite/FTS capability is unavailable',
        details: [],
      },
      {
        name: 'PrimeContextError',
        code: 'CAPABILITY_ERROR',
        message: 'CAPABILITY_ERROR: SQLite/FTS capability is unavailable',
        details: [],
      },
    ],
  });
  assert.equal(result.stderr.includes('ERR_UNKNOWN_BUILTIN_MODULE'), false);
  await assert.rejects(access(join(root, '.primecontext', 'no-sqlite.sqlite')));
});

async function fixture(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'primecontext-fts-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.primecontext'), { recursive: true });
  return root;
}

function source(
  path: string,
  content: string,
  options: Partial<HybridIndexSourceV03> = {},
): HybridIndexSourceV03 {
  return {
    path,
    kind: 'document',
    authority: 'implementation_note',
    source_hash: digest(content),
    content,
    ...options,
  };
}

test('atomically rebuilds a secure bounded FTS5 index and searches deterministically', async (t) => {
  const root = await fixture(t);
  const adapter = new NodeSqliteFtsAdapter();
  const sources = [
    source('docs/b.md', '# Compiler receipt\nThe compiler emits a receipt for review.'),
    source('docs/a.md', '# Compiler receipt\nThe compiler emits a receipt for audit.'),
    source('src/compiler.ts', '// compiler\nexport function compileReceipt() { return "receipt"; }', {
      kind: 'code', authority: 'source_code', title: 'compileReceipt',
    }),
  ];
  const rebuilt = await adapter.rebuild(root, '.primecontext/context-v03.sqlite', sources, {
    repository_id: 'primecontext',
    worktree_digest: digest('worktree-a'),
  });

  assert.equal(rebuilt.schema_version, '0.3');
  assert.equal(rebuilt.index_path, '.primecontext/context-v03.sqlite');
  assert.equal(rebuilt.indexed_source_count, 3);
  assert.equal(rebuilt.secure_delete, true);
  assert.match(rebuilt.index_digest, /^sha256:[0-9a-f]{64}$/);

  const result = await adapter.search(root, '.primecontext/context-v03.sqlite', 'compiler receipt', {
    limit: 10,
    expected_worktree_digest: digest('worktree-a'),
  });
  assert.deepEqual(result.hits.map((hit) => hit.path), [
    'docs/a.md', 'docs/b.md', 'src/compiler.ts',
  ]);
  assert.deepEqual(result.hits[0]?.matched_terms, ['compiler', 'receipt']);
  assert.match(result.hits[0]?.excerpt_hash ?? '', /^sha256:[0-9a-f]{64}$/);
  assert.equal(result.index_digest, rebuilt.index_digest);
  assert.equal(result.worktree_digest, digest('worktree-a'));
  await assert.rejects(access(join(root, '.primecontext', 'context-v03.sqlite.lock')));

  await adapter.rebuild(root, '.primecontext/long-snippet.sqlite', [
    source('docs/long.md', `alpha ${'x'.repeat(2_000)} omega`),
  ], { repository_id: 'repo', worktree_digest: digest('long') });
  const longResult = await adapter.search(root, '.primecontext/long-snippet.sqlite', 'alpha', {
    expected_worktree_digest: digest('long'),
  });
  assert.equal(longResult.hits[0]?.truncated, true);
  assert.equal(Array.from(longResult.hits[0]?.excerpt ?? '').length <= 1_200, true);
});

test('fails closed on stale snapshot, tampering, and invalid query syntax', async (t) => {
  const root = await fixture(t);
  const adapter = new NodeSqliteFtsAdapter();
  await adapter.rebuild(root, '.primecontext/context.sqlite', [
    source('docs/guide.md', '# Deterministic compiler\nA bounded compiler guide.'),
  ], { repository_id: 'repo', worktree_digest: digest('one') });

  await assert.rejects(adapter.search(root, '.primecontext/context.sqlite', 'compiler', {
    expected_worktree_digest: digest('two'),
  }), /stale/i);
  await assert.rejects(adapter.search(root, '.primecontext/context.sqlite', '" *', {
    expected_worktree_digest: digest('one'),
  }), /query/i);

  const database = new DatabaseSync(join(root, '.primecontext', 'context.sqlite'));
  database.prepare('UPDATE sources SET content = ? WHERE path = ?').run('tampered compiler', 'docs/guide.md');
  database.close();
  await assert.rejects(adapter.search(root, '.primecontext/context.sqlite', 'compiler', {
    expected_worktree_digest: digest('one'),
  }), /content|digest/i);

  await adapter.rebuild(root, '.primecontext/path-tamper.sqlite', [
    source('docs/safe.md', '# Safe compiler\nA compiler guide.'),
  ], { repository_id: 'repo', worktree_digest: digest('path-safe') });
  const pathDatabase = new DatabaseSync(join(root, '.primecontext', 'path-tamper.sqlite'));
  pathDatabase.prepare('UPDATE sources SET path = ?').run('.env');
  pathDatabase.prepare('UPDATE entries_fts SET path = ?').run('.env');
  pathDatabase.close();
  await assert.rejects(adapter.search(root, '.primecontext/path-tamper.sqlite', 'compiler', {
    expected_worktree_digest: digest('path-safe'),
  }), /sensitive|safe path|digest/i);
});

test('blocks sensitive content before persistence and preserves the prior valid index', async (t) => {
  const root = await fixture(t);
  const path = '.primecontext/context.sqlite';
  const adapter = new NodeSqliteFtsAdapter();
  await adapter.rebuild(root, path, [source('docs/public.md', '# Public\nSafe content.')], {
    repository_id: 'repo', worktree_digest: digest('safe'),
  });
  const before = await readFile(join(root, path));

  await assert.rejects(adapter.rebuild(root, path, [
    source('src/private-material.ts', 'export const header = "Authorization: Basic dXNlcjpwYXNzd29yZA==";', {
      kind: 'code', authority: 'source_code',
    }),
  ], { repository_id: 'repo', worktree_digest: digest('unsafe') }), /sensitive/i);
  const after = await readFile(join(root, path));
  assert.deepEqual(after, before);

  await assert.rejects(adapter.rebuild(root, path, [
    source('docs/public.md', '# Public\nSafe content.', {
      title: 'Authorization: Basic dXNlcjpwYXNz',
    }),
  ], { repository_id: 'repo', worktree_digest: digest('unsafe-title') }), /sensitive/i);
  await assert.rejects(adapter.rebuild(root, path, [
    source('src/public.ts', 'export function publicValue() { return true; }', {
      kind: 'code', authority: 'source_code', title: 'publicValue',
      locator: {
        start_line: 1, end_line: 1,
        symbol: 'Authorization: Basic dXNlcjpwYXNz',
      },
    }),
  ], { repository_id: 'repo', worktree_digest: digest('unsafe-symbol') }), /locator|sensitive/i);
  assert.deepEqual(await readFile(join(root, path)), before);

  const stillSearchable = await adapter.search(root, path, 'public', {
    expected_worktree_digest: digest('safe'),
  });
  assert.equal(stillSearchable.hits[0]?.path, 'docs/public.md');
});

test('indexes distinct declaration locators from the same code path deterministically', async (t) => {
  const root = await fixture(t);
  const adapter = new NodeSqliteFtsAdapter();
  const contentOne = 'export function alphaOne() { return "alpha"; }';
  const contentTwo = 'export function alphaTwo() { return "alpha"; }';
  await adapter.rebuild(root, '.primecontext/declarations.sqlite', [
    source('src/shared.ts', contentTwo, {
      kind: 'code', authority: 'source_code', title: 'alphaTwo',
      locator: { start_line: 10, end_line: 12, symbol: 'alphaTwo' },
    }),
    source('src/shared.ts', contentOne, {
      kind: 'code', authority: 'source_code', title: 'alphaOne',
      locator: { start_line: 1, end_line: 3, symbol: 'alphaOne' },
    }),
  ], { repository_id: 'repo', worktree_digest: digest('declarations') });

  const result = await adapter.search(root, '.primecontext/declarations.sqlite', 'alpha', {
    expected_worktree_digest: digest('declarations'), limit: 10,
  });
  assert.deepEqual(result.hits.map((hit) => hit.locator?.start_line), [1, 10]);
});

test('rejects sensitive index paths, traversal, duplicate paths, forged hashes, and concurrent writers', async (t) => {
  const root = await fixture(t);
  const adapter = new NodeSqliteFtsAdapter();
  const metadata = { repository_id: 'repo', worktree_digest: digest('worktree') };
  await assert.rejects(adapter.rebuild(root, '.git/context.sqlite', [], metadata), /sensitive/i);
  await assert.rejects(adapter.rebuild(root, '../escape.sqlite', [], metadata), /path/i);
  await assert.rejects(adapter.rebuild(root, '.primecontext/duplicate.sqlite', [
    source('docs/a.md', 'one'), source('docs/a.md', 'two'),
  ], metadata), /duplicate/i);
  await assert.rejects(adapter.rebuild(root, '.primecontext/forged.sqlite', [
    { ...source('docs/a.md', 'one'), source_hash: digest('other') },
  ], metadata), /hash/i);

  const externalLock = join(root, '.primecontext', 'external.sqlite.lock');
  await writeFile(externalLock, '');
  await assert.rejects(adapter.rebuild(root, '.primecontext/external.sqlite', [
    source('docs/a.md', 'one'),
  ], metadata), /active writer/i);
  await rm(externalLock);

  const firstWriter = adapter.rebuild(root, '.primecontext/concurrent.sqlite', [
    source('docs/a.md', 'one'),
  ], metadata);
  await assert.rejects(adapter.rebuild(root, '.primecontext/concurrent.sqlite', [
    source('docs/b.md', 'two'),
  ], metadata), /active writer/i);
  await firstWriter;
});

test('uses monotonic cooperative deadlines in FTS rebuild and result processing loops', async (t) => {
  const root = await fixture(t);
  const metadata = { repository_id: 'repo', worktree_digest: digest('deadline') };
  let rebuildClockCalls = 0;
  const rebuildAdapter = new NodeSqliteFtsAdapter({
    monotonicNow: () => {
      rebuildClockCalls += 1;
      return rebuildClockCalls < 4 ? 50 : 30_051;
    },
  });

  await assert.rejects(rebuildAdapter.rebuild(root, '.primecontext/deadline.sqlite', [
    source('docs/a.md', 'bounded alpha content'),
  ], metadata), (error: unknown) => {
    assert.equal(error instanceof PrimeContextError, true);
    assert.equal((error as PrimeContextError).code, 'CAPABILITY_ERROR');
    assert.match((error as Error).message, /cooperative.*deadline/i);
    return true;
  });
  assert.equal(rebuildClockCalls >= 4, true);
  await assert.rejects(access(join(root, '.primecontext', 'deadline.sqlite')));

  const live = new NodeSqliteFtsAdapter();
  await live.rebuild(root, '.primecontext/search-deadline.sqlite', [
    source('docs/a.md', 'bounded alpha content'),
  ], metadata);
  let searchClockCalls = 0;
  const searchAdapter = new NodeSqliteFtsAdapter({
    monotonicNow: () => {
      searchClockCalls += 1;
      return searchClockCalls < 16 ? 75 : 30_076;
    },
  });
  await assert.rejects(searchAdapter.search(root, '.primecontext/search-deadline.sqlite', 'alpha', {
    expected_worktree_digest: metadata.worktree_digest,
  }), (error: unknown) => {
    assert.equal(error instanceof PrimeContextError, true);
    assert.equal((error as PrimeContextError).code, 'CAPABILITY_ERROR');
    assert.match((error as Error).message, /cooperative.*deadline/i);
    return true;
  });
  assert.equal(searchClockCalls >= 16, true);
});
