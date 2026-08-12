# PrimeContext Document Retrieval Specification v0.2

**Status:** Approved for the first v0.2 implementation slice

## 1. Objective

The first v0.2 slice adds a local Document Catalog and deterministic lexical search over permitted repository Markdown. It proves useful retrieval without adding a search service, database, embedding model, general-purpose ranker, or agent orchestration.

The v0.1 contracts and command behavior remain compatible.

## 2. Authorized scope

This slice includes:

- cataloging permitted `.md` documents;
- stable document identity, source authority, provenance, SHA-256 hashes, and a deterministic catalog digest;
- bounded live lexical search with filters;
- freshness validation before returning content;
- compact excerpts with source line information;
- `primecontext docs index` and `primecontext docs search`;
- three physical v0.2 JSON contracts, regression tests, CLI documentation, and verification evidence.

This slice does not include SQLite/FTS, persisted document bodies or token indexes, MCP, CodeGraph, Context Scout, general ranking or pruning, embeddings, vector databases, AI summaries, remote services, snapshots, memory, or automatic orchestration.

## 3. Corpus

The default corpus is intentionally conservative:

- `.md` files under `docs/`;
- canonical Markdown files such as `README.md`, `AGENTS.md`, `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, and `CHANGELOG.md` at the repository root;
- files allowed by the existing configured excludes and built-in sensitive-path policy.

The catalog never follows symbolic links or junctions and never re-enables a path excluded by the security adapter. Other extensions and arbitrary glob configuration are deferred.

## 4. Contracts

The following draft 2020-12 contracts are versioned independently under `packages/schemas/contracts/v0.2/`:

- `document-catalog.schema.json`;
- `document-search-query.schema.json`;
- `document-search-result.schema.json`.

### 4.1 Document Catalog

A catalog contains:

- `schema_version: "0.2"`;
- `generated_at` as an RFC 3339 UTC instant;
- `catalog_digest` as `sha256:<64 lowercase hex>` over the canonical document metadata, excluding `generated_at`;
- optional Git `worktree` branch/head provenance;
- documents ordered by repository-relative path;
- a summary whose counts and byte totals agree with the documents.

Each document contains:

- stable `id` derived from its normalized path;
- safe repository-relative `path` using `/` separators;
- `format: "markdown"`;
- bounded `title`;
- `authority` and an explicit `authority_basis`;
- bounded `modules` and `topics` metadata;
- `source_hash` over the source bytes;
- `size_bytes`.

The catalog must not contain the Markdown body, snippets, summaries derived from the body, plaintext lexical terms, or private source paths that were excluded.

### 4.2 Search query

A query contains:

- `schema_version: "0.2"`;
- non-empty `query`;
- optional filters for authority, module, and topic;
- optional `limit`, defaulting to 10 and never exceeding 50.

Unknown properties and duplicate filter values are invalid.

The public contract accepts up to 32 values in each filter dimension. Values are ORed within one dimension and the authority, module, and topic dimensions are ANDed together. Comparisons are exact and case-sensitive against the normalized identifiers stored in the catalog. The CLI surface is narrower and accepts at most one value for each filter flag.

### 4.3 Search result

A result contains:

- `schema_version: "0.2"`;
- the catalog digest and original query;
- distinct normalized query terms;
- effective filters;
- ordered hits with document identity, path, title, authority, source hash, integer score, matched fields, matched terms, and a bounded source excerpt;
- aggregate counts and a truncation flag;
- catalog-wide, mechanically detectable potential conflicts where documents have the same normalized title but different source hashes, independent of the requested hit limit.

No result claims semantic conflict detection, token savings, or quality superiority.

## 5. Authority

The initial authority values are:

1. `policy`;
2. `adr`;
3. `specification`;
4. `contract_schema`;
5. `roadmap`;
6. `implementation_note`;
7. `generated_summary`.

Authority is inferred only by documented path/name conventions. The basis records either `convention` plus a stable rule identifier or `default`. No document silently overrides another document. Authority affects only deterministic tie-breaking after lexical relevance.

## 6. Lexical semantics

- Normalize with Unicode NFKC and `toLowerCase()`.
- Tokenize as Unicode letter/number sequences.
- Reject a query with no tokens, more than 32 distinct terms, or more than 1,024 UTF-8 bytes.
- Apply AND semantics: every distinct query term must appear in at least one searchable field.
- Apply authority/module/topic filters before scoring.
- Use integer-only, explainable weights for title, path, module, topic, and bounded body occurrences.
- Give an additional exact-title-phrase bonus.
- Sort by score descending, authority precedence, then path and ID in ordinal order.
- Do not use locale-sensitive sorting, stemming, synonyms, stop words, IDF, floating-point scores, or learned ranking.

Search reads the permitted Markdown sources at execution time. It verifies that the live catalog digest and every source hash still match before returning results. A missing, added, reclassified, blocked, or changed document makes the stored catalog stale and requires re-indexing.

The initial adapter assigns `workspace` to canonical root files and `docs` to direct children of `docs/`. A deeper path receives at most one normalized module from the first directory below `docs/`; a non-tokenizable segment may produce no module. The Markdown filename produces zero to 32 normalized topic tokens. These identifiers are deterministic path metadata, not semantic classification.

## 7. Security and resource limits

Hard ceilings for this slice are:

| Resource | Ceiling |
|---|---:|
| eligible Markdown candidates per collection | 4,096; accepted catalog entries cannot exceed this |
| one Markdown candidate | 512 KiB |
| cumulative bounded bytes read from non-oversize candidates | 64 MiB; accepted catalog source bytes cannot exceed this |
| serialized catalog | 8 MiB |
| parsed catalog structure | 500,000 JSON values / depth 64 |
| query | 1,024 UTF-8 bytes / 32 distinct terms |
| filter values | 32 per filter |
| path | 1,024 Unicode code points |
| module/topic/filter value | 128 Unicode code points |
| returned hits | 50 |
| title | 256 Unicode code points |
| modules/topics | 32 values each |
| excerpt | 400 Unicode code points / 6 source lines |

The existing discovery ceilings of 100,000 entries, depth 64, and 1,024 configured excludes remain in force.

Before cataloging and again before returning an excerpt, the implementation must:

- enforce repository containment and reject absolute paths, traversal, ADS syntax, Windows device aliases, trailing-dot/space aliases, controls, symlinks, and junctions;
- apply the sensitive-path policy before reads;
- decode UTF-8 strictly;
- block binary/control-laden content and high-confidence credential, private-key, token, authorization-header, and PII indicators;
- exclude the entire blocked document without recording the matching value or path in output;
- bound reads before and after opening;
- fail without replacing the previous catalog if a global limit or write fails.

Content detection is a conservative safety layer, not complete DLP. The same-user link-swap race remains a documented portable-filesystem limitation.

## 8. CLI behavior

```text
primecontext docs index
primecontext docs search "<query>" [--limit <1..50>] [--authority <value>] [--module <value>] [--topic <value>]
```

`docs index` accepts no additional arguments. Search accepts one positional query followed by strict flag/value pairs. Unknown, duplicate, missing, non-canonical numeric, or extra arguments fail with `VALIDATION_ERROR`.

The catalog is written beneath the configured `state_dir`; there is no arbitrary output path. PrimeContext does not persist queries, source bodies, terms, or excerpts and does not send them remotely. A successful search deliberately emits the original query, normalized terms, metadata, and bounded excerpts in its structured stdout result; operators must treat captured stdout and shell history as repository data.

## 9. Acceptance criteria

1. Only permitted Markdown is read and indexed.
2. The catalog validates against the physical v0.2 contract and contains no document body or lexical index.
3. IDs, hashes, digest, metadata order, scoring, and result order are stable for the same repository snapshot.
4. Catalog validation rejects absolute, traversal, alias, duplicate, inconsistent, oversized, and unknown input.
5. Search rejects invalid queries, filters, catalog input, and a stale repository snapshot.
6. Search implements AND matching, documented filters, deterministic scoring, tie-breaking, and bounded excerpts with source lines.
7. Sensitive paths or high-confidence sensitive content never appear in catalog or search output.
8. Collection, global-limit, validation, serialization, temporary creation/write/`fsync`, and rename failures before a successful replacement preserve the previous valid catalog. Failures detected after a successful rename remain within the documented residual boundary.
9. Potential same-title/different-hash conflicts remain visible and are never silently resolved.
10. All v0.1 commands, contracts, configuration, and tests remain compatible.
11. A disposable `init -> docs index -> docs search` flow retrieves the expected allowed document and omits a blocked document.
12. No new external runtime dependency, paid service, SQLite database, embedding, vector store, CodeGraph, or MCP is added.
13. `npm run typecheck`, `npm test`, and `npm run build` pass before handoff.

## 10. Exit gate

This slice is complete only with a requirement-to-evidence verification record. Starting Context Scout, general ranking, SQLite/FTS, or any integration surface requires a new approved scope.
