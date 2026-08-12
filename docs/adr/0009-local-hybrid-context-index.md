# ADR-0009: Add an optional local hybrid context index

**Status:** Accepted
**Date:** 2026-08-12
**Scope:** Proof-Carrying Context Compiler v0.3 only

## Context

ADR-0004 selected JSON/JSONL before SQLite for v0.1. ADR-0008 selected a
metadata-only JSON catalog and live Markdown search for v0.2 because that
bounded document corpus did not justify persisted content or a search engine.
Those decisions remain correct for their scopes.

The v0.3 compiler has a different query requirement: it must federate bounded
document, source-code, test, configuration, repository-map, and history
candidates; support deterministic progressive discovery; and produce a receipt
for every considered candidate. Re-reading and linearly scoring the complete
mixed corpus for each expansion would make the executable vertical slice less
representative and would not exercise the explicit local retrieval/index trust
boundary that the product must eventually govern.

TypeScript symbol/import/direct-call facts can improve candidate discovery for
code tasks, but cannot prove complete blast radius or correctness and must not
become a Core dependency.

Persisting screened source text increases local disclosure and remanence risk.
It therefore requires a separate store, full-rebuild freshness, secure-delete
controls, strict containment, and a usable non-indexed fallback.

## Decision

Add an **optional**, repository-local SQLite/FTS5 context index at
`<state_dir>/context/index.sqlite` and an **optional** TypeScript CodeGraph
adapter within `@primecontext/adapters`.

The hybrid index:

- is an additive v0.3 store and is never read by v0.2 `docs search`;
- contains only safely discovered and screened repository sources;
- binds all rows and graph facts to source hashes and one canonical worktree
  manifest digest;
- is rebuilt in full into an exclusive sibling database and published only
  after validation; incremental mutation is not authorized;
- enables SQLite `secure_delete=ON` and FTS5 `secure-delete=1` when supported,
  records support state, and never loads a dynamic extension;
- accepts no SQL or FTS syntax from the user; normalized literal terms and
  bound values are the only query inputs;
- is replaceable behind a Core `ContextSource` port and never supplies Core
  policy, mandatory status, final score, or authority;
- fails open to safe filesystem/document/Repo Map/Git candidate discovery when
  the optional capability is missing, stale, corrupt, locked, timed out, or
  over its source-local limit;
- fails closed when safe collection, containment, content screening, or source
  freshness cannot be established.

The TypeScript CodeGraph:

- uses the local TypeScript compiler API without executing source;
- emits only bounded evidence-backed declaration, import/export, containment,
  test-association, and syntactically resolvable direct-call facts;
- preserves diagnostics, unknowns, truncation, file hashes, and worktree
  freshness;
- is never the sole evidence of callers, tests, security, completeness, or
  blast radius;
- remains optional and cannot remove the non-graph fallback.

No new physical package is created. Core imports neither SQLite nor TypeScript.

## Consequences

### Positive

- The compiler can discover across mixed local sources and progressive queries
  while preserving deterministic Core policy.
- FTS and CodeGraph are exercised as competing evidence sources rather than
  hard product foundations.
- Full manifest comparison and selected-source rereads make stale indexed
  content unusable.
- A receipt can show whether optional capabilities contributed, failed, or
  truncated without hiding fallback behavior.

### Costs and risks

- The SQLite database duplicates screened repository text and therefore has a
  larger confidentiality footprint than the v0.2 metadata-only catalog.
- Building the index consumes CPU, memory, disk, and parser work; exact ceilings
  and a monotonic cooperative deadline are mandatory. That deadline is not a
  hard operating-system CPU quota; adversarial repositories require process or
  container isolation.
- Secure-delete controls do not guarantee elimination from SSDs, filesystem
  snapshots, journals, backups, crash files, or previously copied databases.
- TypeScript static analysis is incomplete for dynamic dispatch, runtime module
  loading, generated code, ambiguous aliases, and unsupported syntax.
- Full rebuild favors simple, auditable freshness over incremental performance.
- One writer per state directory remains the supported concurrency model.

## Compatibility

This ADR supersedes ADR-0004 and ADR-0008 **only for the additive v0.3 hybrid
context index**. It does not change their decisions for v0.1 state or v0.2
Document Catalog/live search. Existing schemas, catalog files, and commands
remain byte/behavior compatible.

## Rejected alternatives

### Make SQLite the canonical source

Rejected. Repository files and their safely observed hashes remain canonical;
a stale/corrupt index cannot be trusted over live source evidence.

### Replace v0.2 document search with FTS

Rejected. It would silently change a validated metadata-only privacy and
freshness contract.

### Put SQLite or TypeScript in Core

Rejected. It reverses dependency direction, couples policy to implementations,
and makes fallback or replacement harder.

### Incrementally update the index

Rejected for this slice. Deletion, newly blocked content, manifest consistency,
crash recovery, and remanence become harder to prove. Reconsider only with a
separate migration/transaction specification and measured need.

### Require CodeGraph

Rejected. Static graph coverage is language- and syntax-dependent and cannot
be the sole path to a usable compiler.

### Add embeddings, a vector database, or a hosted service

Rejected for v0.3. They add learned/non-deterministic policy, network/privacy,
dependency, evaluation, and operational questions outside this gate.

## Evidence required before reconsideration

Incremental indexing, another storage engine, a new package, or learned/remote
retrieval requires measured corpus/latency pressure, privacy and threat review,
freshness/migration/rollback design, fallback evidence, a new ADR, and an
explicit scope change.
