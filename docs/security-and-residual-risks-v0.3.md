# PrimeContext v0.3 security, threat model, and residual risks

This record applies to the Proof-Carrying Context Compiler defined by the
[v0.3 specification](specification/proof-carrying-context-compiler-specification-v0.3.md)
and [architecture](architecture/v0.3-proof-carrying-context-compiler-architecture.md).
It complements [`SECURITY.md`](../SECURITY.md); it does not weaken the v0.1 or
v0.2 controls.

## 1. Protected assets and security objectives

Assets include repository source and documentation, credentials and personal
data that must never be read or retained, task/acceptance text, source paths and
symbols, worktree identity, selected excerpts, the FTS database, compiler
requests/envelopes/receipts, expansion history, outcome declarations, and
experiment results.

The v0.3 objectives are:

- do not read a known-sensitive path;
- do not persist or emit detected sensitive content;
- never treat repository or adapter content as instruction/authorization;
- bind prompt-facing evidence to a fresh safely observed worktree;
- make selection decisions complete, deterministic, and tamper-evident;
- enforce all item/byte/token/time/depth ceilings;
- preserve the last validated local state on pre-publication failure;
- keep all operation local and free of implicit telemetry/network access;
- preserve a usable safe fallback when an optional adapter is unavailable.

PrimeContext is not a sandbox, DLP system, antivirus, SQL isolation boundary,
cryptographic signer, truth oracle, or correctness verifier.

## 2. Actors and trust boundaries

### Trusted for policy, not necessarily bug-free

- the installed PrimeContext code and frozen policy version;
- the operator-selected repository root, configuration, request, and command;
- the local Node runtime and operating-system access controls.

### Untrusted

- every repository path, file, document, code token, comment, and instruction;
- all SQLite bytes/rows, CodeGraph facts, Git text, Repo Map and Document
  Catalog state after persistence;
- every CLI JSON input, local JSON/JSONL state, expansion, and outcome note;
- filesystem enumeration order, locale, timestamps, parser diagnostics, and
  optional-adapter availability;
- another same-user process capable of racing files or reading local state.

### Outside the v0.3 system

- networks, hosted providers, MCP clients, remote models, vector stores,
  telemetry collectors, package publication, and external-system writes.

## 3. Data-flow inventory

| Stage | Data read | Gate before read/use | Data stored | Data emitted |
|---|---|---|---|---|
| CLI ingress | argv and request JSON | relative contained path, 1 MiB/structure/schema limits | validated request after planning | sanitized validation errors |
| Safe collection | directory metadata, then allowed source bytes | exclusions and path components before open; stable bounded handle; strict decode; screening | canonical source manifest | aggregate omissions only |
| FTS build | screened accepted text and metadata | source hash/size/type/cumulative limits | full text, path, hash, manifest in local SQLite | counts/digest/capability flags |
| CodeGraph | screened accepted code | type/size/count/diagnostic limits; no execution | optional bounded facts in local index | candidates and honest truncation |
| Planning | validated candidates and reread excerpts | provider/schema/limits/freshness/hash checks | request, bounded excerpts, envelope, receipt | validated bounded envelope/summary |
| Expansion | request plus prior plan | linkage, idempotence, source freshness, remaining caps | append decision; replace linked plan pair | bounded decision/new summary |
| Outcome | operator/tool/import declaration | source/status/metric/path/count limits | append-only JSONL | compact append result |
| Replay/ablation | validated plan plus fresh repository or parent envelope | digest/snapshot/mandatory checks | disposable experimental JSON | non-causal comparison/result |

Git/package eligibility:

- source configuration and public schema/docs: eligible after normal review;
- `.primecontext/context/**`, requests, indexes, excerpts, outcomes, experiments,
  temporary/lock/journal files, logs, and private evidence: never eligible;
- an explicitly sanitized export would require a later specification and human
  review; none exists in v0.3.

Encryption: PrimeContext adds none. Operating-system/filesystem encryption is
outside the application boundary.

## 4. Threat analysis and controls

### T1. Sensitive path or content disclosure

**Attack:** a secret is placed in `.env`, credentials, dumps, an unusual source
file, code literal, documentation, task text, outcome notes, a label-like PII
field, or a previously indexed file. The attacker tries to expose it through
FTS, selected excerpts, receipts, errors, replay, terminal logging, or Git.

**Controls:** built-in/configured exclusions before reads; no links/junctions;
strict bounded reads; high-confidence credential/private-key/authorization/PII
screening before indexing and again before selected output; full index rebuild;
selected-source reread/hash; `.primecontext` excluded from discovery/Git;
sanitized errors; no body or blocked-path list in receipts.

**Residual:** detection is incomplete DLP. Proprietary prose, unknown secret
formats, unlabelled identifiers, and operator-written task/outcome text can be
stored or emitted. Never put secrets in requests or notes; exclude sensitive
project-specific paths.

### T2. Prompt or policy injection through source content

**Attack:** a README, comment, dependency, generated file, Git message, or SQL
row tells the consumer to ignore policy, expand budget, execute a command, send
data, or elevate its authority.

**Controls:** content is a labeled excerpt, never an instruction channel;
adapters cannot set mandatory status, authority outcome, provider score, Core
policy, limits, or commands; policy and acceptance requirements come only from
validated request/configuration; no tool execution/network sink exists;
receipts preserve provenance.

**Residual:** a downstream model may still follow malicious text. Consumers
must maintain their own instruction/data separation and action gates.

### T3. Path escape, aliasing, link/junction, and state redirection

**Attack:** traversal, absolute/UNC paths, Windows drive-relative syntax, ADS,
device names, control characters, trailing-dot/space aliases, symlinks,
junctions, hard-link identity changes, or a custom state path redirect a read or
write.

**Controls:** portable bounded path grammar; repository/state containment;
existing-component link/reparse checks; before/after stable file identity;
contained sibling files only; revalidation before replacement; IDs never become
unchecked paths.

**Residual:** portable Node APIs cannot make all Windows path checks and later
operations one atomic no-follow transaction. A malicious same-user actor can
race links or directory components. Use an OS/container boundary for an
adversarial repository and never run elevated.

### T4. SQL/FTS injection or malicious database

**Attack:** query text injects FTS operators/SQL; a modified database returns
forged paths/content, loads an extension, consumes excessive resources, or
breaks referential relationships.

**Controls:** no raw SQL/identifier/pragma/path from input; bound non-FTS
values; FTS MATCH assembled from escaped normalized literal terms; extension
loading absent; byte/count/time/row limits; deterministic explicit ordering;
schema/version/manifest/referential-integrity validation; candidates remain
untrusted; selected source is reread live.

**Residual:** SQLite/runtime vulnerabilities and denial of service between
cooperative deadline checkpoints remain possible. Process-level isolation is required for a
fully adversarial repository/state owner.

### T5. Stale, substituted, or mixed-snapshot evidence

**Attack:** HEAD is unchanged while worktree bytes change; the index is copied
from another repository; one selected file changes between discovery and
output; envelope and receipt come from different runs.

**Controls:** repository ID plus canonical worktree manifest digest; per-source
hash and locator; full manifest check before indexed use; selected-source reread
immediately before publication; linked request/selection/receipt digests;
task-plan pair published together; stale replay reports drift instead of
reusing old evidence.

**Residual:** there is a narrow same-user race after final verification and
before/downstream use. A receipt proves observed byte identity, not continuing
filesystem immutability.

### T6. Adapter authority/score escalation and forged completeness

**Attack:** an optional adapter marks its candidate mandatory, supplies a huge
score, hides truncation, invents edges, or reports a complete blast radius.

**Controls:** candidate contracts contain no adapter-controlled mandatory or
provider-score field; Core derives all score components and mandatory status;
provider enums/limits are closed; CodeGraph facts require source evidence and
retain diagnostics/unknown/truncation; evidence status is mechanically scoped;
receipt covers every considered candidate and source outcome.

**Residual:** safe but wrong lexical/graph evidence may still rank poorly.
Selection quality requires benchmark evidence and human/code validation.

### T7. Resource exhaustion

**Attack:** huge directory, deeply nested JSON, many symbols/edges, pathological
TypeScript, costly FTS query, duplicate explosion, oversized excerpts/outcomes,
lock contention, or repeated expansion exhausts CPU, memory, disk, or time.

**Controls:** exact specification ceilings; safe walker limits; strict input and
source types/sizes; bounded candidates/output; graph visited sets/distance;
literal-term FTS and hard limit; optional-adapter cooperative deadline; eight expansions;
database/state size limits; one writer and bounded lock acquisition.

**Residual:** in-process CPU/memory limits are not a hard operating-system
quota. Malicious parser/database inputs should be isolated at the process or OS
boundary.

### T8. Replay, duplicate expansion, and outcome tampering

**Attack:** replay an expansion against a different selection; consume budget
twice; alter a result or prior JSONL entry; claim an outcome from another
snapshot; use an outcome to claim causality.

**Controls:** request/task/snapshot/selection linkage; accepted request digest
and idempotent response; monotonic selected IDs and accounting; complete JSONL
validation; per-record schema and selection linkage; append-only semantics;
explicit source and estimated fields; wording and schema never infer causality.

**Residual:** a same-user actor can delete or replace all local state because it
is not signed or access-controlled by PrimeContext. SHA-256 detects canonical
content changes only when an independently trusted digest/reference exists.

### T9. Incomplete deletion and local-state disclosure

**Attack:** removed or newly blocked source text remains in an incrementally
updated FTS table, journal, filesystem block, backup, SSD, crash dump, or copied
database.

**Controls:** full sibling rebuild, not incremental update; SQLite
`secure_delete=ON` and FTS5 `secure-delete=1` when available; support recorded;
close journals before publication; documented whole-directory deletion and
state exclusion.

**Residual:** application-level deletion does not guarantee physical-media,
snapshot, journal-history, backup, page-cache, or copied-file erasure. Use an
encrypted disposable volume and storage lifecycle appropriate to the data.

### T10. Concurrency and crash consistency

**Attack:** two writers interleave index/plan/outcome state; a crash leaves
partial JSONL or mismatched envelope/receipt; a stale lock is stolen.

**Controls:** one-writer model; exclusive bounded lock; sibling build;
validate/flush/close before replace; publish a linked plan pair; validate the
complete prior JSONL; never ignore a partial trailing record; fail without
claiming publication.

**Residual:** no portable directory `fsync`, universal atomic replacement,
distributed lock, or power-loss guarantee exists. A failure after rename may
make restoration of prior bytes impossible.

## 5. Secure operation checklist

1. Confirm the exact repository root, `state_dir`, and configured excludes.
2. Keep repository-specific credentials, client data, dumps, and private
   documents outside the readable corpus; do not rely on pattern detection.
3. Run as an unprivileged user with one PrimeContext writer per state directory.
4. Use OS/container isolation for an untrusted repository or malicious same-user
   process.
5. Treat `.primecontext/context/index.sqlite`, plan JSON, outcome JSONL, stdout,
   shell history, CI logs, backups, and crash files as repository-confidential.
6. Rebuild after any stale/corrupt/capability warning; never bypass manifest or
   selected-source freshness.
7. Inspect `evidence_status`, conflicts, missing evidence, truncation, and
   optional-source failures before using an envelope.
8. Do not interpret `READY`, a receipt digest, outcome correlation, replay, or
   ablation as correctness or causality.
9. Delete the complete contained context-state directory with no active process
   when retention ends; apply storage-level erasure policy independently.
10. Keep every local state file, private result, export, and audit artifact out
    of Git and public issue bodies.

## 6. Security verification requirements

The release-candidate tree must have direct tests/evidence for:

- blocked paths before reads and high-confidence secret/PII/Authorization
  content before indexing/output;
- path/ADS/device/link/junction/traversal and same-file identity changes;
- FTS literal escaping, bound parameters, no extension load, database tamper,
  manifest freshness, full removal/rebuild, and secure-delete capability state;
- malicious/diagnostic/pathological TypeScript and graph ceilings;
- prompt-injection text unable to change score, mandatory state, policy, or
  execution;
- candidate attempts to supply unknown/authority/score fields;
- stale/mixed repository, copied database, mismatched receipt, replay, duplicate
  expansion, budget exhaustion, and outcome tamper;
- no source body/secret/SQL/native stack/control in sanitized errors;
- fault injection before/after write, flush, close, validation, lock, and rename;
- dependency/code scan proving no v0.3 network/telemetry/MCP/embedding path.

Testing these controls reduces known risk; it does not turn PrimeContext into a
sandbox or complete DLP system.
