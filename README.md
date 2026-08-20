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

The implementation's dated point-in-time evidence is recorded in the [v0.2 Document Retrieval Verification](docs/verification/v0.2-document-retrieval-verification.md). It predates the current consolidation and is not public-release or publication authorization.

This slice does not implement FTS/SQLite, semantic search, embeddings, Context Scout, general ranking/pruning, CodeGraph, MCP, hosted services, telemetry, memory, or automatic Task Capsule integration.

## Authorized v0.3 slice: Proof-Carrying Context Compiler

The current v0.3 implementation gate is a local, additive context compiler:

- validated `ContextPlanRequest` to deterministic `ContextEnvelope` and linked
  complete `SelectionReceipt`;
- explainable Core-derived mandatory retention, integer scoring, marginal
  acceptance-criterion coverage, conflicts, missing evidence, and hard budgets;
- safe filesystem/document fallback plus optional local SQLite/FTS and the
  PrimeContext-internal TypeScript structural-graph candidate adapter;
- bounded progressive expansion, declared `OutcomeReceipt` storage, replay
  drift comparison, and experimental non-causal ablation;
- source/worktree freshness, selected-source rereads, local ignored state,
  threat controls, and complete v0.1/v0.2 compatibility requirements.

SQLite/FTS and the internal structural graph are evidence sources, not the
innovation or a required foundation. The internal graph is not the third-party
`@colbymchenry/codegraph` project. These adapters cannot supply Core scores or
mandatory status, and the v0.2
Document Catalog/search remains metadata-only/live. The compiler makes no
state-of-the-art, causal, token-savings, or quality-superiority claim. Its scope
authorization and its implementation verification are separate gates.

The original compiler slice's dated point-in-time evidence is recorded in the
[v0.3 Proof-Carrying Context Compiler Verification](docs/verification/v0.3-proof-carrying-context-compiler-verification.md).
The additive human/agent onboarding surface has its own
[v0.3 Agent Usability Extension Verification](docs/verification/v0.3-agent-usability-extension-verification.md).
Those records verify their earlier authorized vertical slices only. The current
consolidation has a separate [working-tree verification
record](docs/verification/v0.3-consolidation-verification.md) and a complete
[audit-resolution matrix](docs/verification/v0.3-consolidation-audit-resolution.md).
Only explicit command rows in the working-tree record are point-in-time local
evidence. Immutable, Linux, remote-CI, advisory, legal, publication, pilot, and
benchmark gates remain separate; no record is a release, benchmark, causality,
or state-of-the-art claim.

## Requirements

- Node.js 22.13 or newer.
- Node.js 24 LTS is the preferred line for new development environments.

Every supported runtime has the complete safe filesystem/document fallback.
The optional in-process SQLite/FTS accelerator is enabled only on Node releases
where that module has reached release-candidate status (Node 24.15+, Node
25.7+, and later lines). Earlier builds emit an experimental runtime warning
that would contaminate the strict process-JSON channel. TypeScript CodeGraph
remains independently capability-detected.

## Development setup

```bash
npm ci
npm run verify
```

The repository is configured to run a cross-platform verification surface in
GitHub Actions on Node.js 22.13 and 24 across Linux and Windows. It includes
contracts/typecheck, the complete test suite, build, executable sample,
disposable demo, Markdown links, package tarball inspection, and
generated-diff checks. A checked-in workflow is not evidence that a remote run
has passed; this is technical preparation, not license or npm-publication
authorization.

## Try it in one command

After `npm ci`, run the disposable local demonstration:

```bash
npm run demo
```

It builds the checkout, creates a synthetic repository in the operating-system
temporary directory, runs the same zero-configuration `prepare` command a
person would use, compiles one proof-carrying context package, prints a bounded
JSON summary, and removes the repository. It
uses no model, agent SDK, network service, MCP server, or private data.

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
node /absolute/path/to/primecontext/packages/cli/dist/bin.js setup
node /absolute/path/to/primecontext/packages/cli/dist/bin.js prepare "Fix the login validation" --accept "Existing valid logins still pass"
```

These are the recommended human commands. `setup` creates safe defaults only
when missing, and `prepare` converts the sentence and optional repeated flags
into the strict internal contract, attempts the local index, and uses safe
fallback automatically. A person does not need to author JSON, task IDs,
snapshots, hashes, or budgets.

Human `prepare` output is compact by default: it contains the prompt-facing
envelope, bounded warnings and missing evidence, a receipt summary/reference,
and next commands, with a 1 MiB hard ceiling. Add `--full` only when the caller
needs the complete request and receipt. Use `--type <task-type>` to override the
conservative `small_code_fix` default explicitly.

The lower-level machine and compatibility commands remain available:

```bash
node /absolute/path/to/primecontext/packages/cli/dist/bin.js init
node /absolute/path/to/primecontext/packages/cli/dist/bin.js capabilities
node /absolute/path/to/primecontext/packages/cli/dist/bin.js doctor
node /absolute/path/to/primecontext/packages/cli/dist/bin.js context prepare --from tasks/primecontext-intent.json --compact
node /absolute/path/to/primecontext/packages/cli/dist/bin.js map
node /absolute/path/to/primecontext/packages/cli/dist/bin.js docs index
node /absolute/path/to/primecontext/packages/cli/dist/bin.js docs search "document retrieval" --limit 5 --authority specification
node /absolute/path/to/primecontext/packages/cli/dist/bin.js task TASK-001 --from tasks/TASK-001.json
node /absolute/path/to/primecontext/packages/cli/dist/bin.js inspect TASK-001
node /absolute/path/to/primecontext/packages/cli/dist/bin.js handoff validate evidence/handoff.json
node /absolute/path/to/primecontext/packages/cli/dist/bin.js metrics record evidence/arm-b.json
node /absolute/path/to/primecontext/packages/cli/dist/bin.js metrics
node /absolute/path/to/primecontext/packages/cli/dist/bin.js benchmark --a evidence/arm-a.json --b evidence/arm-b.json
node /absolute/path/to/primecontext/packages/cli/dist/bin.js context index
node /absolute/path/to/primecontext/packages/cli/dist/bin.js context plan --from tasks/TASK-001-context-plan.json
node /absolute/path/to/primecontext/packages/cli/dist/bin.js context inspect TASK-001
node /absolute/path/to/primecontext/packages/cli/dist/bin.js context expand TASK-001 --from tasks/TASK-001-expansion.json
node /absolute/path/to/primecontext/packages/cli/dist/bin.js context outcome TASK-001 --from evidence/TASK-001-outcome.json
node /absolute/path/to/primecontext/packages/cli/dist/bin.js context replay TASK-001
node /absolute/path/to/primecontext/packages/cli/dist/bin.js context ablate TASK-001 --candidate sha256:<64-lowercase-hex>
```

Input files are repository-local and validated before domain execution. See the [v0.1 foundations CLI guide](docs/cli-usage-v0.1.md), [v0.2 document retrieval CLI guide](docs/cli-usage-v0.2.md), and [v0.3 compiler CLI guide](docs/cli-usage-v0.3.md). The v0.3 guide marks the implementation/verification boundary; do not assume an unverified command is available in a globally installed binary.

For agents, `context prepare --from - --compact` accepts one bounded JSON
`ContextIntent` over standard input and returns the prompt-facing envelope,
missing-evidence summary, bounded warnings, receipt digest/reference, and next
commands within a 1 MiB ceiling. Omitting `--compact` preserves the complete
request/envelope/receipt response for compatibility and explicit inspection.
Agents should keep the envelope in active context and follow the stored receipt
reference only when inspection is needed. The
[agent integration guide](docs/agent-integration-v0.3.md)
and templates under `integrations/` use the same process protocol for generic
agents, Codex, and Claude Code. A local regression test checks the required
protocol fragments in all templates; that is not evidence that either
proprietary host was executed.

### `init`

Creates `primecontext.config.json`, local `.primecontext/` state, and the exact
`.gitignore` protection required by v0.3 context commands. Existing
configuration is never silently overwritten.

### `setup` and `prepare`

`setup` is the idempotent zero-configuration entry point: it applies the
existing safe defaults, protects local state, and returns diagnostics and
capabilities. `prepare "<goal>"` generates a deterministic internal intent,
attempts the optional local index, and compiles the normal proof-carrying
package. Only accelerator unavailability falls back; validation, containment,
security, and repository/worktree or selected-source freshness failures remain
blocking. A stale optional accelerator index may be discarded in favor of
freshly recollected safe sources.

By default this command returns the compact agent-facing projection. Use
`--full` for the complete request and receipt, and `--type` when the task is not
a small code fix.

Repository-local Markdown notes also work as knowledge-vault evidence without
a connector, including notes edited with Obsidian. PrimeContext excludes the
`.obsidian` settings directory and does not yet attach external vaults, follow
Obsidian backlinks, use Obsidian Sync, or write notes.

### `map`

Creates `.primecontext/repo-map.json`. v0.1 semantics are deterministic and evidence-backed: package metadata and conventional directory roles. It does not claim caller/callee or blast-radius understanding.

### `docs index` and `docs search`

`docs index` replaces the local metadata-only catalog after collecting the bounded permitted Markdown corpus. `docs search "<query>"` validates that catalog, recollects the live corpus, requires freshness, and then returns at most 50 deterministic lexical hits with bounded excerpts. A changed or newly blocked candidate returns `CATALOG_ERROR` until re-indexed.

### `task`

Reads a task definition, applies the configured Context Budget, attaches Git/worktree metadata when available, validates the result, and stores `.primecontext/capsules/<task-id>.json`.

### `context index`, `plan`, `inspect`, `expand`, `outcome`, `replay`, and `ablate`

These additive v0.3 commands build the optional local hybrid index, compile and
inspect proof-carrying context plans, request bounded additional evidence,
append a declared outcome, compare deterministic replay against current source,
and derive a non-causal experimental ablation. They write validated ignored
state only under the configured state directory; they neither execute
an agent nor edit project sources or external systems.

### `metrics record` and `metrics`

`metrics record <file>` validates one repository-local MetricRecord and appends it to `.primecontext/metrics.jsonl`. `metrics` summarizes local numeric evidence and marks fields that include estimates. Neither command infers savings or quality from totals alone.

## Configuration

`primecontext.config.json` is repository configuration and should normally be committed. `.primecontext/` is generated local state and should not be committed.

Budget defaults originate from the product specification's experimental initial/soft limits. v0.1 derives a configurable hard limit as twice the soft limit; this is an implementation convention, not a benchmark claim.

`exclude` entries are repository-relative path prefixes added to the built-in safe exclusions.

## Security defaults

PrimeContext blocks sensitive paths before content reads, including `.env*`, credentials, API keys/tokens, passwords, cookies, PII, private uploads/dumps/backups, `.git`, `node_modules`, and `.primecontext`. Document retrieval adds strict UTF-8 and high-confidence content checks before cataloging, then reapplies the same collection controls before returning excerpts. v0.3 separately permits a local screened full-text index, binds it to the complete accepted-source manifest, rereads selected source bytes, and treats all repository/index/graph content as untrusted data. Discovery skips symlinks and Windows junctions, task IDs cannot become paths, and existing path components are checked before repository reads or generated-state writes. Inputs and discovery also have explicit byte, record, depth, value, entry, exclude, Git-time, and Git-output limits.

Git enrichment is optional and fail-open: mapping still works without Git metadata.

See `SECURITY.md` and `docs/adr/0005-safe-discovery-and-fail-open.md`.

PrimeContext is not an operating-system sandbox and local state is not encrypted. Review the [v0.1 security limits](docs/security-and-residual-risks-v0.1.md), [v0.2 retrieval residual risks](docs/security-and-residual-risks-v0.2.md), and [v0.3 threat model/residual risks](docs/security-and-residual-risks-v0.3.md) before using it with a sensitive repository.

## Architecture

Start with the [canonical documentation index](docs/README.md), then:

- `docs/specification/product-architecture-specification-v0.1.md`
- `docs/architecture/v0.1-implementation-architecture.md`
- `docs/specification/document-retrieval-specification-v0.2.md`
- `docs/architecture/v0.2-document-retrieval-architecture.md`
- `docs/specification/proof-carrying-context-compiler-specification-v0.3.md`
- `docs/architecture/v0.3-proof-carrying-context-compiler-architecture.md`
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

PrimeContext reports raw A/B deltas plus independent quality, environment, and
measurement gates. The comparator refuses `COMPARABLE_EVIDENCE` when the
pre-registered run environments are absent or differ. A reduction in tokens or
tool calls is **not** considered positive evidence if the PrimeContext-assisted
arm regresses tests or review quality.

No savings claim should be published without real A/B evidence.

Use the [conservative A/B methodology](docs/benchmark-methodology-v0.1.md). Files under `benchmarks/fixtures/` are test fixtures, not product-performance evidence.

## Roadmap

The [phase-gated roadmap](docs/roadmap.md) keeps v0.1 foundations, v0.2
Document Catalog/live lexical search, and the bounded v0.3 proof-carrying
compiler as separate compatibility/scope gates. The
[post-v0.2 evolution specification](docs/specification/post-v0.2-evolution-specification.md)
inventories broader candidate phases, optional integrations, and v1.0 readiness
requirements. Only the v0.3 vertical slice's local optional SQLite/FTS and
TypeScript CodeGraph sources are newly authorized; MCP, embeddings, remote
services, learned ranking, memory, orchestration, and broader later phases
remain deferred.

## License

The public license is intentionally not frozen yet. Apache-2.0 and MIT remain candidates, but an authorized human legal/public-release review must choose and approve the license before public redistribution or package publication. Automated agents may not make that decision. See [ADR-0007](docs/adr/0007-defer-public-license-selection.md).
