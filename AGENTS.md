# PrimeContext Agent Instructions

## Product boundary

PrimeContext is context-engineering infrastructure, not a coding agent, SaaS platform, project manager, vector database, or MaxSound-specific application.

## v0.1 scope

Implement only the foundations defined in `docs/specification/product-architecture-specification-v0.1.md` and `docs/architecture/v0.1-implementation-architecture.md`.

Do not introduce MCP, CodeGraph as a hard dependency, embeddings, vector databases, hosted services, web UI, automatic multi-agent orchestration, or adaptive memory into v0.1.

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
