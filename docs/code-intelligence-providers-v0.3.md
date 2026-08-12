# PrimeContext code-intelligence providers in v0.3

**Status:** factual implementation note for the authorized v0.3 slice. The
v0.4 integration described below is a proposal, not implementation
authorization.

## 1. Identity and naming

PrimeContext currently has an internal, optional TypeScript/JavaScript
structural-graph adapter. The internal provider identifier is `codegraph`, but
the implementation is **not** the third-party
[`@colbymchenry/codegraph`](https://github.com/colbymchenry/codegraph) package,
does not import it, and is not an integration with that project.

The current adapter lives in `@primecontext/adapters`, dynamically loads the
TypeScript compiler API, and is capability-detected. Its package has
`typescript` as an optional dependency; it has no
`@colbymchenry/codegraph` dependency. User-facing documentation should call it
the **PrimeContext TypeScript structural graph** when the distinction matters.
The stable internal provider value may remain `codegraph` for v0.3 contract
compatibility.

This distinction is important because the two implementations have different
languages, graph semantics, persistence, query surfaces, runtime dependencies,
freshness models, and licenses.

## 2. What the internal v0.3 provider does

The PrimeContext TypeScript structural graph is a functional, bounded evidence
source. It:

- accepts `.ts`, `.tsx`, `.js`, `.jsx`, `.mts`, `.cts`, `.mjs`, and `.cjs`;
- parses source with `typescript.createSourceFile` without importing or
  executing repository modules;
- extracts file, function, class, interface, type, enum, variable, method, and
  property nodes;
- emits `contains`, `imports`, `exports`, and syntactically resolvable direct
  `calls` edges;
- resolves relative local modules and conservative bare-identifier calls;
- uses stable IDs, ordinal ordering, source hashes, a graph digest, an accepted
  source manifest, and repository/worktree snapshot binding;
- applies repository discovery exclusions and content screening before a
  source can enter the graph;
- enforces hard file, per-file byte, total-byte, node, edge, AST-depth,
  excerpt, and cooperative-time limits;
- is optional and cannot remove the safe filesystem, document, Repo Map, or
  Git fallbacks.

The CLI recollects the graph as a live optional source during context
preparation. Matching declarations become bounded `ContextCandidate` evidence
when their path, name, qualified name, or excerpt matches task terms or explicit
path/symbol requirements. The compiler, not the adapter, remains responsible
for authority, mandatory evidence, ranking, budgets, conflict handling,
selection, and receipts.

Focused tests cover deterministic collection, source-change freshness,
digest-forgery rejection, shadowed identifiers, property-call ambiguity,
syntax errors, oversized inputs, hard limits, capability absence, deadlines,
and candidate conversion. This is implementation evidence, not a benchmark or
a claim of complete program understanding.

## 3. Current limitations

The internal provider is intentionally narrower than a general code
intelligence platform:

- it supports only TypeScript and JavaScript;
- it builds syntax ASTs, not a project-wide TypeScript `Program` and
  `TypeChecker` model;
- it does not currently resolve package exports, `tsconfig` aliases, runtime
  dispatch, reflection, dependency injection, inheritance, framework routes,
  or cross-language calls;
- property calls retain their textual target but are not guessed as unrelated
  bare symbols;
- the compiler currently matches graph nodes directly; it does not traverse
  the collected edges to answer callers, callees, paths, impact, or blast
  radius queries;
- it has no graph-specific public query command, MCP server, daemon, watcher,
  or auto-sync process;
- the graph is recollected in-process. The separate PrimeContext SQLite/FTS
  store indexes screened repository sources, while the context-index manifest
  records graph counts and a graph digest; it is not a persisted queryable
  copy of the internal graph;
- a graph result is never sole evidence of callers, tests, security,
  completeness, or blast radius.

These limits are deliberate v0.3 trust boundaries. Calling the provider
"CodeGraph" does not imply feature parity, affiliation, or source compatibility
with the third-party project.

## 4. Comparison with `colbymchenry/codegraph`

The comparison below reflects the upstream `main` documentation reviewed on
2026-08-12. Upstream behavior and package requirements can change, so an
integration must pin and verify a release rather than rely on this note.

| Concern | PrimeContext TypeScript structural graph | `colbymchenry/codegraph` upstream |
| --- | --- | --- |
| Product role | Optional evidence adapter inside the proof-carrying compiler | Standalone code-intelligence product, CLI, library, and agent integration |
| Extraction | TypeScript compiler syntax API in Node.js | Native Rust/tree-sitter kernel for its primary language set with a portable fallback; see the [official architecture](https://github.com/colbymchenry/codegraph#how-it-works) |
| Languages | TypeScript and JavaScript | Broad multi-language support listed in the [official language table](https://github.com/colbymchenry/codegraph#supported-languages) |
| Graph facts | Declarations plus conservative contains/imports/exports/direct-call facts | Richer nodes and relationships, cross-file resolution, framework routes, and some provenance-labelled heuristic bridges |
| Persistence | Recollected in-process; digest and summary linked to PrimeContext state | Local `.codegraph/codegraph.db` SQLite graph with FTS5, confirmed by the [upstream schema](https://github.com/colbymchenry/codegraph/blob/main/src/db/schema.sql) |
| Freshness | Exact accepted-source hashes and worktree snapshot; stale evidence fails closed | Initial index, incremental sync, file watcher, and query-time staleness handling described in the [upstream README](https://github.com/colbymchenry/codegraph#how-auto-syncing-works--and-why-you-dont-need-to-run-codegraph-sync-manually) |
| Query surface | Internal task-term and explicit hint matching; no public graph traversal | `explore`, `query`, `node`, `callers`, `callees`, `impact`, `affected`, and related CLI/library calls in the [CLI reference](https://github.com/colbymchenry/codegraph#cli-reference) |
| Agent integration | None in the provider; PrimeContext exposes its own process-JSON CLI | Installer plus MCP, CLI, and direct SDK integration |
| Policy ownership | PrimeContext Core alone selects and emits receipts | Upstream also has context-building and relevance behavior; its [library API](https://github.com/colbymchenry/codegraph#library-usage) exposes graph and context operations |
| Telemetry | No network or telemetry in the v0.3 slice | Anonymous usage telemetry is documented and can be disabled; see [Telemetry](https://github.com/colbymchenry/codegraph#telemetry) |
| License | PrimeContext has no approved public license yet; see [ADR-0007](adr/0007-defer-public-license-selection.md) | MIT, as declared in the upstream [package manifest](https://github.com/colbymchenry/codegraph/blob/main/package.json) and [LICENSE](https://github.com/colbymchenry/codegraph/blob/main/LICENSE) |

### Runtime and distribution differences

The upstream package includes platform-specific compiled components. Its
library documentation states that embedded use requires Node.js 22.5 or newer
for `node:sqlite`, while the current upstream package manifest declares an
engine range of `>=20.0.0 <25.0.0`. PrimeContext currently declares Node.js
`>=22.13` without an upper bound. A direct SDK dependency could therefore
change the supported runtime matrix, particularly Node.js 25, and must be
tested on every supported OS and architecture.

The upstream project documents local operation, but its optional telemetry,
installer, upgrade flow, MCP server, daemon, native release downloads, and
agent-configuration writes are outside the authorized PrimeContext v0.3
boundary. Upstream performance or token claims must not be repeated as
PrimeContext claims without PrimeContext-controlled benchmark evidence and
quality parity.

## 5. Upstream integration risks

An upstream integration offers materially broader language and graph coverage,
incremental indexing, mature traversal queries, and a maintained SDK. It also
introduces new trust and lifecycle risks:

1. **Pre-read exclusion:** upstream discovery rules are not a substitute for
   PrimeContext path blocking and content screening. Rejected sources must not
   enter an upstream database.
2. **Freshness mismatch:** watcher freshness is eventual; PrimeContext needs
   an exact request snapshot and must verify accepted file hashes before and
   after using a result.
3. **Heuristic facts:** inferred or framework-specific edges must retain their
   upstream provenance and cannot be elevated to proved authority.
4. **Determinism:** upstream IDs, ranking, SQLite row order, incremental state,
   and context formatting are not PrimeContext contracts. Results require
   bounded normalization, ordinal ordering, and PrimeContext-owned hashes.
5. **Storage and remanence:** a second local database increases the
   confidentiality footprint and requires contained placement, deletion,
   replacement, recovery, and Windows/WSL locking design.
6. **Runtime and supply chain:** native artifacts, platform packages, release
   provenance, checksums, dependency licenses, exact version pinning, and Node
   compatibility need review.
7. **Network and telemetry:** telemetry and all download/upgrade behavior must
   be disabled and verified under denied network access.
8. **Product boundary:** upstream context-building policy cannot replace
   PrimeContext authority, selection, budgets, missing-evidence reporting, or
   proof receipts.
9. **License:** MIT permits broad reuse subject to its notice conditions, but
   bundled or modified upstream code requires attribution and license
   preservation. PrimeContext publication remains independently blocked until
   its own human license gate is resolved.

## 6. Proposed optional v0.4 adapter

This section is a proposal only. It does not authorize a dependency, code,
MCP configuration, download, database, network operation, or release change.

A future `UpstreamCodeGraphAdapter` should:

- live behind the existing adapter/source boundary and load an exact pinned
  SDK version dynamically;
- use the direct SDK, not `codegraph install`, MCP, a daemon, the upstream
  agent instructions, or a subprocess that can self-upgrade;
- be disabled by default and capability-detected;
- disable telemetry and network before loading the dependency;
- store any approved database only below the ignored PrimeContext state
  directory, never in a user-global location or an unreviewed `.codegraph/`;
- accept only a PrimeContext-produced manifest of already screened regular
  files. If the SDK cannot prove that it avoids reading every rejected path,
  the integration must not ship in that form;
- normalize bounded SDK results into PrimeContext candidates without exposing
  upstream storage or ranking types to Core;
- retain relation provenance, distinguish proved from heuristic edges, and
  reread selected sources through the existing safe reader;
- bind every candidate to the PrimeContext repository ID, worktree digest,
  accepted source hash, adapter version, and an internally computed result
  digest;
- sort and cap all normalized results deterministically;
- remain optional and fail to filesystem, documents, Repo Map, Git, SQLite/FTS,
  and the internal TypeScript graph when unavailable, stale, corrupt, locked,
  incompatible, or over limit;
- fail closed on containment, screening, source identity, provenance, or
  freshness failure.

The existing `LocalCodeGraphV03` contract has only TypeScript/JavaScript
languages and four edge kinds. A multi-language upstream graph must not be
coerced into that schema. A v0.4 design should either emit normalized
`ContextCandidate` values behind an adapter port or define additive,
versioned structural-evidence contracts that preserve language and
provenance.

## 7. Gates before implementation

The proposed adapter requires all of the following:

1. a new specification and accepted ADR changing the current scope;
2. a privacy/threat review covering pre-read exclusions, content retention,
   telemetry, network denial, native artifacts, and malicious source text;
3. a verified allowlisted-source ingestion path;
4. exact dependency/version, license notice, SBOM, provenance, checksum, and
   rollback policy;
5. Node.js 22, 24, and any claimed newer runtime tests on Windows, macOS, and
   Linux, including x64 and supported ARM builds;
6. freshness, TOCTOU, corruption, lock, timeout, crash, and fallback tests;
7. deterministic replay and repeated-index comparison;
8. a controlled evaluation against the internal graph and the no-graph
   fallback on representative repositories and languages;
9. evidence that optional upstream failure never makes the compiler unusable;
10. human approval for the resulting release and license obligations.

Until those gates pass, the PrimeContext TypeScript structural graph remains
the only implemented `codegraph` provider.
