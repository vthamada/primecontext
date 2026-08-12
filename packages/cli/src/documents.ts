import { resolve } from 'node:path';
import {
  NodeDocumentSourceAdapter,
  NodeGitAdapter,
  NodeSha256Hasher,
  type DocumentSourceCollectionResult as AdapterDocumentCollection,
} from '@primecontext/adapters';
import {
  assertValidDocumentCatalog,
  assertValidDocumentSearchQuery,
  createDocumentCatalog,
  PrimeContextError,
  searchDocumentCatalog,
  type DocumentAuthority,
  type DocumentHashPort,
  type DocumentSource,
  type DocumentSourceCollection,
} from '@primecontext/core';
import { loadConfig } from './config.js';
import {
  ensureSafeDirectory,
  parseBoundedJson,
  readInternalText,
  repositoryRelativePath,
  writeInternalTextAtomic,
} from './safe-io.js';

export const MAX_DOCUMENT_CATALOG_BYTES = 8 * 1024 * 1024;
export const MAX_DOCUMENT_CATALOG_VALUES = 500_000;
const DOCUMENT_DISCOVERY_LIMITS = Object.freeze({
  maxDocuments: 4_096,
  maxDocumentBytes: 512 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
});

const DOCUMENT_CATALOG_DIRECTORY = 'documents';
const DOCUMENT_CATALOG_FILE = 'catalog.json';

export interface DocsIndexResult {
  catalog_path: string;
  document_count: number;
  catalog_digest: string;
}

export interface DocsSearchOptions {
  limit?: number;
  authority?: DocumentAuthority;
  module?: string;
  topic?: string;
}

export type DocsSearchResult = ReturnType<typeof searchDocumentCatalog>;

function ordinalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function stableStrings(values: readonly string[]): string[] {
  return [...new Set(values)].sort(ordinalCompare);
}

function inferredAuthorityBasis(
  path: string,
  authority: DocumentAuthority,
): DocumentSource['authority_basis'] {
  if (authority === 'implementation_note') return { kind: 'default' };
  const normalized = path.replaceAll('\\', '/').toLowerCase();
  const ruleId = authority === 'policy'
    ? normalized === 'agents.md'
      ? 'root-agents-file'
      : normalized === 'security.md'
        ? 'root-security-file'
        : 'canonical-policy-document'
    : authority === 'adr'
      ? 'docs-adr-directory'
      : authority === 'specification'
        ? 'docs-specification-directory'
        : authority === 'contract_schema'
          ? 'docs-contract-schema-directory'
          : authority === 'roadmap'
            ? 'roadmap-file'
            : 'generated-summary';
  return { kind: 'convention', rule_id: ruleId };
}

function toCoreCollection(
  collected: AdapterDocumentCollection,
): DocumentSourceCollection {
  const documents = collected.sources.map((source): DocumentSource => ({
    path: source.relative_path,
    format: 'markdown',
    title: source.metadata.title,
    authority: source.metadata.authority,
    authority_basis: source.authority_basis
      ? structuredClone(source.authority_basis)
      : inferredAuthorityBasis(source.relative_path, source.metadata.authority),
    modules: stableStrings(source.metadata.modules),
    topics: stableStrings(source.metadata.topics),
    source_hash: source.source_hash,
    size_bytes: source.size_bytes,
    content: source.content,
  }));
  return {
    documents,
    summary: {
      discovered_path_count: collected.discovered_path_count,
      excluded_path_count: collected.excluded_path_count,
      candidate_document_count: collected.candidate_document_count,
      omitted_document_count: collected.omitted_document_count,
    },
  };
}

function catalogRelativePath(root: string, configuredStateDirectory: string): string {
  const stateDirectory = repositoryRelativePath(resolve(root), configuredStateDirectory, 'state_dir');
  return `${stateDirectory}/${DOCUMENT_CATALOG_DIRECTORY}/${DOCUMENT_CATALOG_FILE}`;
}

function documentHasher(): DocumentHashPort {
  const hasher = new NodeSha256Hasher();
  return {
    sha256(value: string | Uint8Array): string {
      return hasher.hash(value);
    },
  };
}

async function collectDocuments(root: string, excludes: readonly string[]): Promise<DocumentSourceCollection> {
  const adapter = new NodeDocumentSourceAdapter([...excludes], DOCUMENT_DISCOVERY_LIMITS);
  const collected = await adapter.collect(root);
  return toCoreCollection(collected);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertSearchOptions(value: DocsSearchOptions): void {
  if (!isObject(value)) throw new PrimeContextError('VALIDATION_ERROR', 'Document search options must be an object');
  const allowed = new Set(['limit', 'authority', 'module', 'topic']);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new PrimeContextError('VALIDATION_ERROR', `Document search option is not allowed: ${key}`);
  }
}

export async function docsIndexCommand(root: string): Promise<DocsIndexResult> {
  const resolvedRoot = resolve(root);
  const config = await loadConfig(resolvedRoot);
  const sourceCollection = await collectDocuments(resolvedRoot, config.exclude);
  const git = await new NodeGitAdapter().inspect(resolvedRoot);
  const catalog = createDocumentCatalog({
    generated_at: new Date().toISOString(),
    ...(git?.branch || git?.head
      ? {
          worktree: {
            ...(git.branch ? { branch: git.branch } : {}),
            ...(git.head ? { head: git.head } : {}),
          },
        }
      : {}),
    source_collection: sourceCollection,
  }, documentHasher());

  const serialized = `${JSON.stringify(catalog, null, 2)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > MAX_DOCUMENT_CATALOG_BYTES) {
    throw new PrimeContextError(
      'CATALOG_ERROR',
      `Generated Document Catalog exceeds the ${MAX_DOCUMENT_CATALOG_BYTES} byte limit`,
    );
  }

  const relativePath = catalogRelativePath(resolvedRoot, config.state_dir);
  const directory = relativePath.slice(0, relativePath.lastIndexOf('/'));
  await ensureSafeDirectory(resolvedRoot, directory);
  await writeInternalTextAtomic(resolvedRoot, relativePath, serialized);
  return {
    catalog_path: relativePath,
    document_count: catalog.summary.document_count,
    catalog_digest: catalog.catalog_digest,
  };
}

export async function docsSearchCommand(
  root: string,
  query: string,
  options: DocsSearchOptions = {},
): Promise<DocsSearchResult> {
  assertSearchOptions(options);
  const filters = {
    ...(options.authority !== undefined ? { authorities: [options.authority] } : {}),
    ...(options.module !== undefined ? { modules: [options.module] } : {}),
    ...(options.topic !== undefined ? { topics: [options.topic] } : {}),
  };
  const validatedQuery = assertValidDocumentSearchQuery({
    schema_version: '0.2',
    query,
    ...(Object.keys(filters).length > 0 ? { filters } : {}),
    ...(options.limit !== undefined ? { limit: options.limit } : {}),
  });
  const resolvedRoot = resolve(root);
  const config = await loadConfig(resolvedRoot);
  const relativePath = catalogRelativePath(resolvedRoot, config.state_dir);
  const serialized = await readInternalText(
    resolvedRoot,
    relativePath,
    MAX_DOCUMENT_CATALOG_BYTES,
  );
  const parsed = parseBoundedJson(serialized as string, 'CATALOG_ERROR', relativePath, {
    maxValues: MAX_DOCUMENT_CATALOG_VALUES,
  });
  const catalog = assertValidDocumentCatalog(parsed);
  const sourceCollection = await collectDocuments(resolvedRoot, config.exclude);
  return searchDocumentCatalog(
    catalog,
    validatedQuery,
    sourceCollection,
    documentHasher(),
  );
}
