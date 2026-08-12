# PrimeContext v0.3 Proof-Carrying Context Compiler CLI

This guide covers the additive v0.3 compiler. The v0.1 and v0.2 commands and
configuration remain unchanged. The authoritative contract and limits are in
the [v0.3 specification](specification/proof-carrying-context-compiler-specification-v0.3.md).

## Status and installation

The v0.3 implementation is developed from an authorized source checkout. Until
its verification record is complete, examples below describe the frozen CLI
contract and are not a claim that a published/global binary exists.

```bash
cd /absolute/path/to/primecontext
npm ci
npm run typecheck
npm test
npm run build
```

Run the built binary from the target repository:

```bash
cd /absolute/path/to/target-repository
node /absolute/path/to/primecontext/packages/cli/dist/bin.js init
```

## 0. Discover and prepare without compiler internals

For a person, no JSON is required:

```bash
node /absolute/path/to/primecontext/packages/cli/dist/bin.js setup
node /absolute/path/to/primecontext/packages/cli/dist/bin.js prepare "Fix the login validation" \
  --accept "Valid logins still pass" \
  --path src/auth.ts \
  --term login
```

`setup` is idempotent and preserves valid configuration. `prepare` generates a
stable task ID and the existing `ContextIntent`, attempts the local hybrid
index once, and transparently uses safe fallback only when the optional index
is unavailable.

Markdown notes kept inside the repository can be used directly, including an
Obsidian-edited vault directory. PrimeContext reads the notes through its
normal screened repository sources and excludes `.obsidian` settings. This
does not attach an external vault or enable backlink/frontmatter semantics.

For agents and advanced automation, the process-JSON interface remains:

```bash
node /absolute/path/to/primecontext/packages/cli/dist/bin.js capabilities
node /absolute/path/to/primecontext/packages/cli/dist/bin.js doctor
node /absolute/path/to/primecontext/packages/cli/dist/bin.js context prepare --from tasks/primecontext-intent.json
```

A minimal intent is:

```json
{
  "schema_version": "0.3",
  "task_id": "PC-001",
  "task_type": "small_code_fix",
  "goal": "Fix the bounded parser without changing valid behavior.",
  "acceptance": [
    "Invalid input returns VALIDATION_ERROR",
    "Existing valid parser tests remain green"
  ],
  "paths": ["packages/core/src/parser.ts"],
  "terms": ["VALIDATION_ERROR", "parser"]
}
```

`context prepare` collects the live snapshot, derives the conservative budget
and policy, compiles through the normal v0.3 pipeline, stores the linked plan,
and returns the generated `request`, `envelope`, `receipt`, and `plan_path`.
Before any v0.3 context state is used, the command requires the configured
state directory to have the exact `.gitignore` entry written by `init`.
`doctor` reports `BLOCKED` and the repair action if that protection is missing.
Use `--from -` to provide exactly one JSON value over bounded strict UTF-8
standard input. This is the recommended agent-neutral integration surface.

The advanced `context plan` command below remains available when the caller
needs to control every request field explicitly.

All input paths below are repository-relative regular files. Absolute paths,
traversal, aliases, links/junctions, duplicate/unknown flags, missing values,
and extra positionals are rejected.

## 1. Build the optional hybrid index

```bash
node /absolute/path/to/primecontext/packages/cli/dist/bin.js context index
```

The command accepts no arguments. It safely recollects the bounded allowed
Markdown/code corpus and builds a new local SQLite/FTS index under
`.primecontext/context/`. Facts from PrimeContext's internal TypeScript
structural graph are included only when the local capability is available and
remains within its limits. It is not the external
`@colbymchenry/codegraph` package.

The build is full sibling replacement. It does not incrementally update the
old database. Successful JSON identifies the repository/worktree and index
digests, bounded source/symbol counts, database path relative to the repository,
and FTS/secure-delete capability state. Optional-source failures and CodeGraph
omissions are persisted in the validated index manifest. It does not emit
source bodies.

SQLite/FTS and CodeGraph are optional discovery accelerators. If unsupported,
planning still uses safe filesystem/document/Repo Map/Git fallback. A failure
of containment, screening, or global source freshness never fails open.

## 2. Compile a context plan

```bash
node /absolute/path/to/primecontext/packages/cli/dist/bin.js context plan --from tasks/PC-001-context-plan.json
```

Exact syntax:

```text
primecontext context plan --from <request.json>
```

Minimal illustrative request:

```json
{
  "schema_version": "0.3",
  "task": {
    "task_id": "PC-001",
    "task_type": "small_code_fix",
    "goal": "Preserve existing behavior while fixing the bounded parser.",
    "query": "bounded parser validation error",
    "acceptance_criteria": [
      {
        "id": "AC-1",
        "text": "Invalid input returns VALIDATION_ERROR.",
        "required_terms": ["VALIDATION_ERROR"]
      }
    ],
    "hints": {
      "paths": ["packages/core/src/parser.ts"],
      "symbols": ["parseBoundedInput"],
      "terms": ["unknown field"]
    }
  },
  "budget": {
    "max_items": 32,
    "max_bytes": 262144,
    "max_estimated_tokens": 65536
  },
  "snapshot": {
    "repository_id": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    "worktree_digest": "sha256:0000000000000000000000000000000000000000000000000000000000000000"
  },
  "policy_version": "pcc-0.3",
  "required_sources": ["SECURITY.md"]
}
```

Snapshot digests in real requests must come from the current PrimeContext
repository observation, not the zero-valued illustrative placeholders. If the
implementation provides a snapshot-preparation output, use those exact values.
Do not fabricate or reuse another repository's digest.

Planning validates the request before repository/state use, discovers bounded
candidates, rereads selected source bytes, and publishes a linked request,
`ContextEnvelope`, and `SelectionReceipt` under:

```text
.primecontext/context/plans/<task-id>/
  package.json
```

Success emits a bounded summary containing `task_id`, selection/receipt
digests, `evidence_status`, `budget_status`, selected count, and plan path.
`context inspect` returns the validated persisted request, envelope, receipt,
exact snapshot, selected IDs, missing evidence, conflicts, source outcomes, and
budget totals. Neither output means that the selected context is semantically
sufficient or correct.

## 3. Inspect a published plan

```bash
node /absolute/path/to/primecontext/packages/cli/dist/bin.js context inspect PC-001
```

Exact syntax:

```text
primecontext context inspect <task-id>
```

`inspect` reads only bounded validated local state. It verifies the linked
request/envelope/receipt digests and emits the persisted envelope and receipt
summary. It does not recollect the repository and therefore reports stored
freshness rather than claiming current freshness. Use `replay` to compare with
the current worktree.

## 4. Request progressive expansion

```bash
node /absolute/path/to/primecontext/packages/cli/dist/bin.js context expand PC-001 --from tasks/PC-001-expansion.json
```

Exact syntax:

```text
primecontext context expand <task-id> --from <request.json>
```

An `ExpansionRequest` must link the current selection digest, list the
consumer-known candidate IDs, state a missing-evidence reason, provide bounded
path/symbol/term requests, and request an additional budget no greater than the
original hard caps. The command re-establishes freshness and returns
`ALLOWED`, `PARTIAL`, or `DENIED` with stable reasons.

Budget accounting is monotonic. Previously selected duplicate content does not
consume budget twice. Replaying an identical accepted request against the same
state returns the same decision. At most eight expansions and 64 additions per
decision are allowed.

## 5. Record an outcome declaration

```bash
node /absolute/path/to/primecontext/packages/cli/dist/bin.js context outcome PC-001 --from evidence/PC-001-outcome.json
```

Exact syntax:

```text
primecontext context outcome <task-id> --from <outcome.json>
```

The validated `OutcomeReceipt` must identify a stable run, exact selection and
snapshot, used candidate IDs, touched paths, explicit test/review/completion
statuses, source, and optional bounded metrics/notes. It is appended under
`.primecontext/context/outcomes/` after the prior ledger validates.

This command records a declaration. It does not run tests, inspect an agent,
verify a patch, or infer that context caused the result. Mark estimated metrics
explicitly and keep secrets/private data out of notes.

## 6. Replay against the current worktree

```bash
node /absolute/path/to/primecontext/packages/cli/dist/bin.js context replay PC-001
```

Exact syntax:

```text
primecontext context replay <task-id>
```

Replay validates the persisted request and plan, safely recollects current
sources, and recompiles with the same policy and budget. It returns
`IDENTICAL`, `DRIFTED`, or `UNREPLAYABLE`, old/new digests, changed candidate
IDs, freshness, and source failures. It never reports `IDENTICAL` solely because
Git HEAD matches, and it never silently substitutes an old envelope for changed
source bytes.

## 7. Derive an experimental ablation

```bash
node /absolute/path/to/primecontext/packages/cli/dist/bin.js context ablate PC-001 --candidate sha256:<64-lowercase-hex>
```

Exact syntax:

```text
primecontext context ablate <task-id> --candidate <candidate-id>
```

The command models removal of one selected non-mandatory candidate and
deterministically recomputes missing criteria/terms, evidence status, and an
ablated selection digest. It refuses mandatory or unknown candidates. It does
not publish a replacement envelope or claim revised byte/token totals. Output
and any local experiment record have `experimental: true` and link the parent
selection digest.

Ablation does not invoke an agent or demonstrate the marginal/causal value of
the removed evidence. A controlled experiment with quality evidence is needed
for that conclusion.

## Output, state, and disclosure

Successful commands write one bounded JSON object to stdout and exit 0.
Failures write one compact sanitized object to stderr and exit non-zero. Error
codes are `VALIDATION_ERROR`, `SECURITY_ERROR`, `FRESHNESS_ERROR`,
`CONTEXT_ERROR`, `STATE_ERROR`, `CAPABILITY_ERROR`, or `IO_ERROR`.

The v0.3 local state can contain:

- task goals, queries, criteria, hints, and notes;
- full screened source text in `index.sqlite`;
- source paths, hashes, symbols, graph facts, and Git/worktree identity;
- selected excerpts in envelopes;
- selection decisions, expansions, outcomes, and experiments.

`.primecontext/` is ignored by default but is ordinary unencrypted local state.
Stdout, shell history, terminal capture, CI logs, redirection, backups, crash
files, and copied databases can make the same values durable. Treat all of them
as repository-confidential and never commit them.

To end local retention, stop every process using the state and remove the
contained `.primecontext/context/` directory according to your operating-system
policy. SQLite secure-delete controls and application deletion do not guarantee
physical-media, filesystem-snapshot, SSD, journal, or backup erasure.

## Limits

Important maximums are 1 MiB/100,000 values/depth 64 per structured input,
16,384 indexed sources, 256 MiB cumulative index input, a 512 MiB database,
2,048 considered and 128 selected candidates, 32 KiB/400 lines per selected
excerpt, 8 MiB per envelope/receipt, and a 30-second cooperative deadline per
optional adapter. The deadline is checked between bounded parser/index steps;
process isolation remains necessary for a hard operating-system CPU limit. The
complete authoritative table is in
[Specification section 7](specification/proof-carrying-context-compiler-specification-v0.3.md#7-resource-ceilings).

## Recommended first smoke

On a disposable sanitized repository:

```bash
node /absolute/path/to/primecontext/packages/cli/dist/bin.js init
node /absolute/path/to/primecontext/packages/cli/dist/bin.js map
node /absolute/path/to/primecontext/packages/cli/dist/bin.js docs index
node /absolute/path/to/primecontext/packages/cli/dist/bin.js task PC-001 --from tasks/PC-001.json
node /absolute/path/to/primecontext/packages/cli/dist/bin.js context index
node /absolute/path/to/primecontext/packages/cli/dist/bin.js context plan --from tasks/PC-001-context-plan.json
node /absolute/path/to/primecontext/packages/cli/dist/bin.js context inspect PC-001
node /absolute/path/to/primecontext/packages/cli/dist/bin.js context expand PC-001 --from tasks/PC-001-expansion.json
node /absolute/path/to/primecontext/packages/cli/dist/bin.js context outcome PC-001 --from evidence/PC-001-outcome.json
node /absolute/path/to/primecontext/packages/cli/dist/bin.js context replay PC-001
node /absolute/path/to/primecontext/packages/cli/dist/bin.js context ablate PC-001 --candidate sha256:<64-lowercase-hex>
```

Only claim commands that were actually exercised against the exact candidate
tree. Passing this smoke is implementation evidence, not a performance or
public-release claim.
