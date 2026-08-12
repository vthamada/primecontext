# PrimeContext v0.2 document retrieval security limits and residual risks

This document complements [`SECURITY.md`](../SECURITY.md) and the [v0.1 security record](security-and-residual-risks-v0.1.md). It applies only to the local Document Catalog and lexical-search slice.

## Established controls

- the corpus is limited to Markdown below `docs/` and six canonical root Markdown filenames;
- built-in sensitive paths and configured excludes are applied by the bounded repository walker before document reads;
- repository containment rejects absolute paths, traversal, ADS/colon aliases, controls, Windows device names, trailing-dot/space aliases, symlinks, and junctions;
- source reads use a stable file handle, strict UTF-8 decoding, before/after identity and size checks, and bounded allocation;
- binary/control-laden, oversized, invalid-UTF-8, or high-confidence sensitive-content documents are omitted without returning their path or matched value;
- sensitive-content checks cover private-key blocks, authorization/Bearer tokens, common labelled credential values, labelled client PII, and checksum-valid labelled CPF/CNPJ values;
- the persisted catalog contains metadata and hashes only, never bodies, excerpts, plaintext terms, or a lexical index;
- the stored catalog is treated as untrusted input and receives byte, structural, schema, path, cross-field, digest, and freshness validation;
- search recollects the permitted live corpus and requires canonical digest, candidate/omitted counts, and source hashes to agree before returning content;
- the temporary catalog is exclusively created, written, flushed with `fsync`, closed, revalidated, and renamed within the same directory;
- invalid queries are rejected before catalog or corpus I/O.

## Hard ceilings

| Resource | Ceiling |
|---|---:|
| eligible Markdown candidates per collection | 4,096; accepted entries cannot exceed this |
| one Markdown candidate | 512 KiB |
| cumulative bounded bytes read from non-oversize candidates | 64 MiB; accepted source bytes cannot exceed this |
| serialized catalog | 8 MiB |
| parsed catalog structure | 500,000 JSON values / depth 64 |
| query | 1,024 UTF-8 bytes / 32 terms |
| values per filter | 32 |
| path | 1,024 Unicode code points |
| module/topic/filter value | 128 Unicode code points |
| returned hits | 50 |
| excerpt | 400 Unicode code points / 6 lines |

The existing walker limits of 100,000 discovered entries, depth 64, and 1,024 configured excludes remain active.

## Residual risks

### Content detection is not DLP

The detector intentionally targets high-confidence indicators. It cannot prove that ordinary prose, an unfamiliar secret format, an unlabelled identifier, source code, or proprietary information is safe. A permitted document can still contain sensitive material that becomes a live excerpt. Keep secrets out of repositories and use configured excludes for project-specific sensitive documentation.

### Paths, titles, and stdout can disclose context

Accepted repository-relative paths, first-H1-derived titles, authority metadata, sizes, hashes, catalog digest, and optional Git branch/head are persisted in `.primecontext/`. Titles can themselves contain sensitive prose. Search emits the original query, normalized terms, metadata, and excerpts to stdout. Shell history, terminal capture, redirection, CI logs, or copied JSON can make those values durable. Review and protect output as repository data.

### Local state is not encrypted or isolated

`.primecontext/` is ignored by Git by default, but it is ordinary local filesystem state. It is not encrypted, an access-control boundary, a backup, or a sandbox. If `state_dir` is customized, the operator must ensure the corresponding directory is excluded from Git. Operating-system permissions, retention, backup, and secure-deletion policy remain operator responsibilities.

### Portable link checks retain a TOCTOU window

PrimeContext verifies existing path components and stable file identity immediately around reads and writes. Portable Node.js APIs still cannot bind every Windows directory-component check and later operation into one atomic no-follow transaction. A malicious same-user process may race path-component replacement. Do not run elevated on an adversarial repository; use an OS/container boundary when concurrent mutation is in scope.

### Catalog replacement is single-writer

Collection, validation, serialization, temporary creation/write/`fsync`, and rename failures do not intentionally replace the prior catalog. Once rename succeeds, a later path revalidation failure cannot restore the old bytes. The operation does not `fsync` the directory and cannot guarantee recovery across every filesystem or power-loss behavior. It also provides no multi-writer coordination or protection from a same-user actor replacing files concurrently. Run one index writer per state directory.

### Lexical retrieval has no semantic safety guarantee

Module and topic identifiers are inferred from paths. Authority is a deterministic convention and tie-breaker, not proof that content is current, correct, approved, or safe to execute. Same-title/different-hash conflicts are surfaced but never resolved. Operators and downstream agents must inspect provenance and apply human governance.

## Operator checklist

1. confirm the target root, configured excludes, and `state_dir`;
2. run with least privilege and no concurrent index writer;
3. inspect catalog metadata before sharing it;
4. avoid redirecting queries, terms, metadata, or excerpts into public or retained logs;
5. re-index after every `CATALOG_ERROR` rather than bypassing freshness;
6. keep `.primecontext/`, raw results, credentials, private exports, and logs out of Git;
7. use an isolation boundary for adversarial repositories.

No remote telemetry, hosted service, embedding, vector store, MCP, or external content processor is used by this slice.
