# PrimeContext Agent Instructions

## Product boundary

PrimeContext is context-engineering infrastructure, not a coding agent, SaaS platform, project manager, vector database, or MaxSound-specific application.

## Active implementation scope

The v0.1 foundations remain the compatibility baseline.

The only authorized v0.2 slice is defined in:

- `docs/specification/document-retrieval-specification-v0.2.md`;
- `docs/architecture/v0.2-document-retrieval-architecture.md`.

This slice is limited to a local Markdown Document Catalog and bounded, deterministic local lexical search with source authority, provenance, freshness checks, security exclusions, tests, and CLI documentation.

Do not introduce MCP, any CodeGraph integration, embeddings, vector databases, SQLite/FTS, hosted services, web UI, Context Scout, general context ranking or pruning, automatic multi-agent orchestration, AI-generated summaries, snapshots, adaptive memory, or remote telemetry in this slice.

Preserve every v0.1 contract and behavior. Keep Document Catalog and lexical retrieval as modules inside the existing package boundaries until an ADR demonstrates that another package or storage engine is justified.

## Engineering rules

- Preserve dependency direction: schemas -> core -> adapters/repo-map/benchmark -> cli.
- Core must not import concrete filesystem, Git, CLI, MaxSound, or vendor-specific logic.
- Validate external structured input before core execution.
- Block secrets before reads.
- Prefer deterministic behavior and JSON/JSONL artifacts.
- Add a test before changing behavior.
- Do not claim token savings without benchmark evidence and quality parity.
- Keep concepts as modules until package boundaries are proven.

## Verification

Before handoff:

```bash
npm run typecheck
npm test
npm run build
```
