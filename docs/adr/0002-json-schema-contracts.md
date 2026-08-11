# ADR-0002: JSON Schema as external contract

**Status:** Accepted  
**Date:** 2026-08-11

## Context

Task Capsules, handoffs, repo maps, configuration, and metrics must be consumable by different agents and languages.

## Decision

Use JSON Schema for external data contracts and Ajv for runtime validation. Validation happens at ingress/egress boundaries. TypeScript domain types mirror the validated contracts and contract fixtures test parity.

## Consequences

- Contracts remain language-neutral.
- Invalid agent/tool output is rejected before entering core logic.
- Schema version changes are explicit API changes.
- If schema/type drift becomes costly, type generation can be introduced later without changing the wire format.
