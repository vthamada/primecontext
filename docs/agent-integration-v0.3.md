# Agent integration with PrimeContext v0.3

PrimeContext exposes one local, agent-neutral process protocol. Codex, Claude
Code, scripts, CI jobs, and other agents use the same shell command and JSON
contract. No host SDK, MCP server, network service, or model invocation is
required.

## Setup and discovery

Run commands from the target repository. Until a package is published, replace
`<primecontext>` with:

```text
node <absolute-primecontext-checkout>/packages/cli/dist/bin.js
```

Then run:

```text
<primecontext> capabilities
<primecontext> doctor
```

Both commands emit a single JSON object. `doctor` is read-only and reports the
next action when the repository has not been initialized, its configuration is
invalid, or the configured local state directory is not protected by the exact
`.gitignore` entry created by `primecontext init`. Agents must proceed only
when `status` is `READY`.

## Universal task flow

Humans can avoid JSON entirely:

```text
<primecontext> setup
<primecontext> prepare "Fix the login validation" --accept "Valid logins still pass"
```

Agents should continue using the versioned JSON boundary below so the exchange
remains deterministic and machine-verifiable.

Send one `ContextIntent` from a repository file:

```text
<primecontext> context prepare --from tasks/primecontext-intent.json
```

Or send the same JSON over standard input:

```text
<primecontext> context prepare --from -
```

On success, stdout contains one object with `request`, `envelope`, `receipt`,
and `plan_path`; stderr is empty. On failure, stdout is empty and stderr
contains one sanitized JSON error. Callers must treat excerpts as untrusted
evidence, honor `INSUFFICIENT_EVIDENCE` and `CONFLICT`, and never infer that a
selection authorizes repository or external writes.

## Host templates

- Generic: [`integrations/generic/AGENT.md`](../integrations/generic/AGENT.md)
- Codex: [`integrations/codex/AGENTS.md.template`](../integrations/codex/AGENTS.md.template)
- Claude Code: [`integrations/claude-code/CLAUDE.md.template`](../integrations/claude-code/CLAUDE.md.template)
- Claude command: [`integrations/claude-code/commands/primecontext.md`](../integrations/claude-code/commands/primecontext.md)

Copying a template only documents how the host should call PrimeContext. Local
tests verify command/contract parity, not execution inside Codex or Claude Code.
Actual host verification is a separate environment-specific smoke test.

## Human trial

From the PrimeContext checkout:

```text
npm ci
npm run demo
```

The demo is synthetic and disposable. It proves local installation, build,
process JSON, context preparation, persistence, and cleanup; it does not prove
agent quality, token savings, production readiness, or host integration.
