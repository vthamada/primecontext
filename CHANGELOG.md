# Changelog

All notable changes intended for a future versioned release will be recorded here. This file does not authorize publication or select a license.

## Unreleased

### Added

- A checked-in CI matrix targeting the minimum Node.js 22.13 runtime and Node.js 24 across Linux and Windows.
- Automated Markdown-link, prohibited-capability, private-package metadata, and workspace-tarball inspection.
- Community bug-report, pull-request, support, and ownership guidance.
- Compact process-JSON context preparation for agent templates, with a linked full receipt retained in ignored local state.
- Explicit progressive budget tiers, run-environment benchmark fields, agent-facing output-token measurement, and truncation reason codes.

### Changed

- Selection now stops after mechanical sufficiency, distinguishes budget from source/provider/excerpt truncation, applies repository policy by scope, and keeps optional-provider authority untrusted.
- Source discovery reuses one accepted observation, optional indexes are freshness/toolchain-bound, and selected physical sources are reread and rehashed before publication.
- The demo asserts deterministic evidence/linkage/cleanup instead of treating parseable JSON as success.

### Security

- Canonical JSON hashing rejects hostile prototypes and oversized structures; public errors redact credential-like details.
- State and SQLite writers fail closed on stale locks, use atomic sibling replacement, and request restrictive POSIX modes without making unsupported Windows ACL claims.
- TypeScript CodeGraph bindings are exact accepted-source manifests and fail closed on missing, changed, newly blocked, or omitted sources.

## Historical development snapshots

The v0.1 foundations, v0.2 Document Catalog, and v0.3 Proof-Carrying Context Compiler were implemented as pre-release development slices. Their point-in-time verification records are under [`docs/verification`](docs/verification/); they are not release notes or package-publication evidence.
