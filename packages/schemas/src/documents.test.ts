import assert from 'node:assert/strict';
import test from 'node:test';
import {
  documentAuthorities,
  documentCatalogSchema,
  documentMatchFields,
  documentSearchQuerySchema,
  documentSearchResultSchema,
  validateDocumentCatalog,
  validateDocumentSearchQuery,
  validateDocumentSearchResult,
} from './index.js';

const hash = (character: string): string => `sha256:${character.repeat(64)}`;

const validDocument = {
  id: `DOC-${'1'.repeat(64)}`,
  path: 'docs/specification/retrieval.md',
  format: 'markdown',
  title: 'Document Retrieval',
  authority: 'specification',
  authority_basis: { kind: 'convention', rule_id: 'docs-specification-directory' },
  modules: ['core'],
  topics: ['retrieval'],
  source_hash: hash('a'),
  size_bytes: 128,
};

const validCatalog = {
  schema_version: '0.2',
  generated_at: '2026-08-11T18:00:00.000Z',
  catalog_digest: hash('b'),
  worktree: { branch: 'main', head: 'abc123' },
  documents: [validDocument],
  summary: {
    discovered_path_count: 5,
    excluded_path_count: 2,
    candidate_document_count: 1,
    document_count: 1,
    omitted_document_count: 0,
    total_source_bytes: 128,
  },
};

const validQuery = {
  schema_version: '0.2',
  query: 'document retrieval',
  filters: {
    authorities: ['specification'],
    modules: ['core'],
    topics: ['retrieval'],
  },
  limit: 10,
};

const validResult = {
  schema_version: '0.2',
  catalog_digest: hash('b'),
  query: 'document retrieval',
  terms: ['document', 'retrieval'],
  effective_filters: {
    authorities: ['specification'],
    modules: ['core'],
    topics: ['retrieval'],
  },
  hits: [{
    document_id: validDocument.id,
    path: validDocument.path,
    title: validDocument.title,
    authority: validDocument.authority,
    source_hash: validDocument.source_hash,
    score: 42,
    matched_fields: ['title', 'body'],
    matched_terms: ['document', 'retrieval'],
    excerpt: {
      text: 'Document retrieval uses bounded live Markdown.',
      start_line: 1,
      end_line: 1,
      truncated: false,
    },
  }],
  conflicts: [],
  summary: {
    catalog_document_count: 1,
    filtered_document_count: 1,
    matched_document_count: 1,
    returned_hit_count: 1,
    truncated: false,
  },
};

test('exports the exact v0.2 document authority and match-field vocabularies', () => {
  assert.deepEqual(documentAuthorities, [
    'policy',
    'adr',
    'specification',
    'contract_schema',
    'roadmap',
    'implementation_note',
    'generated_summary',
  ]);
  assert.deepEqual(documentMatchFields, ['title', 'path', 'module', 'topic', 'body']);
});

test('publishes strict versioned schemas that cannot persist document content', () => {
  assert.equal(documentCatalogSchema.$id, 'https://primecontext.dev/schemas/v0.2/document-catalog.schema.json');
  assert.equal(documentSearchQuerySchema.$id, 'https://primecontext.dev/schemas/v0.2/document-search-query.schema.json');
  assert.equal(documentSearchResultSchema.$id, 'https://primecontext.dev/schemas/v0.2/document-search-result.schema.json');

  const documentProperties = documentCatalogSchema.properties.documents.items.properties as Record<string, { pattern?: string }>;
  for (const forbidden of ['body', 'content', 'excerpt', 'summary', 'terms', 'tokens', 'lexical_index']) {
    assert.equal(Object.hasOwn(documentProperties, forbidden), false, `${forbidden} must not be serializable in the catalog contract`);
  }
  assert.equal(documentCatalogSchema.additionalProperties, false);
  assert.equal(documentSearchQuerySchema.additionalProperties, false);
  assert.equal(documentSearchResultSchema.additionalProperties, false);

  const pathPattern = new RegExp(documentProperties.path?.pattern ?? '');
  for (const unsafePath of [
    '/absolute.md', '../escape.md', 'docs/../escape.md', 'CON.md', 'docs/NUL.md',
    'docs/CON .md', 'docs/COM¹.md', 'docs/bad?.md', 'docs/bad|name.md', 'docs/trailing./file.md',
  ]) {
    assert.equal(pathPattern.test(unsafePath), false, `physical contract must reject ${unsafePath}`);
  }
});

test('accepts the canonical catalog, query, and search-result fixtures', () => {
  assert.deepEqual(validateDocumentCatalog(validCatalog), { valid: true, errors: [] });
  assert.deepEqual(validateDocumentSearchQuery(validQuery), { valid: true, errors: [] });
  assert.deepEqual(validateDocumentSearchResult(validResult), { valid: true, errors: [] });
});

test('rejects unknown catalog properties and inconsistent aggregate values', () => {
  const extraTopLevel = { ...validCatalog, body: 'must never be persisted' };
  assert.equal(validateDocumentCatalog(extraTopLevel).valid, false);

  const extraDocument = structuredClone(validCatalog);
  Object.assign(extraDocument.documents[0]!, { content: 'must never be persisted' });
  assert.equal(validateDocumentCatalog(extraDocument).valid, false);

  const arrayToJson = structuredClone(validCatalog);
  Object.defineProperty(arrayToJson.documents, 'toJSON', {
    enumerable: false,
    value: () => [{ body: 'must-not-bypass-validation' }],
  });
  assert.equal(validateDocumentCatalog(arrayToJson).valid, false);

  class ArrayWithInheritedToJson extends Array<typeof validDocument> {
    toJSON(): unknown {
      return [{ body: 'must-not-bypass-validation' }];
    }
  }
  const inheritedToJson = {
    ...structuredClone(validCatalog),
    documents: new ArrayWithInheritedToJson(validDocument),
  };
  assert.equal(validateDocumentCatalog(inheritedToJson).valid, false);

  for (const summary of [
    { ...validCatalog.summary, document_count: 0 },
    { ...validCatalog.summary, candidate_document_count: 0 },
    { ...validCatalog.summary, omitted_document_count: 1 },
    { ...validCatalog.summary, total_source_bytes: 127 },
  ]) {
    const result = validateDocumentCatalog({ ...validCatalog, summary });
    assert.equal(result.valid, false, JSON.stringify(summary));
    assert.match(result.errors.join('\n'), /summary|count|bytes/i);
  }
});

test('rejects malformed timestamps, hashes, ids, and unsafe repository paths', () => {
  for (const patch of [
    { generated_at: 'yesterday' },
    { generated_at: '2026-02-30T00:00:00Z' },
    { catalog_digest: `sha256:${'A'.repeat(64)}` },
    { catalog_digest: 'md5:abc' },
  ]) {
    assert.equal(validateDocumentCatalog({ ...validCatalog, ...patch }).valid, false);
  }

  assert.equal(validateDocumentCatalog({
    ...validCatalog,
    generated_at: '2016-12-31T23:59:60Z',
  }).valid, true, 'RFC 3339 leap seconds must remain representable');

  for (const patch of [
    { id: '../escape' },
    { source_hash: `sha256:${'g'.repeat(64)}` },
    { path: '../escape.md' },
    { path: '/absolute.md' },
    { path: 'C:/drive.md' },
    { path: 'docs/file.md:stream' },
    { path: 'docs/CON.md' },
    { path: 'docs/CON .md' },
    { path: 'docs/COM¹.md' },
    { path: 'docs/bad?.md' },
    { path: 'docs/bad|name.md' },
    { path: 'docs/trailing. /file.md' },
    { path: 'docs/bad\u0000name.md' },
    { path: 'docs\\backslash.md' },
  ]) {
    const catalog = structuredClone(validCatalog);
    Object.assign(catalog.documents[0]!, patch);
    assert.equal(validateDocumentCatalog(catalog).valid, false, JSON.stringify(patch));
  }


  const whitespaceTitle = structuredClone(validCatalog);
  whitespaceTitle.documents[0]!.title = '   ';
  assert.equal(validateDocumentCatalog(whitespaceTitle).valid, false);
});

test('counts JSON Schema characters as Unicode code points', () => {
  const unicodeCatalog = structuredClone(validCatalog);
  unicodeCatalog.documents[0]!.title = '😀'.repeat(200);
  assert.deepEqual(validateDocumentCatalog(unicodeCatalog), { valid: true, errors: [] });

  const unicodeResult = structuredClone(validResult);
  unicodeResult.hits[0]!.excerpt.text = '😀'.repeat(300);
  assert.deepEqual(validateDocumentSearchResult(unicodeResult), { valid: true, errors: [] });

  const unicodePathCatalog = structuredClone(validCatalog);
  unicodePathCatalog.documents[0]!.path = `docs/${'😀'.repeat(500)}.md`;
  assert.deepEqual(validateDocumentCatalog(unicodePathCatalog), { valid: true, errors: [] });
});

test('requires unique, ordinally sorted documents and metadata arrays', () => {
  const second = {
    ...validDocument,
    id: `DOC-${'2'.repeat(64)}`,
    path: 'README.md',
    title: 'Read me',
    source_hash: hash('c'),
    size_bytes: 64,
  };
  const unsorted = {
    ...validCatalog,
    documents: [validDocument, second],
    summary: {
      ...validCatalog.summary,
      candidate_document_count: 2,
      document_count: 2,
      total_source_bytes: 192,
    },
  };
  assert.equal(validateDocumentCatalog(unsorted).valid, false);

  for (const duplicate of [
    { ...second, id: validDocument.id, path: 'zz.md' },
    { ...second, id: `DOC-${'2'.repeat(64)}`, path: validDocument.path },
  ]) {
    const catalog = {
      ...validCatalog,
      documents: [validDocument, duplicate].sort((left, right) => left.path < right.path ? -1 : 1),
      summary: {
        ...validCatalog.summary,
        candidate_document_count: 2,
        document_count: 2,
        total_source_bytes: 192,
      },
    };
    assert.equal(validateDocumentCatalog(catalog).valid, false);
  }

  for (const modules of [['core', 'core'], ['zeta', 'alpha']]) {
    const catalog = structuredClone(validCatalog);
    catalog.documents[0]!.modules = modules;
    assert.equal(validateDocumentCatalog(catalog).valid, false, JSON.stringify(modules));
  }
});

test('enforces catalog hard ceilings without materializing unsafe outputs', () => {
  const oversizedTitle = structuredClone(validCatalog);
  oversizedTitle.documents[0]!.title = 'x'.repeat(257);
  assert.equal(validateDocumentCatalog(oversizedTitle).valid, false);

  const tooManyModules = structuredClone(validCatalog);
  tooManyModules.documents[0]!.modules = Array.from({ length: 33 }, (_, index) => `m${index.toString().padStart(2, '0')}`);
  assert.equal(validateDocumentCatalog(tooManyModules).valid, false);

  const tooLargeSource = structuredClone(validCatalog);
  tooLargeSource.documents[0]!.size_bytes = (512 * 1024) + 1;
  tooLargeSource.summary.total_source_bytes = tooLargeSource.documents[0]!.size_bytes;
  assert.equal(validateDocumentCatalog(tooLargeSource).valid, false);

  const tooManyDocuments = {
    ...validCatalog,
    documents: Array.from({ length: 4_097 }, (_, index) => ({
      ...validDocument,
      id: `DOC-${index.toString(16).padStart(64, '0')}`,
      path: `docs/${index.toString().padStart(4, '0')}.md`,
      source_hash: `sha256:${index.toString(16).padStart(64, '0')}`,
      size_bytes: 1,
    })),
    summary: {
      ...validCatalog.summary,
      candidate_document_count: 4_097,
      document_count: 4_097,
      total_source_bytes: 4_097,
    },
  };
  assert.equal(validateDocumentCatalog(tooManyDocuments).valid, false);
});

test('rejects empty, tokenless, oversized, over-tokenized, duplicate, and unknown query input', () => {
  for (const query of ['', '   ', '!!!', 'x'.repeat(1_025)]) {
    const result = validateDocumentSearchQuery({ ...validQuery, query });
    assert.equal(result.valid, false, JSON.stringify(query));
  }

  const thirtyThreeTerms = Array.from({ length: 33 }, (_, index) => `term${index}`).join(' ');
  assert.equal(validateDocumentSearchQuery({ ...validQuery, query: thirtyThreeTerms }).valid, false);
  assert.equal(validateDocumentSearchQuery({ ...validQuery, limit: 0 }).valid, false);
  assert.equal(validateDocumentSearchQuery({ ...validQuery, limit: 51 }).valid, false);
  assert.equal(validateDocumentSearchQuery({ ...validQuery, limit: 1.5 }).valid, false);
  assert.equal(validateDocumentSearchQuery({ ...validQuery, unknown: true }).valid, false);

  for (const filters of [
    { ...validQuery.filters, authorities: ['specification', 'specification'] },
    { ...validQuery.filters, authorities: ['not-an-authority'] },
    { ...validQuery.filters, modules: ['core', 'core'] },
    { ...validQuery.filters, topics: Array.from({ length: 33 }, (_, index) => `t${index}`) },
  ]) {
    assert.equal(validateDocumentSearchQuery({ ...validQuery, filters }).valid, false, JSON.stringify(filters));
  }
});

test('rejects malformed result provenance, hits, excerpts, conflicts, and counts', () => {
  const invalidDigest = { ...validResult, catalog_digest: 'sha256:not-a-digest' };
  assert.equal(validateDocumentSearchResult(invalidDigest).valid, false);

  const invalidHit = structuredClone(validResult);
  invalidHit.hits[0]!.score = -1;
  assert.equal(validateDocumentSearchResult(invalidHit).valid, false);

  const invalidMatchedTerm = structuredClone(validResult);
  invalidMatchedTerm.hits[0]!.matched_terms = ['absent'];
  assert.equal(validateDocumentSearchResult(invalidMatchedTerm).valid, false);

  const oversizedExcerpt = structuredClone(validResult);
  oversizedExcerpt.hits[0]!.excerpt.text = 'x'.repeat(401);
  assert.equal(validateDocumentSearchResult(oversizedExcerpt).valid, false);

  const excessiveLines = structuredClone(validResult);
  excessiveLines.hits[0]!.excerpt.start_line = 2;
  excessiveLines.hits[0]!.excerpt.end_line = 8;
  assert.equal(validateDocumentSearchResult(excessiveLines).valid, false);

  const badConflict = {
    ...structuredClone(validResult),
    conflicts: [{ normalized_title: 'document retrieval', document_ids: [validDocument.id] }],
  };
  assert.equal(validateDocumentSearchResult(badConflict).valid, false);

  const impossibleConflict = {
    ...structuredClone(validResult),
    hits: [],
    conflicts: [{
      normalized_title: 'impossible conflict',
      document_ids: [`DOC-${'2'.repeat(64)}`, `DOC-${'3'.repeat(64)}`],
    }],
    summary: {
      catalog_document_count: 0,
      filtered_document_count: 0,
      matched_document_count: 0,
      returned_hit_count: 0,
      truncated: false,
    },
  };
  assert.equal(validateDocumentSearchResult(impossibleConflict).valid, false);

  for (const summary of [
    { ...validResult.summary, catalog_document_count: 0 },
    { ...validResult.summary, returned_hit_count: 0 },
    { ...validResult.summary, matched_document_count: 0 },
  ]) {
    assert.equal(validateDocumentSearchResult({ ...validResult, summary }).valid, false, JSON.stringify(summary));
  }
});
