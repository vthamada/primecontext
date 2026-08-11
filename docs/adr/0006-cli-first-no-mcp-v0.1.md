# ADR-0006: CLI/library first; no MCP in v0.1

**Status:** Accepted  
**Date:** 2026-08-11

## Context

The product specification explicitly says MCP is not required for v0.1 and value should first be proven through library/CLI behavior.

## Decision

The CLI is the first public integration surface. Core APIs are kept transport-agnostic so a later MCP server can remain a thin adapter.

## Consequences

- The project can benchmark context behavior before tool-protocol complexity.
- MCP does not shape core domain types prematurely.
- Future MCP tools should delegate to the same core services used by the CLI.
