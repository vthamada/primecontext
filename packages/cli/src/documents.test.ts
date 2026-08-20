import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';
import {
  initCommand,
  inspectCommand,
  mapCommand,
  taskCommand,
} from './index.js';
import { MAX_DOCUMENT_CATALOG_VALUES } from './documents.js';
import { parseBoundedJson } from './safe-io.js';

type DocumentAuthority =
  | 'policy'
  | 'adr'
  | 'specification'
  | 'contract_schema'
  | 'roadmap'
  | 'implementation_note'
  | 'generated_summary';

interface DocsIndexResult {
  catalog_path: string;
  document_count: number;
  catalog_digest: string;
}

interface DocsSearchOptions {
  limit?: number;
  authority?: DocumentAuthority;
  module?: string;
  topic?: string;
}

interface DocsSearchHit {
  path: string;
  authority: DocumentAuthority;
  source_hash: string;
  excerpt: {
    start_line: number;
    end_line: number;
    text: string;
  };
}

interface DocsSearchResult {
  schema_version: '0.2';
  hits: DocsSearchHit[];
}

interface PlannedDocumentCommands {
  docsIndexCommand(root: string): Promise<DocsIndexResult>;
  docsSearchCommand(root: string, query: string, options?: DocsSearchOptions): Promise<DocsSearchResult>;
}

interface CatalogDocument {
  path: string;
  source_hash: string;
}

interface DocumentCatalog {
  schema_version: '0.2';
  documents: CatalogDocument[];
}

async function plannedDocumentCommands(): Promise<PlannedDocumentCommands> {
  const exports = await import('./index.js') as Record<string, unknown>;
  assert.equal(
    typeof exports.docsIndexCommand,
    'function',
    'docsIndexCommand must be exported from the public CLI library seam',
  );
  assert.equal(
    typeof exports.docsSearchCommand,
    'function',
    'docsSearchCommand must be exported from the public CLI library seam',
  );
  return exports as unknown as PlannedDocumentCommands;
}

async function repositoryFixture(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'primecontext-documents-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'docs', 'specification'), { recursive: true });
  await mkdir(join(root, 'docs', 'adr'), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'document-fixture' }));
  await writeFile(join(root, 'README.md'), '# Fixture\n\nGeneral project orientation.\n');
  await writeFile(
    join(root, 'docs', 'specification', 'proposal-versioning.md'),
    [
      '# Proposal Versioning',
      '',
      'Immutable proposal versions preserve history.',
      'BODY-ONLY-CONTEXT-SENTINEL is present only in the Markdown body.',
      '',
    ].join('\n'),
  );
  await writeFile(
    join(root, 'docs', 'adr', '0001-immutable-proposals.md'),
    '# ADR: Immutable proposals\n\nAccepted decision for immutable proposal records.\n',
  );
  await writeFile(join(root, 'source.txt'), 'BODY-ONLY-NON-MARKDOWN-SENTINEL');
  return root;
}

function compiledCli(root: string): (...args: string[]) => SpawnSyncReturns<string> {
  const bin = fileURLToPath(new URL('./bin.js', import.meta.url));
  return (...args: string[]) => spawnSync(process.execPath, [bin, ...args], {
    cwd: root,
    encoding: 'utf8',
  });
}

async function catalogPath(root: string): Promise<string> {
  const config = JSON.parse(await readFile(join(root, 'primecontext.config.json'), 'utf8')) as {
    state_dir: string;
  };
  return join(root, config.state_dir, 'documents', 'catalog.json');
}

async function readCatalog(root: string): Promise<DocumentCatalog> {
  return JSON.parse(await readFile(await catalogPath(root), 'utf8')) as DocumentCatalog;
}

function collectObjectKeys(value: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectObjectKeys(item, found);
    return found;
  }
  if (typeof value !== 'object' || value === null) return found;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    found.add(key);
    collectObjectKeys(nested, found);
  }
  return found;
}

test('init-index-search provides a bounded public document retrieval flow', async (t) => {
  const root = await repositoryFixture(t);
  await initCommand(root);
  const { docsIndexCommand, docsSearchCommand } = await plannedDocumentCommands();

  const indexed = await docsIndexCommand(root);
  assert.equal(isAbsolute(indexed.catalog_path), false, 'catalog_path must be repository-relative');
  assert.equal(indexed.catalog_path.replaceAll('\\', '/'), '.primecontext/documents/catalog.json');
  assert.ok(indexed.document_count >= 3);
  assert.match(indexed.catalog_digest, /^sha256:[a-f0-9]{64}$/);

  const reindexed = await docsIndexCommand(root);
  assert.equal(reindexed.catalog_path, indexed.catalog_path);
  assert.equal(reindexed.catalog_digest, indexed.catalog_digest, 'unchanged sources must retain the catalog digest');

  const rawCatalog = await readFile(join(root, indexed.catalog_path), 'utf8');
  assert.doesNotMatch(rawCatalog, /BODY-ONLY-CONTEXT-SENTINEL/);
  assert.doesNotMatch(rawCatalog, /BODY-ONLY-NON-MARKDOWN-SENTINEL/);
  const catalog = JSON.parse(rawCatalog) as DocumentCatalog;
  assert.equal(catalog.schema_version, '0.2');
  for (const forbiddenKey of ['body', 'content', 'snippet', 'excerpt', 'tokens']) {
    assert.equal(collectObjectKeys(catalog).has(forbiddenKey), false, `catalog must not persist ${forbiddenKey}`);
  }

  const search = await docsSearchCommand(root, 'BODY ONLY CONTEXT SENTINEL', { limit: 1 });
  assert.equal(search.schema_version, '0.2');
  assert.equal(search.hits.length, 1);
  assert.equal(search.hits[0]?.path, 'docs/specification/proposal-versioning.md');
  assert.equal(search.hits[0]?.authority, 'specification');
  assert.match(search.hits[0]?.source_hash ?? '', /^sha256:[a-f0-9]{64}$/);
  assert.match(search.hits[0]?.excerpt.text ?? '', /BODY-ONLY-CONTEXT-SENTINEL/);
  assert.ok((search.hits[0]?.excerpt.text.length ?? 0) <= 400);
  assert.ok((search.hits[0]?.excerpt.start_line ?? 0) >= 1);
  assert.ok((search.hits[0]?.excerpt.end_line ?? 0) >= (search.hits[0]?.excerpt.start_line ?? 0));
});

test('compiled CLI help exposes the document commands and accepts valid bounded filters', async (t) => {
  const root = await repositoryFixture(t);
  const run = compiledCli(root);
  const help = run('--help');
  assert.equal(help.status, 0);
  assert.match(help.stdout, /primecontext docs index/);
  assert.match(help.stdout, /primecontext docs search <query>/);

  assert.equal(run('init').status, 0);
  assert.equal(run('docs', 'index').status, 0);
  const search = run(
    'docs',
    'search',
    'immutable proposal',
    '--limit',
    '1',
    '--authority',
    'specification',
    '--module',
    'specification',
    '--topic',
    'versioning',
  );
  assert.equal(search.status, 0, search.stderr);
  const parsed = JSON.parse(search.stdout) as DocsSearchResult;
  assert.deepEqual(parsed.hits.map((hit) => hit.path), ['docs/specification/proposal-versioning.md']);
});

test('compiled CLI rejects malformed document command arguments strictly', async (t) => {
  const root = await repositoryFixture(t);
  const run = compiledCli(root);
  const cases: Array<{ args: string[]; message: RegExp }> = [
    { args: ['docs'], message: /docs.*(?:index|search)/i },
    { args: ['docs', 'index', 'extra'], message: /docs index.*(?:does not accept|no arguments)/i },
    { args: ['docs', 'search'], message: /docs search.*query/i },
    { args: ['docs', 'search', 'query', 'extra'], message: /docs search.*(?:flag|argument)/i },
    { args: ['docs', 'search', 'query', '--unknown', 'value'], message: /Unknown flag: --unknown/ },
    { args: ['docs', 'search', 'query', '--limit', '1', '--limit', '2'], message: /Duplicate flag: --limit/ },
    { args: ['docs', 'search', 'query', '--limit'], message: /--limit.*(?:requires|value)/i },
    { args: ['docs', 'search', 'query', '--authority', 'unknown'], message: /authority.*invalid/i },
  ];

  for (const entry of cases) {
    const result = run(...entry.args);
    assert.equal(result.status, 1, entry.args.join(' '));
    assert.match(result.stderr, /VALIDATION_ERROR/, entry.args.join(' '));
    assert.match(result.stderr, entry.message, entry.args.join(' '));
  }

  for (const invalidLimit of ['0', '51', '01', '+1', '1.5']) {
    const result = run('docs', 'search', 'query', '--limit', invalidLimit);
    assert.equal(result.status, 1, `--limit ${invalidLimit}`);
    assert.match(result.stderr, /VALIDATION_ERROR/, `--limit ${invalidLimit}`);
    assert.match(result.stderr, /limit.*(?:integer|1.*50)/i, `--limit ${invalidLimit}`);
  }
});

test('search rejects a missing or corrupt catalog', async (t) => {
  const root = await repositoryFixture(t);
  const init = await initCommand(root);
  const { docsSearchCommand } = await plannedDocumentCommands();

  await assert.rejects(
    () => docsSearchCommand(root, '!!!'),
    /VALIDATION_ERROR.*Document Search Query/i,
    'query validation must happen before catalog or repository I/O',
  );

  await assert.rejects(() => docsSearchCommand(root, 'proposal'), /IO_ERROR|CATALOG_ERROR|VALIDATION_ERROR/);

  const documentsDir = join(init.state_dir, 'documents');
  await mkdir(documentsDir, { recursive: true });
  await writeFile(join(documentsDir, 'catalog.json'), '{not-json');
  await assert.rejects(() => docsSearchCommand(root, 'proposal'), /CATALOG_ERROR|VALIDATION_ERROR/);
});

test('document state commands reject a state directory that is no longer ignored', async (t) => {
  const root = await repositoryFixture(t);
  await initCommand(root);
  const { docsIndexCommand, docsSearchCommand } = await plannedDocumentCommands();
  await writeFile(join(root, '.gitignore'), '# PrimeContext state exclusion removed\n');

  await assert.rejects(
    () => docsIndexCommand(root),
    /state_dir must be ignored/i,
  );
  await assert.rejects(
    () => docsSearchCommand(root, 'proposal'),
    /state_dir must be ignored/i,
  );
});

test('catalog parsing uses a bounded budget that covers the physical contract maximum', () => {
  const overDefaultBudget = JSON.stringify(Array.from({ length: 100_005 }, () => 0));
  assert.throws(
    () => parseBoundedJson(overDefaultBudget, 'CATALOG_ERROR', 'default-budget'),
    /100000 value limit/,
  );
  assert.ok(Array.isArray(parseBoundedJson(
    overDefaultBudget,
    'CATALOG_ERROR',
    'document-catalog',
    { maxValues: MAX_DOCUMENT_CATALOG_VALUES },
  )));
});

test('catalog value rejection does not enqueue an attacker-sized flat array', () => {
  const safeIoUrl = new URL('./safe-io.js', import.meta.url).href;
  const child = spawnSync(process.execPath, [
    '--max-old-space-size=32',
    '--input-type=module',
    '-e',
    [
      `import { parseBoundedJson } from ${JSON.stringify(safeIoUrl)};`,
      "const content = `[${'0,'.repeat(800_000)}0]`;",
      "try { parseBoundedJson(content, 'CATALOG_ERROR', 'flat-catalog', { maxValues: 500_000 }); }",
      "catch (error) { if (error instanceof Error && /500000 value limit/.test(error.message)) process.exit(0); throw error; }",
      'process.exit(2);',
    ].join('\n'),
  ], { encoding: 'utf8', timeout: 15_000 });

  assert.equal(child.status, 0, child.stderr || child.stdout || `signal=${child.signal}`);
});

test('search rejects a tampered or stale catalog before returning results', async (t) => {
  const root = await repositoryFixture(t);
  await initCommand(root);
  const { docsIndexCommand, docsSearchCommand } = await plannedDocumentCommands();
  await docsIndexCommand(root);
  const path = await catalogPath(root);
  const original = await readFile(path, 'utf8');
  const tampered = JSON.parse(original) as DocumentCatalog;
  assert.ok(tampered.documents.length > 0);
  (tampered.documents[0] as CatalogDocument).path = '../../outside.md';
  await writeFile(path, JSON.stringify(tampered));
  await assert.rejects(() => docsSearchCommand(root, 'proposal'), /SECURITY_ERROR|VALIDATION_ERROR/);

  await writeFile(path, original);
  await writeFile(
    join(root, 'docs', 'specification', 'proposal-versioning.md'),
    '# Proposal Versioning\n\nThe source changed after indexing.\n',
  );
  await assert.rejects(() => docsSearchCommand(root, 'proposal'), /CATALOG_ERROR.*stale|stale.*CATALOG_ERROR/i);
});

test('content-sensitive Markdown is excluded from the catalog and search results', async (t) => {
  const root = await repositoryFixture(t);
  const blockedDocuments = [
    ['runbook.md', '-----BEGIN PRIVATE KEY-----\nCONTENT-SECRET-SENTINEL\n-----END PRIVATE KEY-----'],
    ['encrypted-key.md', '-----BEGIN ENCRYPTED PRIVATE KEY-----\nCONTENT-SECRET-SENTINEL'],
    ['pgp-key.md', '-----BEGIN PGP PRIVATE KEY BLOCK-----\nCONTENT-SECRET-SENTINEL'],
    ['basic-auth.md', 'Authorization: Basic dXNlcjpwYXNzd29yZA==\nCONTENT-SECRET-SENTINEL'],
    ['short-basic-auth.md', 'Authorization: Basic dTpw\nCONTENT-SECRET-SENTINEL'],
    ['inline-basic-auth.md', '`Authorization: Basic dXNlcjpwYXNzd29yZA==`\nCONTENT-SECRET-SENTINEL'],
  ] as const;
  for (const [fileName, sensitiveContent] of blockedDocuments) {
    await writeFile(
      join(root, 'docs', fileName),
      `# Operations Runbook\n\n${sensitiveContent}\n`,
    );
  }
  await initCommand(root);
  const { docsIndexCommand, docsSearchCommand } = await plannedDocumentCommands();
  await docsIndexCommand(root);

  const rawCatalog = await readFile(await catalogPath(root), 'utf8');
  assert.doesNotMatch(rawCatalog, /CONTENT-SECRET-SENTINEL|BEGIN (?:ENCRYPTED |PGP )?PRIVATE KEY|dXNlcjpwYXNzd29yZA==|dTpw/);
  const catalog = JSON.parse(rawCatalog) as DocumentCatalog;
  for (const [fileName] of blockedDocuments) {
    assert.equal(catalog.documents.some((document) => document.path === `docs/${fileName}`), false);
  }

  const search = await docsSearchCommand(root, 'CONTENT SECRET SENTINEL');
  assert.equal(search.hits.length, 0);
  assert.doesNotMatch(
    JSON.stringify(search),
    /CONTENT-SECRET-SENTINEL|BEGIN (?:ENCRYPTED |PGP )?PRIVATE KEY|dXNlcjpwYXNzd29yZA==|dTpw/,
  );
});

test('a global indexing failure preserves the previous valid catalog byte for byte', async (t) => {
  const root = await repositoryFixture(t);
  await initCommand(root);
  const { docsIndexCommand } = await plannedDocumentCommands();
  await docsIndexCommand(root);
  const path = await catalogPath(root);
  const before = await readFile(path, 'utf8');

  const configPath = join(root, 'primecontext.config.json');
  const config = JSON.parse(await readFile(configPath, 'utf8')) as { exclude: string[] };
  config.exclude = Array.from({ length: 1_025 }, (_, index) => `excluded-${index}`);
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

  await assert.rejects(() => docsIndexCommand(root), /SECURITY_ERROR/);
  assert.equal(await readFile(path, 'utf8'), before);
});

test('document retrieval keeps the v0.1 configuration and command flow compatible', async (t) => {
  const root = await repositoryFixture(t);
  const init = await initCommand(root);
  const { docsIndexCommand, docsSearchCommand } = await plannedDocumentCommands();
  await docsIndexCommand(root);
  await docsSearchCommand(root, 'immutable proposal');

  const config = JSON.parse(await readFile(init.config_path, 'utf8')) as { schema_version: string };
  assert.equal(config.schema_version, '0.1');
  const map = await mapCommand(root);
  assert.ok(map.module_count >= 1);

  const taskFile = join(root, 'task.json');
  await writeFile(taskFile, JSON.stringify({
    task_id: 'DOCS-COMPAT-001',
    goal: 'Verify document retrieval compatibility',
    task_type: 'small_code_fix',
    boundaries: { allowed_paths: ['docs'], forbidden_paths: [] },
    acceptance: ['Existing v0.1 commands still work'],
  }));
  await taskCommand(root, 'DOCS-COMPAT-001', taskFile);
  const inspected = await inspectCommand(root, 'DOCS-COMPAT-001');
  assert.equal(inspected.task_id, 'DOCS-COMPAT-001');
  assert.equal(inspected.goal, 'Verify document retrieval compatibility');
});
