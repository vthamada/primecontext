# PrimeContext

> Working name. Public naming is intentionally frozen until the first working release, MaxSound pilot, and initial A/B benchmark.
>
> This source checkout is being prepared for open-source release but is not yet publicly licensed or published as an npm package. See [ADR-0007](docs/adr/0007-defer-public-license-selection.md).

PrimeContext is a local-first context engineering runtime for AI/software agents. It prepares bounded, high-signal task context so agents can do more validated work without repeatedly ingesting irrelevant repository state.

PrimeContext is **not a coding agent**. It is infrastructure for existing agents.

## v0.1 status

Implemented foundation slice:

- JSON Schema-compatible public contract objects and runtime contract validation;
- Context Budget policy with configurable experimental defaults;
- Task Capsule generation and validation;
- Compact Handoff validation;
- safe filesystem and optional Git adapters;
- deterministic Semantic Repo Map;
- benchmark comparison skeleton with quality guardrails;
- CLI commands for init/map/task/inspect/handoff validation, metric recording/summary, and benchmark comparison.

Not in v0.1: MCP, CodeGraph, Document Catalog retrieval, embeddings, vector databases, hosted services, web UI, Context Scout ranking, pruning, snapshots, or adaptive memory.

## First v0.2 slice: document retrieval

The separately scoped first v0.2 slice is now implemented in this source checkout:

- a metadata-and-hash-only Document Catalog for permitted repository Markdown;
- deterministic lexical search with AND semantics, authority/module/topic filters, integer scoring, bounded excerpts, and catalog-wide potential same-normalized-title/different-hash reporting;
- live corpus recollection and hash/digest freshness checks before any excerpt is returned;
- strict UTF-8, sensitive-path, credential, private-key, CPF/CNPJ, byte, count, link, and traversal controls;
- `docs index` and `docs search` CLI workflows plus three physical v0.2 contracts.

The catalog is normally stored at `.primecontext/documents/catalog.json`. It never stores Markdown bodies, excerpts, plaintext terms, or a lexical index. The v0.1 configuration and commands remain compatible.

The implementation and its current working-tree evidence are recorded in the [v0.2 Document Retrieval Verification](docs/verification/v0.2-document-retrieval-verification.md). This is implementation verification, not public-release or publication authorization.

This slice does not implement FTS/SQLite, semantic search, embeddings, Context Scout, general ranking/pruning, CodeGraph, MCP, hosted services, telemetry, memory, or automatic Task Capsule integration.

## Requirements

- Node.js 22 or newer.
- Node.js 24 LTS is the preferred line for new development environments.

## Development setup

```bash
npm ci
npm run check
```

Build:

```bash
npm run build
```

## CLI

PrimeContext currently runs from a built source checkout. A clean installation and build are required before use; a bare `primecontext` command must not be assumed to exist globally.

From the PrimeContext checkout:

```bash
npm ci
npm run typecheck
npm test
npm run build
```

Then run the built binary with Node from the target repository:

```bash
cd /absolute/path/to/target-repository
node /absolute/path/to/primecontext/packages/cli/dist/bin.js init
node /absolute/path/to/primecontext/packages/cli/dist/bin.js map
node /absolute/path/to/primecontext/packages/cli/dist/bin.js docs index
node /absolute/path/to/primecontext/packages/cli/dist/bin.js docs search "document retrieval" --limit 5 --authority specification
node /absolute/path/to/primecontext/packages/cli/dist/bin.js task TASK-001 --from tasks/TASK-001.json
node /absolute/path/to/primecontext/packages/cli/dist/bin.js inspect TASK-001
node /absolute/path/to/primecontext/packages/cli/dist/bin.js handoff validate evidence/handoff.json
node /absolute/path/to/primecontext/packages/cli/dist/bin.js metrics record evidence/arm-b.json
node /absolute/path/to/primecontext/packages/cli/dist/bin.js metrics
node /absolute/path/to/primecontext/packages/cli/dist/bin.js benchmark --a evidence/arm-a.json --b evidence/arm-b.json
```

Input files are repository-local and validated before domain execution. See the [v0.1 foundations CLI guide](docs/cli-usage-v0.1.md) and the [v0.2 document retrieval CLI guide](docs/cli-usage-v0.2.md).

### `init`

Creates `primecontext.config.json` and local `.primecontext/` state. Existing configuration is never silently overwritten.

### `map`

Creates `.primecontext/repo-map.json`. v0.1 semantics are deterministic and evidence-backed: package metadata and conventional directory roles. It does not claim caller/callee or blast-radius understanding.

### `docs index` and `docs search`

`docs index` replaces the local metadata-only catalog after collecting the bounded permitted Markdown corpus. `docs search "<query>"` validates that catalog, recollects the live corpus, requires freshness, and then returns at most 50 deterministic lexical hits with bounded excerpts. A changed or newly blocked candidate returns `CATALOG_ERROR` until re-indexed.

### `task`

Reads a task definition, applies the configured Context Budget, attaches Git/worktree metadata when available, validates the result, and stores `.primecontext/capsules/<task-id>.json`.

### `metrics record` and `metrics`

`metrics record <file>` validates one repository-local MetricRecord and appends it to `.primecontext/metrics.jsonl`. `metrics` summarizes local numeric evidence and marks fields that include estimates. Neither command infers savings or quality from totals alone.

## Configuration

`primecontext.config.json` is repository configuration and should normally be committed. `.primecontext/` is generated local state and should not be committed.

Budget defaults originate from the product specification's experimental initial/soft limits. v0.1 derives a configurable hard limit as twice the soft limit; this is an implementation convention, not a benchmark claim.

`exclude` entries are repository-relative path prefixes added to the built-in safe exclusions.

## Security defaults

PrimeContext blocks sensitive paths before content reads, including `.env*`, credentials, API keys/tokens, passwords, cookies, PII, private uploads/dumps/backups, `.git`, `node_modules`, and `.primecontext`. Document retrieval adds strict UTF-8 and high-confidence content checks before cataloging, then reapplies the same collection controls before returning excerpts. Discovery skips symlinks and Windows junctions, task IDs cannot become paths, and existing path components are checked before repository reads or generated-state writes. Inputs and discovery also have explicit byte, record, depth, value, entry, exclude, Git-time, and Git-output limits.

Git enrichment is optional and fail-open: mapping still works without Git metadata.

See `SECURITY.md` and `docs/adr/0005-safe-discovery-and-fail-open.md`.

PrimeContext is not an operating-system sandbox and local state is not encrypted. Review the [v0.1 security limits](docs/security-and-residual-risks-v0.1.md) and [v0.2 retrieval residual risks](docs/security-and-residual-risks-v0.2.md) before using it with a sensitive repository.

## Architecture

Start with the [canonical documentation index](docs/README.md), then:

- `docs/specification/product-architecture-specification-v0.1.md`
- `docs/architecture/v0.1-implementation-architecture.md`
- `docs/specification/document-retrieval-specification-v0.2.md`
- `docs/architecture/v0.2-document-retrieval-architecture.md`
- `docs/adr/`

Physical v0.1 packages:

```text
@primecontext/schemas
@primecontext/core
@primecontext/adapters
@primecontext/repo-map
@primecontext/benchmark
@primecontext/cli
```

## Reference implementation

MaxSound is the first reference implementation, but MaxSound business logic must never enter PrimeContext Core. `examples/tasks/MAXSOUND-PILOT-001.json` is intentionally sanitized and contains only generic context-engineering fields. The fixture establishes reproducible pilot readiness; the current [verification record](docs/verification/v0.1-foundations-verification.md) separately identifies any real local pilot evidence and its privacy/verification limits.

## Benchmarks

PrimeContext reports raw A/B deltas and quality status. A reduction in tokens or tool calls is **not** considered positive evidence if the PrimeContext-assisted arm regresses tests or review quality.

No savings claim should be published without real A/B evidence.

Use the [conservative A/B methodology](docs/benchmark-methodology-v0.1.md). Files under `benchmarks/fixtures/` are test fixtures, not product-performance evidence.

## Roadmap

The [phase-gated roadmap](docs/roadmap.md) keeps v0.1 foundations separate from the specifically authorized Document Catalog/lexical-search slice. The [post-v0.2 evolution specification](docs/specification/post-v0.2-evolution-specification.md) inventories the remaining candidate phases, optional integrations, and v1.0 readiness gates without authorizing their implementation. Context Scout, general ranking/pruning, SQLite/FTS, and optional CodeGraph remain deferred behind a new scope gate.

## License

The public license is intentionally not frozen yet. Apache-2.0 and MIT remain candidates, but an authorized human legal/public-release review must choose and approve the license before public redistribution or package publication. Automated agents may not make that decision. See [ADR-0007](docs/adr/0007-defer-public-license-selection.md).
