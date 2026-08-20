# PrimeContext Proof-Carrying Context Compiler Specification v0.3

**Status:** Approved implementation scope
**Date:** 2026-08-12
**Compatibility baseline:** v0.1 Foundations and v0.2 Document Retrieval

## 1. Outcome

Given a validated task, explicit limits, and one observed local repository
snapshot, PrimeContext compiles a bounded context package and the evidence
needed to audit that package. The successful planning output is a linked pair:

- `ContextEnvelope`: the selected, prompt-facing evidence;
- `SelectionReceipt`: the deterministic record of why considered evidence was
  included, omitted, conflicted, truncated, or unavailable.

The compiler can then process bounded expansion requests, record declared run
outcomes, and derive replay or ablation artifacts. Outcome and ablation records
are experiment inputs. They do not establish causality, quality improvement,
token savings, or state-of-the-art performance.

The slice is useful without SQLite/FTS or CodeGraph. Both are optional local
candidate-source adapters behind the same Core ports. Safe filesystem,
Document Catalog, Repo Map, and Git-metadata fallbacks remain available.

## 2. Authorization and non-goals

This specification authorizes only the vertical slice described here. It is an
additive v0.3 capability and does not alter the v0.1 configuration, Task
Capsule, Compact Handoff, Repo Map, metrics, benchmark, or v0.2 document
contracts and commands.

This slice does **not** authorize:

- MCP or another agent protocol;
- embeddings, vectors, semantic or learned ranking, a remote model, or RAG;
- network access, hosted storage, telemetry, or transmission of repository
  data;
- a web UI, SaaS service, tool execution, repository writes, or external
  writes;
- automatic multi-agent orchestration, coding-agent behavior, generated
  summaries, adaptive/global memory, or autonomous policy decisions;
- a new workspace package or vendor type in Core;
- publication, licensing, performance, quality, or state-of-the-art claims.

## 3. End-to-end contract

```text
validated ContextPlanRequest
        |
        v
bounded local candidate sources
  mandatory policy + safe filesystem/document fallback
  optional Repo Map/Git metadata
  optional SQLite/FTS and TypeScript CodeGraph
        |
        v
pure deterministic Core normalization, conflict detection, scoring,
mandatory retention, marginal-coverage selection, and budget accounting
        |
        +--> ContextEnvelope
        +--> SelectionReceipt
                 |
                 +--> bounded ExpansionRequest -> ExpansionDecision
                 +--> declared OutcomeReceipt
                 +--> experimental replay/ablation result
```

Every structured boundary uses `schema_version: "0.3"`, rejects unknown fields,
and receives byte, depth, value-count, string, array, and cross-field
validation before Core execution. Physical schemas are additive files under
`packages/schemas/contracts/v0.3/`.

## 4. Versioned contracts

### 4.1 `ContextPlanRequest`

Required fields:

- `schema_version` (`"0.3"`);
- `task`: `task_id`, `task_type`, `goal`, `query`, and one or more
  `acceptance_criteria` entries with stable `id`, `text`, and optional
  `required_terms`;
- `budget`: `max_items`, `max_bytes`, and `max_estimated_tokens`;
- `snapshot`: `repository_id`, optional `head`, and required `worktree_digest`;
- `policy_version`.

Optional task hints are `paths`, `symbols`, and `terms`. At request level,
optional `required_sources` identify repository-relative paths that must be
retained or reported missing. Hints improve discovery; they are not proof of
correctness.

At request level, optional `capsule_digest` can link an existing v0.1 Task
Capsule. It does not mutate the capsule or change the v0.1 schema.

### 4.2 `ContextCandidate`

`ContextCandidate` is the adapter-to-Core boundary shape. Each candidate has:

- stable content-addressed `id` (`sha256:<64 lowercase hex>`);
- `kind`: `document`, `code`, `test`, `configuration`, `history`, or
  `repository_map`;
- `provider`: `filesystem`, `documents`, `repo_map`, `git`, `fts`, or
  `codegraph`;
- repository-relative `path` and optional bounded 1-based line range/symbol;
- `source_hash`, repository/worktree identity, `freshness`, and observed source
  size;
- source `authority` and its evidence;
- bounded prompt-facing `excerpt` plus `excerpt_hash`;
- deterministic `estimated_tokens` and byte size;
- discovery evidence: matched terms, acceptance-criterion IDs, optional graph
  distance, and adapter truncation state.

Adapters cannot mark their own evidence authoritative or mandatory. Core
derives mandatory status from explicit required sources and applicable policy.
Provider scores are not accepted. Malformed, unknown-provider, stale, unsafe,
or over-limit candidate data is rejected or omitted with a stable reason.

Token estimation is deterministic and explicitly approximate:
`ceil(UTF-8 excerpt bytes / 4)`. It is only a budget unit, not a tokenizer or a
claim about a particular model.

### 4.3 `ContextEnvelope`

The envelope contains:

- task, snapshot, policy, optional capsule link, and selection digest;
- `evidence_status`: `READY`, `INSUFFICIENT_EVIDENCE`, or `CONFLICT`;
- `budget_status`: `WITHIN_BUDGET`, `TRUNCATED`, or `EXHAUSTED`;
- selected candidates in deterministic order;
- totals for items, bytes, and estimated tokens;
- per-criterion coverage (`COVERED`, `MISSING`, or `CONFLICTED`) with candidate
  IDs and matched terms;
- missing required sources/terms, authority conflicts, source failures, and
  truncation summaries.

`READY` means only that every required acceptance criterion has mechanically
matched evidence, required sources are present, no authority conflict remains,
and limits were respected. It is not a correctness or sufficiency guarantee.

### 4.4 `SelectionReceipt`

The receipt links the request digest and exact envelope selection digest. It
contains:

- policy version and deterministic policy-component definitions;
- one compact decision per considered candidate;
- include/omit status and stable reason codes;
- integer score components and marginal-coverage evidence;
- duplicate groups, authority conflicts, source failures, and truncation;
- canonical receipt digest.

Allowed decision reasons are:

```text
INCLUDE_REQUIRED_SOURCE
INCLUDE_APPLICABLE_POLICY
INCLUDE_CRITERION_COVERAGE
INCLUDE_RELEVANCE
OMIT_DUPLICATE_CONTENT
OMIT_NO_MATCH
OMIT_LOWER_MARGINAL_COVERAGE
OMIT_BUDGET_ITEMS
OMIT_BUDGET_BYTES
OMIT_BUDGET_TOKENS
OMIT_STALE_SOURCE
OMIT_UNSAFE_SOURCE
OMIT_INVALID_SOURCE
OMIT_SOURCE_TRUNCATED
OMIT_CONFLICT_REVIEW
OMIT_SUFFICIENT_EVIDENCE
```

A SHA-256 digest proves byte identity under the documented canonicalization. It
is not a signature, identity attestation, or proof that the source is true.

### 4.5 Progressive-disclosure contracts

`ExpansionRequest` links `task_id`, the prior selection digest, the consumer's
known candidate IDs, a missing-evidence reason, requested paths/symbols/terms,
and a requested additional budget.

`ExpansionDecision` has status `ALLOWED`, `PARTIAL`, or `DENIED`; stable reason
codes; additions; monotonic cumulative budget; old and new selection digests;
freshness evidence; and any remaining missing evidence. Duplicate content does
not consume budget twice. Replaying the same valid request against the same
snapshot is idempotent.

An expansion never raises the plan's original hard limits. There are at most
eight persisted expansion decisions, accepted or denied, and 64 additions per
decision.

### 4.6 `OutcomeReceipt`

An outcome is a declared observation linked to one exact selection digest. It
records:

- stable `run_id`, `task_id`, repository/worktree identity, and timestamps;
- used candidate IDs and touched repository-relative paths;
- `test_status`, `review_status`, and `completion_status` using explicit
  pass/fail/partial/not-run states;
- bounded numeric metrics and names of estimated fields;
- source (`human`, `tool`, or `imported`) and notes bounded to 4 KiB.

PrimeContext validates and stores the declaration; it does not infer that the
context caused the outcome. Outcomes may be appended, never silently replaced.

### 4.7 Replay and ablation result

Replay recomputes a plan from the persisted request policy/input and current
source snapshot. It reports `IDENTICAL`, `DRIFTED`, or `UNREPLAYABLE`, the old
and new digests, changed candidate IDs, source failures, and freshness details.
It never substitutes an old envelope for a changed snapshot.

Ablation derives a compact experimental coverage result and an ablated
selection digest by removing one selected, non-mandatory candidate. It
recomputes missing criteria/terms and evidence status, links the parent digest,
names the removed candidate, and sets `experimental: true`. The parent envelope
remains the immutable source for unchanged items and budget totals; the result
does not publish a replacement envelope. Removing a mandatory candidate is
denied. An ablation does not run an agent and makes no causal claim.

## 5. Deterministic compiler policy

### 5.1 Normalization and identity

- Unicode matching uses normalization compatible with the v0.2 lexical
  normalizer; paths stay canonical repository-relative `/` paths.
- Candidate ID is SHA-256 over explicit canonical fields including provider,
  path, locator, source hash, and excerpt hash.
- Duplicate content is grouped by source/excerpt hash. The deterministic
  representative is highest authority, then shortest stable locator, provider
  order, path, and ID.
- Timestamps are never part of request, selection, receipt, replay, or ablation
  digests.
- Arrays used as sets are unique and ordinally sorted before hashing.

### 5.2 Integer score components

Core computes these components; adapters cannot supply them:

| Component | Integer value |
|---|---:|
| exact required-source path | 10,000 and mandatory |
| applicable repository policy | 9,000 and mandatory |
| exact hinted path | 800 |
| exact hinted symbol | 700 |
| each distinct matched required criterion term | 120, maximum 7,680 |
| each distinct matched normalized query term | 80, maximum 5,120 |
| graph distance 0 through 5 | `300 - (50 * distance)` |
| authority: policy/ADR/specification/contract | 200/180/160/140 |
| authority: roadmap/implementation/generated | 100/80/0 |
| test candidate matching a hinted code symbol/path | 100 |
| live source freshness | 100 |

Scores are additive non-negative integers. Missing evidence is recorded, not
scored as zero evidence. Final ties use provider order
`filesystem`, `documents`, `repo_map`, `git`, `fts`, `codegraph`, then path,
line start, symbol, and candidate ID in ordinal order.

### 5.3 Selection

1. Validate the request and adapter outcomes.
2. Fail closed if safe discovery, containment, sensitive-content screening, or
   freshness establishment fails globally.
3. Normalize candidates, reject invalid/stale/unsafe inputs, and collapse exact
   duplicate content.
4. Detect same-authority and cross-authority conflicts without resolving them.
5. Retain mandatory candidates; if they exceed any limit, return
   `EXHAUSTED`/`INSUFFICIENT_EVIDENCE` without silently dropping one.
6. Greedily add the candidate with the greatest number of newly covered
   criterion terms; break ties by total integer score and the ordinal order.
7. Continue only for required marginal value, an explicit expansion request,
   or unresolved authority review. Once requirements are mechanically
   sufficient and none of those conditions applies, record
   `OMIT_SUFFICIENT_EVIDENCE`; a larger unused budget alone is not a reason to
   add generic evidence. Integer score and ordinal order remain tie-breakers,
   not a budget-filling phase.
8. Recompute all totals, coverage, statuses, and canonical digests.

No source can silently exceed the budget. An optional adapter failure is
recorded and the fallback continues. A security-control failure is fail-closed.

## 6. Optional local sources

### 6.1 SQLite/FTS

The FTS adapter is a replaceable candidate-discovery accelerator, not the
canonical source. It may persist screened source text only under
`<state_dir>/context/index.sqlite`.

- It uses the Node runtime's local SQLite capability and FTS5; no downloaded
  extension or dynamic extension loading is allowed.
- All non-FTS values use bound parameters. MATCH input is assembled only from
  normalized literal terms escaped by the adapter; raw SQLite query syntax is
  never accepted.
- `PRAGMA secure_delete=ON` and FTS5 `secure-delete=1` are enabled when the
  runtime supports them. Support state is recorded in the index manifest.
- Every rebuild writes a new exclusive sibling database, completes validation,
  closes it, revalidates paths, and replaces the old database. Incremental
  updates that could retain deleted/newly blocked content are not authorized.
- Plan/replay verifies the complete accepted-source manifest digest before
  using FTS candidates, then rereads and rehashes selected source ranges.
- Search begins one read transaction before the first schema, integrity,
  toolchain, metadata, source-row, content, FTS-equivalence, or digest check.
  The final MATCH query and bounded hit materialization use that same snapshot.
  Success commits only after materialization; every failure rolls back
  best-effort and always closes the connection.
- Missing FTS5, unsupported secure-delete controls, a locked/corrupt database,
  or a stale manifest records an optional-source failure and uses fallback.

Secure-delete controls reduce logical retention; they do not guarantee media,
backup, journal, or SSD remanence elimination.

### 6.2 TypeScript CodeGraph

The CodeGraph adapter uses the local TypeScript compiler API for `.ts`, `.tsx`,
`.js`, `.jsx`, `.mts`, `.cts`, `.mjs`, and `.cjs` within safe discovery.
It may emit bounded symbol, declaration, import/export, containment, and
syntactically resolved direct-call edges.

- Results are bound to per-file hashes and the worktree digest.
- Parser diagnostics, dynamic dispatch, generated code, path aliases, and
  unresolved edges are explicit truncation/uncertainty, not invented edges.
- CodeGraph is never the sole proof of callers, tests, blast radius, security,
  or correctness.
- Unsupported syntax, missing TypeScript capability, or limits use filesystem,
  document, Repo Map, and Git fallbacks.
- Parsed source is untrusted data and is never evaluated or imported.

## 7. Resource ceilings

All byte, count, depth, and structural ceilings are hard and include generated
output where applicable. The optional-adapter time limit is a cooperative
deadline at bounded in-process checkpoints, as qualified in its row below; it
is not a hard CPU or wall-clock quota.

| Resource | Ceiling |
|---|---:|
| one structured input | 1 MiB / 100,000 JSON values / depth 64 |
| task goal or query | 4,096 UTF-8 bytes |
| acceptance criteria | 64; 1,024 UTF-8 bytes each; 64 required terms total |
| hints or required sources | 128 paths, 128 symbols, 128 terms; 1,024 code points each |
| source-discovery entries/depth/configured excludes | existing 100,000 / 64 / 1,024 |
| source files accepted for hybrid index | 16,384 |
| one Markdown/code source | 1 MiB (v0.2 document commands retain 512 KiB) |
| bytes read while building hybrid index | 256 MiB |
| SQLite database | 512 MiB |
| CodeGraph symbols/edges | 100,000 / 250,000 |
| CodeGraph graph distance | 5 |
| candidates returned by one source | 1,024 |
| aggregate considered candidates | 2,048 |
| selected candidates | 128 |
| one selected excerpt | 32 KiB / 400 lines |
| envelope or receipt | 8 MiB each |
| requested budget | 128 items / 8 MiB / 1,000,000 estimated tokens maximum |
| expansion decisions/additions | 8 / 64 per decision |
| outcomes per task | 1,024; outcome JSONL 8 MiB |
| optional-adapter cooperative deadline | 30 seconds per optional adapter; checked at bounded in-process checkpoints, not an OS CPU quota |
| sanitized error text | 4 KiB |

The effective plan budget is the smallest of the request values, these hard
ceilings, and the linked v0.1 Task Capsule/configuration hard limit where one is
present.

## 8. Freshness, conflicts, and evidence status

`worktree_digest` is a SHA-256 digest over the canonical accepted-source
manifest: relative path, source hash, size, and source classification. A Git
HEAD alone never represents a dirty worktree.

Indexed candidates are usable only when the stored manifest digest matches a
fresh safe collection. Selected excerpts are reread through the safe bounded
adapter and their hashes rechecked immediately before envelope persistence and
stdout. A changed, missing, newly linked, newly excluded, newly sensitive, or
unreadable selected source fails freshness/security closed. No partial envelope
is published from the changed observation.

Potential conflict means materially different hashes occupy the same canonical
authority/topic/symbol locator. The compiler reports both sources and does not
choose truth. A conflict involving a required criterion yields `CONFLICT`.

## 9. Persistence and lifecycle

Default local state is:

```text
.primecontext/context/
  index.sqlite
  index-manifest.json
  plans/<task-id>/package.json
  plans/<task-id>/expansions.jsonl
  outcomes/<task-id>.jsonl
  experiments/<task-id>/*.json
```

This directory is ignored local state, is never package/Git eligible, and is
not encrypted. Plan state contains task text and bounded source excerpts; the
FTS database can contain screened full source text. Outcome notes can contain
operator text. Operators must apply repository confidentiality, retention,
backup, and deletion policy.

`package.json` is one validated, digest-linked object containing the request,
envelope, and receipt so readers cannot observe a mixed triple. Index and plan
replacements use bounded exclusive sibling files, flush/close, path
revalidation, and same-directory rename. JSONL appends use a documented
single-writer lock and validate the prior complete file before append. One
writer per state directory is supported. A failed operation preserves the last
validated state whenever failure happens before replacement.

Rebuilding replaces the prior hybrid index. A plan for the same task replaces
only that task's plan after complete validation. Outcomes are append-only.
Experiments are derived and disposable. Complete local deletion is performed
by removing the contained `.primecontext/context/` directory while no process
is using it; physical-media erasure is outside PrimeContext's guarantee.

## 10. CLI surface

```text
primecontext context index
primecontext context plan --from <request.json>
primecontext context inspect <task-id>
primecontext context expand <task-id> --from <request.json>
primecontext context outcome <task-id> --from <outcome.json>
primecontext context replay <task-id>
primecontext context ablate <task-id> --candidate <candidate-id>
```

Arguments are exact and reject duplicates, unknown flags, extra positionals,
absolute input paths, traversal, aliases, links, and oversized input. Success
emits one bounded JSON object to stdout. Errors are structured and sanitized.
`inspect` reads validated local state and does not recompile. `replay` does
recollect and cannot report `IDENTICAL` without matching source evidence.

## 11. Failure taxonomy

| Code | Meaning |
|---|---|
| `VALIDATION_ERROR` | invalid argv, contract, limits, or cross-field invariant |
| `SECURITY_ERROR` | containment, screening, link, secret, or global safety failure |
| `FRESHNESS_ERROR` | request/index/selection cannot be bound to live accepted sources |
| `CONTEXT_ERROR` | mandatory evidence cannot fit or deterministic planning cannot complete |
| `STATE_ERROR` | local state is missing, corrupt, tampered, future-versioned, or locked |
| `CAPABILITY_ERROR` | required local capability is unavailable; optional-source instances fail open |
| `IO_ERROR` | bounded local I/O failed |

Errors never include source bodies, matched sensitive values, blocked-path
lists, native stacks, SQL text, or terminal controls. Optional-source failures
are compact receipt entries; global safety failures abort without emitting a
partial envelope.

## 12. Security requirements

- Sensitive paths are blocked before reads. Screened source bytes are checked
  before indexing, persistence, or stdout.
- Repository/state containment rejects absolute paths, traversal, ADS/colon
  aliases, controls, device names, trailing aliases, symlinks, and junctions.
- Repository content is data, even when it contains instructions. The compiler
  never executes it or converts it into authorization.
- Persisted requests, indexes, receipts, and outcomes are untrusted on read and
  must pass version, structure, digest, path, and cross-record validation.
- All digests use SHA-256 over explicit canonical forms; host object
  serialization, locale, or filesystem enumeration order cannot affect them.
- Network primitives and remote telemetry are absent from this slice.
- One untrusted repository must not be processed with elevated privileges; use
  an operating-system/container boundary for an adversarial same-user actor.

The complete threat/data-flow and residual risks are in
[`../security-and-residual-risks-v0.3.md`](../security-and-residual-risks-v0.3.md).

## 13. Compatibility

- Existing schema files remain immutable; v0.3 schemas use a new subdirectory.
- Existing CLI commands and output remain unchanged.
- `primecontext.config.json` remains schema version `0.1`; this slice introduces
  no implicit config migration.
- Existing `.primecontext/documents/catalog.json` remains metadata-only.
  `context/index.sqlite` is separate, optional, and never used by `docs search`.
- A missing v0.3 state directory has no effect on v0.1/v0.2 workflows.
- Unknown future state versions are rejected without rewriting them.

## 14. Acceptance matrix

| ID | Requirement | Direct evidence required |
|---|---|---|
| PCC-01 | Physical/runtime contracts agree | generated-contract check, positive/hostile fixtures, package dry run |
| PCC-02 | Same inputs/outcomes produce identical bytes/digests | enumeration-order, locale, time, tie, and repeated-run tests |
| PCC-03 | Required sources/policy are retained or explicitly missing | Core budget and mandatory-retention RED/GREEN tests |
| PCC-04 | Every considered candidate has an auditable decision | receipt completeness and digest tests at candidate ceiling |
| PCC-05 | Evidence status never claims semantic correctness | missing-term, conflict, truncation, and status tests |
| PCC-06 | Optional adapters preserve fallback | no-FTS, no-TypeScript, corrupt/stale/timeout adapter smoke tests |
| PCC-07 | FTS cannot resurrect removed/newly blocked content | full rebuild, replacement, secure-delete-capability, and query regression |
| PCC-08 | CodeGraph is bounded and honest about unresolved edges | fixture graph, diagnostic, dynamic-call, cycle, and hard-limit tests |
| PCC-09 | Freshness binds dirty worktree and selected bytes | changed/head-equal/link-swap/tamper/replay tests |
| PCC-10 | Progressive expansion is bounded, monotonic, and idempotent | replay, duplicate, stale, partial, exhaustion, and eight-request tests |
| PCC-11 | Outcomes are declarations, not inferred effects | schema/source/append/tamper and no-causal-wording tests |
| PCC-12 | Ablation is derived, safe, and experimental | mandatory-denial, coverage recompute, parent-link, and determinism tests |
| PCC-13 | Secrets/PII are not indexed or emitted | path/content/SQL/error/stdout/non-disclosure tests |
| PCC-14 | Previous valid state survives pre-replacement failures | fault injection for collect/write/flush/close/validate/rename/lock |
| PCC-15 | v0.1/v0.2 remain compatible | complete prior suite plus disposable old-command smoke |
| PCC-16 | No remote or prohibited capability exists | dependency/code scan and offline smoke |
| PCC-17 | CLI vertical slice is usable | disposable `init -> map -> docs index -> task -> context index -> plan -> inspect -> expand -> outcome -> replay -> ablate` |
| PCC-18 | Release claims remain gated | documentation review plus benchmark evidence before any claim |

## 15. Verification and completion gate

Implementation is complete only after focused contract/Core/adapter/CLI tests,
security regressions, compatibility tests, and a disposable end-to-end smoke
pass, followed by:

```bash
npm run typecheck
npm test
npm run build
```

The verification record must identify the exact tree/commit, Node versions
actually exercised, commands, counts, failures, package contents, diff/link
checks, threat review, and remaining limitations. A passing implementation gate
does not authorize package publication or a performance claim.
