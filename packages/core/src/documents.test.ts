import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  assertValidDocumentCatalog,
  assertValidDocumentSearchQuery,
  createDocumentCatalog,
  PrimeContextError,
  searchDocumentCatalog,
  type DocumentAuthority,
  type DocumentHashPort,
  type DocumentSearchQuery,
  type DocumentSource,
  type DocumentSourceCollection,
} from './index.js';

const generatedAt = '2026-08-11T18:00:00.000Z';

const hasher: DocumentHashPort = {
  sha256(value: string | Uint8Array): string {
    const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value);
    return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  },
};

interface SourceOptions {
  path: string;
  content: string;
  title: string;
  authority: DocumentAuthority;
  ruleId?: string;
  modules?: string[];
  topics?: string[];
}

function source(options: SourceOptions): DocumentSource {
  return {
    path: options.path,
    format: 'markdown',
    title: options.title,
    authority: options.authority,
    authority_basis: options.ruleId
      ? { kind: 'convention', rule_id: options.ruleId }
      : { kind: 'default' },
    modules: options.modules ?? [],
    topics: options.topics ?? [],
    source_hash: hasher.sha256(options.content),
    size_bytes: Buffer.byteLength(options.content, 'utf8'),
    content: options.content,
  };
}

function collection(documents: DocumentSource[], overrides: Partial<DocumentSourceCollection['summary']> = {}): DocumentSourceCollection {
  return {
    documents,
    summary: {
      discovered_path_count: documents.length + 2,
      excluded_path_count: 2,
      candidate_document_count: documents.length,
      omitted_document_count: 0,
      ...overrides,
    },
  };
}

function catalogFrom(sourceCollection: DocumentSourceCollection, timestamp = generatedAt) {
  return createDocumentCatalog({
    generated_at: timestamp,
    worktree: { branch: 'main', head: 'abc123' },
    source_collection: sourceCollection,
  }, hasher);
}

function query(text: string, overrides: Partial<DocumentSearchQuery> = {}): DocumentSearchQuery {
  return {
    schema_version: '0.2',
    query: text,
    ...overrides,
  };
}

function assertCatalogError(run: () => unknown): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof PrimeContextError);
    assert.equal(error.code, 'CATALOG_ERROR');
    return true;
  });
}

const policySource = source({
  path: 'AGENTS.md',
  title: 'PrimeContext Agent Instructions',
  authority: 'policy',
  ruleId: 'root-agents-file',
  modules: ['workspace'],
  topics: ['governance'],
  content: '# PrimeContext Agent Instructions\n\nPreserve deterministic local retrieval.\n',
});

const specificationSource = source({
  path: 'docs/specification/document-retrieval.md',
  title: 'Document Retrieval',
  authority: 'specification',
  ruleId: 'docs-specification-directory',
  modules: ['core'],
  topics: ['retrieval', 'search'],
  content: [
    '# Document Retrieval',
    '',
    'Local retrieval reads the permitted Markdown corpus.',
    'Search remains deterministic and bounded.',
  ].join('\n'),
});

test('creates a metadata-only catalog with stable ordering, identity, digest, and totals', () => {
  const forward = catalogFrom(collection([specificationSource, policySource]));
  const reversed = catalogFrom(collection([policySource, specificationSource]));

  assert.deepEqual(forward, reversed, 'source enumeration order must not affect the catalog');
  assert.deepEqual(forward.documents.map((document) => document.path), [
    'AGENTS.md',
    'docs/specification/document-retrieval.md',
  ]);
  assert.equal(forward.summary.document_count, 2);
  assert.equal(
    forward.summary.total_source_bytes,
    policySource.size_bytes + specificationSource.size_bytes,
  );
  assert.equal(forward.catalog_digest, hasher.sha256(JSON.stringify(forward.documents)));
  assert.match(forward.documents[0]!.id, /^DOC-[0-9a-f]{64}$/);

  const serialized = JSON.stringify(forward);
  assert.equal(serialized.includes('Preserve deterministic local retrieval'), false);
  for (const forbiddenKey of ['"content"', '"body"', '"excerpt"', '"terms"', '"tokens"']) {
    assert.equal(serialized.includes(forbiddenKey), false, `${forbiddenKey} must not be persisted`);
  }
});

test('catalog digest excludes generation time and discovery counters but covers every document metadata change', () => {
  const baseCollection = collection([policySource, specificationSource]);
  const base = catalogFrom(baseCollection);
  const later = catalogFrom(collection([policySource, specificationSource], {
    discovered_path_count: 999,
    excluded_path_count: 997,
  }), '2027-01-01T00:00:00.000Z');

  assert.equal(base.catalog_digest, later.catalog_digest);

  const changedContent = source({
    ...specificationSource,
    content: `${specificationSource.content}\nChanged source bytes.`,
  });
  const changedCatalog = catalogFrom(collection([policySource, changedContent]));
  assert.notEqual(changedCatalog.catalog_digest, base.catalog_digest);
  assert.equal(
    changedCatalog.documents.find((document) => document.path === changedContent.path)?.id,
    base.documents.find((document) => document.path === specificationSource.path)?.id,
    'content changes must retain path-derived identity',
  );

  const reclassified = source({ ...specificationSource, authority: 'roadmap', ruleId: 'roadmap-file' });
  assert.notEqual(catalogFrom(collection([policySource, reclassified])).catalog_digest, base.catalog_digest);

  const reordered = structuredClone(base);
  reordered.documents = reordered.documents.map((document) => ({
    size_bytes: document.size_bytes,
    source_hash: document.source_hash,
    topics: document.topics,
    modules: document.modules,
    authority_basis: document.authority_basis,
    authority: document.authority,
    title: document.title,
    format: document.format,
    path: document.path,
    id: document.id,
  }));
  assert.doesNotThrow(
    () => searchDocumentCatalog(reordered, query('retrieval'), baseCollection, hasher),
    'digest verification must be independent of untrusted JSON object key order',
  );
});

test('catalog creation and public assertions return defensive JSON clones', () => {
  const mutableSource = source({
    path: 'docs/mutable.md',
    title: 'Mutable input',
    authority: 'implementation_note',
    modules: ['core'],
    topics: ['safety'],
    content: '# Mutable input\n\nOriginal content.\n',
  });
  const mutableCollection = collection([mutableSource]);
  const catalog = catalogFrom(mutableCollection);

  mutableSource.title = 'Changed title';
  mutableSource.modules[0] = 'changed';
  mutableSource.content = 'Changed content';
  mutableCollection.summary.discovered_path_count = 500;

  assert.equal(catalog.documents[0]!.title, 'Mutable input');
  assert.deepEqual(catalog.documents[0]!.modules, ['core']);
  assert.equal(catalog.summary.discovered_path_count, 3);

  const untrustedCatalog = structuredClone(catalog);
  const assertedCatalog = assertValidDocumentCatalog(untrustedCatalog);
  untrustedCatalog.documents[0]!.title = 'Mutated after assertion';
  assert.equal(assertedCatalog.documents[0]!.title, 'Mutable input');

  const maliciousCatalog = structuredClone(catalog);
  Object.defineProperty(maliciousCatalog.documents, 'toJSON', {
    enumerable: false,
    value: () => [{ body: 'must-not-bypass-validation' }],
  });
  assert.throws(
    () => assertValidDocumentCatalog(maliciousCatalog),
    (error: unknown) => error instanceof PrimeContextError && error.code === 'VALIDATION_ERROR',
  );

  const untrustedQuery: DocumentSearchQuery = {
    schema_version: '0.2',
    query: 'original',
    filters: { modules: ['core'] },
  };
  const assertedQuery = assertValidDocumentSearchQuery(untrustedQuery);
  untrustedQuery.filters!.modules![0] = 'changed';
  assert.deepEqual(assertedQuery.filters?.modules, ['core']);
});

test('rejects invalid catalog and query values at the Core public boundary', () => {
  const catalog = catalogFrom(collection([specificationSource]));
  assert.throws(
    () => assertValidDocumentCatalog({ ...catalog, catalog_digest: 'invalid' }),
    (error: unknown) => error instanceof PrimeContextError && error.code === 'VALIDATION_ERROR',
  );
  assert.throws(
    () => assertValidDocumentSearchQuery({ schema_version: '0.2', query: '!!!' }),
    (error: unknown) => error instanceof PrimeContextError && error.code === 'VALIDATION_ERROR',
  );

  for (const malformedCollection of [
    { documents: [null], summary: collection([]).summary },
    { documents: [{ path: 'docs/malformed.md', content: '# Malformed\n' }], summary: collection([]).summary },
    { documents: [], summary: null },
  ]) {
    assert.throws(
      () => createDocumentCatalog({
        generated_at: generatedAt,
        source_collection: malformedCollection as unknown as DocumentSourceCollection,
      }, hasher),
      (error: unknown) => error instanceof PrimeContextError && error.code === 'VALIDATION_ERROR',
      'malformed public input must fail as a classified PrimeContextError, never as a raw TypeError',
    );
  }

  for (const worktree of [null, false, 0, {}]) {
    assert.throws(
      () => createDocumentCatalog({
        generated_at: generatedAt,
        worktree: worktree as unknown as { branch?: string; head?: string },
        source_collection: collection([specificationSource]),
      }, hasher),
      (error: unknown) => error instanceof PrimeContextError && error.code === 'VALIDATION_ERROR',
    );
  }

  assertCatalogError(() => searchDocumentCatalog(
    catalog,
    query('retrieval'),
    collection([specificationSource]),
    {} as DocumentHashPort,
  ));
});

test('uses distinct normalized terms with AND semantics and applies every documented filter', () => {
  const sourceCollection = collection([policySource, specificationSource]);
  const catalog = catalogFrom(sourceCollection);

  const result = searchDocumentCatalog(
    catalog,
    query('LOCAL local retrieval', {
      filters: {
        authorities: ['specification'],
        modules: ['core'],
        topics: ['retrieval'],
      },
      limit: 5,
    }),
    sourceCollection,
    hasher,
  );

  assert.deepEqual(result.terms, ['local', 'retrieval']);
  assert.deepEqual(result.effective_filters, {
    authorities: ['specification'],
    modules: ['core'],
    topics: ['retrieval'],
  });
  assert.deepEqual(result.hits.map((hit) => hit.path), [specificationSource.path]);
  assert.equal(Number.isSafeInteger(result.hits[0]!.score), true);
  assert.ok(result.hits[0]!.matched_fields.includes('body'));
  assert.deepEqual(new Set(result.hits[0]!.matched_terms), new Set(['local', 'retrieval']));

  const missingAndTerm = searchDocumentCatalog(
    catalog,
    query('local absent-term'),
    sourceCollection,
    hasher,
  );
  assert.equal(missingAndTerm.hits.length, 0, 'a partial OR match must not be returned');

  for (const filters of [
    { authorities: ['roadmap'] as DocumentAuthority[] },
    { modules: ['missing'] },
    { topics: ['missing'] },
  ]) {
    const filtered = searchDocumentCatalog(catalog, query('local retrieval', { filters }), sourceCollection, hasher);
    assert.equal(filtered.hits.length, 0, JSON.stringify(filters));
  }
});

test('keeps NFKC-expanded valid queries inside the search-result contract', () => {
  const expansion = '㌀'.repeat(341);
  const unicodeSource = source({
    path: 'docs/unicode-expansion.md',
    title: 'Unicode expansion',
    authority: 'implementation_note',
    content: `# Unicode expansion\n\n${expansion}\n`,
  });
  const sourceCollection = collection([unicodeSource]);
  const catalog = catalogFrom(sourceCollection);
  const result = searchDocumentCatalog(catalog, query(expansion), sourceCollection, hasher);

  assert.equal(Buffer.byteLength(expansion, 'utf8') <= 1024, true);
  assert.ok((result.terms[0]?.length ?? 0) > 1024);
  assert.deepEqual(result.hits.map((hit) => hit.path), [unicodeSource.path]);
});

test('requires a fresh complete live corpus and independently verifies live content hashes', () => {
  const originalCollection = collection([policySource, specificationSource]);
  const catalog = catalogFrom(originalCollection);
  assert.doesNotThrow(() => searchDocumentCatalog(catalog, query('retrieval'), originalCollection, hasher));

  const changed = source({
    ...specificationSource,
    content: `${specificationSource.content}\nChanged after indexing.`,
  });
  assertCatalogError(() => searchDocumentCatalog(
    catalog,
    query('retrieval'),
    collection([policySource, changed]),
    hasher,
  ));

  const added = source({
    path: 'docs/added.md',
    title: 'Added later',
    authority: 'implementation_note',
    content: '# Added later\n\nRetrieval.\n',
  });
  assertCatalogError(() => searchDocumentCatalog(
    catalog,
    query('retrieval'),
    collection([policySource, specificationSource, added]),
    hasher,
  ));
  assertCatalogError(() => searchDocumentCatalog(
    catalog,
    query('retrieval'),
    collection([specificationSource]),
    hasher,
  ));

  const forged = structuredClone(specificationSource);
  forged.content = `${forged.content}\nTampered while retaining the old claimed hash.`;
  forged.size_bytes = Buffer.byteLength(forged.content, 'utf8');
  assertCatalogError(() => searchDocumentCatalog(
    catalog,
    query('retrieval'),
    collection([policySource, forged]),
    hasher,
  ));

  assertCatalogError(() => searchDocumentCatalog(
    catalog,
    query('retrieval'),
    collection([policySource, specificationSource], {
      candidate_document_count: 3,
      omitted_document_count: 1,
    }),
    hasher,
  ));
});

test('uses authority then ordinal path as tie-breakers without changing relevance scores', () => {
  const shared = (path: string, authority: DocumentAuthority, suffix: string): DocumentSource => source({
    path,
    title: suffix === 'upper' ? 'SHARED GUIDE' : 'Shared Guide',
    authority,
    ruleId: `${authority}-fixture`,
    content: `# Shared Guide\n\nShared ${suffix} content.\n`,
  });
  const policyZ = shared('docs/policy/z.md', 'policy', 'zeta');
  const specificationA = shared('docs/specification/a.md', 'specification', 'alpha');
  const policyA = shared('docs/policy/a.md', 'policy', 'upper');
  const sourceCollection = collection([policyZ, specificationA, policyA]);
  const catalog = catalogFrom(sourceCollection);
  const result = searchDocumentCatalog(catalog, query('shared'), sourceCollection, hasher);

  assert.deepEqual(result.hits.map((hit) => hit.path), [
    'docs/policy/a.md',
    'docs/policy/z.md',
    'docs/specification/a.md',
  ]);
  assert.equal(new Set(result.hits.map((hit) => hit.score)).size, 1, 'authority must not be hidden inside lexical relevance');
});

test('returns bounded excerpts with 1-based source lines and no unsafe full-body result', () => {
  const excerptSource = source({
    path: 'docs/excerpt.md',
    title: 'Excerpt fixture',
    authority: 'implementation_note',
    content: [
      '# Excerpt fixture',
      'line two',
      'line three',
      'line four',
      `needle ${'x'.repeat(500)}`,
      'line six',
      'line seven',
      'line eight',
    ].join('\n'),
  });
  const sourceCollection = collection([excerptSource]);
  const catalog = catalogFrom(sourceCollection);
  const result = searchDocumentCatalog(catalog, query('needle'), sourceCollection, hasher);
  const excerpt = result.hits[0]!.excerpt;

  assert.match(excerpt.text, /needle/);
  assert.ok(excerpt.text.length <= 400);
  assert.ok(excerpt.start_line >= 1);
  assert.ok(excerpt.start_line <= 5 && excerpt.end_line >= 5);
  assert.ok((excerpt.end_line - excerpt.start_line) < 6);
  assert.equal(excerpt.truncated, true);
  assert.equal(Object.hasOwn(result.hits[0]!, 'content'), false);
  assert.equal(Object.hasOwn(result.hits[0]!, 'body'), false);
});

test('surfaces normalized same-title/different-hash conflicts without resolving them', () => {
  const first = source({
    path: 'docs/first.md',
    title: 'Café Policy',
    authority: 'policy',
    content: '# Café Policy\n\nShared conflict marker first.\n',
  });
  const second = source({
    path: 'docs/second.md',
    title: 'CAFÉ POLICY',
    authority: 'specification',
    content: '# CAFÉ POLICY\n\nShared conflict marker second.\n',
  });
  const sourceCollection = collection([second, first]);
  const catalog = catalogFrom(sourceCollection);
  const result = searchDocumentCatalog(catalog, query('shared conflict'), sourceCollection, hasher);

  assert.equal(result.hits.length, 2);
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0]!.normalized_title, 'café policy');
  assert.deepEqual(
    result.conflicts[0]!.document_ids,
    result.hits.map((hit) => hit.document_id).sort(),
  );
  assert.notEqual(result.hits[0]!.source_hash, result.hits[1]!.source_hash);

  const limited = searchDocumentCatalog(catalog, query('shared conflict', { limit: 1 }), sourceCollection, hasher);
  assert.equal(limited.hits.length, 1);
  assert.deepEqual(limited.conflicts, result.conflicts, 'result limiting must not hide a catalog conflict');

  const expandingTitle = 'İ'.repeat(256);
  const longFirst = source({
    path: 'docs/long-first.md',
    title: expandingTitle,
    authority: 'implementation_note',
    content: '# First\n\nUnicode conflict marker.\n',
  });
  const longSecond = source({
    path: 'docs/long-second.md',
    title: expandingTitle,
    authority: 'implementation_note',
    content: '# Second\n\nUnicode conflict marker changed.\n',
  });
  const longCollection = collection([longFirst, longSecond]);
  const longCatalog = catalogFrom(longCollection);
  const longResult = searchDocumentCatalog(longCatalog, query('unicode conflict'), longCollection, hasher);
  assert.ok((longResult.conflicts[0]?.normalized_title.length ?? 0) > 256);
});

test('search output is deterministic and does not alias live sources or query filters', () => {
  const mutableDocument = source({
    path: 'docs/determinism.md',
    title: 'Determinism',
    authority: 'implementation_note',
    modules: ['core'],
    content: '# Determinism\n\nDeterministic search output.\n',
  });
  const sourceCollection = collection([mutableDocument]);
  const catalog = catalogFrom(sourceCollection);
  const mutableQuery = query('deterministic', { filters: { modules: ['core'] } });
  const first = searchDocumentCatalog(catalog, mutableQuery, sourceCollection, hasher);
  const second = searchDocumentCatalog(catalog, structuredClone(mutableQuery), structuredClone(sourceCollection), hasher);
  assert.deepEqual(first, second);

  mutableDocument.title = 'Changed after search';
  mutableDocument.content = 'Changed after search';
  mutableQuery.filters!.modules![0] = 'changed';
  assert.equal(first.hits[0]!.title, 'Determinism');
  assert.deepEqual(first.effective_filters.modules, ['core']);
});
