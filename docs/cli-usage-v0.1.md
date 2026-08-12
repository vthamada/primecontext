# PrimeContext v0.1 CLI installation and usage

PrimeContext v0.1 is currently operated from a source checkout. No npm package or global binary is published yet, so examples must not assume that a bare `primecontext` command is already on `PATH`.

## Prerequisites

- Node.js 22.13 or newer. Node.js 24 LTS is the preferred development line.
- npm supplied with Node.js.
- A local checkout of PrimeContext and a separate target repository.

No hosted or paid service is required.

## Clean source installation

From the PrimeContext checkout:

```bash
npm ci
npm run typecheck
npm test
npm run build
```

`npm ci` is the reproducible installation path when `package-lock.json` is present. A release claim requires these commands to pass from a clean checkout; existing `node_modules`, `dist`, or `.tsbuildinfo` directories are not clean-install evidence.

The development binary is:

```text
/absolute/path/to/primecontext/packages/cli/dist/bin.js
```

Run it with Node from the target repository. For example:

```bash
cd /absolute/path/to/target-repository
node /absolute/path/to/primecontext/packages/cli/dist/bin.js --help
```

All repository-relative paths below are resolved from that target repository.

## Initialize local state

```bash
node /absolute/path/to/primecontext/packages/cli/dist/bin.js init
```

`init` creates `primecontext.config.json` if it is absent, creates the configured local state directory (normally `.primecontext/`), and adds that generated-state directory to `.gitignore`. It does not silently replace existing configuration.

`primecontext.config.json` is repository configuration and is intended to be reviewed and committed. `.primecontext/` is generated local state and must not be committed.

## Generate a Semantic Repo Map

```bash
node /absolute/path/to/primecontext/packages/cli/dist/bin.js map
```

The command writes `.primecontext/repo-map.json` by default. v0.1 inference is deterministic and limited to manifests, conventional directory roles, safe filesystem discovery, and optional Git metadata. It does not provide AST, caller/callee, or blast-radius analysis.

## Create and inspect a Task Capsule

Store a sanitized task definition inside the target repository, for example `tasks/TASK-001.json`, and run:

```bash
node /absolute/path/to/primecontext/packages/cli/dist/bin.js task TASK-001 --from tasks/TASK-001.json
node /absolute/path/to/primecontext/packages/cli/dist/bin.js inspect TASK-001
```

Without `--from`, the command reads `.primecontext/tasks/TASK-001.json`. Task identifiers are bounded safe identifiers, and input files must remain within the target repository. The generated capsule is written under `.primecontext/capsules/` and validated before use.

## Validate a Compact Handoff

```bash
node /absolute/path/to/primecontext/packages/cli/dist/bin.js handoff validate evidence/handoff.json
```

The input must be a repository-local JSON file conforming to the v0.1 Compact Handoff contract. Invalid input returns a non-zero exit status. Validation does not persist or publish the handoff.

## Record and summarize metric evidence

Create a repository-local metric record such as `evidence/arm-b.json`:

```json
{
  "schema_version": "0.1",
  "task_id": "TASK-001",
  "recorded_at": "2026-08-11T15:00:00.000Z",
  "arm": "B",
  "input_tokens": 7000,
  "output_tokens": 2400,
  "tool_calls": 11,
  "file_reads": 9,
  "duration_ms": 150000,
  "selected_context_tokens": 4200,
  "test_status": "PASS",
  "review_status": "PASS",
  "completion_status": "PASS",
  "rework_count": 0,
  "estimated_fields": []
}
```

Record it and inspect the local aggregate:

```bash
node /absolute/path/to/primecontext/packages/cli/dist/bin.js metrics record evidence/arm-b.json
node /absolute/path/to/primecontext/packages/cli/dist/bin.js metrics
```

`metrics record` validates one `MetricRecord` and appends it to `.primecontext/metrics.jsonl`. `metrics` reports record count, numeric totals, and the union of fields marked as estimated. It does not infer quality, causality, or savings from those totals.

`completion_status` is optional because some hosts cannot report it reliably. When it is absent, preserve that as a measurement gap; do not translate absence to PASS or use the record to support a broad completion claim.

Only list a field in `estimated_fields` when its numeric value is present and estimated. Do not fabricate unavailable measurements. Keep explanatory notes and large raw evidence outside the metric record and reference them from a review artifact when needed.

## Compare benchmark arms

```bash
node /absolute/path/to/primecontext/packages/cli/dist/bin.js benchmark \
  --a evidence/arm-a.json \
  --b evidence/arm-b.json
```

Both files must be repository-local validated MetricRecords for the same `task_id`, labeled `A` and `B`. The result reports raw `B - A` deltas, estimate labels, `measurement_gaps` such as absent optional completion evidence, and a conservative quality gate. Follow the [A/B benchmark methodology](benchmark-methodology-v0.1.md); fixture output is never a savings claim.

## Exit behavior and debugging

Successful commands write compact JSON to standard output. Invalid configuration, validation, security, I/O, and benchmark inputs return a non-zero exit status with a concise error. Set `PRIMECONTEXT_DEBUG=1` only during local diagnosis when stack traces are appropriate for the environment.

## Data boundary

PrimeContext runs with the current user's filesystem permissions; it is not an operating-system sandbox. Review input files before recording or validating them. Never place credentials, `.env` content, client data, private dumps, or production secrets in task definitions, handoffs, metric records, examples, or benchmark artifacts.
