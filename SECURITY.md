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

## Residual local risk

PrimeContext performs link and identity checks immediately around filesystem operations, but portable Node.js APIs cannot bind every Windows path-component check and subsequent operation into one atomic no-follow transaction. A same-user process that can mutate repository links concurrently may still create a time-of-check/time-of-use race. The sensitive-content detector is conservative rather than complete DLP; accepted prose and stdout excerpts can still contain confidential material. Local `.primecontext` state is neither encrypted nor a sandbox. Do not run PrimeContext with elevated privileges on an untrusted repository, and isolate adversarial repositories at the operating-system or container boundary. See the [v0.2 retrieval risk record](docs/security-and-residual-risks-v0.2.md).

## Reporting

Do not include secrets, credentials, private customer data, or exploit material in public issue bodies. Until a public security-contact process is established, keep security reports private to the repository maintainers.

## Telemetry

PrimeContext does not implement remote telemetry in the current scope.
