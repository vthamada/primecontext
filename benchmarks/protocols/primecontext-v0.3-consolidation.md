# PrimeContext v0.3 consolidation self-hosted A/B protocol

**Status:** DRAFT FOR HUMAN APPROVAL — not executed and not performance evidence
**Prepared:** 2026-08-14

## Question

For bounded maintenance tasks in the PrimeContext repository, how do raw context cost, elapsed time, tool use, rework, and independently reviewed quality differ between a normal repository workflow and the same workflow supplied with PrimeContext's compiled context?

This protocol cannot establish a general causal or superiority claim. Its first purpose is to expose regressions, overhead, confounders, and missing measurements.

## Arms

- **Arm A:** the agent receives the task and normal repository tools. It does not receive a PrimeContext envelope or receipt.
- **Arm B:** the same agent receives the same task and tools plus the compact output of \`primecontext prepare\`. Explicit bounded expansion is allowed only under the pre-registered stopping rule below.

The only intended material difference is PrimeContext context preparation. Indexing and preparation time, I/O, and tool calls count toward Arm B overhead.

## Frozen environment

Before either arm, record the same complete \`MetricRecord.run_environment\` in both records:

- exact repository commit and dirty-worktree digest;
- agent, model, reasoning effort, and tool permissions;
- Node/OS/architecture runtime;
- \`package-lock.json\` SHA-256;
- wall-clock limit;
- exact test command;
- approved review-rubric identifier.

The comparator must return \`INSUFFICIENT_ENVIRONMENT_EVIDENCE\` if either environment is absent or any field differs. No run may be silently repaired after observing the other arm.

## Task strata

Use synthetic or public repository content only. Before execution, an independent reviewer must freeze one task in each stratum:

1. narrow semantic Core correction with a public regression test;
2. state/atomicity or concurrency correction with fault injection;
3. Unicode/structured-input boundary correction;
4. documentation plus CLI-contract alignment;
5. cross-package integration correction requiring Schemas, Core, adapter, and CLI evidence.

Each task must name goal, allowed/forbidden paths, acceptance criteria, test command, time limit, and review rubric. A task is invalidated if either arm starts from a different commit or receives additional private hints.

## Repetition and order

Run at least three independent repetitions per task and arm. Randomize or counterbalance arm order. Use a fresh checkout and fresh ignored PrimeContext state for every repetition. Preserve failed, timed-out, and incomplete runs.

An agent may stop when tests and every acceptance criterion pass and the reviewer has enough evidence to assess the patch. Arm B may request at most two bounded expansions, only for an explicitly missing criterion, source, term, or conflict. Record every expansion and denial.

## Measurements

Record direct values when the host exposes them:

- input/cached-input/output tokens;
- tool calls, file reads, CodeGraph calls, and context expansions;
- selected context tokens;
- end-to-end duration including PrimeContext overhead;
- rework count;
- test, review, and completion status.

Label estimates in \`estimated_fields\`; missing is not zero. Separately record preparation duration, source count, bytes read, index reuse/rebuild, compact-output bytes, receipt bytes, and optional-provider status in the private run artifact. Do not put private source text or prompts in Git.

## Quality review

The reviewer is blinded to arm when practical and scores:

- acceptance-criterion completion;
- correctness and regression coverage;
- security/privacy boundary preservation;
- maintainability and unnecessary change;
- unsupported assumptions and remaining risks.

Arm B failure, lower quality, hidden insufficiency, or unsafe behavior is a regression regardless of lower token or time values. \`COMPARABLE_EVIDENCE\` only permits inspection of raw deltas; it is not a win label.

## Reporting

Publish all valid runs, exclusions with reasons, raw deltas, environment gates, quality outcomes, medians/ranges, and observed confounders. Keep raw private evidence outside Git. No external efficiency, quality, state-of-the-art, or causal wording is permitted without a separate human-approved analysis and disclosure gate.
