# ADR-0001: TypeScript, Node.js, ESM, and npm workspaces

**Status:** Accepted  
**Date:** 2026-08-11

## Context

PrimeContext must be local-first, agent-agnostic, easy to install, CLI-first, and suitable for future MCP/agent adapters without making those adapters mandatory.

## Decision

Use TypeScript in strict mode on Node.js 22+, ESM modules, and npm workspaces. Test Node 22 and Node 24 in CI when CI is added. Node 24 LTS is the preferred development line.

## Consequences

- One runtime covers core libraries and CLI.
- npm is available with Node, avoiding a mandatory package-manager dependency.
- Future JavaScript/TypeScript MCP integrations remain straightforward.
- Cross-language interoperability is handled by JSON contracts, not by requiring TypeScript consumers.
