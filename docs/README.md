# PrimeContext documentation

This directory is the canonical home for PrimeContext product, architecture, decision, operating, and verification documents.

## Canonical references

Precedence is scoped rather than based only on version number. Use these references in this order when they differ:

1. [`AGENTS.md`](../AGENTS.md) — repository-wide contributor instructions and the currently authorized product boundary.
2. The applicable accepted specification: [v0.1 baseline](specification/product-architecture-specification-v0.1.md) for foundations, or [v0.2 Document Retrieval](specification/document-retrieval-specification-v0.2.md) for the first retrieval slice.
3. The architecture for that scope: [v0.1 Foundations](architecture/v0.1-implementation-architecture.md) or [v0.2 Document Retrieval](architecture/v0.2-document-retrieval-architecture.md).
4. [Accepted ADRs](adr/) within their stated scope, including [ADR-0008](adr/0008-json-metadata-catalog-and-live-lexical-search.md) for retrieval.
5. Operating and security guides for the applicable scope.
6. Plans, such as the [v0.1 Foundations plan](superpowers/plans/2026-08-11-v0.1-foundations.md), as historical implementation sequences rather than current norms.
7. Verification records — [v0.1](verification/v0.1-foundations-verification.md) and [v0.2](verification/v0.2-document-retrieval-verification.md) — as point-in-time evidence, never as normative requirements.

Root-level copies of architecture or plan documents are transport artifacts, not canonical editing targets.

## v0.1 operating guides

- [CLI installation and usage](cli-usage-v0.1.md)
- [Conservative A/B benchmark methodology](benchmark-methodology-v0.1.md)
- [Roadmap and phase gates](roadmap.md)
- [Security limits and residual risks](security-and-residual-risks-v0.1.md)

## First v0.2 retrieval slice

- [Document retrieval CLI usage](cli-usage-v0.2.md)
- [Document retrieval security limits and residual risks](security-and-residual-risks-v0.2.md)
- [Document retrieval verification](verification/v0.2-document-retrieval-verification.md)

## Future planning, not implementation authorization

- [Post-v0.2 evolution specification](specification/post-v0.2-evolution-specification.md) — classifies and sequences candidate v0.3-v0.6 work, optional integrations, v1.0 readiness requirements, and human release gates. Each implementation slice still requires separate approval and an `AGENTS.md` scope change.

## Release governance

- [ADR-0007: Defer the public-license choice to a human legal/release gate](adr/0007-defer-public-license-selection.md)
- [`CODE_OF_CONDUCT.md`](../CODE_OF_CONDUCT.md)
- [`SECURITY.md`](../SECURITY.md)

PrimeContext remains local-first infrastructure. The approved v0.2 scope is limited to the metadata-only Markdown catalog and live deterministic lexical search. It does not authorize SQLite/FTS, Context Scout, general ranking/pruning, MCP, embeddings, vector databases, CodeGraph, hosted services, automatic orchestration, or publication before the applicable human gates are complete.
