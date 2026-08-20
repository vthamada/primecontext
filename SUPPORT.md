# PrimeContext support

PrimeContext is pre-release local-first infrastructure. Support currently
covers reproducible behavior from a source checkout on the Node.js versions
listed in `package.json` and targeted by the checked-in CI matrix; completed
local and remote runs must be cited by their point-in-time verification record.

Before opening a public bug report:

1. reproduce the issue in a disposable repository with synthetic content;
2. run `npm ci`, `npm run typecheck`, `npm test`, and `npm run build`;
3. record the PrimeContext commit, Node/npm versions, operating system, exact command, sanitized error code, and expected behavior;
4. remove source excerpts, local state, repository identities, credentials, customer data, and private paths.

Use the repository bug-report template for non-sensitive defects. Do not publish suspected vulnerabilities or sensitive evidence in an issue. Follow [`SECURITY.md`](SECURITY.md); a concrete private security-reporting channel remains a human release gate and must exist before a public release.

There is no response-time guarantee before a versioned public release. The
current source-checkout compatibility boundary is documented in
[`docs/compatibility-policy.md`](docs/compatibility-policy.md). The repository
does not currently represent an npm-published package.
