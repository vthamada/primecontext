# Security Policy

PrimeContext handles repository context and must default to non-disclosure of sensitive local data.

## v0.1 security invariants

PrimeContext must not index or expose `.env` files, API keys, tokens, passwords, credentials, private dumps/backups, cookies, client PII, or private uploads. Built-in discovery also skips symlinks, Windows junctions/reparse-point links, `.git`, `node_modules`, and PrimeContext's generated state.

Sensitive-path checks happen before content reads. Task identifiers use a bounded portable grammar. Repository reads and generated-state writes reject lexical traversal and inspect every existing path component for links before use.

Structured CLI input is bounded to 1 MiB and 64 levels/100,000 JSON values. Metrics state is bounded to 8 MiB and 10,000 records. Discovery stops at 100,000 entries, depth 64, or 1,024 configured exclusions. Git is read-only metadata enrichment, is invoked without a shell, and is bounded to 5 seconds and 64 KiB of output.

## v0.2 document retrieval invariants

Document retrieval catalogs only bounded Markdown below `docs/` and canonical root documentation. Sources are read through stable bounded handles, decoded as strict UTF-8, and checked for high-confidence private keys, credentials, authorization tokens, labelled PII, and checksum-valid labelled CPF/CNPJ before metadata is accepted. A blocked document is omitted without emitting its path or matched value.

The catalog contains metadata and SHA-256 hashes only. It is treated as untrusted local input and is limited to 8 MiB/500,000 JSON values. Search validates the query before I/O, recollects the permitted live corpus, and requires canonical digest, accepted-source hashes, and candidate/omitted counts to match before returning a bounded excerpt. Catalog writes use an exclusively created sibling temporary file, `fsync`, close, path revalidation, and same-directory replacement.

Retrieval ceilings are 4,096 eligible Markdown candidates per collection, 512 KiB per candidate, 64 MiB of cumulative bounded bytes read from non-oversize candidates, 1,024 UTF-8 query bytes/32 terms, 50 hits, and 400 Unicode code points/six lines per excerpt. Accepted catalog entries and source bytes cannot exceed the corresponding candidate limits.

## v0.3 Proof-Carrying Context Compiler invariants

The additive v0.3 compiler treats repository content, persisted state, SQLite
rows, and CodeGraph facts as untrusted data. Adapters cannot make a candidate
mandatory, provide a final relevance score, alter Core policy, or authorize an
action. Every prompt-facing item retains a repository-relative locator,
source/excerpt hashes, authority evidence, provider, and worktree freshness.
The compiler emits explicit missing, conflict, truncation, and source-failure
status rather than treating absence as evidence.

The optional hybrid index is separate from the v0.2 metadata-only Document
Catalog. It may persist screened Markdown/code text only below
`<state_dir>/context/index.sqlite`. It is rebuilt in full through a contained
exclusive sibling database, binds rows to the complete accepted-source manifest
digest, enables supported SQLite/FTS secure-delete controls, loads no extension,
and accepts no raw SQL/FTS syntax. A selected indexed source is safely reread
and rehashed before publication. Missing, stale, corrupt, locked, or unsupported
optional capabilities use safe filesystem/document fallback; containment,
screening, or global freshness failure is fail-closed.

The optional TypeScript CodeGraph parses accepted local source without
executing it. It is bounded, bound to file/worktree hashes, preserves
diagnostics and unresolved edges, and is never sole evidence of callers, tests,
blast radius, security, or correctness.

Context requests, envelopes, receipts, expansion/outcome ledgers, experiments,
indexes, temporary files, and logs remain ignored private local state. Reads
validate version, structure, digests, paths, limits, freshness, and cross-record
linkage. Progressive expansion is monotonic and idempotent under the same
snapshot; replay reports drift; ablation is explicitly experimental; outcomes
are declarations and never causal conclusions. No v0.3 path executes tools,
writes a repository/external system, uses a network, or emits telemetry.
All v0.3 context commands refuse to collect or access this state unless the
configured state directory has the exact repository-root `.gitignore` entry
created by `primecontext init`; `doctor` checks the same invariant without
repairing it implicitly.

The principal v0.3 ceilings are 1 MiB/100,000 JSON values/depth 64 per
structured input, 16,384 indexed sources, 256 MiB index input, a 512 MiB local
database, 2,048 considered/128 selected candidates, 32 KiB/400 lines per
excerpt, 8 MiB per envelope/receipt, and a 30-second cooperative deadline per
optional adapter. This deadline is checked at bounded in-process checkpoints;
it is not an operating-system-enforced CPU limit. See
the [v0.3 security and threat-model record](docs/security-and-residual-risks-v0.3.md)
for the complete data flow, controls, and limits.

The agent-neutral process interface accepts standard input only when `--from
-` is explicit. It reads incrementally to the same 1 MiB ceiling, requires
strict UTF-8 and one structurally bounded JSON value, then applies the same
versioned validators used for repository files. Successful commands reserve
stdout for one JSON result; failures reserve stderr for one sanitized JSON
error. Capability discovery, diagnostics, demos, and agent templates add no
network, host SDK, model execution, or authorization surface.

## Residual local risk

PrimeContext performs link and identity checks immediately around filesystem operations, but portable Node.js APIs cannot bind every Windows path-component check and subsequent operation into one atomic no-follow transaction. A same-user process that can mutate repository links concurrently may still create a time-of-check/time-of-use race. The sensitive-content detector is conservative rather than complete DLP; accepted prose and stdout excerpts can still contain confidential material. Local `.primecontext` state is neither encrypted nor a sandbox. SQLite secure-delete controls and file deletion cannot guarantee removal from physical media, snapshots, journals, SSDs, backups, or copies. Static CodeGraph results can be incomplete. One writer per context state directory is supported, without a universal directory-`fsync` or power-loss guarantee. Do not run PrimeContext with elevated privileges on an untrusted repository, and isolate adversarial repositories at the operating-system or container boundary. See the [v0.2 retrieval risk record](docs/security-and-residual-risks-v0.2.md) and [v0.3 threat-model record](docs/security-and-residual-risks-v0.3.md).

## Reporting

Do not include secrets, credentials, private customer data, or exploit material in public issue bodies. Until a public security-contact process is established, keep security reports private to the repository maintainers.

## Telemetry

PrimeContext does not implement remote telemetry in the current scope.
