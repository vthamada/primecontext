# PrimeContext roadmap and phase gates

This roadmap separates implementation phases. It is not authorization to pull later capabilities into v0.1.

## v0.1 — Foundations

v0.1 proves the smallest local, deterministic, agent-agnostic vertical slice:

- versioned JSON contracts and boundary validation;
- Context Budget policy with configurable experimental defaults;
- Task Capsule creation and validation;
- Compact Handoff validation;
- safe filesystem discovery and optional Git metadata;
- deterministic Semantic Repo Map roles and evidence;
- JSON/JSONL local state;
- CLI workflows for init, map, task, inspect, handoff validation, metric recording/summary, and fixture-based A/B comparison;
- security exclusions, examples, and operating documentation.

v0.1 is stable only after a clean install, typecheck, tests, build, sample-repository smoke flow, security checks, contract fixtures, and benchmark fixture comparison pass against one identified commit. A sanitized MaxSound-style fixture establishes pilot readiness; it is not evidence of a real production pilot.

Not part of v0.1:

- Document Catalog or retrieval;
- Context Scout, ranking, or pruning;
- CodeGraph/AST intelligence;
- MCP;
- embeddings, vector databases, hosted services, or web UI;
- automatic multi-agent orchestration;
- snapshots, artifact storage, or adaptive memory.

## Pilot gate — real reference use

After v0.1 is stable, run PrimeContext against an authorized private reference repository under explicit human authorization. Keep repository identity, credentials, customer information, business data, private uploads, and production artifacts out of Core, examples, metrics, Git, and public reports unless a separate disclosure decision approves a specific sanitized statement.

The pilot should test whether the generic contracts are usable and identify missing context. It must not introduce MaxSound-specific rules into Core. Publish only sanitized findings approved for disclosure.

## Benchmark gate — initial controlled A/B evidence

After the stable foundations and pilot-readiness gates, run controlled Arm A/Arm B tasks using the [conservative benchmark methodology](benchmark-methodology-v0.1.md). Raw deltas and quality outcomes inform later design; they do not automatically authorize efficiency claims.

## v0.2 — Authorized first retrieval slice

A separately approved scope gate authorized one narrow v0.2 slice after its [specification](specification/document-retrieval-specification-v0.2.md), acceptance criteria, [architecture](architecture/v0.2-document-retrieval-architecture.md), and [ADR](adr/0008-json-metadata-catalog-and-live-lexical-search.md) were written. This targeted authorization does not claim that a broader pilot or benchmark gate has been satisfied.

Implemented and subject to the current [verification record](verification/v0.2-document-retrieval-verification.md):

- a bounded JSON Document Catalog containing metadata and hashes, never source bodies or a lexical index;
- safe Markdown collection with deterministic authority/module/topic path metadata;
- live source recollection, canonical digest/hash freshness, and stale-catalog failure;
- deterministic local lexical matching, filters, scoring, excerpts, and catalog-wide potential same-normalized-title/different-hash reporting;
- `docs index` and `docs search` while preserving v0.1 configuration and commands.

The slice deliberately uses existing packages and portable Node APIs. It adds no new external runtime dependency or service.

Still deferred behind a new specification and explicit authorization:

- SQLite or native FTS;
- Context Scout candidate discovery;
- general ranking, pruning, or context selection;
- any CodeGraph/AST adapter;
- MCP, embeddings, vectors, semantic search, RAG, hosted services, or web UI;
- automatic Task Capsule integration, orchestration, snapshots, or memory.

CodeGraph must remain optional if a future gate authorizes it. No retrieval result supports a token-savings or quality-superiority claim without separate A/B evidence.

## Later direction, not current scope

The [post-v0.2 evolution specification](specification/post-v0.2-evolution-specification.md) inventories the complete candidate path, dependencies, optional tracks, v1.0 outcome gates, and human decisions. It is a planning baseline and does not authorize production changes.

Potential later phases remain subject to separately approved executable specifications and evidence:

- v0.3: progressive disclosure runtime, pruning, artifact store, output filtering, and delta context;
- v0.4: expanded observability, benchmark reporting, and quality analysis;
- v0.5: integration surfaces such as a thin MCP adapter and generic agent examples;
- v0.6: selective experience retrieval without global memory dumps.

No phase begins merely because an attachment point exists in v0.1 code.

## Human release gates

Public release additionally requires human decisions on licensing, naming, disclosure, security reporting, and benchmark claims. See [ADR-0007](adr/0007-defer-public-license-selection.md). Automated agents may prepare evidence and drafts but may not independently cross these gates.
