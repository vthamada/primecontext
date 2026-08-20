# PrimeContext release process

**Status:** release-candidate procedure; no release, package publication, or license decision is authorized by this document.

## 1. Independent gates

A technical candidate, public-source release, npm publication, and product claim are separate decisions. A successful build or merge crosses none of the later gates automatically.

Before public redistribution or npm publication, an authorized human must record:

- the SPDX license, full license text, notices, dependency obligations, and any patent decision;
- the final public name and package ownership/namespace;
- the private security-reporting channel and response policy;
- privacy/disclosure approval for repository documentation and examples;
- supported platforms and Node.js versions;
- versioning, compatibility, migration, deprecation, and rollback policy;
- exact benchmark or product wording, if any, backed by approved evidence;
- npm organization access, maintainers, provenance, two-factor authentication, and release authority.

## 2. Technical release candidate

From a clean checkout of the exact candidate commit:

```bash
npm ci --ignore-scripts
npm run typecheck
npm test
npm run build
npm run sample:test
npm run demo
npm run docs:links
npm run package:check
npm run capabilities:check
npm ls --all
git diff --exit-code --check
```

The CI matrix must pass on Node.js 22.13 and Node.js 24 on Linux and Windows. Inspect the complete staged diff, dependency tree, generated contracts, and dry-run tarball manifests. Run a secret/content scan against the exact immutable candidate and keep raw private evidence outside Git.

The verification record must name the commit, tree, runtime matrix, commands, counts, failures, package contents, known limitations, migration/rollback behavior, and independent security-review result. A dirty working-tree record is not immutable release evidence.

## 3. Package preparation

Keep every workspace `private: true` until the license, package topology, public package names, and maintainers are approved. Then, in a dedicated release change:

1. choose which workspaces are public and remove `private` only there;
2. add the approved `license`, `publishConfig`, version, and compatibility metadata;
3. pin or constrain runtime and optional dependencies according to the approved support matrix;
4. generate an SBOM or equivalent dependency/license inventory;
5. repeat `npm pack --dry-run --json --workspaces` and inspect every entry;
6. install the produced tarballs in a disposable project and run the documented CLI flow;
7. verify provenance/signing configuration without publishing;
8. obtain the recorded human release approval.

## 4. Publication and rollback

Publication must use an immutable reviewed commit and tag. Publish one time from the approved environment; do not automatically retry an ambiguous registry response. Read back package metadata and tarball integrity from the registry before announcing availability.

For a bad release, prefer an immediate deprecation notice and a corrected patch. Unpublishing is registry-policy-dependent and is not the default rollback mechanism. Preserve the incident record and never rewrite or conceal benchmark or verification failures.
