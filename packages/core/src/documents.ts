import {
  documentAuthorities,
  documentMatchFields,
  validateDocumentCatalog,
  validateDocumentSearchQuery,
  validateDocumentSearchResult,
} from '@primecontext/schemas';
import { PrimeContextError, type PrimeContextErrorCode } from './errors.js';
import { cloneValidatedJson } from './json.js';
import type {
  DocumentAuthority,
  DocumentCatalog,
  DocumentCatalogEntry,
  DocumentCatalogInput,
  DocumentConflict,
  DocumentExcerpt,
  DocumentHashPort,
  DocumentMatchField,
  DocumentSearchHit,
  DocumentSearchQuery,
  DocumentSearchResult,
  DocumentSource,
  DocumentSourceCollection,
} from './types.js';

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const MAX_DOCUMENTS = 4096;
const MAX_DOCUMENT_BYTES = 512 * 1024;
const MAX_TOTAL_SOURCE_BYTES = 64 * 1024 * 1024;
const MAX_EXCERPT_CHARACTERS = 400;
const MAX_EXCERPT_LINES = 6;

const authorityRank = new Map<DocumentAuthority, number>(
  documentAuthorities.map((authority, index) => [authority, index]),
);

interface PreparedCatalog {
  catalog: DocumentCatalog;
  sources: DocumentSource[];
}

function catalogFailure(code: PrimeContextErrorCode, message: string, details: readonly string[] = []): never {
  throw new PrimeContextError(code, message, details);
}

function ensureHash(value: unknown, label: string, code: PrimeContextErrorCode): string {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) catalogFailure(code, `Invalid SHA-256 digest for ${label}`);
  return value;
}

function ordinalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function encodedBytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function cloneSource(source: unknown, hasher: DocumentHashPort, code: PrimeContextErrorCode): DocumentSource {
  if (typeof source !== 'object' || source === null || Array.isArray(source)) {
    catalogFailure(code, 'Document source must be an object');
  }
  const candidate = source as Record<string, unknown>;
  if (typeof candidate.path !== 'string') catalogFailure(code, 'Document source path must be a string');
  const label = candidate.path;
  if (typeof candidate.content !== 'string') catalogFailure(code, `Document source content must be a string: ${label}`);
  if (candidate.format !== 'markdown') catalogFailure(code, `Document source format must be markdown: ${label}`);
  if (typeof candidate.title !== 'string') catalogFailure(code, `Document source title must be a string: ${label}`);
  if (typeof candidate.authority !== 'string' || !(documentAuthorities as readonly string[]).includes(candidate.authority)) {
    catalogFailure(code, `Document source authority is invalid: ${label}`);
  }
  const basis = candidate.authority_basis;
  if (typeof basis !== 'object' || basis === null || Array.isArray(basis)) {
    catalogFailure(code, `Document source authority basis is invalid: ${label}`);
  }
  const basisRecord = basis as Record<string, unknown>;
  if (basisRecord.kind !== 'default' && basisRecord.kind !== 'convention') {
    catalogFailure(code, `Document source authority basis is invalid: ${label}`);
  }
  if (basisRecord.kind === 'convention' && typeof basisRecord.rule_id !== 'string') {
    catalogFailure(code, `Document source authority rule is invalid: ${label}`);
  }
  if (!Array.isArray(candidate.modules) || candidate.modules.length > 32 || !candidate.modules.every((item) => typeof item === 'string')) {
    catalogFailure(code, `Document source modules are invalid: ${label}`);
  }
  if (!Array.isArray(candidate.topics) || candidate.topics.length > 32 || !candidate.topics.every((item) => typeof item === 'string')) {
    catalogFailure(code, `Document source topics are invalid: ${label}`);
  }
  const actualBytes = encodedBytes(candidate.content);
  if (!Number.isSafeInteger(candidate.size_bytes) || (candidate.size_bytes as number) < 0 || (candidate.size_bytes as number) > MAX_DOCUMENT_BYTES) {
    catalogFailure(code, `Document source size is outside the allowed range: ${label}`);
  }
  if (candidate.size_bytes !== actualBytes) catalogFailure(code, `Document source size does not match content: ${label}`);
  const claimedHash = ensureHash(candidate.source_hash, label, code);
  const actualHash = ensureHash(hasher.sha256(candidate.content), label, code);
  if (claimedHash !== actualHash) catalogFailure(code, `Document source hash does not match content: ${label}`);
  return {
    path: candidate.path,
    format: 'markdown',
    title: candidate.title,
    authority: candidate.authority as DocumentAuthority,
    authority_basis: basisRecord.kind === 'convention'
      ? { kind: 'convention', rule_id: basisRecord.rule_id as string }
      : { kind: 'default' },
    modules: [...candidate.modules].sort(ordinalCompare),
    topics: [...candidate.topics].sort(ordinalCompare),
    source_hash: claimedHash,
    size_bytes: candidate.size_bytes as number,
    content: candidate.content,
  };
}

function cloneCollectionSummary(value: unknown, code: PrimeContextErrorCode): DocumentSourceCollection['summary'] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    catalogFailure(code, 'Document source collection summary must be an object');
  }
  const summary = value as Record<string, unknown>;
  const fields = [
    'discovered_path_count',
    'excluded_path_count',
    'candidate_document_count',
    'omitted_document_count',
  ] as const;
  for (const field of fields) {
    if (!Number.isSafeInteger(summary[field]) || (summary[field] as number) < 0) {
      catalogFailure(code, `Document source collection ${field} must be a non-negative safe integer`);
    }
  }
  return {
    discovered_path_count: summary.discovered_path_count as number,
    excluded_path_count: summary.excluded_path_count as number,
    candidate_document_count: summary.candidate_document_count as number,
    omitted_document_count: summary.omitted_document_count as number,
  };
}

function canonicalCatalogDigestInput(documents: readonly DocumentCatalogEntry[]): string {
  return JSON.stringify(documents.map((document) => ({
    id: document.id,
    path: document.path,
    format: document.format,
    title: document.title,
    authority: document.authority,
    authority_basis: document.authority_basis.kind === 'convention'
      ? { kind: 'convention', rule_id: document.authority_basis.rule_id }
      : { kind: 'default' },
    modules: [...document.modules],
    topics: [...document.topics],
    source_hash: document.source_hash,
    size_bytes: document.size_bytes,
  })));
}

function cloneWorktree(value: unknown, code: PrimeContextErrorCode): DocumentCatalog['worktree'] | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    catalogFailure(code, 'Document Catalog worktree must be an object');
  }
  const worktree = value as Record<string, unknown>;
  for (const key of Object.keys(worktree)) {
    if (key !== 'branch' && key !== 'head') catalogFailure(code, `Document Catalog worktree field is not allowed: ${key}`);
  }
  if (worktree.branch === undefined && worktree.head === undefined) {
    catalogFailure(code, 'Document Catalog worktree must contain branch or head');
  }
  if (worktree.branch !== undefined && typeof worktree.branch !== 'string') {
    catalogFailure(code, 'Document Catalog worktree branch must be a string');
  }
  if (worktree.head !== undefined && typeof worktree.head !== 'string') {
    catalogFailure(code, 'Document Catalog worktree head must be a string');
  }
  return {
    ...(worktree.branch !== undefined ? { branch: worktree.branch } : {}),
    ...(worktree.head !== undefined ? { head: worktree.head } : {}),
  };
}

function prepareCatalog(
  input: DocumentCatalogInput,
  hasher: DocumentHashPort,
  errorCode: PrimeContextErrorCode,
): PreparedCatalog {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) catalogFailure(errorCode, 'Document Catalog input must be an object');
  if (typeof hasher !== 'object' || hasher === null || typeof hasher.sha256 !== 'function') {
    catalogFailure(errorCode, 'Document hashing port is unavailable');
  }
  const worktree = cloneWorktree((input as unknown as Record<string, unknown>).worktree, errorCode);
  const collection = input.source_collection;
  if (typeof collection !== 'object' || collection === null || !Array.isArray(collection.documents)) {
    catalogFailure(errorCode, 'Document source collection is invalid');
  }
  const collectionSummary = cloneCollectionSummary(collection.summary, errorCode);
  if (collection.documents.length > MAX_DOCUMENTS) catalogFailure(errorCode, 'Document source count exceeds 4096');
  const sources = collection.documents.map((source) => cloneSource(source, hasher, errorCode));
  sources.sort((left, right) => ordinalCompare(left.path, right.path));
  const totalSourceBytes = sources.reduce((total, source) => total + source.size_bytes, 0);
  if (!Number.isSafeInteger(totalSourceBytes) || totalSourceBytes > MAX_TOTAL_SOURCE_BYTES) {
    catalogFailure(errorCode, 'Document source bytes exceed 64 MiB');
  }

  const documents: DocumentCatalogEntry[] = sources.map((source) => {
    const pathDigest = ensureHash(hasher.sha256(source.path), source.path, errorCode);
    return {
      id: `DOC-${pathDigest.slice('sha256:'.length)}`,
      path: source.path,
      format: 'markdown',
      title: source.title,
      authority: source.authority,
      authority_basis: source.authority_basis.kind === 'convention'
        ? { kind: 'convention', rule_id: source.authority_basis.rule_id }
        : { kind: 'default' },
      modules: [...source.modules],
      topics: [...source.topics],
      source_hash: source.source_hash,
      size_bytes: source.size_bytes,
    };
  });
  const catalogDigest = ensureHash(hasher.sha256(canonicalCatalogDigestInput(documents)), 'catalog', errorCode);
  const catalog: DocumentCatalog = {
    schema_version: '0.2',
    generated_at: input.generated_at,
    catalog_digest: catalogDigest,
    documents,
    summary: {
      discovered_path_count: collectionSummary.discovered_path_count,
      excluded_path_count: collectionSummary.excluded_path_count,
      candidate_document_count: collectionSummary.candidate_document_count,
      document_count: documents.length,
      omitted_document_count: collectionSummary.omitted_document_count,
      total_source_bytes: totalSourceBytes,
    },
    ...(worktree ? { worktree } : {}),
  };
  const validation = validateDocumentCatalog(catalog);
  if (!validation.valid) catalogFailure(errorCode, 'Invalid Document Catalog', validation.errors);
  return { catalog: cloneValidatedJson(catalog), sources };
}

export function createDocumentCatalog(input: DocumentCatalogInput, hasher: DocumentHashPort): DocumentCatalog {
  return prepareCatalog(input, hasher, 'VALIDATION_ERROR').catalog;
}

export function assertValidDocumentCatalog(value: unknown): DocumentCatalog {
  const validation = validateDocumentCatalog(value);
  if (!validation.valid) throw new PrimeContextError('VALIDATION_ERROR', 'Invalid Document Catalog', validation.errors);
  return cloneValidatedJson(value as DocumentCatalog);
}

export function assertValidDocumentSearchQuery(value: unknown): DocumentSearchQuery {
  const validation = validateDocumentSearchQuery(value);
  if (!validation.valid) throw new PrimeContextError('VALIDATION_ERROR', 'Invalid Document Search Query', validation.errors);
  return cloneValidatedJson(value as DocumentSearchQuery);
}

function tokenize(value: string): string[] {
  return value.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function distinctTerms(value: string): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const term of tokenize(value)) {
    if (seen.has(term)) continue;
    seen.add(term);
    terms.push(term);
  }
  return terms;
}

function termCounts(value: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const term of tokenize(value)) counts.set(term, (counts.get(term) ?? 0) + 1);
  return counts;
}

function combinedCounts(values: readonly string[]): Map<string, number> {
  return termCounts(values.join(' '));
}

function countFor(counts: ReadonlyMap<string, number>, term: string): number {
  return counts.get(term) ?? 0;
}

function matchesFilter(document: DocumentCatalogEntry, query: DocumentSearchQuery): boolean {
  const filters = query.filters;
  if (!filters) return true;
  if (filters.authorities?.length && !filters.authorities.includes(document.authority)) return false;
  if (filters.modules?.length && !filters.modules.some((module) => document.modules.includes(module))) return false;
  if (filters.topics?.length && !filters.topics.some((topic) => document.topics.includes(topic))) return false;
  return true;
}

function createExcerpt(content: string, terms: readonly string[]): DocumentExcerpt {
  const lines = content.split(/\r\n|\n|\r/u);
  let matchedLine = lines.findIndex((line) => {
    const lineTerms = new Set(tokenize(line));
    return terms.some((term) => lineTerms.has(term));
  });
  if (matchedLine < 0) matchedLine = 0;
  const startIndex = Math.max(0, matchedLine - 2);
  const endIndex = Math.min(lines.length - 1, startIndex + MAX_EXCERPT_LINES - 1);
  const safeLines = lines.slice(startIndex, endIndex + 1).map((line) => (
    line.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, ' ')
  ));
  const unboundedText = safeLines.join('\n');
  const characters = Array.from(unboundedText);
  const textWasTruncated = characters.length > MAX_EXCERPT_CHARACTERS;
  const text = textWasTruncated ? characters.slice(0, MAX_EXCERPT_CHARACTERS).join('') : unboundedText;
  const representedLineCount = Math.max(1, text.split('\n').length);
  const representedEndIndex = Math.min(endIndex, startIndex + representedLineCount - 1);
  return {
    text,
    start_line: startIndex + 1,
    end_line: representedEndIndex + 1,
    truncated: textWasTruncated || startIndex > 0 || endIndex < lines.length - 1,
  };
}

function scoreDocument(
  document: DocumentCatalogEntry,
  source: DocumentSource,
  terms: readonly string[],
  queryText: string,
): DocumentSearchHit | undefined {
  const titleCounts = termCounts(document.title);
  const pathCounts = termCounts(document.path);
  const moduleCounts = combinedCounts(document.modules);
  const topicCounts = combinedCounts(document.topics);
  const bodyCounts = termCounts(source.content);
  const matchedFields = new Set<DocumentMatchField>();
  let score = 0;
  for (const term of terms) {
    const title = countFor(titleCounts, term);
    const path = countFor(pathCounts, term);
    const module = countFor(moduleCounts, term);
    const topic = countFor(topicCounts, term);
    const body = countFor(bodyCounts, term);
    if (title + path + module + topic + body === 0) return undefined;
    if (title > 0) {
      matchedFields.add('title');
      score += 16 * Math.min(title, 3);
    }
    if (path > 0) {
      matchedFields.add('path');
      score += 8 * Math.min(path, 3);
    }
    if (module > 0) {
      matchedFields.add('module');
      score += 6 * Math.min(module, 3);
    }
    if (topic > 0) {
      matchedFields.add('topic');
      score += 6 * Math.min(topic, 3);
    }
    if (body > 0) {
      matchedFields.add('body');
      score += Math.min(body, 8);
    }
  }
  const normalizedTitle = tokenize(document.title).join(' ');
  const normalizedQuery = tokenize(queryText).join(' ');
  if (normalizedTitle === normalizedQuery) score += 24;
  return {
    document_id: document.id,
    path: document.path,
    title: document.title,
    authority: document.authority,
    source_hash: document.source_hash,
    score,
    matched_fields: documentMatchFields.filter((field) => matchedFields.has(field)),
    matched_terms: [...terms],
    excerpt: createExcerpt(source.content, terms),
  };
}

function compareHits(left: DocumentSearchHit, right: DocumentSearchHit): number {
  if (left.score !== right.score) return right.score - left.score;
  const authorityDifference = (authorityRank.get(left.authority) ?? Number.MAX_SAFE_INTEGER)
    - (authorityRank.get(right.authority) ?? Number.MAX_SAFE_INTEGER);
  if (authorityDifference !== 0) return authorityDifference;
  const pathDifference = ordinalCompare(left.path, right.path);
  return pathDifference !== 0 ? pathDifference : ordinalCompare(left.document_id, right.document_id);
}

function normalizedTitle(value: string): string {
  return value.normalize('NFKC').toLowerCase().trim().replace(/\s+/gu, ' ');
}

function findConflicts(documents: readonly DocumentCatalogEntry[]): DocumentConflict[] {
  const groups = new Map<string, DocumentCatalogEntry[]>();
  for (const document of documents) {
    const title = normalizedTitle(document.title);
    const group = groups.get(title) ?? [];
    group.push(document);
    groups.set(title, group);
  }
  const conflicts: DocumentConflict[] = [];
  for (const [title, group] of groups) {
    if (group.length < 2 || new Set(group.map((document) => document.source_hash)).size < 2) continue;
    conflicts.push({
      normalized_title: title,
      document_ids: group.map((document) => document.id).sort(ordinalCompare),
    });
  }
  conflicts.sort((left, right) => ordinalCompare(left.normalized_title, right.normalized_title));
  return conflicts;
}

export function searchDocumentCatalog(
  catalogValue: unknown,
  queryValue: unknown,
  liveCollection: DocumentSourceCollection,
  hasher: DocumentHashPort,
): DocumentSearchResult {
  if (typeof hasher !== 'object' || hasher === null || typeof hasher.sha256 !== 'function') {
    catalogFailure('CATALOG_ERROR', 'Document hashing port is unavailable');
  }
  const catalog = assertValidDocumentCatalog(catalogValue);
  const query = assertValidDocumentSearchQuery(queryValue);
  const storedDigest = ensureHash(hasher.sha256(canonicalCatalogDigestInput(catalog.documents)), 'stored catalog', 'CATALOG_ERROR');
  if (storedDigest !== catalog.catalog_digest) catalogFailure('CATALOG_ERROR', 'Stored Document Catalog digest does not match its metadata');

  const live = prepareCatalog({
    generated_at: catalog.generated_at,
    ...(catalog.worktree ? { worktree: catalog.worktree } : {}),
    source_collection: liveCollection,
  }, hasher, 'CATALOG_ERROR');
  if (
    live.catalog.catalog_digest !== catalog.catalog_digest
    || live.catalog.summary.candidate_document_count !== catalog.summary.candidate_document_count
    || live.catalog.summary.omitted_document_count !== catalog.summary.omitted_document_count
  ) {
    catalogFailure('CATALOG_ERROR', 'Document Catalog is stale; re-index before searching');
  }

  const sourcesByPath = new Map(live.sources.map((source) => [source.path, source]));
  const terms = distinctTerms(query.query);
  const filteredDocuments = catalog.documents.filter((document) => matchesFilter(document, query));
  const matches: DocumentSearchHit[] = [];
  for (const document of filteredDocuments) {
    const source = sourcesByPath.get(document.path);
    if (!source || source.source_hash !== document.source_hash) {
      catalogFailure('CATALOG_ERROR', 'Document Catalog is stale; source provenance does not match');
    }
    const hit = scoreDocument(document, source, terms, query.query);
    if (hit) matches.push(hit);
  }
  matches.sort(compareHits);
  const limit = query.limit ?? 10;
  const hits = matches.slice(0, limit);
  const result: DocumentSearchResult = {
    schema_version: '0.2',
    catalog_digest: catalog.catalog_digest,
    query: query.query,
    terms,
    effective_filters: {
      authorities: [...(query.filters?.authorities ?? [])],
      modules: [...(query.filters?.modules ?? [])],
      topics: [...(query.filters?.topics ?? [])],
    },
    hits,
    conflicts: findConflicts(catalog.documents),
    summary: {
      catalog_document_count: catalog.documents.length,
      filtered_document_count: filteredDocuments.length,
      matched_document_count: matches.length,
      returned_hit_count: hits.length,
      truncated: matches.length > hits.length,
    },
  };
  const validation = validateDocumentSearchResult(result);
  if (!validation.valid) throw new PrimeContextError('VALIDATION_ERROR', 'Invalid Document Search Result', validation.errors);
  return cloneValidatedJson(result);
}
