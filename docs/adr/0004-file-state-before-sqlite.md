# ADR-0004: JSON/JSONL state before SQLite

**Status:** Accepted  
**Date:** 2026-08-11

## Context

The specification permits local SQLite but does not require indexed/query-heavy persistence in v0.1.

## Decision

Use repository config plus local JSON/JSONL generated state. Do not add SQLite until Document Catalog, historical metrics, or retrieval workloads demonstrate a query requirement.

## Consequences

- Zero database setup in v0.1.
- State is inspectable and portable.
- Migration to SQLite remains possible behind persistence ports later.
