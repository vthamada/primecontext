# PrimeContext

> Working name. Public naming is intentionally frozen until the first working release, MaxSound pilot, and initial A/B benchmark.

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
- CLI commands for init/map/task/inspect/handoff/metrics/benchmark.

Not in v0.1: MCP, CodeGraph, Document Catalog retrieval, embeddings, vector databases, hosted services, web UI, Context Scout ranking, pruning, snapshots, or adaptive memory.

## Requirements

- Node.js 22 or newer.
- Node.js 24 LTS is the preferred line for new development environments.

## Development setup

```bash
npm install
npm run check
```

Build:

```bash
npm run build
```

## CLI

During repository development:

```bash
node packages/cli/dist/bin.js --help
```

Inside a target repository:

```bash
primecontext init
primecontext map
primecontext task TASK-001 --from path/to/task.json
primecontext inspect TASK-001
primecontext handoff validate handoff.json
primecontext metrics
primecontext benchmark --a arm-a.json --b arm-b.json
```

### `init`

Creates `primecontext.config.json` and local `.primecontext/` state. Existing configuration is never silently overwritten.

### `map`

Creates `.primecontext/repo-map.json`. v0.1 semantics are deterministic and evidence-backed: package metadata and conventional directory roles. It does not claim caller/callee or blast-radius understanding.

### `task`

Reads a task definition, applies the configured Context Budget, attaches Git/worktree metadata when available, validates the result, and stores `.primecontext/capsules/<task-id>.json`.

## Configuration

`primecontext.config.json` is repository configuration and should normally be committed. `.primecontext/` is generated local state and should not be committed.

Budget defaults originate from the product specification's experimental initial/soft limits. v0.1 derives a configurable hard limit as twice the soft limit; this is an implementation convention, not a benchmark claim.

`exclude` entries are repository-relative path prefixes added to the built-in safe exclusions.

## Security defaults

PrimeContext v0.1 blocks sensitive paths before content reads, including `.env*`, common credential/key files, `.git`, `node_modules`, `.primecontext`, and private dump/key extensions. Symlinks are skipped during repository discovery. Repository reads cannot traverse outside the configured root.

Git enrichment is optional and fail-open: mapping still works without Git metadata.

See `SECURITY.md` and `docs/adr/0005-safe-discovery-and-fail-open.md`.

## Architecture

Start with:

- `docs/specification/product-architecture-specification-v0.1.md`
- `docs/architecture/v0.1-implementation-architecture.md`
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

MaxSound is the first reference implementation, but MaxSound business logic must never enter PrimeContext Core. `examples/tasks/MAXSOUND-PILOT-001.json` is intentionally sanitized and contains only generic context-engineering fields.

## Benchmarks

PrimeContext reports raw A/B deltas and quality status. A reduction in tokens or tool calls is **not** considered positive evidence if the PrimeContext-assisted arm regresses tests or review quality.

No savings claim should be published without real A/B evidence.

## License

The public license is intentionally not frozen yet. Apache-2.0 and MIT remain candidates pending the public-release review described in the product specification.
