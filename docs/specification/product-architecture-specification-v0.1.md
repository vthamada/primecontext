# PrimeContext — Product & Architecture Specification v0.1

**Status:** Draft for implementation  
**Repository (working name):** `primecontext`  
**Project type:** Open-source context engineering infrastructure for AI/software agents  
**Initial reference implementation:** MaxSound Digital Ecosystem  
**Primary goal:** maximize validated work per token by delivering the minimum sufficient, high-signal context required for each agent task.

---

## 1. Executive Summary

PrimeContext is a local-first context engineering runtime designed to improve the efficiency, reliability, and scalability of AI agents working on software projects.

The project addresses a recurring problem in agentic software engineering:

> Agents often consume large amounts of irrelevant or repeated context while rediscovering the same repository structure, documentation, runtime state, logs, decisions, and previous work.

PrimeContext introduces an explicit context-management layer between the project and the agent.

Instead of giving every agent the entire project context, PrimeContext:

1. identifies the task;
2. determines the relevant scope;
3. discovers the most useful context sources;
4. ranks and filters information;
5. applies a context budget;
6. generates a compact Task Capsule;
7. provides additional context only when justified;
8. stores large outputs outside the model context;
9. records a compact handoff after execution;
10. measures whether the workflow actually reduced cost without reducing quality.

PrimeContext is not a new coding agent.

It is infrastructure that helps existing agents work with better context.

---

## 2. Problem Statement

Modern coding agents frequently waste tokens and tool calls on:

- rereading repository structure;
- repeated `find`, `grep`, and file reads;
- loading large documentation sets;
- loading irrelevant architecture decisions;
- repeatedly querying external systems;
- carrying large tool schemas;
- ingesting raw logs;
- keeping long-running sessions alive after their useful context has expired;
- transferring entire conversation histories between agents;
- re-deriving project knowledge already discovered by previous agents.

Larger context windows do not eliminate this problem. They can increase cost and noise if context is not curated.

PrimeContext treats context as a managed computational resource.

---

## 3. Core Thesis

The central hypothesis is:

> Agent performance is improved not by maximizing available context, but by maximizing relevant information density within the context actually consumed.

PrimeContext therefore optimizes for:

**Validated Work per Token**

rather than:

**Minimum Tokens at Any Cost**

The system must never reduce context so aggressively that correctness, safety, or maintainability degrade.

---

## 4. Product Principles

1. **Minimum Sufficient Context** — provide the smallest context set sufficient for correct execution.
2. **Progressive Disclosure** — start small and expand only when evidence shows it is needed.
3. **Source Authority** — preserve provenance and authority of requirements and decisions.
4. **Local First** — no mandatory cloud, paid API, vector database, or hosted dependency.
5. **Agent Agnostic** — do not depend on a single coding-agent vendor.
6. **Adapter Based** — CodeGraph, MCP, GitHub, WordPress and other integrations remain adapters.
7. **Measurable** — benchmark every optimization claim.
8. **Fail Open** — agents can fall back to normal tools if PrimeContext is unavailable.
9. **Explicit Budgets** — treat context as a budgeted resource.
10. **Externalize Large State** — keep large logs, reports, snapshots and raw tool outputs outside model context.

---

## 5. Non-Goals

PrimeContext v0.x will not attempt to become:

- a coding agent;
- an IDE;
- a SaaS;
- a project-management platform;
- a general-purpose LLM framework;
- a vector database;
- a code-search engine replacement;
- a replacement for Git or MCP;
- an unlimited-memory system;
- a cloud orchestration platform.

---

## 6. Target Users

### Primary
- developers using coding agents;
- teams using multi-agent software workflows;
- maintainers of medium and large repositories;
- projects with substantial documentation;
- teams where agents repeatedly rediscover the same state.

### Secondary
- agent-framework developers;
- AI engineering teams;
- CI/CD automation teams;
- context-engineering researchers;
- organizations with large internal software repositories.

---

## 7. Core Use Cases

- Task Context Preparation
- Repository Discovery
- Multi-Agent Handoffs
- Documentation Retrieval
- Runtime State Snapshots
- Tool Output Compaction
- Release Delta Context
- Experience Reuse
- Benchmarking and Observability

---

## 8. Conceptual Architecture

```text
                       AI AGENT / ORCHESTRATOR
                                 │
                             Task Request
                                 │
                         ┌───────▼────────┐
                         │  Task Router   │
                         └───────┬────────┘
                                 │
                         ┌───────▼────────┐
                         │ Context Broker │
                         └───────┬────────┘
                                 │
                         ┌───────▼────────┐
                         │ Context Scout  │
                         └───────┬────────┘
                                 │
        ┌──────────────┬─────────┼──────────┬──────────────┐
        │              │         │          │              │
    Documents         Code      Git       Runtime       Experience
        │              │         │          │              │
  Doc Catalog      CodeGraph   Diff      Snapshots       Memory
  FTS/Search       Filesystem  History    MCP/Tools       Store
        │              │         │          │              │
        └──────────────┴─────────┼──────────┴──────────────┘
                                 │
                         ┌───────▼────────┐
                         │ Rank / Filter  │
                         └───────┬────────┘
                                 │
                         ┌───────▼────────┐
                         │ Context Pruner │
                         └───────┬────────┘
                                 │
                         ┌───────▼────────┐
                         │ Context Budget │
                         └───────┬────────┘
                                 │
                         ┌───────▼────────┐
                         │  Task Capsule  │
                         └───────┬────────┘
                                 │
                              Agent
                                 │
                         Code / Artifacts
                                 │
                         ┌───────▼────────┐
                         │ Compact Handoff│
                         └───────┬────────┘
                                 │
                           Orchestrator
```

---

## 9. Core Domain Model

### Task
A bounded unit of work.

### ContextSource
A provider of potentially relevant information.

Examples:
- filesystem;
- Git;
- Markdown;
- CodeGraph;
- MCP;
- snapshot store;
- experience store.

### ContextItem
One candidate unit of information with source, type, authority, freshness, relevance, token estimate and provenance.

### ContextBudget
Defines how much context may be delivered.

### TaskCapsule
Final bounded context package for an agent.

### Artifact
Persistent output stored outside model context.

### Handoff
Compact structured task result.

### Snapshot
Point-in-time external-system state.

### Experience
Reusable lesson from previous validated work.

### MetricRecord
Execution and context-efficiency measurement.

---

## 10. Core Interfaces

Conceptual contracts:

```text
ContextSource
  discover(task) -> candidates
  retrieve(reference) -> context items

ContextRanker
  rank(task, items) -> ranked items

ContextPruner
  prune(task, items, budget) -> selected items

BudgetPolicy
  allocate(task) -> context budget
  expand(task, reason) -> decision

ArtifactStore
  put(artifact)
  get(reference)

SnapshotProvider
  capture(scope)
  freshness(snapshot)

HandoffStore
  record(handoff)
  get(task_id)

MetricSink
  record(metric)
  query(filters)
```

---

## 11. Task Capsule

Example:

```json
{
  "task_id": "PROP-014",
  "goal": "Implement immutable proposal versioning",
  "module": "proposal",
  "priority": "P1",
  "boundaries": {
    "allowed_paths": ["src/Proposal", "tests/Proposal"],
    "forbidden_paths": ["src/Pricing"]
  },
  "decisions": [
    {
      "source": "ADR-021",
      "summary": "Proposal versions are immutable."
    }
  ],
  "contracts": [
    "ProposalRepositoryInterface",
    "PricingResult"
  ],
  "documents": ["docs/proposal-versioning.md"],
  "code_targets": [
    "ProposalService",
    "ProposalVersion"
  ],
  "acceptance": [
    "Previous versions are not overwritten",
    "New version keeps its own calculated values",
    "Existing tests continue to pass"
  ],
  "context_budget": {
    "initial_tokens": 6000,
    "soft_limit_tokens": 10000,
    "hard_limit_tokens": 16000
  }
}
```

---

## 12. Context Budgets

Experimental defaults:

| Task type | Initial | Soft Limit |
|---|---:|---:|
| Small UI | 3k | 6k |
| Small code fix | 4k | 8k |
| Module feature | 6k | 12k |
| Integration | 8k | 16k |
| QA | 6k | 12k |
| Orchestration | 10k | 20k |

All values must be configurable.

---

## 13. Semantic Repo Map

Generate a compact map describing roles and boundaries, not just file names.

Example:

```text
PricingCalculator
Role:
Authoritative commercial calculation boundary.

Consumes:
SupplierCost
PricingPolicy

Produces:
PricingResult

Must not:
Persist proposals.
```

The map should prioritize important modules, symbols, interfaces, inputs, outputs and boundaries while remaining compact.

---

## 14. Document Catalog

Index project documents independently from source code.

Example:

```json
{
  "id": "DOC-023",
  "path": "docs/architecture/proposals.md",
  "title": "Proposal Architecture",
  "authority": "specification",
  "modules": ["proposal"],
  "releases": ["R2"],
  "topics": ["proposal", "versioning"],
  "summary": "Defines proposal creation and immutable versions.",
  "hash": "sha256..."
}
```

Initial retrieval:
- metadata filters;
- lexical search;
- local FTS.

Embeddings are not required in v0.x.

---

## 15. Document Authority

Suggested precedence:

1. policy;
2. ADR;
3. specification;
4. contract/schema;
5. roadmap;
6. implementation note;
7. generated summary.

Conflicts must be surfaced.

Generated summaries never silently override source documents.

---

## 16. Code Intelligence

Initial adapters:

### Filesystem
Always available.

### Git
Always available in repositories.

### CodeGraph
Optional.

Prefer CodeGraph for:
- callers/callees;
- dependency flows;
- symbol relations;
- blast radius;
- affected tests;
- architecture discovery.

CodeGraph is not a hard dependency.

---

## 17. Context Scout

The Scout explores before the implementation agent receives its package.

Expected result:

```text
Relevant code:
- src/Proposal/ProposalService.php:41-118
- src/Proposal/ProposalVersion.php:1-94

Relevant decisions:
- ADR-021

Relevant contract:
- PricingResult

Relevant test:
- ProposalVersionTest
```

The implementation agent receives the result, not the Scout's exploration history.

---

## 18. Context Pruning

Optimize at:
- document level;
- file level;
- symbol level;
- line/range level where reliable.

Prefer precise ranges over full files when correctness is preserved.

---

## 19. Progressive Disclosure

```text
Orientation Context
      ↓
Implementation begins
      ↓
Missing evidence?
      ↓
Request additional context
      ↓
Broker validates expansion
```

Do not load extra context preemptively.

---

## 20. Compact Handoff

Example:

```json
{
  "task_id": "PROP-014",
  "status": "PASS",
  "commit": "abc123",
  "changed_files": [
    "src/Proposal/ProposalVersion.php"
  ],
  "interfaces_added": [],
  "decisions": [
    "ProposalVersion is immutable after persistence."
  ],
  "tests": {
    "passed": 18,
    "failed": 0
  },
  "risks": [],
  "next_unblocked": [
    "PROP-015"
  ]
}
```

Orchestrators should consume handoffs instead of full agent transcripts.

---

## 21. External Artifacts

Large outputs remain outside model context.

Examples:
- raw logs;
- reports;
- benchmark outputs;
- QA evidence;
- MCP payloads;
- snapshots;
- dependency graphs.

Agents receive a compact result plus artifact reference.

---

## 22. Tool Output Filtering

Preferred pattern:

```text
Tool
→ Local processing
→ Filter / aggregate
→ Useful slice
→ Model
```

Avoid feeding huge raw outputs directly to models.

---

## 23. Runtime State Snapshots

PrimeContext may cache sanitized read-only external state.

Snapshots must include:
- captured_at;
- source;
- scope;
- hash;
- freshness policy.

Live state is mandatory before sensitive writes.

---

## 24. Experience Store

Store reusable lessons selectively.

Good:

```text
experience/
  wordpress/
    elementor-json-write.md
```

Each experience should contain:
- problem;
- cause;
- successful pattern;
- applicability;
- contraindications;
- source task;
- validation status.

Avoid a global memory dump.

---

## 25. Delta Context

Agents should receive changes from known baselines.

Example:

```text
Known baseline:
v0.3.0

Delta:
- commit abc
- ADR-018
- Proposal contract v2
```

---

## 26. Cache-Aware Prompt Architecture

Keep stable prefixes stable:

- policies;
- durable agent role;
- stable project rules;
- stable tool ordering;
- stable contracts.

Keep task-specific data appended later:

- Task Capsule;
- delta;
- selected code;
- current errors.

---

## 27. Deferred Tool Discovery

Do not load every tool for every agent.

Expose or discover tools on demand where host platforms support it.

---

## 28. Agent Lifecycle

Prefer short-lived task agents:

```text
Task Capsule
↓
Agent
↓
Implementation
↓
Tests
↓
Handoff
↓
Agent ends
```

Fresh agents plus structured handoffs are preferred over indefinitely growing sessions.

---

## 29. Worktree Awareness

Requirements:
- task identifies branch/worktree;
- code intelligence reflects that worktree;
- stale main indexes cannot silently represent divergent worktree code;
- Task Capsule includes branch/worktree metadata when applicable.

---

## 30. Security and Privacy

Never index or expose:
- `.env`;
- secrets;
- API keys;
- passwords;
- private dumps;
- cookies;
- credentials;
- client PII;
- private uploads.

Core operation is local-first.

No remote telemetry by default in v0.x.

---

## 31. Observability

Measure where available:
- input tokens;
- cached input;
- output tokens;
- tool calls;
- file reads;
- CodeGraph calls;
- context expansions;
- duration;
- selected context size;
- test status;
- review status;
- rework count.

Estimated values must be labeled as estimates.

---

## 32. Core Metrics

### Context Precision
Relevant retrieved context / total retrieved context.

### Discovery Cost
Tokens/tool calls before first correct edit.

### Tool Tax
Context spent on schemas and tool outputs.

### Coordination Tax
Context spent coordinating agents.

### Rework Cost
Resources spent correcting previous work.

### Validated Work per Token
Primary strategic metric family.

---

## 33. Benchmark Framework

Compare:

### Arm A
Normal agent workflow.

### Arm B
PrimeContext-assisted workflow.

Measure:
- tokens;
- cache;
- tool calls;
- files read;
- time;
- tests;
- review quality;
- rework;
- completion.

No savings claims without benchmark evidence.

---

## 34. Reference Implementation — MaxSound

MaxSound is the first production reference implementation.

PrimeContext Core must not contain MaxSound business logic.

MaxSound-specific rules stay in:
- configuration;
- private integration;
- adapter/example where sanitized.

---

## 35. Adapter Architecture

Initial:

```text
filesystem
git
markdown
codegraph
mcp
snapshot
experience
```

Potential later adapters:

```text
github
notion
linear
jira
confluence
serena
supabase
```

---

## 36. Initial Repository Structure

```text
primecontext/
│
├── packages/
│   ├── core/
│   ├── schemas/
│   ├── cli/
│   ├── repo-map/
│   ├── doc-catalog/
│   ├── task-capsule/
│   ├── handoff/
│   ├── artifact-store/
│   ├── benchmark/
│   └── adapters/
│       ├── filesystem/
│       ├── git/
│       ├── markdown/
│       └── codegraph/
│
├── examples/
│   └── sample-project/
│
├── benchmarks/
├── docs/
├── AGENTS.md
├── CONTRIBUTING.md
├── SECURITY.md
├── CODE_OF_CONDUCT.md
├── LICENSE
└── README.md
```

Do not over-fragment before package boundaries are proven.

---

## 37. CLI

Initial CLI:

```bash
primecontext init
primecontext map
primecontext docs
primecontext task <task-id>
primecontext inspect <task-id>
primecontext handoff validate <file>
primecontext benchmark
primecontext metrics
```

A shorter binary alias may be introduced after public naming is finalized.

---

## 38. MCP

MCP is not required for v0.1.

First prove value through library/CLI.

Potential future tools:
- `context_for_task`
- `context_search_docs`
- `context_get_contracts`
- `context_get_snapshot`
- `context_record_handoff`
- `context_metrics`

Keep the MCP surface intentionally small.

---

## 39. Technical Constraints

Prefer:
- existing project runtime;
- local SQLite where needed;
- JSON/JSONL artifacts;
- deterministic processing;
- simple local FTS;
- standard schemas.

Avoid initially:
- cloud DB;
- remote vector DB;
- Redis;
- Elasticsearch;
- paid embeddings;
- hosted RAG;
- distributed queues.

---

## 40. Roadmap

### v0.1 — Foundations
- schemas;
- Task Capsule;
- Compact Handoff;
- Context Budget;
- Semantic Repo Map;
- CLI;
- basic metrics;
- benchmark harness skeleton.

### v0.2 — Retrieval
- Document Catalog;
- local search;
- CodeGraph adapter;
- Context Scout;
- ranking.

### v0.3 — Context Runtime
- progressive disclosure;
- pruning;
- artifact store;
- output filtering;
- delta context.

### v0.4 — Observability
- benchmark runner;
- metrics;
- A/B reports;
- quality comparison.

### v0.5 — Integration
- MCP server;
- Codex integration;
- generic agent examples;
- snapshots.

### v0.6 — Memory
- Experience Store;
- selective retrieval;
- task-history deltas.

### v1.0 prerequisites
- stable API;
- documented architecture;
- production use in MaxSound;
- at least two additional pilot projects;
- benchmark evidence;
- security review;
- easy installation;
- migration policy;
- contributor guide.

---

## 41. v0.1 Definition of Done

- [ ] repository created;
- [ ] package structure established;
- [ ] Task Capsule schema implemented;
- [ ] Compact Handoff schema implemented;
- [ ] Context Budget implemented;
- [ ] Semantic Repo Map generated;
- [ ] CLI works locally;
- [ ] tests pass;
- [ ] benchmark harness skeleton exists;
- [ ] secrets are excluded;
- [ ] documentation exists;
- [ ] MaxSound can consume a generated Task Capsule;
- [ ] no paid service required.

---

## 42. v0.1 Non-Goals

Do not block v0.1 on:
- CodeGraph integration;
- MCP;
- embeddings;
- AI summaries;
- web UI;
- hosted service;
- automatic agent orchestration;
- adaptive memory;
- ML-based line pruning.

---

## 43. Open Source Strategy

Design the project to become public.

Before public release:
- choose license;
- create CONTRIBUTING;
- create SECURITY;
- create CODE_OF_CONDUCT;
- publish architecture overview;
- include examples;
- publish benchmark methodology;
- publish roadmap.

Never publish MaxSound secrets or business data.

---

## 44. License

Temporary decision: not frozen until public-release review.

Candidates:
- Apache-2.0;
- MIT.

Apache-2.0 should receive serious evaluation because of explicit patent terms.

---

## 45. Naming

Working repository name:

```text
primecontext
```

The public brand remains unresolved.

Naming must not delay implementation.

---

## 46. Naming Freeze

No further branding work is required before v0.1.

Revisit after:
- first working release;
- MaxSound integration;
- initial A/B benchmark;
- clearer product differentiation.

---

## 47. Implementation Strategy

Recommended order:

```text
Schemas
↓
Task Capsule
↓
Compact Handoff
↓
Context Budget
↓
Semantic Repo Map
↓
CLI
↓
Tests
↓
MaxSound pilot
↓
Benchmark
```

Only then move to retrieval intelligence.

---

## 48. Development Method

Each feature requires:
- explicit scope;
- tests;
- acceptance criteria;
- documentation;
- independent review when security/context-selection/benchmark methodology is affected.

---

## 49. Final Product Statement

PrimeContext is an open-source context engineering runtime that helps AI agents do more correct work with less irrelevant context.

Its purpose is not to starve agents of information.

Its purpose is to provide:

> **the right context, to the right agent, at the right time, within the right budget.**

The long-term objective is:

> **maximize validated work per token.**
