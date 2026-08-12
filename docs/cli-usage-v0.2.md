# PrimeContext v0.2 document retrieval CLI

This guide covers only the first v0.2 slice. The v0.1 commands and `primecontext.config.json` schema remain unchanged; see the [v0.1 CLI guide](cli-usage-v0.1.md) for those workflows.

PrimeContext is currently run from a built source checkout, not a published global package:

```bash
cd /absolute/path/to/primecontext
npm ci
npm run typecheck
npm test
npm run build
```

Run the compiled binary from the target repository:

```bash
cd /absolute/path/to/target-repository
node /absolute/path/to/primecontext/packages/cli/dist/bin.js init
```

## Build the Document Catalog

```bash
node /absolute/path/to/primecontext/packages/cli/dist/bin.js docs index
```

The command accepts no arguments. It writes `<state_dir>/documents/catalog.json`, normally `.primecontext/documents/catalog.json`, using a flushed sibling temporary file and same-directory replacement. A failed global collection or write leaves the previous catalog in place where the filesystem provides atomic replacement.

The catalog contains repository-relative paths, titles, authority and its basis, inferred module/topic identifiers, sizes, SHA-256 source hashes, a catalog digest, aggregate counts, and optional Git metadata. It never persists Markdown bodies, excerpts, plaintext terms, summaries derived from bodies, or a lexical index.

On success, `docs index` writes one JSON object to stdout with `catalog_path`, `document_count`, and `catalog_digest`. Git branch/head metadata is optional and fail-open; source hashes remain authoritative when Git inspection is unavailable.

The current corpus is deliberately narrow: `.md` files below `docs/` plus `README.md`, `AGENTS.md`, `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, and `CHANGELOG.md` when present at the repository root. Built-in sensitive exclusions and configured `exclude` prefixes always take precedence.

## Search

```bash
node /absolute/path/to/primecontext/packages/cli/dist/bin.js docs search "document retrieval"
node /absolute/path/to/primecontext/packages/cli/dist/bin.js docs search "document retrieval" --limit 5 --authority specification
node /absolute/path/to/primecontext/packages/cli/dist/bin.js docs search "proposal versioning" --module specification --topic versioning
```

Full syntax:

```text
primecontext docs search <query> [--limit <1..50>] [--authority <value>] [--module <value>] [--topic <value>]
```

Supported authority values are:

```text
policy
adr
specification
contract_schema
roadmap
implementation_note
generated_summary
```

`generated_summary` is only a path classification. PrimeContext does not generate summaries in this slice.

Module identifiers come from the repository root (`workspace`) or the first documentation directory, such as `specification` for `docs/specification/example.md`. Topic identifiers are normalized filename tokens. They are deterministic path metadata, not semantic labels.

The CLI accepts at most one exact value for each filter flag and rejects duplicate flags. In the public structured contract, values are ORed within each dimension and authority/module/topic dimensions are ANDed together. Module and topic comparisons are exact and case-sensitive against normalized catalog identifiers; inspect the catalog or an unfiltered result before choosing them.

All distinct normalized query terms use AND semantics. Scoring is integer-only and explainable across title, path, module, topic, and the live body. Authority is used only after equal lexical scores. Final ties use path and stable document ID in ordinal order.

Run `docs index` before the first search. Search validates the query before catalog or corpus I/O, validates the stored catalog, and then recollects the permitted live corpus. A changed, added, removed, reclassified, or newly content-blocked candidate returns `CATALOG_ERROR`; run `docs index` again before searching. Results include at most 50 hits, excerpts of at most 400 Unicode code points and six source lines, plus catalog-wide potential same-normalized-title/different-hash groups. These groups are mechanically detectable review signals, not semantic conflict judgments.

On success, `docs search` writes a validated JSON result to stdout with `schema_version`, `catalog_digest`, the original `query`, normalized `terms`, `effective_filters`, ordered `hits`, potential `conflicts`, and `summary` counts. Each hit contains provenance, matched fields/terms, score, and a bounded live excerpt.

## Strict argument behavior

The query is exactly one positional CLI argument, so shell quoting is required for spaces. Every option is a strict flag/value pair. `--limit` accepts only canonical decimal integers from 1 through 50. Values such as `0`, `51`, `01`, `+1`, and `1.5`, as well as duplicate, unknown, missing-value, or extra arguments, fail with `VALIDATION_ERROR`.

## Limits and data boundary

- 4,096 eligible Markdown candidates per collection; accepted entries cannot exceed this;
- 512 KiB per Markdown candidate;
- 64 MiB cumulative bounded bytes read from non-oversize candidates; accepted source bytes cannot exceed this;
- 8 MiB serialized catalog, 500,000 parsed JSON values, and JSON depth 64;
- 1,024 UTF-8 query bytes and 32 distinct terms;
- 32 values in each structured-contract filter, with one value per CLI flag;
- 1,024 Unicode code points per path and 128 per module/topic/filter value;
- 50 returned hits;
- 400 Unicode code points and six lines per excerpt.

The content detector blocks high-confidence credential, private-key, authorization-token, labelled PII, and checksum-valid labelled CPF/CNPJ indicators. It is a conservative safety layer, not complete DLP. Otherwise allowed proprietary prose can still appear in an excerpt.

Search results are written to stdout and include the original query, normalized terms, metadata, and excerpts. Redirecting or logging stdout makes them persistent, so treat captured output according to the source repository's sensitivity. `.primecontext/` is local, ignored by Git by default, and not encrypted.

## Exit behavior

Successful commands write JSON to stdout and exit with status 0. Failures write a compact structured error to stderr, return non-zero status, and do not print a stack by default. Invalid argv, queries, filters, or schema-invalid catalogs use `VALIDATION_ERROR`; malformed or structurally excessive catalog JSON and stale/digest-mismatched catalogs use `CATALOG_ERROR`; a missing, unreadable, oversized, or invalid-UTF-8 catalog file uses `IO_ERROR`. Unsafe paths and global safety ceilings can use `SECURITY_ERROR`.

This slice performs no network call and adds no telemetry, hosted service, FTS/SQLite database, semantic search, RAG, embedding, vector store, Context Scout, CodeGraph, or automatic Task Capsule integration.
