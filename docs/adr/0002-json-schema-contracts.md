# ADR-0002: JSON Schema as external contract

**Status:** Accepted  
**Date:** 2026-08-11

## Context

Task Capsules, handoffs, repo maps, configuration, and metrics must be consumable by different agents and languages.

## Decision

Use JSON Schema for external data contracts. In v0.1, keep runtime validation dependency-free with contract-specific structural validators because the contract set is small. Validation happens at ingress/egress boundaries. TypeScript domain types mirror the validated contracts and contract fixtures test parity. Re-evaluate a generic JSON Schema engine when contract scale or interoperability tests justify it.

## Consequences

- Contracts remain language-neutral.
- Invalid agent/tool output is rejected before entering core logic.
- Schema version changes are explicit API changes.
- If schema/type drift or contract count becomes costly, type generation and/or a generic JSON Schema validator can be introduced later without changing the wire format.
