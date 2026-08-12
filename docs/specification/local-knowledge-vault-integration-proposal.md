# Local Knowledge Vault Integration Proposal

**Status: PROPOSAL — NOT AUTHORIZED.**

This document records a possible future integration. It is not an accepted
PrimeContext implementation specification and does not authorize reading an
external path, changing CLI behavior, adding an Obsidian dependency, launching
an application, writing a vault, syncing data, using a network, or publishing a
package. A separate accepted specification and ADR are required before code is
changed.

## 1. Motivation and product boundary

Many people keep project decisions, research, meeting notes, runbooks, and
design rationale in a local Markdown knowledge vault. PrimeContext could use
explicitly approved notes as another evidence source while remaining context
infrastructure rather than becoming a note editor, synchronization service,
personal knowledge manager, or global memory system.

Obsidian is a useful compatibility target because its official documentation
states that notes are Markdown-formatted plain-text files and a vault is a
folder on the local filesystem. See
[How Obsidian stores data](https://obsidian.md/help/data-storage). The proposed
boundary is therefore a **generic local Markdown vault adapter** with optional
Obsidian interoperability, not an Obsidian plugin and not an Obsidian-only
storage format.

## 2. What works today

PrimeContext already provides limited Obsidian-compatible behavior when the
vault is the repository root or a directory below it:

- the v0.3 safe filesystem fallback considers `.md` and `.mdx` files anywhere
  below the repository root, subject to normal limits, excludes, safe reads,
  UTF-8 validation, content screening, hashes, and snapshot freshness;
- a human can point `primecontext prepare` at a repository-relative note path
  with `--path` and terms, or an agent can provide the equivalent
  `ContextIntent` hints;
- ordinary Markdown note text can become lexical evidence in a context
  envelope;
- when the optional v0.3 hybrid index is available, screened note text may be
  copied into the ignored repository-local `.primecontext/context/index.sqlite`;
  selected bounded excerpts may also be retained in the ignored task-plan
  state under `.primecontext/context/plans/`;
- `.obsidian` is a blocked directory name and cannot enter discovery or
  context. Obsidian documents that `.obsidian` contains vault settings,
  themes, hotkeys, and community-plugin configuration; see the official
  [configuration-folder documentation](https://obsidian.md/help/Files%2Band%2Bfolders/Configuration%2Bfolder).

This is v0.3 filesystem fallback behavior, not an expansion of the v0.2
Document Catalog. The v0.2 catalog remains limited to `docs/` Markdown and
canonical root documents.

Current support does **not**:

- read a vault outside the repository root;
- parse or resolve Obsidian wikilinks, embeds, backlinks, block references,
  tags, properties, Canvas files, Bases, attachments, or graph metadata;
- use the Obsidian metadata cache, CLI, plugin API, URI protocol, Sync, or
  Publish;
- watch a vault or incrementally synchronize it;
- preserve a distinct knowledge-note authority class for arbitrary Markdown;
- infer that note text is policy, truth, instruction, or authorization;
- write, rename, delete, append to, or reorganize any note.

## 3. Proposed future capability

A future adapter could make an external local vault available as an optional,
read-only context source. It must remain separate from the default repository
corpus and must never be discovered implicitly from home directories, recent
Obsidian vault lists, global Obsidian settings, environment variables, or
mounted/cloud folders.

The user would explicitly identify one exact vault root. The conceptual flow
is:

1. **Preview:** resolve and inspect the requested root without persisting an
   authorization or note body. Show bounded candidate/exclusion counts, total
   bytes, supported extensions, security rules, and the fact that selected
   excerpts may later enter normal PrimeContext task state.
2. **Snapshot:** collect only eligible regular Markdown files and produce a
   canonical manifest of vault-relative paths, sizes, and source hashes plus a
   manifest digest.
3. **Confirmation:** require an exact, one-time confirmation bound to the
   resolved root, manifest digest, include/exclude rules, limits, and intended
   repository. A changed manifest invalidates the confirmation.
4. **Use:** query only the confirmed snapshot, return bounded candidates, and
   reread every selected note through the safe reader before compilation.
5. **Freshness:** reject a result if a selected file, accepted-source manifest,
   or vault snapshot changed. Recollection and a new preview are required when
   scope changes.
6. **Revocation:** remove the local grant and metadata without touching the
   vault. Revocation must be idempotent and independently verifiable.

Command names and contract shapes are intentionally deferred. Illustrative
terms such as `vault preview`, `vault authorize`, and `vault status` are not
reserved public interfaces.

## 4. Read-only and no-network contract

The future adapter must be read-only with respect to the vault:

- no note, attachment, configuration, cache, lock, sidecar, database, or
  `.obsidian` entry may be created, changed, renamed, or deleted;
- no filesystem watcher may obtain write privileges;
- no Obsidian CLI write command, plugin API, `new` URI, `append`, `prepend`,
  Sync, Publish, Git operation, cloud API, or third-party synchronization tool
  may be invoked;
- no telemetry, update check, hosted service, remote model, or network request
  is permitted;
- no repository source or vault note may be sent to an external process or
  service.

PrimeContext's own existing task artifacts remain governed by the normal
ignored repository-local state boundary. The proposed vault catalog should
persist only grant metadata, relative paths, sizes, hashes, snapshot digests,
and bounded diagnostics—never an entire note body. If a note is selected, its
bounded excerpt may enter the same context envelope/plan store as any other
selected source; the preview must disclose this before confirmation.

"No network request" describes PrimeContext behavior. A vault located in
OneDrive, Dropbox, iCloud, an on-demand filesystem, or another sync provider
may cause the operating system or that provider to hydrate or transmit files
when they are read. PrimeContext cannot prove network isolation in that case.
A strict offline mode must require an already materialized local vault and
document that external sync is disabled. Obsidian's own
[security](https://obsidian.md/security) and
[privacy](https://obsidian.md/privacy) statements describe Obsidian; they do
not automatically extend to PrimeContext or third-party sync providers.

## 5. Discovery and security requirements

External-vault access creates a broader trust boundary than repository-local
reads. A future implementation must:

- accept one explicit absolute vault root only at the preview boundary and
  canonicalize it before use;
- bind the resulting grant to that exact canonical root without exposing the
  absolute path in ordinary receipts or logs;
- reject a root that is missing, non-directory, a filesystem root, the user's
  home directory, a PrimeContext workspace root, or otherwise broader than the
  exact approved vault;
- reject symbolic links, junctions, reparse-point escapes, hard-link identity
  surprises where detectable, non-regular files, devices, sockets, and path
  traversal;
- block `.obsidian`, alternate dot-prefixed Obsidian configuration folders,
  `.git`, `.primecontext`, credential stores, plugin code/configuration,
  backups, trash, caches, and all existing sensitive names/extensions before
  content reads;
- apply user excludes before reads and never allow an include rule to revive a
  hard security exclusion;
- enforce hard maximum depth, path length, file count, one-file bytes, total
  bytes, excerpt bytes, and cooperative deadline;
- perform stable bounded reads with strict UTF-8 decoding and before/after file
  identity checks;
- content-screen each bounded note before it becomes accepted evidence;
- redact absolute paths, note text, secret matches, and personal data from
  errors and audit records;
- treat all note text, frontmatter, links, HTML, code blocks, and embeds as
  untrusted data, never as instructions, tool calls, authority, or permission;
- preserve note provenance and avoid assigning policy authority without an
  explicit repository-owned authority rule;
- fail closed on containment, screening, identity, or freshness uncertainty;
- leave the existing repository-only fallback usable when the vault adapter is
  absent, denied, revoked, stale, timed out, or over limit.

The `.obsidian` exclusion is mandatory even though Obsidian is local-first.
The official data-storage documentation explains that this directory can hold
preferences and community-plugin configuration. Those are application state,
not project evidence.

## 6. Snapshot and freshness model

The proposed `KnowledgeVaultSnapshot` should contain only bounded metadata:

- a versioned schema identifier;
- an opaque local grant ID;
- an opaque vault ID derived without publishing its absolute path;
- the associated PrimeContext repository ID;
- normalized vault-relative Markdown paths;
- byte sizes and SHA-256 source hashes;
- explicit include/exclude rule digests;
- accepted, excluded, oversized, invalid, and sensitive counts;
- the complete accepted-source manifest digest;
- the collection implementation/version and deterministic snapshot digest.

Modification time alone is not freshness evidence. Query and selection must
verify the current accepted-source manifest, then stably reread each selected
note and compare its hash. Added, removed, renamed, reclassified, newly blocked,
or changed notes make the snapshot stale. A stale external vault must not be
silently refreshed because doing so could broaden the confirmed information
scope.

## 7. Optional Obsidian URI handoff

The official [Obsidian URI documentation](https://obsidian.md/help/Extending%2BObsidian/Obsidian%2BURI)
defines `obsidian://open` for opening a vault or an existing note. A future UI
convenience may produce an encoded URI for a selected, already authorized note:

```text
obsidian://open?vault=<encoded-vault-id-or-name>&file=<encoded-relative-note>
```

This handoff must obey all of the following:

- URI support is optional and never required for retrieval;
- default behavior returns or displays the URI but does not launch it;
- opening Obsidian is an external GUI action and requires an explicit user
  request or confirmation at the time of launch;
- only the `open` action is allowed—never `new`, `daily`, `unique`, `append`,
  `prepend`, `overwrite`, callback execution, or content/clipboard parameters;
- prefer vault ID or configured vault name plus a vault-relative file over the
  absolute `path` parameter, which can disclose local filesystem structure;
- all components must be correctly percent-encoded and length-bounded;
- the URI carries no note content, query, secret, token, or PrimeContext state;
- launching a URI does not prove note identity or freshness and cannot replace
  the snapshot/hash checks;
- opening a note may activate the user's installed Obsidian environment,
  including community plugins or embedded content, so PrimeContext must not
  claim that the launch itself is side-effect-free.

## 8. Threats and required responses

| Threat | Required response |
| --- | --- |
| Note contains prompt injection or fake policy | Treat text as quoted evidence only; retain provenance and never derive permission |
| Vault contains credentials or personal material | Block sensitive paths before reads, content-screen bounded reads, and require explicit scope preview |
| Symlink/junction escapes the vault | Reject links/reparse components and verify canonical containment and file identity |
| File changes during or after collection | Stable read plus exact manifest and selected-source hash checks; fail stale |
| New notes silently broaden scope | Invalidate the snapshot and require a new preview/confirmation |
| Synced/cloud placeholder triggers transfer | Document residual risk; require materialized local files for strict offline use |
| Absolute path leaks through output | Use opaque vault/grant IDs and vault-relative paths; sanitize errors |
| URI opens an unsafe app environment | Never auto-launch; explicit action, `open` only, and warn about local plugins/embeds |
| Vault adapter fails or is unavailable | Preserve repository-local fallback and report bounded source failure |
| Revocation leaves note content behind | Store metadata-only catalog; remove grant metadata and rely on existing plan-retention policy for previously selected excerpts |

## 9. Explicitly out of scope

- writing or reorganizing notes;
- bidirectional synchronization;
- Obsidian Sync, Publish, account, plugin, or metadata-cache integration;
- invoking the Obsidian CLI for retrieval or mutation;
- automatic home-directory or vault discovery;
- cloud vaults, remote APIs, network filesystems, or hosted indexing;
- importing `.obsidian`, plugin configuration, Canvas, Bases, attachments, or
  arbitrary binary files;
- turning the vault into global/adaptive memory;
- AI-generated summaries, automatic policy extraction, or authority inference;
- silently sharing one user's vault with another repository, user, agent, or
  process;
- using Obsidian URI for creation, mutation, callbacks, search ingestion, or
  freshness verification.

## 10. Gates before authorization

Implementation requires:

1. an accepted normative specification and ADR for the external-path trust
   boundary;
2. privacy and threat review, including personal notes, prompt injection,
   cloud hydration, URI launching, and residual state;
3. explicit schemas for preview, one-time confirmation, grant, snapshot,
   candidate provenance, revocation, and sanitized diagnostics;
4. Windows junction/reparse, POSIX symlink, hard-link, case-folding, Unicode,
   TOCTOU, oversized, invalid UTF-8, secret, and stale-snapshot tests;
5. denied-network tests and evidence that no Obsidian/Sync/plugin process is
   invoked;
6. before/after vault hashes proving preview, retrieval, status, and revocation
   do not modify the vault;
7. recovery and rollback evidence for PrimeContext's own grant metadata;
8. deterministic repeatability and fallback tests;
9. a separately confirmed manual smoke test for the optional `open` URI;
10. human approval of the privacy UX, state retention, and release scope.

Until these gates pass, supported use remains repository-local Markdown with
`.obsidian` excluded.
