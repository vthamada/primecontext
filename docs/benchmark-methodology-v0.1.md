# PrimeContext v0.1 conservative A/B benchmark methodology

## Purpose

The v0.1 harness compares raw evidence from a normal agent workflow (Arm A) with a PrimeContext-assisted workflow (Arm B). It is designed to expose trade-offs and quality regressions, not to prove that PrimeContext saves tokens or is superior.

The benchmark skeleton is evidence infrastructure. It is not a universal Validated Work per Token formula, a statistical claims engine, or the broader observability system deferred to later roadmap phases.

## Pre-register a comparable task

Before either arm starts, record:

- one task identifier, goal, boundaries, acceptance criteria, and repository commit;
- the same model/agent family, tool permissions, runtime, dependency state, and time limit;
- the test command and independent review rubric;
- which fields will be measured directly and which may be estimated;
- permitted stopping or retry rules.

The intended experimental difference is context preparation: Arm A uses the normal workflow and Arm B uses PrimeContext. If another material condition changes, disclose it and do not treat the pair as causal evidence.

Do not tune Arm B after observing Arm A without recording that intervention. Do not discard failed, slow, or inconvenient runs.

## Evidence captured by v0.1

Record fields when they are available and attributable:

- input, cached input, and output tokens;
- tool calls and file reads;
- context expansions;
- duration;
- selected context size;
- test and review status;
- completion status, when the host can report it reliably;
- rework count.

`codegraph_calls` may remain absent or zero in v0.1; its presence in the contract does not authorize or require CodeGraph integration. Measurements outside the v0.1 schema, such as detailed discovery cost or completion notes, belong in a separate review artifact until a versioned contract explicitly adds them.

Every estimate must be named in `estimated_fields`. A missing measurement stays missing; it must not be replaced with zero. Preserve raw provider/tool evidence outside Git when it contains private data, and use sanitized references in review reports.

Record each validated arm through the CLI:

```bash
primecontext metrics record evidence/arm-a.json
primecontext metrics record evidence/arm-b.json
```

When operating from a source checkout, replace `primecontext` with the Node invocation documented in [CLI installation and usage](cli-usage-v0.1.md).

## Quality gate

The comparison is interpreted conservatively:

| Evidence state | Interpretation |
| --- | --- |
| Arm B test, review, or reported completion is `FAIL` | `QUALITY_REGRESSION` |
| Arm A test, review, or reported completion is `FAIL` | `INSUFFICIENT_QUALITY_EVIDENCE` |
| Either test/review status is not `PASS`, or any reported completion is `UNKNOWN` | `INSUFFICIENT_QUALITY_EVIDENCE` |
| Both arms pass test/review, no reported completion blocks comparison, and they share measurable fields | `COMPARABLE_EVIDENCE` |

`COMPARABLE_EVIDENCE` means only that raw deltas can be reviewed. It is not an optimization verdict. A pair with no shared numeric measurement is insufficient efficiency evidence even when both quality statuses are PASS.

`completion_status` is optional in v0.1. Its absence does not manufacture a failure or PASS, but it must be listed as a measurement gap and prevents broad claims about completed work. A reported `UNKNOWN` makes quality evidence insufficient; a reported Arm B `FAIL` is a regression.

Test counts alone do not establish parity. Review should consider acceptance criteria, behavior, security, maintainability, and rework. An independent reviewer is required when security, context-selection policy, or benchmark methodology materially affects the result.

## Run the comparison

```bash
primecontext benchmark --a evidence/arm-a.json --b evidence/arm-b.json
```

Deltas are reported as `B - A`. For cost-like metrics, a negative delta may be directionally lower, but no field is favorable in isolation. Report the raw values, delta sign convention, quality result, estimate labels, environment, task identity, and known confounders together.

The JSON files under `benchmarks/fixtures/` are deterministic test fixtures. They are not empirical evidence and must never be cited as product performance.

## Repetition and claims

One pair is a diagnostic case study. Repeated tasks are needed before making a generalized statement. v0.1 does not prescribe a universal sample size or significance threshold because workloads and variance differ.

Any future external claim requires, at minimum:

1. a human-approved protocol and claim wording;
2. multiple representative tasks and disclosed exclusions;
3. quality parity with no hidden failed runs;
4. reproducible raw evidence and environment metadata;
5. uncertainty/variance analysis appropriate to the sample;
6. review for privacy, security, and misleading comparisons.

Until those gates are satisfied, use language such as “this run produced these raw deltas.” Do not use “saves,” “improves,” “faster,” “more efficient,” or equivalent superiority language.
