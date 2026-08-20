# PrimeContext v0.3 Agent Usability Extension

**Status:** authorized additive implementation scope.

## 1. Outcome

A person must be able to verify PrimeContext from a source checkout with one
documented command after dependency installation. A local software agent must
be able to discover the interface, submit one bounded task intent over a file
or standard input, and receive one complete proof-carrying context package as
JSON without constructing repository or worktree digests itself.

The extension reuses the existing v0.3 compiler and state lifecycle. It does
not execute an agent, inject a prompt into a host, contact a model, or create a
second selection policy.

## 2. Public process protocol

- `primecontext capabilities` emits one deterministic JSON object describing
  the local protocol, supported input modes, commands, contract versions, and
  absence of required network access.
- `primecontext doctor` emits one bounded JSON object with runtime,
  configuration, ignored-state protection, and next-action status. Missing
  initialization or ignore protection is reported as an action, not repaired
  implicitly.
- `primecontext context prepare --from <intent.json|-> [--compact]` validates a
  `ContextIntent`, binds it to the live accepted-source snapshot, derives a
  conservative budget from repository configuration, compiles it through the
  existing Core service, stores it through the existing plan lifecycle, and
  returns the generated request, envelope, receipt, and repository-relative
  state path. The optional `--compact` projection returns the complete
  prompt-facing envelope plus bounded warning, missing-evidence, receipt
  reference, and next-command metadata under a 1 MiB output ceiling; omitting
  it preserves the original complete response.
- Existing single-input `--from` commands may accept `-` for one bounded UTF-8
  JSON value on standard input. Existing repository-file behavior remains
  unchanged.

Success writes exactly one JSON value to stdout, no stderr, and exit status
zero. Failure writes no stdout, one sanitized JSON error to stderr, and a
non-zero status. The process is non-interactive and uses no ANSI output,
daemon, socket, network request, or remote telemetry.

## 3. ContextIntent contract

The additive physical contract has `schema_version: "0.3"` and these fields:

- required: `task_id`, `task_type`, `goal`, and non-empty `acceptance`;
- optional: `query`, `paths`, `symbols`, `terms`, and `required_sources`.

Unknown fields, unsafe identifiers or paths, control characters, invalid task
types, duplicates, excessive counts, oversized UTF-8 strings, malformed JSON,
and aggregate input above 1 MiB are rejected before source collection.

Generation is deterministic:

- acceptance entries become ordinal IDs `AC-001` through `AC-064`;
- omitted query equals the goal;
- hint and required-source sets are deduplicated and ordinally sorted;
- policy is `0.3-default`;
- `max_items` is 32;
- token budget is the configured initial budget for the task type;
- byte budget is four times that token budget, within the existing envelope
  hard limit;
- snapshot identity is collected live by the existing safe source pipeline.

Advanced callers retain `context plan --from <ContextPlanRequest>` unchanged.

## 4. Human and host examples

- `npm run demo` builds and exercises a synthetic disposable repository, then
  prints a bounded success summary and removes the temporary repository.
- Generic shell, Codex `AGENTS.md`, and Claude Code `CLAUDE.md`/command
  templates invoke only the public process protocol.
- Templates contain no selection logic and no private data. A template test
  proves documentation parity only; it must not be described as execution in
  the actual Codex or Claude Code host.

## 5. Security and compatibility

All existing sensitive-path, content-screening, containment, link/junction,
freshness, budget, state-locking, digest, and sanitized-error controls remain
mandatory. Standard input is read incrementally, stops above 1 MiB, and is
decoded as strict UTF-8 before bounded structural JSON parsing. No stdin value
is persisted except through the existing validated plan/outcome stores.
Every v0.3 context command verifies that the configured state directory has
the exact repository-root `.gitignore` entry written by `primecontext init`;
missing protection fails before context collection or state access.

No MCP, agent SDK, network dependency, model invocation, automatic
orchestration, repository edit, package publication, license choice, or host
installation is authorized by this extension.

## 6. Acceptance criteria

1. `capabilities` and `doctor` are strict, deterministic, machine-readable, and
   do not mutate repository state. `doctor` reports a missing state-directory
   ignore entry as `BLOCKED`.
2. A valid file-based intent produces a schema-valid request, envelope, and
   receipt linked to the same selection and stored plan.
3. The same intent over stdin produces the same generated request and
   selection under the same live snapshot.
   The compact projection omits the embedded request and receipt while keeping
   a valid envelope and linked receipt digest/reference.
4. Malformed, invalid UTF-8, oversized, empty, truncated, or interactive stdin
   fails before source collection with JSON-only sanitized errors.
5. Existing v0.1-v0.3 commands and repository-file inputs remain compatible.
6. `npm run demo` succeeds in a disposable directory with spaces and no paid,
   remote, MCP, Codex, or Claude dependency.
7. Generic, Codex, and Claude templates use the same commands and intent
   contract; an automated parity test detects drift.
8. Typecheck, all tests, build, physical-contract check, package dry run, link
   check, and prohibited-capability scan pass on the integrated tree.
