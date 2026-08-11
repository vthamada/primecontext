# Security Policy

PrimeContext handles repository context and must default to non-disclosure of sensitive local data.

## v0.1 security invariants

PrimeContext must not index or expose `.env` files, API keys, passwords, credentials, private dumps, cookies, client PII, or private uploads. Built-in discovery also skips symlinks, `.git`, `node_modules`, and PrimeContext's generated state.

Sensitive-path checks happen before content reads. Path traversal outside the repository root is rejected.

Git is read-only metadata enrichment in v0.1 and is invoked without a shell.

## Reporting

Do not include secrets, credentials, private customer data, or exploit material in public issue bodies. Until a public security-contact process is established, keep security reports private to the repository maintainers.

## Telemetry

v0.1 has no remote telemetry by default.
