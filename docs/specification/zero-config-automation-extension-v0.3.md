# PrimeContext v0.3 Zero-Configuration Automation Extension

**Status:** authorized additive implementation scope.

## 1. Outcome

A person who can run a command must be able to initialize PrimeContext and
prepare proof-carrying context from one sentence. JSON remains the strict
inter-agent protocol but is not a prerequisite for ordinary use.

This extension reuses `init`, `ContextIntent`, the existing context compiler,
the optional local hybrid index, and all established security/freshness gates.
It does not add a second selection policy or invoke an agent/model.

## 2. Public commands

### `primecontext setup`

The command accepts no arguments and performs only the existing idempotent
local initialization:

- creates default `primecontext.config.json` only when missing;
- creates the contained local state directory;
- adds the exact state-directory entry to the root `.gitignore` when missing;
- preserves every existing config byte and unrelated `.gitignore` line;
- runs read-only diagnostics after initialization;
- returns one JSON object with setup changes, readiness, and capabilities.

It does not install a package, edit agent instructions, contact a service,
enable telemetry, launch a daemon, index an external path, or silently repair
an invalid/unsafe existing configuration.

### `primecontext prepare <goal> [flags]`

Flags are repeatable and additive:

- `--accept <criterion>`;
- `--path <repository-relative-path>`;
- `--term <lexical-term>`.

The command rejects unknown/duplicate-invalid/empty inputs and creates an
internal `ContextIntent` with:

- `task_type: "small_code_fix"`;
- `query` equal to the goal;
- acceptance equal to repeated `--accept` values, or `[goal]` when omitted;
- a deterministic `AUTO-` task ID from the canonical human input;
- normalized ordinal path and term sets.

It then attempts the existing local `context index` once. Capability,
catalog, lock, or optional-index failure is reported in bounded automation
metadata and compilation continues through the existing safe filesystem,
documents, Repo Map, and optional CodeGraph fallbacks. A security, containment,
freshness, configuration, or input-validation failure remains fail-closed.
An obsolete or corrupt optional index may be discarded in favor of live safe
sources; a repository/worktree freshness mismatch in the request or selected
evidence may not be downgraded to fallback success.

The persisted request, envelope, receipt, and plan are exactly those produced
by the normal `ContextIntent` path. By default, stdout is the bounded compact
projection: prompt-facing envelope, bounded warnings/missing evidence, receipt
summary/reference, next commands, and automation metadata. `--full` returns the
complete request/envelope/receipt response for explicit inspection. Automation
metadata never changes compiler policy or proof digests.

### Repository-local Markdown knowledge vaults

A directory of Markdown notes inside the target repository, including a vault
edited with Obsidian, is ordinary repository evidence and needs no separate
connector. Permitted `.md` and `.mdx` notes use the existing bounded document
and filesystem paths. The `.obsidian` settings directory is always excluded
before reads and indexing; links, sensitive paths/content, byte limits,
freshness, and source hashes retain their normal meaning.

This is compatibility without an external connector or vault import, not an
Obsidian application integration. Screened note text may enter the ignored
local SQLite/FTS index, and selected bounded excerpts may enter the ignored
plan state just like other repository sources. Backlinks, wiki-link traversal,
tags, frontmatter semantics, attachment ingestion, an external vault, Obsidian
Sync, and writes to notes remain outside this extension.

## 3. Output and safety

Success emits one JSON value on stdout and nothing on stderr. Failure emits one
sanitized JSON error on stderr and no stdout. There is no interactive prompt,
ANSI output, network request, remote telemetry, package installation, agent
execution, or external write.

All path/content screening, bounded reads, `.gitignore` state protection,
snapshot binding, optional-provider fallback, state locking, and atomic write
requirements remain unchanged.

## 4. Acceptance criteria

1. `setup` is idempotent and never overwrites valid existing configuration or
   unrelated ignore entries.
2. A plain goal with no flags creates and compiles a valid deterministic intent
   without a user-authored JSON file.
3. Repeated acceptance/path/term flags are parsed strictly and appear in the
   generated request after existing validation/normalization.
4. Optional index unavailability is visible and uses safe fallback; security
   or freshness failure never becomes fallback success.
5. Existing process-JSON commands and all v0.1-v0.3 behavior remain compatible.
6. Tests cover compiled CLI help, strict argv, idempotency, deterministic IDs,
   optional-index failure, validation before state writes, state containment,
   repository-local Markdown-vault evidence, `.obsidian` exclusion, and
   JSON-only output.
7. Full typecheck, tests, build, contracts, package dry run, link check, and
   independent review pass before handoff.

## 5. Explicitly deferred

- automatic package publication or installation;
- editing Codex/Claude instruction files without preview and confirmation;
- importing or writing an external Obsidian vault;
- incorporating the third-party `colbymchenry/codegraph` dependency;
- MCP, hosted services, learned ranking, embeddings, or network access.

These may be specified separately after their trust, license, lifecycle, and
rollback boundaries are accepted.
