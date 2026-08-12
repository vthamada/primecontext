# ADR-0008: Persist metadata and perform lexical search against live Markdown

**Status:** Accepted

**Date:** 2026-08-11

## Context

PrimeContext v0.2 needs its first document-retrieval slice. The current repository has a small Markdown corpus, while the product requires local operation, provenance, source authority, freshness, security exclusions, and evidence before adding infrastructure.

Persisting document bodies or plaintext token indexes would duplicate repository content and increase the impact of a catalog disclosure. SQLite/FTS, an embedding service, or a new package would add complexity before corpus size or latency demonstrates a need.

## Decision

Persist one bounded JSON Document Catalog containing only document metadata, authority evidence, hashes, provenance, aggregate counts, and a stable catalog digest.

Perform lexical search against the permitted live Markdown corpus. Before returning results, independently recollect the corpus, reapply path/content protections, recompute hashes and catalog metadata, and require the live digest to match the stored catalog.

Use deterministic integer scoring and bounded source excerpts. Do not persist document bodies, summaries derived from bodies, snippets, plaintext search terms, queries, or telemetry.

Keep the implementation as modules in the existing schemas, Core, adapters, and CLI packages. Do not add SQLite/FTS, a seventh package, CodeGraph, Context Scout, MCP, embeddings, or remote services in this slice.

## Consequences

- Search always uses content whose freshness was checked during that command.
- The local catalog has a smaller privacy and duplication footprint.
- Search performs bounded repository reads on every request and is intended for the current small corpus.
- A changed, added, removed, or reclassified document requires `docs index` before search resumes.
- SQLite/FTS or a persisted lexical index may be reconsidered only with measured corpus/latency evidence and a superseding ADR.
- Content-pattern detection reduces common secret exposure but is not complete DLP.
- Same-user link swaps and platform-specific replacement semantics remain documented residual risks.
