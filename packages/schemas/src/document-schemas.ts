const draft = 'https://json-schema.org/draft/2020-12/schema';
const maxNormalizedDocumentText = 8192;

export const documentAuthorities = [
  'policy',
  'adr',
  'specification',
  'contract_schema',
  'roadmap',
  'implementation_note',
  'generated_summary',
] as const;

export const documentMatchFields = ['title', 'path', 'module', 'topic', 'body'] as const;

const nonEmptyString = { type: 'string', minLength: 1 } as const;
const boundedMetadataString = { ...nonEmptyString, maxLength: 128 } as const;
const hashString = { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' } as const;
const documentIdString = { type: 'string', pattern: '^DOC-[0-9a-f]{64}$' } as const;
const portableMarkdownPath = {
  type: 'string',
  minLength: 1,
  maxLength: 1024,
  pattern: '^(?!/)(?!.*\\\\)(?!.*:)(?!.*[<>"|?*])(?!.*//)(?!\\.{1,2}(?:/|$))(?!.*\\/\\.{1,2}(?:/|$))(?!.*(?:^|/)(?:[Cc][Oo][Nn]|[Pp][Rr][Nn]|[Aa][Uu][Xx]|[Nn][Uu][Ll]|[Cc][Oo][Mm][1-9¹²³]|[Ll][Pp][Tt][1-9¹²³])[ .]*(?:\\.|/|$))(?!.*[. ](?:/|$))[^\\u0000-\\u001f\\u007f-\\u009f]+\\.[Mm][Dd]$',
} as const;
const nonNegativeInteger = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER } as const;
const positiveInteger = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER } as const;
const metadataArray = {
  type: 'array',
  maxItems: 32,
  uniqueItems: true,
  items: boundedMetadataString,
} as const;
const authorityArray = {
  type: 'array',
  maxItems: 32,
  uniqueItems: true,
  items: { enum: documentAuthorities },
} as const;

const authorityBasis = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'rule_id'],
      properties: {
        kind: { const: 'convention' },
        rule_id: boundedMetadataString,
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind'],
      properties: { kind: { const: 'default' } },
    },
  ],
} as const;

const catalogDocument = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id', 'path', 'format', 'title', 'authority', 'authority_basis',
    'modules', 'topics', 'source_hash', 'size_bytes',
  ],
  properties: {
    id: documentIdString,
    path: portableMarkdownPath,
    format: { const: 'markdown' },
    title: { ...nonEmptyString, maxLength: 256, pattern: '\\S' },
    authority: { enum: documentAuthorities },
    authority_basis: authorityBasis,
    modules: metadataArray,
    topics: metadataArray,
    source_hash: hashString,
    size_bytes: { type: 'integer', minimum: 0, maximum: 512 * 1024 },
  },
} as const;

const worktree = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    branch: { ...nonEmptyString, maxLength: 512 },
    head: { ...nonEmptyString, maxLength: 128 },
  },
} as const;

const filters = {
  type: 'object',
  additionalProperties: false,
  properties: {
    authorities: authorityArray,
    modules: metadataArray,
    topics: metadataArray,
  },
} as const;

const excerpt = {
  type: 'object',
  additionalProperties: false,
  required: ['text', 'start_line', 'end_line', 'truncated'],
  properties: {
    text: { type: 'string', maxLength: 400 },
    start_line: positiveInteger,
    end_line: positiveInteger,
    truncated: { type: 'boolean' },
  },
  $comment: 'end_line must be >= start_line and cover at most six source lines; enforced by the runtime validator.',
} as const;

const searchHit = {
  type: 'object',
  additionalProperties: false,
  required: [
    'document_id', 'path', 'title', 'authority', 'source_hash', 'score',
    'matched_fields', 'matched_terms', 'excerpt',
  ],
  properties: {
    document_id: documentIdString,
    path: portableMarkdownPath,
    title: { ...nonEmptyString, maxLength: 256, pattern: '\\S' },
    authority: { enum: documentAuthorities },
    source_hash: hashString,
    score: nonNegativeInteger,
    matched_fields: {
      type: 'array', minItems: 1, maxItems: documentMatchFields.length,
      uniqueItems: true, items: { enum: documentMatchFields },
    },
    matched_terms: {
      type: 'array', minItems: 1, maxItems: 32,
      uniqueItems: true, items: { ...nonEmptyString, maxLength: maxNormalizedDocumentText },
    },
    excerpt,
  },
} as const;

export const documentCatalogSchema = {
  $schema: draft,
  $id: 'https://primecontext.dev/schemas/v0.2/document-catalog.schema.json',
  type: 'object',
  additionalProperties: false,
  required: ['schema_version', 'generated_at', 'catalog_digest', 'documents', 'summary'],
  properties: {
    schema_version: { const: '0.2' },
    generated_at: { type: 'string', format: 'date-time', pattern: 'Z$', maxLength: 64 },
    catalog_digest: hashString,
    worktree,
    documents: {
      type: 'array',
      maxItems: 4096,
      items: catalogDocument,
      $comment: 'Document ids and paths must be unique and documents must be ordinally sorted by path; enforced by the runtime validator.',
    },
    summary: {
      type: 'object',
      additionalProperties: false,
      required: [
        'discovered_path_count', 'excluded_path_count', 'candidate_document_count',
        'document_count', 'omitted_document_count', 'total_source_bytes',
      ],
      properties: {
        discovered_path_count: { type: 'integer', minimum: 0, maximum: 100_000 },
        excluded_path_count: { type: 'integer', minimum: 0, maximum: 100_000 },
        candidate_document_count: { type: 'integer', minimum: 0, maximum: 4096 },
        document_count: { type: 'integer', minimum: 0, maximum: 4096 },
        omitted_document_count: { type: 'integer', minimum: 0, maximum: 4096 },
        total_source_bytes: { type: 'integer', minimum: 0, maximum: 64 * 1024 * 1024 },
      },
      $comment: 'Counts and total_source_bytes must agree with documents; enforced by the runtime validator.',
    },
  },
} as const;

export const documentSearchQuerySchema = {
  $schema: draft,
  $id: 'https://primecontext.dev/schemas/v0.2/document-search-query.schema.json',
  type: 'object',
  additionalProperties: false,
  required: ['schema_version', 'query'],
  properties: {
    schema_version: { const: '0.2' },
    query: { ...nonEmptyString, maxLength: 1024 },
    filters,
    limit: { type: 'integer', minimum: 1, maximum: 50 },
  },
  $comment: 'Query UTF-8 bytes and distinct normalized terms are bounded by the runtime validator.',
} as const;

export const documentSearchResultSchema = {
  $schema: draft,
  $id: 'https://primecontext.dev/schemas/v0.2/document-search-result.schema.json',
  type: 'object',
  additionalProperties: false,
  required: [
    'schema_version', 'catalog_digest', 'query', 'terms', 'effective_filters',
    'hits', 'conflicts', 'summary',
  ],
  properties: {
    schema_version: { const: '0.2' },
    catalog_digest: hashString,
    query: { ...nonEmptyString, maxLength: 1024 },
    terms: {
      type: 'array', minItems: 1, maxItems: 32,
      uniqueItems: true, items: { ...nonEmptyString, maxLength: maxNormalizedDocumentText },
    },
    effective_filters: {
      ...filters,
      required: ['authorities', 'modules', 'topics'],
    },
    hits: { type: 'array', maxItems: 50, items: searchHit },
    conflicts: {
      type: 'array',
      maxItems: 4096,
      items: {
        type: 'object', additionalProperties: false,
        required: ['normalized_title', 'document_ids'],
        properties: {
          normalized_title: { ...nonEmptyString, maxLength: maxNormalizedDocumentText },
          document_ids: {
            type: 'array', minItems: 2, maxItems: 4096,
            uniqueItems: true, items: documentIdString,
          },
        },
      },
    },
    summary: {
      type: 'object',
      additionalProperties: false,
      required: [
        'catalog_document_count', 'filtered_document_count', 'matched_document_count',
        'returned_hit_count', 'truncated',
      ],
      properties: {
        catalog_document_count: { type: 'integer', minimum: 0, maximum: 4096 },
        filtered_document_count: { type: 'integer', minimum: 0, maximum: 4096 },
        matched_document_count: { type: 'integer', minimum: 0, maximum: 4096 },
        returned_hit_count: { type: 'integer', minimum: 0, maximum: 50 },
        truncated: { type: 'boolean' },
      },
      $comment: 'Counts, truncation, hit ordering, term membership, and conflicts are enforced by the runtime validator.',
    },
  },
} as const;
