# PrimeContext v0.3 security, threat model, and residual risks

This record applies to the Proof-Carrying Context Compiler defined by the
[v0.3 specification](specification/proof-carrying-context-compiler-specification-v0.3.md)
and [architecture](architecture/v0.3-proof-carrying-context-compiler-architecture.md),
including the accepted [v0.3 consolidation](specification/v0.3-consolidation-specification.md).
It complements [`SECURITY.md`](../SECURITY.md); it does not weaken the v0.1 or
v0.2 controls.

The final technical-candidate evidence is layered without rewriting history:
implementation commit `b6f950cebb8621a99d0442a3d0ce548a286ffb9b`, tree
`ce0ca3efbbd6764295725bf6800a22c81faec107`, received a complete 56/56
commit-bound scan with zero findings. Test-only portability follow-up
`fcdb33495fc0cb186d7e925426b2ddfff3a6d4e0`, tree
`1e90b5140cab006a5bbabd93a5957ad9596ada74`, changes no executable byte and
received a complete 1/1 diff scan with zero findings. This later evidence-only
prose does not claim a self-referential containing commit or scan.

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
- enforce hard item/byte/token/depth ceilings and cooperative time checkpoints;
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
effective ordered root-and-ancestor Git-ignore verification before state writes;
complete Authorization Basic/Bearer and bounded opaque-token redaction in
public errors and compiler source-failure artifacts before envelope/receipt
hashing; no body or blocked-path list in receipts. Source-failure output is
defensively cloned and capped at 4,096 Unicode characters after redaction.

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
receipts preserve provenance. Applicability of `SECURITY.md` uses a bounded,
deterministic lexical classifier over the complete request vocabulary,
independent of the shorter ranking-term projection. The CLI uses the same
classifier rules when a security policy was blocked, so it cannot silently
return `READY` for a term recognized by Core. Task Capsule path boundaries
filter ordinary evidence but cannot remove recognized operational-policy
candidates before Core performs that applicability decision.

**Residual:** a downstream model may still follow malicious text. Consumers
must maintain their own instruction/data separation and action gates. The
classifier is conservative but not semantic and can produce false positives or
false negatives. The equivalent rules are currently duplicated in Core and
CLI; a parity corpus detects known drift but does not eliminate that maintenance
risk. A caller that requires the root security policy regardless of wording
must list `SECURITY.md` explicitly in `required_sources`.

### T3. Path escape, aliasing, link/junction, and state redirection

**Attack:** traversal, absolute/UNC paths, Windows drive-relative syntax, ADS,
device names, control characters, trailing-dot/space aliases, symlinks,
junctions, hard-link identity changes, or a custom state path redirect a read or
write.

**Controls:** portable bounded path grammar; repository/state containment;
existing-component link/reparse checks; before/after stable file identity;
contained sibling files only; revalidation before replacement; IDs never become
unchecked paths. State writes additionally require effective ordered Git-ignore
semantics from the root `.gitignore` through every ancestor of `state_dir`, with
each ruleset interpreted relative to its containing directory. Evaluation is
bounded to 64 applicable ignore files and 1 MiB aggregate input; missing root
protection, bound exhaustion, malformed/ambiguous rules, and descendant
re-inclusions fail closed. Later variant-case re-inclusions on a case-insensitive
repository also fail closed. A custom `state_dir` is encoded as a literal
Git-ignore path even when it contains Git control/glob metacharacters.
The matcher parses repository patterns literally and linearly without compiling
them to RegExp: ambiguous globs, classes, or escapes can never restore ignore,
and ambiguous negations fail closed. It precomputes full-path/basename and
lowercase candidates once per base and applies early length checks to retain the
intended `O(B + D*S)` bound, where `B` is aggregate ignore input, `D <= 64` is
the number of applicable bases, and `S` is normalized `state_dir` length.
Configured repository excludes use one shared filesystem-aware exact/ancestor
comparison: raw case-sensitive keys on POSIX and both lower/upper case keys on
Windows, without Unicode normalization. Safe discovery, accepted document
observations, and bound CodeGraph manifests therefore reject the same Windows
case aliases before TypeScript capability loading or source/document reads.
Initialization publishes the root rule
and verifies the complete hierarchy before it creates the state directory or
its lock.

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
untrusted; selected source is reread live. The exact stored `entries_fts` DDL,
including tokenizer `unicode61 remove_diacritics 0`, is compared with the
builder's canonical identity. That identity, integrity, toolchain, metadata,
source rows, screened content, FTS equivalence, digest, final MATCH, and hit
materialization share one read transaction.

**Residual:** SQLite/runtime vulnerabilities and denial of service between
cooperative deadline checkpoints remain possible. The read transaction closes
the internal validation-to-MATCH substitution window but not same-user races on
repository paths before the transaction or after final selected-source
verification. Process-level isolation is required for a fully adversarial
repository/state owner.

### T5. Stale, substituted, or mixed-snapshot evidence

**Attack:** HEAD is unchanged while worktree bytes change; the index is copied
from another repository; one selected file changes between discovery and
output; envelope and receipt come from different runs.

**Controls:** repository ID plus canonical worktree manifest digest; per-source
hash and locator; full manifest check before indexed use; selected-source reread
immediately before publication; linked request/selection/receipt digests;
task-plan pair published together; stale replay reports drift instead of
reusing old evidence. A programmatic preparation observation is defensively
cloned and privately bound to source bodies and hashes, metadata, locators,
documents, graph, Repo Map, omissions, failures, root, and configuration; every
selection-relevant body is rehashed before use. A separate bounded
verification-only recollection proves freshness but never feeds selection.

**Residual:** there is a narrow same-user race after final verification and
before/downstream use. A receipt proves observed byte identity, not continuing
filesystem immutability.

### T6. Adapter authority/score escalation and forged completeness

**Attack:** an optional adapter marks its candidate mandatory, supplies a huge
score, hides truncation, invents edges, or reports a complete blast radius.

**Controls:** candidate contracts contain no adapter-controlled mandatory or
provider-score field; Core derives all score components and mandatory status;
provider enums/limits are closed; CodeGraph facts require source evidence and
retain diagnostics/unknown/truncation. A bound CodeGraph manifest reapplies the
same filesystem-aware configured-exclude semantics, including Windows case
aliases and excluded ancestors, before optional runtime loading or source
reads, then retains extension, sensitive-content, and hash/freshness gates;
evidence status is mechanically scoped; the receipt covers every considered
candidate plus recorded failures and truncation.

**Residual:** safe but wrong lexical/graph evidence may still rank poorly.
Selection quality requires benchmark evidence and human/code validation.

### T7. Resource exhaustion

**Attack:** huge directory, deeply nested JSON, many symbols/edges, pathological
TypeScript, costly FTS query, duplicate explosion, oversized excerpts/outcomes,
lock contention, or repeated expansion exhausts CPU, memory, disk, or time.

**Controls:** exact specification ceilings; safe walker limits; strict input and
source types/sizes; bounded candidates/output; graph visited sets/distance;
literal-term FTS and hard limit; optional-adapter cooperative deadline; eight expansions;
database/state size limits; one writer and bounded lock acquisition. Canonical
Repo Map hashing applies its aggregate JSON ceiling to contract-valid metadata
instead of reusing the smaller prompt-excerpt string boundary, so valid package
roles do not fail solely at 32 KiB; aggregate oversize remains rejected.
Hierarchical Git-ignore verification is separately capped at 64 applicable
files and 1 MiB total text and rejects the state operation when either ceiling
would be exceeded. Its matcher is single-pass and non-backtracking; per-base
full/basename lowercase precomputation and early length rejection avoid repeated
candidate normalization while retaining the bounded `O(B + D*S)` work model.
Opaque-secret public-error screening likewise uses a simple token-candidate
scan followed by one linear letter/digit classification pass; a reachable
public validation-error regression bounds hostile alternating input.
Source-failure redaction is applied before deterministic ordering and canonical
hashing and then capped at the public 4,096-character contract boundary, so
redaction expansion cannot invalidate an otherwise valid compiler result.

**Residual:** in-process CPU/memory limits and cooperative deadlines are not a
hard operating-system quota. The compact-output byte check currently occurs
after the compiled plan may have been published, so an oversized compact
projection can return a bounded `CAPABILITY_ERROR` while leaving a valid plan
in local state. Malicious parser/database inputs should be isolated at the
process or OS boundary; callers must inspect state after this error before
retrying.

### T8. Replay, duplicate expansion, and outcome tampering

**Attack:** replay an expansion against a different selection; consume budget
twice; alter a result or prior JSONL entry; claim an outcome from another
snapshot; use an outcome to claim causality.

**Controls:** request/task/snapshot/selection linkage; accepted request digest
and idempotent response; monotonic selected IDs and accounting; complete JSONL
validation; per-record schema and selection linkage; append-only semantics;
explicit source and estimated fields; wording and schema never infer causality.
Duplicate groups are complete, disjoint, non-self-referential, and linked
bidirectionally to included representatives; a newly mandatory duplicate alias
cannot evict a retained expansion item.

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

**Attack:** two writers interleave index/plan/outcome state; concurrent
initializers replace or lose an externally published configuration; a crash
leaves partial JSONL or mismatched envelope/receipt; a stale lock is stolen.

**Controls:** one-writer model; exclusive bounded lock; sibling build;
validate/flush/close before replace; publish a linked plan pair; validate the
complete prior JSONL; never ignore a partial trailing record; fail without
claiming publication; never automatically reclaim a dead-owner lock through a
non-atomic check/rename sequence. Initialization installs and verifies ignore
protection before creating state, prepares and `fsync`s a configuration
temporary file inside ignored state, and publishes by atomic hard link so an
existing winner is never replaced. External configuration wins, produces an
explicit retry path, and is re-observed with ignore protection after state
directory creation.

**Residual:** no portable directory `fsync`, universal atomic replacement,
distributed lock, or power-loss guarantee exists. A failure after rename may
make restoration of prior bytes impossible. A crashed writer can leave an
availability-blocking lock that requires exact-path operator removal after
independent confirmation that no writer remains active.

## 5. Secure operation checklist

1. Confirm the exact repository root, `state_dir`, configured excludes, and all
   root/ancestor `.gitignore` rules that can affect that state path.
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
  content before indexing/output, including complete Basic and short Bearer
  values in public error projections and schema-valid compiler source failures;
- source-failure cloning, deterministic post-redaction ordering, 4,096-character
  output validity, artifact/digest linkage, and unchanged benign messages;
- path/ADS/device/link/junction/traversal and same-file identity changes;
- configured excludes applied with platform-aware exact/ancestor comparison to
  accepted document and CodeGraph manifests before optional runtime loading or
  reads, including real Windows case aliases, POSIX case-sensitive controls,
  and distinct NFC/NFD spellings;
- FTS literal escaping, bound parameters, no extension load, database tamper,
  exact DDL/tokenizer identity, manifest freshness, one validation-to-MATCH read
  transaction, concurrent mutation, full removal/rebuild, and secure-delete
  capability state;
- malicious/diagnostic/pathological TypeScript, graph ceilings, and configured
  excludes reapplied to accepted CodeGraph bindings before runtime loading or
  reads;
- prompt-injection text unable to change score, mandatory state, policy, or
  execution;
- candidate attempts to supply unknown/authority/score fields;
- stale/mixed repository, copied database, mismatched receipt, replay, duplicate
  expansion, retained-ID monotonicity, complete duplicate-group linkage, budget
  exhaustion, and outcome tamper;
- no source body/secret/SQL/native stack/control in sanitized errors;
- hostile alternating opaque-token input through public error construction,
  including a 32,769-character regression and a direct 65,537-character scale
  check after removal of the quadratic lookahead form;
- mutable observation body/metadata/locator/graph substitution and effective
  hierarchical Git-ignore precedence relative to each containing directory,
  case-insensitive re-inclusion, literal custom-state Git patterns, bounded
  fail-closed ignore evaluation, positive lookalikes `foo**bar/baz/`,
  `foo***bar/baz/`, and `foo[/]bar/baz/`, non-backtracking adversarial glob
  completion within 2 seconds, 30,000-character/30,000-rule completion within
  2.5 seconds, initialization ordering before state/lock creation, Windows
  concurrent config-publication `EPERM`, create-only hard-link publication,
  external-config preservation/retry, and final config/ignore revalidation;
- Core/CLI parity for the bounded lexical security classifier, including
  adversarial ranking prefixes, common security concepts, unrelated negative
  controls, query-discovered nearest-ancestor `AGENTS.md` applicability, and
  Capsule boundaries unable to prefilter recognized policy;
- contract-valid Repo Map/package-role hashing above the excerpt boundary plus
  aggregate canonical-input rejection;
- fault injection before/after write, flush, close, validation, lock, and rename;
- dependency/code scan proving no v0.3 network/telemetry/MCP/embedding path.

Testing these controls reduces known risk; it does not turn PrimeContext into a
sandbox or complete DLP system.

## 7. Security scan provenance

Discovery scan `417f7eb6-946e-478f-b398-3e9fd029b99a` compared baseline
`80bf4f08` with frozen snapshot
`codex-security-snapshot/v1:sha256:3bc517318936c095b781e4f5bf72209548ed93e37a5cd3847e8b4e897f1f1c83`.
It sealed three low findings covering canonical Repo Map preparation,
initialization ordering, and Capsule-policy preservation. It also retained three
suppressed/ignored hardening items covering CodeGraph binding excludes, exact
SQLite DDL/tokenizer identity, and literal custom-`state_dir` Git patterns.
Targeted RED→GREEN changes for all six were applied after the snapshot.

A third working-tree scan, `b23f2fc5-f4a9-42cc-bba9-cdacd080b1c9`, compared
baseline `80bf4f08` with frozen snapshot
`codex-security-snapshot/v1:sha256:69c4fac06bfe7ad4e59044f0db58f0425f2d7372ed25f5735353eb2d7ed3f0a3`.
It completed 54/54 full-file reviews. Its coverage receipt is
`sha256:5389f1aaee8da005418581c7a8d20cc11edfff93d88f10aad62a87541ed98a66`,
and its zero-finding artifact is
`sha256:dd09db6d382c191aae181f945efbc917e92df19e89d1b8f58be2321b9c9ccd58`.
Strict diff therefore sealed zero reportable findings, while retaining one
inherited hierarchical-`.gitignore` candidate that strict diff suppressed.

After that frozen snapshot, targeted RED→GREEN hardening made state-ignore
verification apply the root and every ancestor `.gitignore`, interpret rules
relative to each containing directory, enforce the 64-file/1-MiB ceilings, and
fail closed on descendant re-inclusion or ambiguous/unbounded evaluation. The
final matcher is literal and linear, does not compile untrusted patterns to
RegExp, never lets ambiguous globs/classes/escapes restore ignore, and treats
ambiguous negations as fail-closed re-inclusions. Per-base full-path/basename
lowercase precomputation plus early length checks retain the intended
`O(B + D*S)` bound (`B` aggregate ignore bytes, `D <= 64` bases, `S` normalized
state path length).

RED cases reproduced Git-visible state with `foo**bar/baz/`,
`foo***bar/baz/`, and `foo[/]bar/baz/`; imposed a 2-second timeout on an
adversarial would-be backtracking pattern; and imposed a 2.5-second timeout on a
30,000-character state path plus 30,000 literal rules. All are GREEN. The
recorded final root `npm test` run had 387 tests: 382 passed, 5 skipped, and
0 failed.

A fourth working-tree scan, `5727be72-aac0-4f99-917c-ff5a20d17e97`, compared
baseline `80bf4f08` with frozen snapshot
`codex-security-snapshot/v1:sha256:76db2ea81950b5c1ad79b48c58ad7ab48a3c84aafa747ab53ab4c7130b651ebf`.
Its coverage artifact is
`sha256:51385f3eac6f244b6309d6ef71adf91abcf5f288e5f491939e3718e0cc771d43`,
and its findings artifact is
`sha256:221816704c59a2f414812f4adeec0f8be15feaed2d63b4d3635e596f47606067`.
The scan sealed one medium finding, `csf_c7a625bef52f5364ba317c81`: an opaque
secret candidate could drive quadratic regular-expression work through a
reachable public validation-error path. The recorded RED took 2,337 ms.

After that frozen snapshot, [Core error redaction](../packages/core/src/errors.ts)
replaced the lookahead form with simple candidate extraction and a one-pass
letter/digit classifier. [Core tests](../packages/core/src/core.test.ts) now carry
the hostile input through `PrimeContextError` and require the public path to
finish below one second. The recorded GREEN was approximately 2 ms on that
path, with a direct 65,537-character scale check at 0.779 ms. The subsequent
root `npm test` run had 388 tests: 383 passed, 5 skipped, and 0 failed. Those
timings are local point-in-time anti-regression evidence, not a general
performance claim.

A fifth working-tree scan, `4577d98f-9433-43c7-816c-f00dd1ecd5a5`, compared
baseline `80bf4f08` with frozen snapshot
`codex-security-snapshot/v1:sha256:ab602788d6933773a7111fd36bb46ea12c3d611a6a54492f667ce6595b8cb48c`.
It completed 54/54 full-file reviews. Its coverage artifact is sealed by
`sha256:bbd087bea53085826e923783c7e8926c7df0c3be42ddbf25477ce43c4215cfbd`,
and its findings artifact by
`sha256:13cc6d32adea7457a0eb717df339687f15d99bb5ccff6cd17bcd390b77a7a0c6`.
The scan sealed three low findings: filesystem source-count/byte truncation
could omit an applicable nested `AGENTS.md`; the 1,024-candidate filesystem
provider cap could discard an already accepted applicable policy; and an exact
directory hint could skip the `AGENTS.md` located in that directory.

After that snapshot, targeted RED→GREEN hardening tracks policy paths omitted
by collection, provider, document, and aggregate caps; applies them before a
`READY` result or emits a security-control failure; and computes applicability
in bounded `O(P + T*64)` work without treating policy candidates as targets.
Tests cover the 16,384-source, 1-MiB-per-source, 256-MiB-total,
1,024-provider-candidate, and 2,048-aggregate-candidate boundaries. Core now
checks the exact directory scope before ancestors, distinguishes a known
extensionless file from a directory, preserves the original path spelling, and
selects canonical case variants deterministically for `AGENTS.md` and
security-relevant root `SECURITY.md`.

After those changes, a separate concurrency review reproduced a Windows Node
24 RED: concurrent initializers racing replace-style publication of
`primecontext.config.json` could make one rename fail with `EPERM`. The
corrected path installs/verifies ignore protection before state, prepares and
flushes the default config under ignored state, publishes it by atomic hard
link without clobbering an existing file, preserves an external winner with a
retryable state-change result, and revalidates final configuration plus ignore
protection. Focused Node 22.13.1/24.19.0/25.9.0 cases and independent targeted
rereview recorded `PASS`.

The complete frozen-tree suites recorded: integrated Node 25.9 `npm run
verify`, 408 total / 403 pass / 5 skip / 0 fail in 67.377527 s; Node 22.13.1,
408 total / 386 pass / 22 skip / 0 fail in 106.206661 s; Node 24.19.0,
408 total / 403 pass / 5 skip / 0 fail in 104.531991 s; and standalone Node
25.9 `npm test`, 408 total / 403 pass / 5 skip / 0 fail in 108.524598 s.

These are working-tree discovery/remediation records only. The third scan is
pre-fix because the hierarchical-ignore correction changed its tree, the fourth
predates the opaque-redaction correction, and the fifth predates the policy-cap,
exact-directory, and later init-race corrections above. None is evidence of a
final post-fix scan, an immutable commit, another operating system,
dependency-audit status, package publication, or production suitability.

A sixth working-tree scan, `a8688bba-4c56-458d-a8c7-7bbcdc824590`, was sealed
at `2026-08-20T20:39:49.161722Z` against baseline `80bf4f08` and frozen
snapshot
`codex-security-snapshot/v1:sha256:f91d5f37160a8901172d549a1cf4d99b5fa7f578bd4dc2023c958c2692960968`.
Its findings artifact is
`sha256:0390aaa4a4d854a5ebad30606626c39b5d21592a8a504203b1deec1a0b353417`
and its coverage artifact is
`sha256:a6aa83fc8a2257bf29618e62fafc1d86802ccb5e80af4436135f86643466ce11`.
It completed the sealed review and reported medium finding
`csf_ba4307bd4c60cb716d6c3b25` for source-failure credentials propagated into
public compiler artifacts/digests, low finding
`csf_b78ca1b9b13abea1d5ce6829` for CodeGraph configured-exclude bypass through
Windows case aliases, and low finding `csf_1a42f17878147be34a0bf639` for the
corresponding accepted-document observation bypass.

Post-snapshot TDD now sanitizes and bounds source failures before artifact
construction and hashing, and makes safe discovery, accepted document
observations, and CodeGraph bindings share the filesystem-aware exclude
comparison before runtime loading or reads. The focused Core regressions passed
3/3; the affected Core/Schemas suite passed 147/147. The two focused adapter
regressions passed 2/2 on Node 22.13.1, 24.19.0, and 25.9.0; the adapter suite
recorded 71 pass, 2 platform skips, and 0 fail. Independent rereview recorded
`PASS` for both corrected boundaries.

Those changes make the completed sixth scan pre-fix evidence.

A seventh working-tree scan, `8672e283-008c-435d-8a16-fc98eef31e74`, compared
the same baseline with frozen snapshot
`codex-security-snapshot/v1:sha256:926e537221ce9a3a752408f969d3f004321dd0f6534b562444a4b783a5bb7626`.
Its findings and 54/54 coverage artifacts are sealed by
`sha256:cee727d6e95fab16d357944b1e3b7792048365882d6ad14763ae2f7e7e38e9a0`
and
`sha256:a1e84d13002125cb8084c3c0ada87a13b83fdaf3ecb7cc414ff900e289f9abf4`.
It reported medium `csf_4053e220bdcdd7e51131e746` for credential-bearing
failures republished from imported envelopes by ablation, plus low
`csf_7c8be172758f328516156c91`, `csf_e48705aaca12516082ae60ae`, and
`csf_2b09a541405590f45b636d53` for NTFS DOS 8.3 aliases crossing physical
CodeGraph, document, and SQLite state boundaries.

Post-snapshot TDD applies bounded public failure redaction to imported
compile/expand/replay/ablation artifacts and rebuilds linked digests from
defensive clones. On Windows, accepted source paths now resolve each existing
component to its physical long path, prove containment, recheck links, and
reapply sensitive/configured exclusions before loading or reading. SQLite
performs the equivalent state/index validation before any runtime load,
directory, lock, temporary file, or database write while preserving safe
nonexistent suffixes. Core/Schemas passed 149/149; adapter matrices passed with
zero failures on Node 22/24/25; independent rereview recorded `PASS`.

These changes make the seventh scan pre-fix evidence too.

The eighth post-fix working-tree scan,
`4139230d-b5a7-47e2-830b-69387b7c23e3`, was sealed at
`2026-08-20T22:37:18.903537Z` for snapshot
`codex-security-snapshot/v1:sha256:1df8c59eabe0d0298c1a997d61060bd5d87421ad8cd5153bb1582ea61263dde3`.
It completed 56/56 full-file/full-diff reviews with zero findings. Its findings
and coverage artifacts are sealed by
`sha256:d6b92b8622518acdc16bdba7f9af97474fd94036ef8c806ea2e62f5b3939830b`
and
`sha256:fe896b2cfd676b11e944127ba215d92c4132adea59216b73c3dd57b2da00ac57`.
This is complete post-remediation working-tree evidence, not immutable proof by
itself.

The complete commit-bound scan,
`114d4ae4-5968-4ea2-a792-155f95bf6082`, was sealed at
`2026-08-20T22:51:34.382952Z` for implementation commit `b6f950ce`, tree
`ce0ca3efbbd6764295725bf6800a22c81faec107`, and snapshot
`codex-security-snapshot/v1:sha256:ed75c0c3e54504af8e8d23b321c5c3fab412a5703a28adfe4cec2eea918990a0`.
It completed 56/56 reviews with zero findings. Its findings and coverage
artifacts are sealed by
`sha256:8bc551c3ec9b4ab8d26096f5590566e1ab7730c92a935c3110f4cf53647fe11b`
and
`sha256:fdea963c33977947744f96581098c70175966f8d47b1272671e85d0cca5bd1db`.

The test-only diff scan,
`bd616de7-7b8b-4ce4-bfbb-c90ee68b50d2`, was sealed at
`2026-08-20T23:11:17.370944Z` for `b6f950ce..fcdb3349` and snapshot
`codex-security-snapshot/v1:sha256:5af98dd832dbea2ad168871e176ab14775d8912670002ab53ae12c4a883460eb`.
It completed the sole changed test file (1/1) with zero findings. Its findings
and coverage artifacts are sealed by
`sha256:0dc245618b090c16290e886cfcaa2b67f81f61caeb674c01c3bc8a7d7b0f6052`
and
`sha256:162671ffdd739ffb0e2d5eab6d766abac80e9d44c1a98d313a250ecfbb3c5d69`.
The executable tree remains byte-identical to the complete scanned
implementation commit. The TAC advisory status was `unknown`, so no protected
advisory-output claim is made. The complete commit-bound scan and the sealed
test-only diff scan over immutable revisions compose the security evidence for
exact CI HEAD `fcdb3349`; this later documentation prose is outside that claim.

GitHub Actions run
[32427175624](https://github.com/vthamada/primecontext/actions/runs/32427175624)
then passed all four Ubuntu/Windows Node 22.13/24 jobs for `fcdb3349`, including
the production dependency audit in the Ubuntu Node 24 cell. This closes the
technical candidate's post-remediation, immutable-code, cross-platform, and
dependency-audit evidence. Licensing, public security contact, branch
protection, publication, pilot, benchmark, and product-claim approvals remain
outside this technical security result.
