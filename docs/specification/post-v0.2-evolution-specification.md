# PrimeContext Post-v0.2 Evolution Specification

**Status:** Planning baseline; not approved implementation scope
**Date:** 2026-08-12
**Covers:** Candidate phases v0.3 through v0.6 and the v1.0 readiness gates

## 1. Purpose and authorization boundary

This document inventories and orders the product work that remains after the v0.1 foundations and the first v0.2 Document Catalog and lexical-retrieval slice. It is a master planning specification, not authorization to implement every listed capability as one change.

The repository-wide `AGENTS.md` remains the implementation authority. Before work begins on any phase below, that phase requires:

- a separately approved, bounded implementation specification;
- an architecture and data/trust-flow description;
- versioned contracts and exact resource ceilings where structured data crosses a boundary;
- acceptance criteria and a requirement-to-evidence plan;
- explicit scope authorization in `AGENTS.md`;
- an ADR when storage, package, dependency, compatibility, or integration policy changes.

Human release decisions remain independent gates. This document does not choose a license, public name, security contact, package publication policy, external claim, or release date.

## 2. Verified baseline

The compatibility baseline consists of:

- v0.1 contracts and workflows for configuration, Context Budget, Task Capsule, Compact Handoff, Semantic Repo Map, metrics, benchmark comparison, filesystem/Git adapters, and CLI commands;
- the v0.2 metadata-only Markdown Document Catalog and bounded live deterministic lexical search;
- local JSON/JSONL state, strict external-input validation, sensitive-path/content exclusion, source provenance, freshness checks, and bounded I/O;
- the dependency direction `schemas -> core -> adapters/repo-map/benchmark -> cli`.

Every later phase must preserve the public v0.1 contracts and behavior and must either preserve v0.2 contracts or introduce an explicit migration while continuing to validate the old version. Existing versioned contract files are immutable compatibility artifacts.

## 3. Classification of remaining work

Remaining work is classified so that "finish the project" does not silently turn optional infrastructure into a hard dependency.

### 3.1 Planned candidate phases

These capabilities express the intended product direction, but each remains behind its own implementation gate:

1. context discovery, selection, pruning, budgets, and progressive disclosure;
2. external artifacts, filtered outputs, and baseline deltas;
3. expanded local observability, reproducible benchmark execution, and quality analysis;
4. optional integration surfaces and read-only snapshots;
5. selective validated experience retrieval.

### 3.2 Conditional capabilities

The following are not required dependencies and may be added only after evidence and a separate decision:

- CodeGraph or another AST/symbol-intelligence adapter;
- SQLite or native FTS for a measured corpus/latency problem;
- a thin MCP adapter;
- external-system adapters and snapshots;
- corpus formats beyond the approved Markdown boundary;
- a new physical package boundary;
- a generic JSON Schema engine or generated runtime types;
- embeddings, semantic search, or another learned retrieval stage.

CodeGraph must remain optional. SQLite/FTS requires measured need and an ADR superseding ADR-0008. Embeddings, a vector store, hosted RAG, or paid services are not default completion requirements.

### 3.3 Explicit non-goals

PrimeContext must not become a coding agent, IDE, SaaS platform, project manager, general LLM framework, vector database, replacement for Git/MCP/code search, unlimited-memory system, or cloud orchestration platform. Core must contain no MaxSound, vendor, model, host, or remote-service business logic.

## 4. Target dependency flow

The planned runtime flow is:

```text
Task + accepted policies + Context Budget
        |
        v
Document Catalog + Repo Map + optional ContextSource adapters
        |
        v
Context Scout -> explainable rank/filter -> Context Pruner
        |
        v
Context Selection -> Task Capsule linkage
        |
        v
bounded expansion requests through the Context Broker
        |
        v
compact handoff + private external artifacts + local evidence
```

The architectural constraints are:

- schemas own boundary shapes and validators;
- Core owns pure deterministic policy, selection, scoring, pruning, budgeting, conflict handling, and state-transition rules;
- adapters own filesystem, Git, optional code intelligence, snapshot, and external-system I/O;
- repo-map remains repository-structure analysis rather than a general retrieval engine;
- benchmark owns experiment comparison, never domain selection policy;
- CLI and optional integration surfaces orchestrate validated services and do not duplicate Core rules;
- current package boundaries remain until an ADR demonstrates separate lifecycle or dependency pressure.

## 5. Phase v0.3 — context selection runtime

v0.3 should be delivered as at least two independently reviewable slices.

### 5.1 Slice A — Context Scout and deterministic selection

#### Outcome

Given a validated task and repository snapshot, PrimeContext discovers bounded context candidates, explains why each candidate was considered, selects a deterministic set within a Context Budget, and links the selection to a Task Capsule. The implementation agent receives the selected result, not raw exploration history.

#### Required domain contracts

The slice must define versioned contracts for at least:

- `SourceReference`: source kind, stable reference, authority, provenance, freshness evidence, and repository/worktree identity;
- `ContextCandidate`: stable ID, kind, source reference, bounded locator/range, estimated size, and discovery evidence;
- `ScoutRequest` and `ScoutResult`: task linkage, active budgets, source outcomes, omissions, and truncation reasons;
- `RankDecision`: integer score components and evidence, with no opaque learned score;
- `PruneDecision`: kept/dropped status and stable reason code;
- `ContextSelection`: selected candidates, total estimated/actual size, conflicts, mandatory items, and budget status;
- Task Capsule linkage to the selection and its source snapshot.

All collections must have exact byte, count, depth, term, range, duration, and output ceilings in the executable slice specification.

#### Selection invariants

- Results are deterministic for the same validated task, configuration, source snapshot, and adapter outcomes.
- Policy, explicit acceptance criteria, security constraints, and required contracts cannot be silently pruned.
- Authority conflicts are reported and never resolved by generated material.
- Every selected item retains source provenance and freshness evidence.
- Missing or truncated evidence is explicit; absence is not scored as zero evidence.
- Optional adapter failure cannot remove filesystem/Git/document fallback, but security-control failure is fail-closed.
- Symbol- or line-range pruning is allowed only when the adapter can prove a stable locator and correctness-preserving boundary; otherwise use the enclosing file/document.
- No token-savings or quality claim is implied by a smaller selection.

#### Proposed CLI surface

The exact syntax must be frozen in the slice specification. The intended user outcome is equivalent to:

```text
primecontext context plan <task-id>
primecontext context inspect <selection-id>
```

Commands must emit bounded structured JSON, store no raw exploration transcript, and preserve all existing CLI behavior.

#### Exit criteria

- physical and runtime contracts agree and package correctly;
- selection is deterministic under ties, source failure, Unicode, and different filesystem enumeration orders;
- regressions cover mandatory-item retention, authority conflicts, stale sources, hostile paths, sensitive content, malformed adapters, and all hard limits;
- a disposable `init -> map -> docs index -> task -> context plan -> inspect` flow passes;
- independent review covers selection correctness and security.

### 5.2 Slice B — Context Broker and progressive disclosure

#### Outcome

A consumer starts with bounded orientation context and can request additional context only for a stated missing-evidence reason. The broker validates each expansion against source safety, freshness, prior selections, and remaining budget.

#### Required contracts

- `ExpansionRequest`: task/selection linkage, requested evidence, reason, and consumer-known baseline;
- `ExpansionDecision`: allow/deny/partial status, stable reason codes, selected additions, budget delta, and new selection digest;
- `ContextSessionSummary`: bounded state required to continue without retaining a full transcript.

#### Broker invariants

- no preemptive unlimited loading;
- monotonic accounting of budget and selected IDs;
- idempotent replay for the same request and source snapshot;
- duplicate content does not consume the budget twice;
- stale, changed, or newly blocked sources require recollection or denial;
- an over-budget request fails or returns a documented partial result; it never silently exceeds the hard limit;
- the broker does not execute code, tools, or external writes.

#### Exit criteria

- deterministic request/decision replay and digest tests;
- concurrency/single-writer policy documented and tested;
- stale/tampered/replayed request tests;
- budget exhaustion, partial failure, rollback, and non-disclosure tests;
- evidence that the fallback workflow remains usable without the broker.

### 5.3 Slice C — artifacts, output filtering, and delta context

#### Outcome

Large local outputs remain outside model context. Consumers receive a compact, validated result and a repository-local private reference. Context can be expressed as a bounded delta from a known baseline.

#### Required contracts and services

- `ArtifactReference` and `ArtifactManifest`: ID, type, size, hash, creation time, producer, task linkage, sensitivity classification, retention state, and provenance;
- `FilteredOutput`: source tool, aggregate fields, omissions/truncation, artifact reference, and filter policy version;
- `DeltaContext`: baseline identity, head identity, changed decisions/contracts/code references, deletions, freshness, and truncation status.

#### Storage and safety rules

- artifacts live only under the configured ignored state directory by default;
- no artifact is Git-eligible unless an explicit sanitized export flow says so;
- filenames and IDs use portable bounded grammars and never become arbitrary paths;
- writes use contained, bounded, durable replacement with a declared single-writer policy;
- stored content is hashed, size-bounded, classified, and subject to retention/deletion;
- filtered output cannot claim completeness when data was omitted;
- secret/PII detection runs before persistence and before display, while remaining documented as incomplete DLP;
- delta baselines must identify the exact worktree/commit or artifact digest; stale main cannot represent a divergent worktree.

#### Exit criteria

- previous valid state survives all defined failures before successful replacement;
- artifact tamper, stale baseline, traversal, link/junction, oversize, binary, invalid UTF-8, and secret-disclosure tests pass;
- compact output has an explicit size reduction measurement without a product-performance claim;
- deletion and retention behavior is tested and documented.

## 6. Phase v0.4 — observability and benchmark evidence

### 6.1 Outcome

PrimeContext records bounded, privacy-safe local execution evidence and can run reproducible controlled comparisons. It reports raw deltas and quality outcomes without turning metrics into causal or marketing claims.

### 6.2 Required capabilities

- versioned local execution-event and benchmark-run manifests;
- correlation among task, selection, expansion, artifact, handoff, and metric records;
- measurements for available input/cached/output tokens, tool calls, file reads, optional CodeGraph calls, context expansions, duration, selected context size, tests, review, completion, and rework;
- explicit `observed`, `estimated`, `unavailable`, or `not_applicable` provenance for every metric;
- reproducible benchmark runner, report generator, and quality-comparison rubric;
- uncertainty/sample description and a complete failed-run ledger;
- sanitized export separate from private raw evidence.

### 6.3 Benchmark invariants

- pre-register task, commit, model, permissions, runtime, dependencies, limits, tests, rubric, and retry policy;
- keep conditions equivalent except for the context-preparation intervention;
- do not hide failed, abandoned, or retried runs;
- an Arm B quality failure is a regression regardless of resource deltas;
- comparable passing quality permits discussion of raw deltas only;
- fixtures validate machinery and are never product-performance evidence;
- external claims require separately approved wording, representative pilots, reproducible evidence, uncertainty analysis, and human privacy/security review.

### 6.4 Exit criteria

- schemas preserve missing versus zero and measured versus estimated values;
- reports reproduce byte-for-byte from identical inputs aside from declared timestamps;
- private raw evidence remains ignored and sanitized export tests prove field removal;
- the Node support matrix and disposable benchmark smoke pass;
- an independent reviewer signs the quality assessment;
- no claim is emitted automatically.

## 7. Phase v0.5 — optional integration surfaces

No integration in this phase becomes a Core dependency or a prerequisite for local CLI operation.

### 7.1 Thin MCP adapter

If authorized, MCP exposes a deliberately small surface over already tested application services. Candidate read-oriented operations are context planning, document search, contract lookup, snapshot lookup, and metrics summary. Local handoff recording may be exposed only through the same validated state service used by the CLI.

Requirements:

- capability discovery and explicit opt-in;
- strict request/response schemas, bounded payloads, timeouts, retries, and sanitized errors;
- no raw stack, credential, private path, artifact body, or unbounded tool output;
- no independent selection, security, or persistence policy inside the adapter;
- read-only default and no external-system write in the first MCP slice;
- parity tests showing CLI and MCP call the same services and produce equivalent domain results.

### 7.2 Generic agent examples

Examples must use synthetic repositories and data, state the human approval boundaries, and work without a paid service. They must not imply that PrimeContext orchestrates agents or that an example proves production quality.

### 7.3 Read-only snapshots

Optional snapshot providers may capture sanitized external state with `captured_at`, source, scope, hash, authority, and freshness policy. A snapshot is orientation evidence only. Live state is mandatory before any sensitive external write, and such writes require their own later scope with preview/diff, exact human confirmation, rollback, and post-verification.

### 7.4 Optional CodeGraph/AST adapter

CodeGraph may enrich callers, callees, dependency paths, symbols, affected tests, or blast-radius candidates. It must:

- remain capability-detected and optional;
- preserve filesystem/Git fallback;
- bind results to the active worktree and freshness evidence;
- treat output as untrusted bounded input;
- never be the sole proof of security, correctness, or complete blast radius;
- add no vendor type to Core contracts.

### 7.5 Remote adapter policy

Any future GitHub, Notion, Linear, Jira, Confluence, Serena, Supabase, or similar adapter requires a separate specification. Remote operation is opt-in, least-privilege, allowlisted, bounded, auditable without sensitive values, and free of implicit telemetry. Operators must preview destination and fields before any transmission. Credentials never enter Git, artifacts, metrics, or model-visible error output.

## 8. Phase v0.6 — selective validated experience

### 8.1 Outcome

PrimeContext may retrieve a small number of validated reusable lessons relevant to a task without loading global history or treating past output as current authority.

### 8.2 Required contract

An `ExperienceRecord` must include:

- stable ID and schema version;
- problem and validated successful pattern;
- applicability and contraindications;
- source task/handoff/artifact references;
- source authority and validation status;
- created/validated timestamps and freshness/expiry policy;
- bounded topic/module selectors;
- sensitivity classification and retention state;
- supersession or revocation metadata.

The stored record must not be an automatic transcript summary. AI-generated text, if ever allowed by a later gate, remains clearly generated and cannot override source evidence.

### 8.3 Admission and retrieval rules

- admit only from a completed handoff with passing tests/review and an explicit validation decision;
- reject secret/PII/private-client material before persistence;
- preserve provenance and link to private source evidence without copying it into Git;
- retrieve deterministically and selectively within its own budget;
- exclude expired, revoked, inapplicable, or contraindicated records;
- surface conflicts and never silently merge lessons;
- provide list/export/delete operations under bounded local-state rules;
- define retention defaults and allow complete local deletion;
- never inject an entire store or task history into context.

### 8.4 Exit criteria

- admission, revocation, expiry, supersession, conflict, selective retrieval, and deletion tests;
- hostile record and `toJSON`/prototype/duplicate/oversize validation tests;
- no global-dump code path or command;
- privacy review of every persisted and emitted field;
- task-history deltas remain bound to known immutable baselines.

## 9. Cross-cutting security and privacy requirements

Each executable slice must include a data inventory with:

- sources and trust boundary;
- fields and authority;
- provenance and freshness;
- persistence location and encryption status;
- stdout/log/audit behavior;
- retention, deletion, and export;
- eligibility for Git or package inclusion;
- byte/count/time/depth limits;
- failure taxonomy and recovery behavior.

The following requirements apply to every phase:

- validate untrusted structured input before Core execution;
- block sensitive paths before reads and sensitive content before persistence/output;
- enforce repository/state containment and reject traversal, absolute paths, ADS, device aliases, trailing aliases, control characters, symlinks, and junctions;
- use least privilege and do not run elevated against an adversarial repository;
- treat retrieved content, snapshots, integration results, experiences, and artifacts as untrusted data, never executable authorization;
- keep remote telemetry disabled by default;
- bound network destination, payload, time, retries, redirect behavior, and response before any optional remote adapter is allowed;
- emit sanitized stable errors without terminal controls, stacks, secret values, or blocked path lists by default;
- document residual same-user TOCTOU, local-state confidentiality, power-loss, and single-writer limitations rather than overstating protection.

Security-affecting and context-selection changes require an independent review and RED regression before implementation.

## 10. Compatibility and migration policy

Before v1.0, the project must define and exercise:

- semantic versioning policy for packages, CLI, configuration, stored state, and JSON contracts;
- immutable published contract versions and additive new subpaths;
- explicit readers/migrators for supported previous state versions;
- backup, preview, atomic replacement, rollback, and idempotence for state migrations;
- rejection of unknown future versions without destructive rewriting;
- deprecation windows and removal criteria;
- compatibility fixtures covering the oldest supported version through the candidate release;
- separation between state migration and repository-source changes.

`primecontext init` must never overwrite an existing configuration merely to adopt a new version.

## 11. v1.0 readiness requirements

The explicit v1.0 prerequisites remain outcome gates, not a declaration that every optional capability above must ship:

1. stable documented API and contracts;
2. architecture documented for every shipped subsystem;
3. authorized production use in MaxSound without MaxSound logic entering Core;
4. at least two additional representative pilots;
5. reproducible benchmark evidence with quality parity and conservative claims;
6. independent security review against an immutable release candidate;
7. easy, documented installation on the supported Node/runtime matrix;
8. tested compatibility and migration policy;
9. complete contributor, security-reporting, support, and release guidance.

Additional technical release evidence must include:

- clean install from the exact candidate tree;
- deterministic contract generation/check;
- `npm run typecheck`, `npm test`, and `npm run build`;
- supported Node matrix and disposable CLI smoke;
- package dry runs plus dependency, license, and supply-chain review;
- staged secret/content scan and proof that private state/evidence is excluded;
- migration and rollback rehearsal;
- documentation/link/diff checks;
- known limitations and residual-risk record;
- evidence tied to an immutable commit and, after approval, a signed/immutable release artifact.

## 12. Human gates that implementation cannot satisfy

The following require explicit decisions recorded separately:

- selected SPDX license, exact text, patent/notices/attribution analysis, and package metadata;
- public product/repository name;
- private security contact and disclosure process;
- authorization and data-owner approval for production pilots;
- exact benchmark claim wording and disclosure of uncertainty/failures;
- package publication, tag/release, repository disclosure, and distribution approval;
- any external write, remote data transmission, or hosted dependency.

Automation may prepare comparisons, evidence, and draft changes, but it may not infer or cross these gates.

## 13. Standard gate for each future slice

No future slice is complete until all applicable rows have direct evidence:

| Gate | Required evidence |
|---|---|
| Scope | Approved bounded specification, non-goals, dependencies, and authorization |
| Architecture | Data/trust flow, dependency direction, storage, failure model, and ADRs |
| Contracts | Physical schemas, runtime validators, deterministic generation, compatibility fixtures |
| Tests | RED-before-GREEN behavior, hostile inputs, hard limits, stale/tamper/replay, rollback and disclosure assertions |
| Security | Threat review, data inventory, secret/PII review, least privilege, residual risks |
| Quality | Determinism, correctness rubric, mandatory-item and conflict handling |
| Operations | Install, configuration, migration, retention/deletion, recovery, and CLI guide |
| Verification | Fresh typecheck/test/build, Node matrix, package dry run, links/diff, disposable end-to-end smoke |
| Evidence | Requirement-to-evidence matrix tied to an immutable tree/commit |
| Release | All applicable human legal, naming, security-contact, pilot, claim, and publication decisions |

## 14. Recommended implementation order

Subject to separate approval at every arrow:

```text
v0.1 + approved v0.2 baseline
  -> v0.3A Scout and selection
  -> v0.3B broker and progressive disclosure
  -> v0.3C artifacts, filtering, and delta context
  -> v0.4 observability and benchmark evidence
  -> optional v0.5 integration slices
  -> optional/selected v0.6 experience retrieval
  -> v1.0 readiness and human release gates
```

The order may stop after any independently useful slice. Optional integrations, storage engines, embeddings, and memory are never pulled forward merely because an attachment point exists.

## 15. Next actionable gate

The next implementation proposal should be the narrow v0.3A Context Scout and deterministic-selection slice. It must freeze the candidate/selection contracts, ranking evidence, mandatory-item policy, exact hard limits, CLI shape, compatibility behavior, and acceptance matrix before production code changes. Until that scope is explicitly approved, the only authorized runtime remains the v0.1 baseline plus the v0.2 Document Catalog and lexical search.
