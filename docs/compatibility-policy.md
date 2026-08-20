# PrimeContext compatibility and deprecation policy

**Status:** pre-release policy for source checkouts; it does not promise a public package or stable v1 API.

## Runtime matrix

The package manifests require Node.js 22.13 or newer for the supported base
CLI and safe filesystem/document fallback. The checked-in continuous-
integration workflow is configured to exercise Node.js 22.13 and Node.js 24 on
Linux and Windows; remote results belong in a commit-bound verification record.
The in-process SQLite API emits an unavoidable experimental warning before its
release-candidate transition, so PrimeContext treats that optional accelerator
as unavailable before Node.js 24.15 (and before 25.7 on the following line)
instead of contaminating the process-JSON channel or mutating global warning
state. Those runtimes remain fully supported through fallback; warning-free
release-candidate SQLite builds must pass the same local and remote matrix
before a release claim. A newer runtime satisfying `engines` is not considered
verified until it passes that matrix.

Optional TypeScript CodeGraph and SQLite/FTS capabilities may be unavailable. Their absence must retain the safe filesystem/document fallback and appear in diagnostics rather than breaking import of the base CLI.

## Contract compatibility

- v0.1 and v0.2 JSON contracts and commands are compatibility baselines during v0.3 consolidation.
- v0.3 additions are versioned and additive. Optional fields must preserve the previous behavior when absent.
- Physical JSON contracts and runtime validators must agree. Generated contracts are checked in and must be regenerated and verified in the same change.
- Persisted state with an unsupported schema version fails with a stable sanitized error; it is never silently rewritten.
- Rebuildable indexes may be replaced after a successful bounded rebuild. Non-rebuildable records require a documented side-by-side migration and rollback path before their schema changes.

## Deprecation

Before v1, an API may change only through an accepted specification, compatibility test, migration note, and changelog entry. Existing behavior is not removed in the same release that first marks it deprecated unless preserving it would create a demonstrated security defect.

After the first public release, normal non-security removal requires:

1. a deprecation notice in the CLI/API and changelog;
2. a supported replacement and migration instructions;
3. at least one documented compatibility window;
4. a major-version change when the public contract is incompatible.

Security fixes may narrow invalid or unsafe input without a compatibility window. The release record must identify the affected behavior and rollback implications.
