# PrimeContext v0.1 security limits and residual risks

This document complements [`SECURITY.md`](../SECURITY.md). It describes what the v0.1 controls establish and what remains the operator's responsibility.

## Security boundary

PrimeContext v0.1 is a local CLI/library running with the current user's operating-system permissions. It is not a sandbox, access-control system, secret scanner, malware scanner, backup tool, or remote security boundary.

The expected operator controls the target repository and explicitly invokes the CLI. Structured external input is still untrusted and must pass size, path, syntax, and contract validation before domain execution.

## Controls implemented by the v0.1 design

- sensitive path classes are blocked before discovery reads;
- `.git`, `node_modules`, generated `.primecontext` state, common credentials/keys, private dumps, and configured exclusions are omitted from mapping;
- symlinks are skipped during discovery;
- repository-relative reads and writes reject traversal outside the target root;
- task identifiers are bounded safe identifiers rather than path fragments;
- Git metadata enrichment is read-only, invoked without a shell, and non-fatal when unavailable;
- generated runtime state stays under the configured repository-local state directory;
- JSON/JSONL inputs and outputs use versioned structural validation;
- no remote telemetry, hosted service, paid dependency, or write-oriented external integration is required.

Optional Git failure is fail-open only for enrichment: mapping may continue without branch/head metadata. Secret blocking, path containment, size limits, and contract validation are fail-closed.

## Residual risks

### Path rules do not inspect every value

Built-in exclusions primarily identify risky paths and file classes. They do not prove that an otherwise allowed source file contains no embedded token, password, PII, or proprietary content. Operators must keep secrets out of repositories and add project-specific excludes where needed.

### Explicit JSON input can contain sensitive prose

Task definitions, handoffs, metric records, and benchmark arms are intentional user inputs. Structural validation does not determine whether free-text fields reveal confidential information. Use sanitized files and review them before recording, sharing, or committing them.

### Local state is not encrypted

`.primecontext/` may contain repository paths, task goals, Git metadata, capsules, maps, and metric evidence. It is ignored by Git by default but is not encrypted. Protect it with operating-system permissions, local retention rules, backups policy, and secure deletion practices appropriate to the repository.

### Git metadata can be absent or stale

When Git is unavailable, the map and capsule may omit branch/head metadata. PrimeContext does not prove that an external index or artifact matches the current worktree. Consumers must inspect the emitted metadata and reject stale evidence when branch identity matters.

### Semantic inference is intentionally shallow

The v0.1 Repo Map infers roles from manifests and conventional directories. It does not understand call graphs, runtime behavior, data flow, or authorization boundaries. Do not use it as blast-radius or security-impact proof.

### Metrics are evidence supplied by the workflow

PrimeContext validates metric structure and marks estimates, but it does not independently attest provider token counts, test truth, review quality, or causal attribution. Keep source evidence and apply the [benchmark methodology](benchmark-methodology-v0.1.md).

### Availability and atomicity are bounded

Local JSON/JSONL is intentionally simple. v0.1 is not a concurrent multi-writer database and does not promise transactional recovery from process interruption, disk exhaustion, or external file modification. Avoid concurrent writers to the same state directory and preserve material evidence before risky operations.

PrimeContext checks every existing path component for symlinks or Windows junctions immediately before repository reads and generated-state writes. Portable Node.js APIs cannot bind every Windows component check and the later operation into one atomic no-follow transaction, so a same-user process able to swap links concurrently may still create a time-of-check/time-of-use race. Do not run PrimeContext with elevated privileges on an adversarial repository; use an operating-system or container boundary when concurrent local mutation is in scope.

### Public release remains gated

No license or security-contact process should be inferred from source availability. Public redistribution, package publication, disclosure of pilot evidence, and security-contact details require explicit human approval. Never put exploit details, credentials, customer data, or MaxSound business data in public issues.

## Operator checklist

Before running PrimeContext on a sensitive repository:

1. review built-in and configured exclusions;
2. confirm the target root and generated state directory;
3. ensure explicit JSON inputs are repository-local and sanitized;
4. run under a least-privileged local account;
5. inspect generated artifacts before sharing or committing anything;
6. keep `.primecontext/`, raw benchmark evidence, logs, and private exports out of Git;
7. stop if a security control fails—do not reinterpret it as optional enrichment.

Report security concerns privately to repository maintainers using an approved private channel. If no private channel is published, request one without disclosing sensitive details publicly.
