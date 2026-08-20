# Contributing to PrimeContext

PrimeContext is still in its v0.x foundation phase. Contributions should remain narrowly aligned with the current roadmap.

Before proposing a feature:

1. confirm it belongs to the current roadmap phase;
2. explain the context-efficiency or correctness problem it solves;
3. avoid introducing a mandatory hosted/paid dependency;
4. include tests and acceptance criteria;
5. include benchmark evidence for optimization claims.

Run before submitting changes:

```bash
npm run typecheck
npm test
npm run build
npm run sample:test
npm run demo
npm run docs:links
npm run package:check
npm run capabilities:check
```

Architecture or contract changes should include an ADR or update an existing ADR.

Use a synthetic disposable fixture for bug reports and tests. Never commit
generated `.primecontext` state, private repository content, customer data,
credentials, or raw security evidence. See [`SUPPORT.md`](SUPPORT.md) and
[`SECURITY.md`](SECURITY.md) before opening an issue.
