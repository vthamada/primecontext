# PrimeContext documentation

This directory is the canonical home for PrimeContext product, architecture, decision, operating, and verification documents.

## Canonical references

Precedence is scoped rather than based only on version number. Use these references in this order when they differ:

1. [`AGENTS.md`](../AGENTS.md) — repository-wide contributor instructions and the currently authorized product boundary.
2. The applicable accepted specification: [v0.1 baseline](specification/product-architecture-specification-v0.1.md) for foundations, [v0.2 Document Retrieval](specification/document-retrieval-specification-v0.2.md) for the first retrieval slice, [v0.3 Proof-Carrying Context Compiler](specification/proof-carrying-context-compiler-specification-v0.3.md) for the compiler, the additive [v0.3 Agent Usability Extension](specification/agent-usability-extension-v0.3.md) for local process interoperability, or the [v0.3 consolidation specification](specification/v0.3-consolidation-specification.md) for compatibility-preserving hardening.
3. The architecture for that scope: [v0.1 Foundations](architecture/v0.1-implementation-architecture.md), [v0.2 Document Retrieval](architecture/v0.2-document-retrieval-architecture.md), or [v0.3 Proof-Carrying Context Compiler](architecture/v0.3-proof-carrying-context-compiler-architecture.md).
4. [Accepted ADRs](adr/) within their stated scope, including [ADR-0008](adr/0008-json-metadata-catalog-and-live-lexical-search.md) for v0.2 retrieval and [ADR-0009](adr/0009-local-hybrid-context-index.md) for the optional v0.3 hybrid index.
5. Operating and security guides for the applicable scope.
6. Plans, such as the [v0.1 Foundations plan](superpowers/plans/2026-08-11-v0.1-foundations.md), as historical implementation sequences rather than current norms.
7. Verification records — [v0.1](verification/v0.1-foundations-verification.md), [v0.2](verification/v0.2-document-retrieval-verification.md), [v0.3 compiler](verification/v0.3-proof-carrying-context-compiler-verification.md), [v0.3 adoption](verification/v0.3-agent-usability-extension-verification.md), and [v0.3 consolidation](verification/v0.3-consolidation-verification.md) — as point-in-time evidence, never as normative requirements.

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

## Authorized v0.3 compiler slice

- [Proof-Carrying Context Compiler specification](specification/proof-carrying-context-compiler-specification-v0.3.md)
- [Proof-Carrying Context Compiler architecture](architecture/v0.3-proof-carrying-context-compiler-architecture.md)
- [ADR-0009: Optional local hybrid context index](adr/0009-local-hybrid-context-index.md)
- [Compiler CLI usage](cli-usage-v0.3.md)
- [Compiler security, threat model, and residual risks](security-and-residual-risks-v0.3.md)
- [Compiler implementation verification](verification/v0.3-proof-carrying-context-compiler-verification.md)
- [Agent Usability Extension specification](specification/agent-usability-extension-v0.3.md)
- [Zero-Configuration Automation Extension specification](specification/zero-config-automation-extension-v0.3.md)
- [Generic/Codex/Claude Code integration guide](agent-integration-v0.3.md)
- [Agent Usability Extension verification](verification/v0.3-agent-usability-extension-verification.md)
- [Zero-Configuration Automation verification](verification/v0.3-zero-config-automation-verification.md)
- [v0.3 consolidation specification](specification/v0.3-consolidation-specification.md)
- [v0.3 consolidation local verification](verification/v0.3-consolidation-verification.md)
- [v0.3 consolidation audit-resolution matrix](verification/v0.3-consolidation-audit-resolution.md)
- [Release-candidate process](release-process.md)
- [Compatibility and deprecation policy](compatibility-policy.md)

The earlier slice records are historical point-in-time evidence. The v0.3
consolidation record is working-tree evidence: only its explicit command rows
support a point-in-time local result. It does not establish Linux, an immutable
commit, remote CI, advisory or independent final-scan attestations. Release,
benchmark, causality, superiority, licensing, and publication remain separate
human/evidence gates.

## Future planning, not implementation authorization

- [Post-v0.2 evolution specification](specification/post-v0.2-evolution-specification.md) — classifies the broader candidate v0.3-v0.6 work, optional integrations, v1.0 readiness requirements, and human release gates. Only the separately specified proof-carrying compiler vertical slice has crossed an implementation scope gate.
- [Code-intelligence providers in v0.3](code-intelligence-providers-v0.3.md) — distinguishes the implemented internal TypeScript/JavaScript structural graph from the third-party `colbymchenry/codegraph` project and records the gates for a possible optional v0.4 SDK adapter.
- [Local Knowledge Vault Integration Proposal](specification/local-knowledge-vault-integration-proposal.md) — **PROPOSAL / NOT AUTHORIZED** for an explicit, read-only external Markdown vault adapter and optional Obsidian `open` URI handoff.

## Release governance

- [ADR-0007: Defer the public-license choice to a human legal/release gate](adr/0007-defer-public-license-selection.md)
- [`CODE_OF_CONDUCT.md`](../CODE_OF_CONDUCT.md)
- [`SECURITY.md`](../SECURITY.md)

PrimeContext remains local-first infrastructure. The additive v0.3 gate
authorizes deterministic proof-carrying context compilation and optional local
SQLite/FTS and TypeScript CodeGraph adapters under the exact v0.3 limits. It
does not authorize MCP, embeddings, vector databases, learned ranking, network
or hosted services, telemetry, automatic orchestration, coding-agent behavior,
or publication before the applicable human gates are complete.
