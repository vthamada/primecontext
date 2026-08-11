# ADR-0005: Safe discovery with fail-open optional integrations

**Status:** Accepted  
**Date:** 2026-08-11

## Context

PrimeContext must never index secrets and must keep functioning if optional tools such as Git metadata or future CodeGraph adapters are unavailable.

## Decision

Block sensitive paths before content reads, skip symlinks in v0.1, execute Git without a shell, and treat unavailable Git metadata as non-fatal for repository mapping.

## Consequences

- Filesystem mapping remains usable in minimal environments.
- Security rules apply at discovery, not only after retrieval.
- Optional intelligence enriches context without becoming a hard dependency.
