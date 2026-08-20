import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { access, chmod, mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { hostname, platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PrimeContextError } from '@primecontext/core';
import {
  DEFAULT_SQLITE_FTS_LIMITS_V03,
  NodeSqliteFtsAdapter,
  type HybridIndexSourceV03,
} from './sqlite-fts.js';
import { windowsShortNameFor } from './windows-short-name.test-helper.js';

const digest = (value: string): string => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const [NODE_MAJOR, NODE_MINOR] = process.versions.node.split('.').map((part) => Number.parseInt(part, 10));
const SQLITE_RUNTIME_AVAILABLE = Number.isSafeInteger(NODE_MAJOR) && Number.isSafeInteger(NODE_MINOR)
  && (NODE_MAJOR! >= 26 || NODE_MAJOR === 25 && NODE_MINOR! >= 7 || NODE_MAJOR === 24 && NODE_MINOR! >= 15);
const sqliteRuntimeTest = SQLITE_RUNTIME_AVAILABLE ? test : test.skip;

function lockRecord(pid: number, ownerHost = hostname()): string {
  return `${JSON.stringify({
    schema_version: 'primecontext-lock-v1',
    pid,
    hostname: ownerHost,
    created_at: '2026-08-14T12:00:00.000Z',
    operation: 'sqlite-fts-rebuild',
    owner_token: '00000000-0000-4000-8000-000000000001',
  })}\n`;
}

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

test('pre-release-candidate SQLite runtimes remain optional without emitting an ExperimentalWarning', {
  skip: SQLITE_RUNTIME_AVAILABLE ? 'runtime has warning-free release-candidate SQLite' : false,
}, async (t) => {
  const root = await fixture(t);
  const adapterUrl = new URL('./sqlite-fts.js', import.meta.url).href;
  const script = [
    `import { NodeSqliteFtsAdapter } from ${JSON.stringify(adapterUrl)};`,
    `const root = ${JSON.stringify(root)};`,
    "const worktreeDigest = `sha256:${'0'.repeat(64)}`;",
    "try { await new NodeSqliteFtsAdapter().rebuild(root, '.primecontext/unavailable-sqlite.sqlite', [], { repository_id: 'repo', worktree_digest: worktreeDigest }); }",
    "catch (error) { if (error?.code === 'CAPABILITY_ERROR') { console.log(error.code); process.exit(0); } throw error; }",
    'process.exit(2);',
  ].join('\n');
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], { encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /CAPABILITY_ERROR/);
  assert.doesNotMatch(result.stderr, /ExperimentalWarning|SQLite is an experimental feature/i);
});

async function fixture(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'primecontext-fts-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.primecontext'), { recursive: true });
  return root;
}

async function runNodeScript(script: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (status) => resolve({ status, stdout, stderr }));
  });
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

sqliteRuntimeTest('keeps the default SQLite index strictly inside the PrimeContext state boundary', async (t) => {
  const root = await fixture(t);
  const projectDirectory = join(root, 'src');
  await mkdir(projectDirectory);
  if (platform() !== 'win32') await chmod(projectDirectory, 0o755);
  const modeBefore = platform() === 'win32' ? undefined : (await stat(projectDirectory)).mode & 0o777;
  const adapter = new NodeSqliteFtsAdapter();

  await assert.rejects(adapter.rebuild(root, 'src/context.sqlite', [], {
    repository_id: 'repo', worktree_digest: digest('outside-default-state'),
  }), (error: unknown) => error instanceof PrimeContextError && error.code === 'SECURITY_ERROR');

  await assert.rejects(access(join(projectDirectory, 'context.sqlite')));
  if (modeBefore !== undefined) assert.equal((await stat(projectDirectory)).mode & 0o777, modeBefore);
});

test('validates explicit SQLite state boundaries before loading the optional runtime', async (t) => {
  const root = await fixture(t);
  const adapter = new NodeSqliteFtsAdapter();
  const metadata = { repository_id: 'repo', worktree_digest: digest('explicit-boundary') };
  const outsideOptions = { state_dir: '.primecontext' };

  await assert.rejects(
    adapter.rebuild(root, 'state/context.sqlite', [], metadata, outsideOptions),
    (error: unknown) => error instanceof PrimeContextError && error.code === 'SECURITY_ERROR',
  );
  await assert.rejects(
    adapter.search(root, 'state/context.sqlite', 'alpha', {
      expected_worktree_digest: metadata.worktree_digest,
      state_dir: '.primecontext',
    }),
    (error: unknown) => error instanceof PrimeContextError && error.code === 'SECURITY_ERROR',
  );
  await assert.rejects(
    adapter.rebuild(root, 'state-backup/context.sqlite', [], metadata, {
      state_dir: 'state',
    }),
    (error: unknown) => error instanceof PrimeContextError && error.code === 'SECURITY_ERROR',
  );
  await assert.rejects(
    adapter.rebuild(root, 'state.sqlite', [], metadata, {
      state_dir: 'state.sqlite',
    }),
    (error: unknown) => error instanceof PrimeContextError && error.code === 'SECURITY_ERROR',
  );
  await assert.rejects(
    adapter.rebuild(root, '.git/context.sqlite', [], metadata, {
      state_dir: '.git',
    }),
    (error: unknown) => error instanceof PrimeContextError && error.code === 'SECURITY_ERROR',
  );
  await assert.rejects(
    adapter.rebuild(root, 'state/.obsidian/context.sqlite', [], metadata, {
      state_dir: 'state',
    }),
    (error: unknown) => error instanceof PrimeContextError && error.code === 'SECURITY_ERROR',
  );

  await assert.rejects(access(join(root, 'state')));
  await assert.rejects(access(join(root, 'state-backup')));
});

sqliteRuntimeTest('supports a custom safe SQLite state boundary without touching its project parent', async (t) => {
  const root = await fixture(t);
  const parentDirectory = join(root, 'occupied');
  const stateDirectory = join(parentDirectory, 'context-state');
  await mkdir(parentDirectory);
  if (platform() !== 'win32') await chmod(parentDirectory, 0o755);
  const parentModeBefore = platform() === 'win32' ? undefined : (await stat(parentDirectory)).mode & 0o777;
  const adapter = new NodeSqliteFtsAdapter();
  const metadata = { repository_id: 'repo', worktree_digest: digest('custom-state') };

  const rebuilt = await adapter.rebuild(
    root,
    'occupied/context-state/context/index.sqlite',
    [source('docs/a.md', 'bounded alpha content')],
    metadata,
    { state_dir: 'occupied/context-state' },
  );
  const searched = await adapter.search(
    root,
    'occupied/context-state/context/index.sqlite',
    'alpha',
    { state_dir: 'occupied/context-state', expected_worktree_digest: metadata.worktree_digest },
  );

  assert.equal(rebuilt.index_path, 'occupied/context-state/context/index.sqlite');
  assert.equal(searched.hits[0]?.path, 'docs/a.md');
  if (parentModeBefore !== undefined) {
    assert.equal((await stat(parentDirectory)).mode & 0o777, parentModeBefore);
    assert.equal((await stat(stateDirectory)).mode & 0o777, 0o700);
    assert.equal((await stat(join(stateDirectory, 'context'))).mode & 0o777, 0o700);
  }
});

sqliteRuntimeTest('resolves Windows DOS short names before validating sensitive and custom SQLite state boundaries', {
  skip: platform() === 'win32' ? false : 'Windows DOS short names are platform-specific',
}, async (t) => {
  const root = await fixture(t);
  await mkdir(join(root, '.obsidian'));
  await mkdir(join(root, 'custom-context-state'));
  const sensitiveShortName = windowsShortNameFor(root, '.obsidian');
  const customShortName = windowsShortNameFor(root, 'custom-context-state');
  if (!sensitiveShortName || !customShortName) {
    t.skip('The test volume does not expose DOS short names');
    return;
  }
  const adapter = new NodeSqliteFtsAdapter();
  const metadata = { repository_id: 'repo', worktree_digest: digest('short-state') };

  await assert.rejects(
    adapter.rebuild(root, `${sensitiveShortName}/context.sqlite`, [], metadata, {
      state_dir: sensitiveShortName,
    }),
    (error: unknown) => error instanceof PrimeContextError && error.code === 'SECURITY_ERROR',
  );
  assert.deepEqual(await readdir(join(root, '.obsidian')), []);

  const relativePath = `${customShortName}/nested/context.sqlite`;
  const rebuilt = await adapter.rebuild(root, relativePath, [
    source('docs/a.md', 'bounded custom state content'),
  ], metadata, { state_dir: customShortName });
  assert.equal(rebuilt.index_path, relativePath);
  assert.equal(
    await realpath(join(root, relativePath)),
    await realpath(join(root, 'custom-context-state', 'nested', 'context.sqlite')),
  );
});

sqliteRuntimeTest('does not recursively create ancestors outside a nested SQLite state boundary', async (t) => {
  const root = await fixture(t);
  const adapter = new NodeSqliteFtsAdapter();
  const metadata = { repository_id: 'repo', worktree_digest: digest('missing-state-parent') };

  await assert.rejects(
    adapter.rebuild(root, 'missing/context-state/index.sqlite', [], metadata, {
      state_dir: 'missing/context-state',
    }),
    (error: unknown) => error instanceof PrimeContextError && error.code === 'IO_ERROR',
  );
  await assert.rejects(access(join(root, 'missing')));
});

sqliteRuntimeTest('atomically rebuilds a secure bounded FTS5 index and searches deterministically', async (t) => {
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
  assert.match(rebuilt.toolchain.sqlite_version, /^\d+\.\d+/);
  assert.equal(rebuilt.toolchain.fts5_available, true);
  if (rebuilt.toolchain.fts5_source_id !== undefined) {
    assert.match(rebuilt.toolchain.fts5_source_id, /^fts5:/);
  }
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
  assert.deepEqual(result.toolchain, rebuilt.toolchain);
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

sqliteRuntimeTest('fails closed on stale snapshot, tampering, and invalid query syntax', async (t) => {
  const root = await fixture(t);
  const { DatabaseSync } = await import('node:sqlite');
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

sqliteRuntimeTest('rejects an FTS table whose exact DDL or tokenizer identity was replaced', async (t) => {
  const root = await fixture(t);
  const { DatabaseSync } = await import('node:sqlite');
  const adapter = new NodeSqliteFtsAdapter();
  const relativePath = '.primecontext/tokenizer-tamper.sqlite';
  const worktreeDigest = digest('tokenizer-tamper');
  await adapter.rebuild(root, relativePath, [
    source('docs/a.md', 'running quickly'),
  ], { repository_id: 'repo', worktree_digest: worktreeDigest });

  const legitimate = await adapter.search(root, relativePath, 'running', {
    expected_worktree_digest: worktreeDigest,
  });
  assert.deepEqual(legitimate.hits.map((hit) => hit.path), ['docs/a.md']);

  const database = new DatabaseSync(join(root, relativePath));
  database.exec(`
    DROP TABLE entries_fts;
    CREATE VIRTUAL TABLE entries_fts USING fts5(
      source_id UNINDEXED, path UNINDEXED, title, content,
      tokenize='porter unicode61 remove_diacritics 0'
    );
    INSERT INTO entries_fts(rowid, source_id, path, title, content)
      SELECT rowid, source_id, path, title, content FROM sources;
  `);
  database.close();

  await assert.rejects(
    adapter.search(root, relativePath, 'run', { expected_worktree_digest: worktreeDigest }),
    (error: unknown) => {
      assert.equal(error instanceof PrimeContextError, true);
      assert.equal((error as PrimeContextError).code, 'CATALOG_ERROR');
      assert.match((error as Error).message, /schema|DDL|tokenizer/i);
      return true;
    },
  );
});

sqliteRuntimeTest('binds FTS validation and returned excerpts to one read snapshot', async (t) => {
  const root = await fixture(t);
  const { DatabaseSync } = await import('node:sqlite');
  const relativePath = '.primecontext/read-snapshot.sqlite';
  const absolutePath = join(root, relativePath);
  const worktreeDigest = digest('read-snapshot');
  const safeContent = 'alpha safe content';
  const injectedContent = 'alpha Authorization: Bearer SYNTHETIC0123456789ABCDEF';
  await new NodeSqliteFtsAdapter().rebuild(root, relativePath, [
    source('docs/safe.md', safeContent),
  ], { repository_id: 'repo', worktree_digest: worktreeDigest });

  let clockCalls = 0;
  let writeAttempted = false;
  const searchAdapter = new NodeSqliteFtsAdapter({
    monotonicNow: () => {
      clockCalls += 1;
      if (clockCalls === 14) {
        writeAttempted = true;
        const writer = new DatabaseSync(absolutePath);
        try {
          writer.prepare('UPDATE entries_fts SET content = ?').run(injectedContent);
        } catch (error) {
          assert.match(String(error), /busy|locked/i);
        } finally {
          writer.close();
        }
      }
      return clockCalls;
    },
  });

  const result = await searchAdapter.search(root, relativePath, 'alpha', {
    expected_worktree_digest: worktreeDigest,
  });

  assert.equal(writeAttempted, true, 'the concurrent write must be attempted after validation');
  assert.equal(result.hits.length, 1);
  assert.equal(result.hits.some((hit) => hit.excerpt.includes(injectedContent)), false);
  assert.match(result.hits[0]?.excerpt ?? '', /safe content/);
});

sqliteRuntimeTest('blocks sensitive content before persistence and preserves the prior valid index', async (t) => {
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

sqliteRuntimeTest('indexes distinct declaration locators from the same code path deterministically', async (t) => {
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

sqliteRuntimeTest('rejects sensitive index paths, traversal, duplicate paths, forged hashes, and concurrent writers', async (t) => {
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

  const staleLock = join(root, '.primecontext', 'stale.sqlite.lock');
  const staleRecord = lockRecord(2_147_483_647);
  await writeFile(staleLock, staleRecord);
  const staleAttempts = await Promise.allSettled(Array.from({ length: 8 }, async () => (
    new NodeSqliteFtsAdapter().rebuild(root, '.primecontext/stale.sqlite', [
      source('docs/a.md', 'one'),
    ], metadata)
  )));
  assert.equal(staleAttempts.every((result) => result.status === 'rejected'), true);
  for (const result of staleAttempts) {
    if (result.status === 'rejected') assert.match(String(result.reason), /active writer|dead process|manual removal/i);
  }
  assert.equal(await readFile(staleLock, 'utf8'), staleRecord);
  await assert.rejects(access(join(root, '.primecontext', 'stale.sqlite')));

  const foreignLock = join(root, '.primecontext', 'foreign.sqlite.lock');
  await writeFile(foreignLock, lockRecord(2_147_483_647, `${hostname()}-foreign`));
  await assert.rejects(adapter.rebuild(root, '.primecontext/foreign.sqlite', [
    source('docs/a.md', 'one'),
  ], metadata), /active writer|host|unverifiable/i);
  await rm(foreignLock);

  const firstWriter = adapter.rebuild(root, '.primecontext/concurrent.sqlite', [
    source('docs/a.md', 'one'),
  ], metadata);
  await assert.rejects(adapter.rebuild(root, '.primecontext/concurrent.sqlite', [
    source('docs/b.md', 'two'),
  ], metadata), /active writer/i);
  await firstWriter;
});

sqliteRuntimeTest('concurrent processes cannot reclaim a dead-owner SQLite lock', async (t) => {
  const root = await fixture(t);
  const staleLock = join(root, '.primecontext', 'process-race.sqlite.lock');
  const staleRecord = lockRecord(2_147_483_647);
  await writeFile(staleLock, staleRecord);
  const adapterUrl = new URL('./sqlite-fts.js', import.meta.url).href;
  const content = 'bounded process race content';
  const script = `
    import { NodeSqliteFtsAdapter } from ${JSON.stringify(adapterUrl)};
    const adapter = new NodeSqliteFtsAdapter();
    try {
      await adapter.rebuild(
        ${JSON.stringify(root)},
        '.primecontext/process-race.sqlite',
        [{
          path: 'docs/a.md',
          kind: 'document',
          authority: 'implementation_note',
          source_hash: ${JSON.stringify(digest(content))},
          content: ${JSON.stringify(content)},
        }],
        { repository_id: 'repo', worktree_digest: ${JSON.stringify(digest('process-race'))} },
      );
      process.stdout.write(JSON.stringify({ unexpected_success: true }));
      process.exitCode = 2;
    } catch (error) {
      process.stdout.write(JSON.stringify({ code: error?.code, message: error?.message }));
      process.exitCode = error?.code === 'STATE_ERROR' ? 0 : 3;
    }
  `;

  const results = await Promise.all(Array.from({ length: 8 }, async () => runNodeScript(script)));
  for (const result of results) {
    assert.equal(result.status, 0, `child stderr: ${result.stderr}; stdout: ${result.stdout}`);
    const error = JSON.parse(result.stdout) as { code?: string; message?: string };
    assert.equal(error.code, 'STATE_ERROR');
    assert.match(error.message ?? '', /dead process|manual removal/i);
  }
  assert.equal(await readFile(staleLock, 'utf8'), staleRecord);
  await assert.rejects(access(join(root, '.primecontext', 'process-race.sqlite')));
});

sqliteRuntimeTest('SQLite writer locks expose bounded owner metadata while active', async (t) => {
  const root = await fixture(t);
  const lockPath = join(root, '.primecontext', 'metadata.sqlite.lock');
  let observed: string | undefined;
  const adapter = new NodeSqliteFtsAdapter({
    monotonicNow: () => {
      try { observed = readFileSync(lockPath, 'utf8'); } catch { /* lock is not active yet */ }
      return performance.now();
    },
  });
  await adapter.rebuild(root, '.primecontext/metadata.sqlite', [
    source('docs/a.md', 'bounded content'),
  ], { repository_id: 'repo', worktree_digest: digest('lock-metadata') });

  assert.ok(observed);
  assert.equal(Buffer.byteLength(observed, 'utf8') <= 4_096, true);
  const record = JSON.parse(observed) as Record<string, unknown>;
  assert.deepEqual(Object.keys(record).sort(), ['created_at', 'hostname', 'operation', 'owner_token', 'pid', 'schema_version']);
  assert.equal(record.pid, process.pid);
  assert.equal(record.hostname, hostname());
  assert.equal(record.operation, 'sqlite-fts-rebuild');
  await assert.rejects(access(lockPath));
});

sqliteRuntimeTest('hardens pre-existing SQLite state directories and owned files on POSIX', {
  skip: platform() === 'win32' ? 'Windows ACLs are not represented by POSIX mode bits' : false,
}, async (t) => {
  const root = await fixture(t);
  const stateDirectory = join(root, '.primecontext');
  const databasePath = join(stateDirectory, 'permissions.sqlite');
  const lockPath = `${databasePath}.lock`;
  await chmod(stateDirectory, 0o755);
  let observedLockMode: number | undefined;
  const adapter = new NodeSqliteFtsAdapter({
    monotonicNow: () => {
      try { observedLockMode = statSync(lockPath).mode & 0o777; } catch { /* lock is not active yet */ }
      return performance.now();
    },
  });

  await adapter.rebuild(root, '.primecontext/permissions.sqlite', [
    source('docs/a.md', 'bounded content'),
  ], { repository_id: 'repo', worktree_digest: digest('permissions') });

  assert.equal((await stat(stateDirectory)).mode & 0o777, 0o700);
  assert.equal((await stat(databasePath)).mode & 0o777, 0o600);
  assert.equal(observedLockMode, 0o600);
});

sqliteRuntimeTest('uses monotonic cooperative deadlines in FTS rebuild and result processing loops', async (t) => {
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

sqliteRuntimeTest('SQLite loading does not mutate process.emitWarning', async (t) => {
  const root = await fixture(t);
  const descriptor = Object.getOwnPropertyDescriptor(process, 'emitWarning');
  assert.ok(descriptor);
  const original = process.emitWarning;
  Object.defineProperty(process, 'emitWarning', { ...descriptor, value: original, writable: false });
  try {
    const result = await new NodeSqliteFtsAdapter().rebuild(root, '.primecontext/no-global.sqlite', [
      source('docs/a.md', 'bounded alpha content'),
    ], { repository_id: 'repo', worktree_digest: digest('no-global') });
    assert.equal(result.indexed_source_count, 1);
    assert.equal(process.emitWarning, original);
  } finally {
    Object.defineProperty(process, 'emitWarning', descriptor);
  }
});

sqliteRuntimeTest('SQLite rebuild and search honor pre-aborted cooperative cancellation signals', async (t) => {
  const root = await fixture(t);
  const adapter = new NodeSqliteFtsAdapter();
  const metadata = { repository_id: 'repo', worktree_digest: digest('cancel') };
  const cancelledRebuild = new AbortController();
  cancelledRebuild.abort();
  await assert.rejects(adapter.rebuild(root, '.primecontext/cancelled.sqlite', [
    source('docs/a.md', 'bounded alpha content'),
  ], metadata, { signal: cancelledRebuild.signal }), /cancel/i);
  await assert.rejects(access(join(root, '.primecontext', 'cancelled.sqlite')));

  await adapter.rebuild(root, '.primecontext/search-cancel.sqlite', [
    source('docs/a.md', 'bounded alpha content'),
  ], metadata);
  const cancelledSearch = new AbortController();
  cancelledSearch.abort();
  await assert.rejects(adapter.search(root, '.primecontext/search-cancel.sqlite', 'alpha', {
    expected_worktree_digest: metadata.worktree_digest,
    signal: cancelledSearch.signal,
  }), /cancel/i);
});
