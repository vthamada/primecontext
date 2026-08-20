import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  validateContextEnvelope,
  validateOutcomeReceipt,
  validateSelectionReceipt,
  type ContextPlanRequestV03,
} from '@primecontext/schemas';
import {
  compileContext,
  createContextCandidateId,
  hashContextJson,
  hashContextText,
  PrimeContextError,
  type ContextCandidateV03,
} from '@primecontext/core';
import {
  contextAblateCommand,
  contextExpandCommand,
  contextIndexCommand,
  contextInspectCommand,
  contextOutcomeCommand,
  contextPlanCommand,
  contextReplayCommand,
  compilePreparedContext,
  createContextPreparationObservation,
  defaultConfig,
  initCommand,
  prepareContextRequest,
} from './index.js';

async function contextFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'primecontext-context-'));
  await mkdir(join(root, 'docs'), { recursive: true });
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'context-fixture', type: 'module' }));
  await writeFile(join(root, 'README.md'), '# Context Fixture\n\nProof-carrying context compiler.');
  await writeFile(join(root, 'docs', 'security.md'), '# Security policy\n\nThe compiler emits a selection receipt.');
  await writeFile(join(root, 'src', 'compiler.ts'), [
    'export interface Receipt { digest: string }',
    'export function compileContext(): Receipt {',
    "  return { digest: 'deterministic' };",
    '}',
  ].join('\n'));
  return root;
}

function requestValue(
  worktreeDigest = `sha256:${'a'.repeat(64)}`,
  repositoryId = 'context-fixture',
): ContextPlanRequestV03 {
  return {
    schema_version: '0.3',
    task: {
      task_id: 'CTX-VERTICAL-001',
      task_type: 'module_feature',
      goal: 'Compile proof-carrying context',
      query: 'compiler selection receipt security',
      acceptance_criteria: [
        { id: 'AC-1', text: 'Compiler evidence is selected', required_terms: ['compiler'] },
        { id: 'AC-2', text: 'A selection receipt is represented', required_terms: ['receipt'] },
      ],
      hints: { paths: ['src/compiler.ts'], symbols: ['compileContext'], terms: ['security'] },
    },
    budget: { max_items: 8, max_bytes: 32_768, max_estimated_tokens: 8_192 },
    snapshot: { repository_id: repositoryId, worktree_digest: worktreeDigest },
    policy_version: '0.3-default',
  };
}

type FilesystemPolicyCapacityScenario = 'count' | 'total-bytes' | 'oversize-policy' | 'provider' | 'aggregate';

interface FilesystemPolicyCapacityResult {
  scenario: FilesystemPolicyCapacityScenario;
  policy_path: string;
  target_path: string;
  observation_policy_present: boolean;
  policy_selected: boolean;
  policy_mandatory?: boolean;
  target_selected: boolean;
  required_selected: boolean;
  evidence_status: 'READY' | 'INSUFFICIENT_EVIDENCE' | 'CONFLICT';
  security_failure: boolean;
  source_failure_codes: string[];
  truncation_reasons: string[];
}

function runFilesystemPolicyCapacityScenario(
  scenario: FilesystemPolicyCapacityScenario,
): FilesystemPolicyCapacityResult {
  const contextModuleUrl = new URL('./context.js', import.meta.url).href;
  const commandsModuleUrl = new URL('./commands.js', import.meta.url).href;
  const program = `
    import { mock } from 'node:test';
    import { mkdtemp, rm } from 'node:fs/promises';
    import { tmpdir } from 'node:os';
    import { dirname, join } from 'node:path';
    import * as adapters from '@primecontext/adapters';
    import { createContextCandidateId, hashContextText } from '@primecontext/core';

    const scenario = ${JSON.stringify(scenario)};
    const maxSourceBytes = 1024 * 1024;
    const maxTotalBytes = 256 * 1024 * 1024;
    const entries = [];
    const documentEntries = [];
    const addFile = (path, logicalSize, content) => entries.push({
      relative_path: path,
      kind: 'file',
      size_bytes: logicalSize,
      logical_size: logicalSize,
      content,
    });
    let policyPath = 'scope/AGENTS.md';
    let targetPath = 'scope/0-target.py';
    let targetTerm = 'policycapacityproof';

    if (scenario === 'count') {
      for (let index = 0; index < 16_383; index += 1) {
        addFile('a/' + String(index).padStart(5, '0') + '.py', 1, 'x');
      }
      addFile(targetPath, new TextEncoder().encode(targetTerm).byteLength, targetTerm);
      addFile(policyPath, 18, '# Applicable policy');
    } else if (scenario === 'total-bytes') {
      for (let index = 0; index < 255; index += 1) {
        addFile('a/' + String(index).padStart(4, '0') + '.py', maxSourceBytes, 'x');
      }
      const targetBytes = new TextEncoder().encode(targetTerm).byteLength;
      addFile('a/9999-tail.py', maxSourceBytes - targetBytes, 'tail');
      addFile(targetPath, targetBytes, targetTerm);
      addFile(policyPath, 18, '# Applicable policy');
    } else if (scenario === 'oversize-policy') {
      addFile(targetPath, new TextEncoder().encode(targetTerm).byteLength, targetTerm);
      addFile(policyPath, maxSourceBytes + 1, '# Applicable policy');
    } else if (scenario === 'provider') {
      for (let index = 0; index < 1_025; index += 1) {
        const directory = 'policy/' + String(index).padStart(4, '0');
        addFile(directory + '/AGENTS.md', 18, '# Policy ' + index);
        const term = 'proofneedle' + String(index).padStart(4, '0');
        addFile(directory + '/target.py', term.length, term);
      }
    } else {
      for (let index = 0; index < 1_024; index += 1) {
        const suffix = String(index).padStart(4, '0');
        addFile('filesystem-policy/' + suffix + '/AGENTS.md', 24, '# Filesystem policy ' + suffix);
        const content = '# Document policy ' + suffix;
        documentEntries.push({
          relative_path: 'document-policy/' + suffix + '/AGENTS.md',
          content,
          size_bytes: new TextEncoder().encode(content).byteLength,
          source_hash: hashContextText(content),
          authority_basis: { kind: 'convention', rule_id: 'ancestor-agents-file' },
          metadata: { title: 'Policy ' + suffix, authority: 'policy', modules: [], topics: [] },
        });
      }
    }
    entries.sort((left, right) => left.relative_path < right.relative_path ? -1 : left.relative_path > right.relative_path ? 1 : 0);
    const entryByPath = new Map(entries.map((entry) => [entry.relative_path, entry]));
    const walk = {
      paths: entries.map(({ relative_path, kind, size_bytes }) => ({ relative_path, kind, size_bytes })),
      excluded_path_count: 0,
      truncated: false,
      truncation_reasons: [],
      visited_entry_count: entries.length,
      capacity_omitted_entry_count: 0,
    };
    const documents = {
      sources: documentEntries,
      discovered_path_count: documentEntries.length,
      excluded_path_count: 0,
      candidate_document_count: documentEntries.length,
      omitted_document_count: 0,
      total_source_bytes: documentEntries.reduce((sum, entry) => sum + entry.size_bytes, 0),
      skipped_oversize_count: 0,
      skipped_binary_count: 0,
      skipped_sensitive_content_count: 0,
      blocked_policy_count: 0,
      blocked_policy_kinds: { operational: 0, security: 0, governance: 0 },
      discovery_truncated: false,
      discovery_truncation_reasons: [],
      discovery_visited_entry_count: documentEntries.length,
      discovery_capacity_omitted_entry_count: 0,
      capacity_omitted_document_count: 0,
    };

    class SyntheticFileSystem extends adapters.NodeFileSystemAdapter {
      async walk() { return structuredClone(walk); }
      async readText(_root, path) { return entryByPath.get(path)?.content; }
    }
    class SyntheticDocuments {
      async collect() { return structuredClone(documents); }
    }
    const readSyntheticSource = async (_root, path, maximumBytes) => {
      const entry = entryByPath.get(path);
      if (!entry || entry.logical_size > maximumBytes) return undefined;
      return {
        content: entry.content,
        size_bytes: entry.logical_size,
        source_hash: hashContextText(entry.content),
      };
    };
    mock.module('@primecontext/adapters', {
      namedExports: {
        ...adapters,
        NodeFileSystemAdapter: SyntheticFileSystem,
        NodeDocumentSourceAdapter: SyntheticDocuments,
        readSafeRepositoryText: readSyntheticSource,
      },
    });

    const root = await mkdtemp(join(tmpdir(), 'primecontext-policy-capacity-'));
    try {
      const { initCommand } = await import(${JSON.stringify(commandsModuleUrl)} + '?scenario=' + scenario);
      const {
        compilePreparedContext,
        createContextPreparationObservation,
      } = await import(${JSON.stringify(contextModuleUrl)} + '?scenario=' + scenario);
      await initCommand(root);
      const observation = await createContextPreparationObservation(root);

      if (scenario === 'provider' || scenario === 'aggregate') {
        const candidateForSource = (source, provider, authorityEvidence, observedSize) => {
          const bytes = new TextEncoder().encode(source.content).byteLength;
          const candidate = {
            schema_version: '0.3', id: '', kind: source.kind, provider, path: source.path,
            source_hash: source.source_hash, excerpt_hash: hashContextText(source.content),
            snapshot: observation.live.snapshot, freshness: 'live', observed_size_bytes: observedSize,
            authority: 'policy', authority_evidence: [authorityEvidence],
            excerpt: source.content, excerpt_bytes: bytes, estimated_tokens: Math.ceil(bytes / 4),
            discovery: { matched_terms: [], criteria_ids: [], truncated: false },
          };
          candidate.id = createContextCandidateId(candidate);
          return { path: source.path, id: candidate.id };
        };
        const policyIds = observation.live.filesystem_sources
          .filter((source) => source.authority === 'policy')
          .map((source) => candidateForSource(
            source, 'filesystem', 'convention:ancestor-agents-file',
            new TextEncoder().encode(source.content).byteLength,
          ));
        if (scenario === 'aggregate') {
          policyIds.push(...observation.live.documents.sources
            .filter((source) => source.metadata.authority === 'policy')
            .map((source) => candidateForSource(
              { ...source, path: source.relative_path, kind: 'document', authority: 'policy' },
              'documents', 'convention:' + source.authority_basis.rule_id, source.size_bytes,
            )));
        }
        policyIds.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
        const omittedPolicy = policyIds.at(-1);
        if (!omittedPolicy) throw new Error('policy capacity fixture did not produce a policy');
        policyPath = omittedPolicy.path;
        targetPath = dirname(policyPath) + '/target.py';
        if (scenario === 'provider') {
          const targetEntry = entryByPath.get(targetPath);
          if (!targetEntry) throw new Error('provider fixture target is missing');
          targetTerm = targetEntry.content;
        } else {
          targetTerm = 'aggregatepolicyproof';
        }
      }

      const request = {
        schema_version: '0.3',
        task: {
          task_id: 'CTX-POLICY-CAPACITY-001', task_type: 'module_feature',
          goal: 'Compile bounded policy evidence', query: targetTerm,
          acceptance_criteria: [{ id: 'AC-CAPACITY', text: 'Bounded evidence', required_terms: [targetTerm] }],
          hints: { paths: [targetPath], symbols: [], terms: [targetTerm] },
        },
        budget: { max_items: 8, max_bytes: 32_768, max_estimated_tokens: 8_192 },
        snapshot: observation.live.snapshot, policy_version: '0.3-default',
        required_sources: [scenario === 'aggregate' ? 'repository-map' : targetPath],
      };
      const prepared = await compilePreparedContext(root, request, observation);
      const policyItem = prepared.envelope.items.find((item) => item.path === policyPath);
      console.log(JSON.stringify({
        scenario, policy_path: policyPath, target_path: targetPath,
        observation_policy_present: observation.live.hybrid_sources.some((source) => source.path === policyPath),
        policy_selected: policyItem !== undefined,
        ...(policyItem ? { policy_mandatory: policyItem.mandatory } : {}),
        target_selected: prepared.envelope.items.some((item) => item.path === targetPath),
        required_selected: prepared.envelope.items.some((item) => item.path === (
          scenario === 'aggregate' ? 'repository-map' : targetPath
        )),
        evidence_status: prepared.envelope.evidence_status,
        security_failure: prepared.envelope.source_failures.some((failure) => failure.security_control),
        source_failure_codes: prepared.envelope.source_failures.map((failure) => failure.code),
        truncation_reasons: prepared.envelope.truncation.truncation_reasons ?? [],
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  `;
  const child = spawnSync(
    process.execPath,
    ['--no-warnings', '--experimental-test-module-mocks', '--input-type=module', '--eval', program],
    { cwd: fileURLToPath(new URL('../../..', import.meta.url)), encoding: 'utf8', timeout: 60_000 },
  );
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout) as FilesystemPolicyCapacityResult;
}

test('indexes local documents and TypeScript structure, then compiles an inspectable envelope', async () => {
  const root = await contextFixture();
  await initCommand(root);
  const indexed = await contextIndexCommand(root);
  assert.match(indexed.index_path, /\.primecontext\/context\/index\.sqlite$/);
  if (indexed.fallback_used) assert.equal(indexed.indexed_source_count, 0);
  else assert.ok(indexed.indexed_source_count >= 2);
  assert.ok(indexed.code_symbol_count >= 2);
  assert.match(indexed.index_digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(indexed.provenance.primecontext.context_version, '0.3');
  assert.equal(indexed.provenance.node.version, process.versions.node);
  if (indexed.code_symbol_count > 0) {
    assert.equal(indexed.provenance.capabilities.typescript_codegraph, true);
    assert.match(indexed.provenance.typescript_codegraph?.typescript_version ?? '', /^\d+\.\d+\.\d+/);
  }
  if (!indexed.fallback_used) assert.equal(indexed.provenance.capabilities.sqlite_fts, true);

  const requestPath = 'context-request.json';
  const request = requestValue(indexed.worktree_digest, indexed.repository_id);
  request.task.acceptance_criteria.push({
    id: 'AC-3', text: 'Repository structure is represented', required_terms: ['repository'],
  });
  await writeFile(join(root, requestPath), JSON.stringify(request));
  const planned = await contextPlanCommand(root, requestPath);
  assert.equal(planned.task_id, 'CTX-VERTICAL-001');
  assert.match(planned.selection_digest, /^sha256:[0-9a-f]{64}$/);

  const inspected = await contextInspectCommand(root, 'CTX-VERTICAL-001');
  assert.equal(validateContextEnvelope(inspected.envelope).valid, true);
  assert.equal(validateSelectionReceipt(inspected.receipt).valid, true);
  assert.equal(inspected.envelope.selection_digest, inspected.receipt.selection_digest);
  assert.ok(inspected.envelope.items.some((item) => item.provider === 'codegraph'));
  assert.ok(inspected.envelope.items.some((item) => item.provider === 'repo_map'));
  assert.ok(inspected.envelope.items.filter((item) => item.provider === 'codegraph').every((item) => (
    item.discovery.truncated === false && item.discovery.truncation_reasons === undefined
  )));
  assert.ok(inspected.envelope.items.filter((item) => item.provider === 'fts').every((item) => (
    item.discovery.truncated === false && item.discovery.truncation_reasons === undefined
  )));
  assert.equal(
    inspected.envelope.source_failures.some((failure) => failure.provider === 'fts'),
    indexed.fallback_used,
    JSON.stringify(inspected.envelope.source_failures),
  );
  assert.equal(inspected.envelope.items.find((item) => item.provider === 'codegraph')?.freshness, 'snapshot');
});

test('reuses a validated index for the same accepted-source manifest', async (t) => {
  const root = await contextFixture();
  await initCommand(root);
  const first = await contextIndexCommand(root);
  if (first.fallback_used) {
    t.skip('SQLite FTS capability is unavailable in this Node runtime');
    return;
  }
  const indexPath = join(root, '.primecontext', 'context', 'index.sqlite');
  const manifestPath = join(root, '.primecontext', 'context', 'index-manifest.json');
  const beforeIndex = await readFile(indexPath);
  const beforeManifest = await readFile(manifestPath);
  const beforeMtime = (await stat(indexPath)).mtimeMs;

  const second = await contextIndexCommand(root);
  assert.equal(second.reused, true);
  assert.equal(second.accepted_source_digest, first.accepted_source_digest);
  assert.deepEqual(await readFile(indexPath), beforeIndex);
  assert.deepEqual(await readFile(manifestPath), beforeManifest);
  assert.equal((await stat(indexPath)).mtimeMs, beforeMtime);
});

test('accepted-source digest covers screened manifests and build files but ignores arbitrary control JSON', async () => {
  const root = await contextFixture();
  await writeFile(join(root, 'control.json'), '{"private_query":"do not index"}\n');
  await initCommand(root);
  const baseline = await contextIndexCommand(root);

  await writeFile(join(root, 'control.json'), '{"private_query":"changed"}\n');
  const ignoredControlChange = await contextIndexCommand(root);
  assert.equal(ignoredControlChange.accepted_source_digest, baseline.accepted_source_digest);

  await writeFile(join(root, 'tsconfig.json'), '{"compilerOptions":{"strict":true}}\n');
  const withTypeScriptConfig = await contextIndexCommand(root);
  assert.notEqual(withTypeScriptConfig.accepted_source_digest, baseline.accepted_source_digest);

  await writeFile(join(root, 'Dockerfile'), 'FROM scratch\n');
  const withBuildFile = await contextIndexCommand(root);
  assert.notEqual(withBuildFile.accepted_source_digest, withTypeScriptConfig.accepted_source_digest);
});

test('repository identity disambiguates checkouts with the same basename without exposing an absolute path', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'primecontext-identity-'));
  const firstRoot = join(parent, 'first', 'repository');
  const secondRoot = join(parent, 'second', 'repository');
  try {
    for (const root of [firstRoot, secondRoot]) {
      await mkdir(root, { recursive: true });
      await writeFile(join(root, 'package.json'), '{"name":"same-name","private":true}\n');
      await writeFile(join(root, 'README.md'), '# Same repository name\n');
      await initCommand(root);
    }
    const first = await contextIndexCommand(firstRoot);
    const second = await contextIndexCommand(secondRoot);
    assert.notEqual(first.repository_id, second.repository_id);
    assert.match(first.repository_id, /^repository-[0-9a-f]{16}$/);
    assert.equal(first.repository_id.includes(parent), false);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('applies root and nearest targeted AGENTS policy without default governance or security tax', async () => {
  const root = await contextFixture();
  await mkdir(join(root, 'src', 'nested'), { recursive: true });
  await writeFile(join(root, 'AGENTS.md'), '# Root policy\n\nrootpolicyproof\n');
  await writeFile(join(root, 'SECURITY.md'), '# Security policy\n\nsecuritypolicyproof\n');
  await writeFile(join(root, 'CODE_OF_CONDUCT.md'), '# Conduct\n\ngovernanceproof\n');
  await writeFile(join(root, 'src', 'nested', 'AGENTS.md'), '# Nested policy\n\nnestedpolicyproof\n');
  await writeFile(join(root, 'src', 'nested', 'target.ts'), 'export const targeted = true;\n');
  await initCommand(root);
  const indexed = await contextIndexCommand(root);
  const base = requestValue(indexed.worktree_digest, indexed.repository_id);
  base.task.query = 'targeted';
  base.task.hints = { paths: ['src/nested/target.ts'], symbols: [], terms: ['targeted'] };
  base.task.acceptance_criteria = [{ id: 'AC-TARGET', text: 'Targeted code', required_terms: ['targeted'] }];
  const requestPath = 'policy-request.json';
  await writeFile(join(root, requestPath), JSON.stringify(base));
  await contextPlanCommand(root, requestPath);
  const stored = await contextInspectCommand(root, 'CTX-VERTICAL-001');
  const selectedPaths = stored.envelope.items.map((item) => item.path);
  assert.ok(selectedPaths.includes('AGENTS.md'));
  assert.ok(selectedPaths.includes('src/nested/AGENTS.md'));
  assert.equal(selectedPaths.includes('SECURITY.md'), false);
  assert.equal(selectedPaths.includes('CODE_OF_CONDUCT.md'), false);

  const securityRequest = {
    ...base,
    task: {
      ...base.task,
      task_id: 'CTX-SECURITY-001',
      query: 'security authentication targeted',
      hints: { paths: ['src/nested/target.ts'], symbols: [], terms: ['authentication', 'security'] },
    },
  };
  await writeFile(join(root, requestPath), JSON.stringify(securityRequest));
  await contextPlanCommand(root, requestPath);
  const secured = await contextInspectCommand(root, 'CTX-SECURITY-001');
  assert.ok(secured.envelope.items.some((item) => item.path === 'SECURITY.md'));
});

test('blocked policy failures are applicable by sanitized policy kind', async () => {
  const root = await contextFixture();
  const blocked = '# Policy\nAuthorization: Basic dXNlcjpwYXNzd29yZA==\n';
  await writeFile(join(root, 'SECURITY.md'), blocked);
  await writeFile(join(root, 'CODE_OF_CONDUCT.md'), blocked);
  await initCommand(root);
  const observation = await createContextPreparationObservation(root);
  const ordinary = requestValue(observation.live.snapshot.worktree_digest, observation.live.repository_id);
  ordinary.task.goal = 'Compile repository evidence';
  ordinary.task.query = 'compiler evidence';
  ordinary.task.hints = { paths: ['src/compiler.ts'], symbols: ['compileContext'], terms: ['compiler'] };
  ordinary.task.acceptance_criteria = [{ id: 'AC-1', text: 'Compiler evidence', required_terms: ['compiler'] }];

  const ordinaryResult = await compilePreparedContext(root, ordinary, observation);
  assert.equal(ordinaryResult.envelope.source_failures.some((failure) => (
    failure.code === 'REQUIRED_SOURCE_BLOCKED'
  )), false);

  const security = structuredClone(ordinary);
  security.task.task_id = 'CTX-SECURITY-BLOCKED-001';
  security.task.goal = 'Audit authentication security';
  security.task.query = 'authentication security compiler';
  security.task.hints = { paths: ['src/compiler.ts'], symbols: [], terms: ['authentication', 'security'] };
  const securityResult = await compilePreparedContext(root, security, observation);
  const blockedFailure = securityResult.envelope.source_failures.find((failure) => (
    failure.code === 'REQUIRED_SOURCE_BLOCKED'
  ));
  assert.ok(blockedFailure);
  assert.doesNotMatch(JSON.stringify(blockedFailure), /SECURITY\.md|CODE_OF_CONDUCT\.md/i);

  const securityAfterRankingCap = structuredClone(ordinary);
  securityAfterRankingCap.task.task_id = 'CTX-SECURITY-CAP-001';
  securityAfterRankingCap.task.goal = `${Array.from(
    { length: 65 },
    (_value, index) => `a${String(index).padStart(3, '0')}`,
  ).join(' ')} security`;
  const cappedResult = await compilePreparedContext(root, securityAfterRankingCap, observation);
  assert.ok(cappedResult.envelope.source_failures.some((failure) => (
    failure.code === 'REQUIRED_SOURCE_BLOCKED'
  )));
});

test('blocked SECURITY policy applicability stays aligned with the Core security corpus', async (t) => {
  const root = await contextFixture();
  await writeFile(
    join(root, 'SECURITY.md'),
    '# Policy\nAuthorization: Basic dXNlcjpwYXNzd29yZA==\n',
  );
  await initCommand(root);
  const observation = await createContextPreparationObservation(root);
  const base = requestValue(observation.live.snapshot.worktree_digest, observation.live.repository_id);
  base.task.query = 'compiler evidence';
  base.task.acceptance_criteria = [{
    id: 'AC-COMPILER', text: 'Compiler evidence', required_terms: ['compiler'],
  }];
  base.task.hints = { paths: ['src/compiler.ts'], symbols: [], terms: ['compiler'] };

  const coreSecurityPolicy = (request: ContextPlanRequestV03): ContextCandidateV03 => {
    const excerpt = 'Repository security policy.';
    const bytes = new TextEncoder().encode(excerpt).byteLength;
    const candidate: ContextCandidateV03 = {
      schema_version: '0.3', id: '', kind: 'document', provider: 'documents', path: 'SECURITY.md',
      source_hash: hashContextText(excerpt), excerpt_hash: hashContextText(excerpt),
      snapshot: structuredClone(request.snapshot), freshness: 'live', observed_size_bytes: bytes,
      authority: 'policy', authority_evidence: ['convention:root-security-file'], excerpt,
      excerpt_bytes: bytes, estimated_tokens: Math.ceil(bytes / 4),
      discovery: { matched_terms: [], criteria_ids: [], truncated: false },
    };
    candidate.id = createContextCandidateId(candidate);
    return candidate;
  };
  const goals = [
    'Add an OAuth callback',
    'Repair the login flow',
    'Rotate application credentials',
    'Review package permissions',
    'Encrypt stored configuration',
    'Audit npm dependencies for advisories',
    'Prevent SQL injection in account lookup',
    'Add CSRF protection',
    'Require MFA for administrators',
    'Verify a JWT signature',
    'Rotate API keys',
    'Patch CVE-2026-1234',
    'Fix XSS in the preview',
    'Prevent cross-site scripting',
    'Prevent command injection',
    'Block path traversal',
    'Prevent SSRF in callbacks',
    'Enforce RBAC roles',
    'Fix an IDOR',
    'Patch remote code execution',
    'Restrict administrator privileges',
    'Review an exploit and threat model',
    'Sandbox unsafe deserialization',
    'Secure file uploads',
    'Validate webhook redirects',
    'Fix XXE in XML parsing',
    'Harden TLS certificate validation',
    'Prevent prototype pollution',
    'Mitigate denial of service',
    'Fix CORS configuration',
    'Add secure cookie flags',
    'Patch buffer overflow',
    'Fix a stack overflow',
    'Prevent session fixation',
    'Stop a DDoS attack',
    'Stop a DoS attack',
    `${Array.from({ length: 80 }, (_, index) => `alpha${index.toString().padStart(3, '0')}`).join(' ')} oauth`,
    'Update npm dependencies for compatibility',
    'Refactor a TypeScript function signature',
    'Configure dependency injection for service construction',
    'Implement syntax tree traversal',
    'Rename an object key',
    'Edit prose about Basic concepts',
    'Atualizar nomes dos módulos',
  ];

  for (const [index, goal] of goals.entries()) {
    await t.test(`Core parity ${String(index + 1).padStart(2, '0')}`, async () => {
      const request = structuredClone(base);
      request.task.task_id = `CTX-SECURITY-CORPUS-${String(index + 1).padStart(3, '0')}`;
      request.task.goal = goal;
      const policy = coreSecurityPolicy(request);
      const coreResult = compileContext(request, [policy]);
      const coreMandatory = coreResult.receipt.decisions.find((decision) => (
        decision.candidate_id === policy.id
      ))?.mandatory ?? false;

      const cliResult = await compilePreparedContext(root, request, observation);
      const cliBlocked = cliResult.envelope.source_failures.some((failure) => (
        failure.code === 'REQUIRED_SOURCE_BLOCKED' && failure.security_control
      ));
      assert.equal(cliBlocked, coreMandatory, goal);
    });
  }
});

test('a blocked operational policy fails closed for an ordinary task', async () => {
  const root = await contextFixture();
  await writeFile(join(root, 'AGENTS.md'), '# Policy\nAuthorization: Basic dXNlcjpwYXNzd29yZA==\n');
  await initCommand(root);
  const observation = await createContextPreparationObservation(root);
  const request = requestValue(observation.live.snapshot.worktree_digest, observation.live.repository_id);
  request.task.goal = 'Compile repository evidence';
  request.task.query = 'compiler evidence';
  request.task.hints = { paths: ['src/compiler.ts'], symbols: [], terms: ['compiler'] };
  request.task.acceptance_criteria = [{ id: 'AC-1', text: 'Compiler evidence', required_terms: ['compiler'] }];

  const prepared = await compilePreparedContext(root, request, observation);
  assert.ok(prepared.envelope.source_failures.some((failure) => (
    failure.code === 'REQUIRED_SOURCE_BLOCKED' && failure.security_control
  )));
});

test('a blocked nested AGENTS policy applies only to targeted descendant evidence', async () => {
  const root = await contextFixture();
  await mkdir(join(root, 'src', 'nested'), { recursive: true });
  await writeFile(
    join(root, 'src', 'nested', 'AGENTS.md'),
    '# Nested policy\nAuthorization: Basic dXNlcjpwYXNzd29yZA==\n',
  );
  await writeFile(join(root, 'src', 'nested', 'target.ts'), 'export const nestedproof = true;\n');
  await initCommand(root);
  const indexed = await contextIndexCommand(root);
  const targeted = requestValue(indexed.worktree_digest, indexed.repository_id);
  targeted.task.query = 'nestedproof';
  targeted.task.hints = { paths: ['src/nested/target.ts'], symbols: [], terms: ['nestedproof'] };
  targeted.task.acceptance_criteria = [{ id: 'AC-NESTED', text: 'Nested proof', required_terms: ['nestedproof'] }];

  const targetedResult = await compilePreparedContext(root, targeted);
  const failure = targetedResult.envelope.source_failures.find((item) => item.code === 'REQUIRED_SOURCE_BLOCKED');
  assert.ok(failure);
  assert.equal(targetedResult.envelope.evidence_status, 'INSUFFICIENT_EVIDENCE');
  assert.doesNotMatch(JSON.stringify(failure), /AGENTS\.md|nested|dXNlcj/i);

  const discoveredByQuery = structuredClone(targeted);
  discoveredByQuery.task.task_id = 'CTX-QUERY-POLICY-001';
  delete discoveredByQuery.task.hints;
  const queryResult = await compilePreparedContext(root, discoveredByQuery);
  assert.ok(queryResult.envelope.items.some((item) => item.path === 'src/nested/target.ts'));
  assert.ok(queryResult.envelope.source_failures.some((item) => (
    item.code === 'REQUIRED_SOURCE_BLOCKED'
  )));

  const unrelated = structuredClone(targeted);
  unrelated.task.task_id = 'CTX-UNRELATED-POLICY-001';
  unrelated.task.query = 'compiler';
  unrelated.task.hints = { paths: ['src/compiler.ts'], symbols: [], terms: ['compiler'] };
  unrelated.task.acceptance_criteria = [{ id: 'AC-COMPILER', text: 'Compiler proof', required_terms: ['compiler'] }];
  const unrelatedResult = await compilePreparedContext(root, unrelated);
  assert.equal(unrelatedResult.envelope.source_failures.some((item) => (
    item.code === 'REQUIRED_SOURCE_BLOCKED'
  )), false);
});

test('an explicit source omitted by content screening yields a sanitized blocked failure', async () => {
  const root = await contextFixture();
  await writeFile(
    join(root, 'src', 'blocked.py'),
    '# Authorization: Basic dXNlcjpwYXNzd29yZA==\n',
  );
  await initCommand(root);
  const indexed = await contextIndexCommand(root);
  const request = requestValue(indexed.worktree_digest, indexed.repository_id);
  request.task.goal = 'Compile repository evidence';
  request.task.query = 'compiler evidence';
  request.task.hints = { paths: ['src/compiler.ts'], symbols: [], terms: ['compiler'] };
  request.task.acceptance_criteria = [{ id: 'AC-COMPILER', text: 'Compiler evidence', required_terms: ['compiler'] }];
  request.required_sources = ['src/blocked.py'];

  const prepared = await compilePreparedContext(root, request);
  const failure = prepared.envelope.source_failures.find((item) => item.code === 'REQUIRED_SOURCE_BLOCKED');
  assert.ok(failure);
  assert.equal(prepared.envelope.evidence_status, 'INSUFFICIENT_EVIDENCE');
  assert.doesNotMatch(JSON.stringify(failure), /blocked\.py|authorization|dXNlcj/i);
});

test('excludes a configured non-default state directory from indexing and selection', async () => {
  const root = await contextFixture();
  const stateDirectory = '.prime-cache';
  await writeFile(join(root, 'primecontext.config.json'), JSON.stringify({
    ...defaultConfig(),
    state_dir: stateDirectory,
  }));
  await initCommand(root);
  const before = await contextIndexCommand(root);
  const sentinelPath = join(stateDirectory, 'private-context.md');
  const sentinel = 'state-only-sentinel-9284';
  await writeFile(join(root, sentinelPath), `# Private context\n\n${sentinel}\n`);

  const after = await contextIndexCommand(root);
  assert.equal(after.document_source_count, before.document_source_count);
  assert.equal(after.indexed_source_count, before.indexed_source_count);
  assert.equal(after.worktree_digest, before.worktree_digest);

  const requestPath = 'state-exclusion-request.json';
  const request: ContextPlanRequestV03 = {
    ...requestValue(after.worktree_digest, after.repository_id),
    task: {
      ...requestValue(after.worktree_digest, after.repository_id).task,
      query: sentinel,
      hints: { paths: [sentinelPath.replaceAll('\\', '/')], symbols: [], terms: [sentinel] },
      acceptance_criteria: [{ id: 'AC-STATE', text: 'State-only sentinel', required_terms: [sentinel] }],
    },
    required_sources: [sentinelPath.replaceAll('\\', '/')],
  };
  await writeFile(join(root, requestPath), JSON.stringify(request));
  await contextPlanCommand(root, requestPath);
  const inspected = await contextInspectCommand(root, 'CTX-VERTICAL-001');
  assert.equal(inspected.envelope.items.some((item) => item.path === sentinelPath.replaceAll('\\', '/')), false);
});

test('records observational outcome and creates a non-causal ablation linked to the selection', async () => {
  const root = await contextFixture();
  await initCommand(root);
  const requestPath = 'context-request.json';
  const indexed = await contextIndexCommand(root);
  await writeFile(join(root, requestPath), JSON.stringify(requestValue(indexed.worktree_digest, indexed.repository_id)));
  await contextPlanCommand(root, requestPath);
  const inspected = await contextInspectCommand(root, 'CTX-VERTICAL-001');
  const candidateId = inspected.envelope.items[0]?.id as string;

  const outcomePath = 'outcome.json';
  await writeFile(join(root, outcomePath), JSON.stringify({
    schema_version: '0.3', run_id: 'RUN-001', task_id: 'CTX-VERTICAL-001',
    selection_digest: inspected.envelope.selection_digest, snapshot: inspected.envelope.snapshot,
    started_at: '2026-08-12T11:59:00.000Z', recorded_at: '2026-08-12T12:00:00.000Z', used_candidate_ids: [candidateId],
    touched_paths: ['src/compiler.ts'], test_status: 'PASS', review_status: 'NOT_RUN',
    completion_status: 'PASS', metrics: { duration_ms: 100, input_tokens: 200, output_tokens: 50 }, source: 'tool',
  }));
  const outcome = await contextOutcomeCommand(root, 'CTX-VERTICAL-001', outcomePath);
  assert.equal(validateOutcomeReceipt(outcome.receipt).valid, true);
  assert.equal(outcome.receipt.causality, 'OBSERVATIONAL_ONLY');

  const ablation = await contextAblateCommand(root, 'CTX-VERTICAL-001', candidateId);
  assert.equal(ablation.experimental, true);
  assert.equal(ablation.causal_claim, 'NONE');
  assert.notEqual(ablation.ablated_selection_digest, inspected.envelope.selection_digest);
});

test('links bounded expansion and deterministic replay to the stored selection', async () => {
  const root = await contextFixture();
  await initCommand(root);
  await writeFile(join(root, 'docs', 'later-one.md'), '# Later one\n\nuniquefirstexpansion evidence.');
  await writeFile(join(root, 'docs', 'later-two.md'), '# Later two\n\nuniquesecondexpansion evidence.');
  const indexed = await contextIndexCommand(root);
  const requestPath = 'context-request.json';
  const request = requestValue(indexed.worktree_digest, indexed.repository_id);
  request.task.query = 'compiler';
  request.task.acceptance_criteria = [{ ...request.task.acceptance_criteria[0]! }];
  request.task.hints = { paths: ['src/compiler.ts'], symbols: ['compileContext'], terms: [] };
  request.budget = { max_items: 32, max_bytes: 1_048_576, max_estimated_tokens: 262_144 };
  await writeFile(join(root, requestPath), JSON.stringify(request));
  await contextPlanCommand(root, requestPath);
  const before = await contextInspectCommand(root, 'CTX-VERTICAL-001');
  const expansionPath = 'expansion.json';
  await writeFile(join(root, expansionPath), JSON.stringify({
    schema_version: '0.3', task_id: 'CTX-VERTICAL-001',
    previous_selection_digest: before.envelope.selection_digest,
    known_candidate_ids: before.envelope.items.map((item) => item.id),
    reason: 'MISSING_TERM', requested_paths: [], requested_symbols: [], requested_terms: ['uniquefirstexpansion'],
    additional_budget: { max_items: 2, max_bytes: 4096, max_estimated_tokens: 1024 },
  }));
  const expanded = await contextExpandCommand(root, 'CTX-VERTICAL-001', expansionPath);
  assert.ok(['ALLOWED', 'PARTIAL'].includes(expanded.decision.status));
  assert.equal(expanded.decision.previous_selection_digest, before.envelope.selection_digest);
  assert.deepEqual(await contextExpandCommand(root, 'CTX-VERTICAL-001', expansionPath), expanded);

  const afterFirst = await contextInspectCommand(root, 'CTX-VERTICAL-001');
  const secondExpansionPath = 'expansion-second.json';
  await writeFile(join(root, secondExpansionPath), JSON.stringify({
    schema_version: '0.3', task_id: 'CTX-VERTICAL-001',
    previous_selection_digest: afterFirst.envelope.selection_digest,
    known_candidate_ids: afterFirst.envelope.items.map((item) => item.id),
    reason: 'MISSING_TERM', requested_paths: [], requested_symbols: [], requested_terms: ['uniquesecondexpansion'],
    additional_budget: { max_items: 2, max_bytes: 4096, max_estimated_tokens: 1024 },
  }));
  const second = await contextExpandCommand(root, 'CTX-VERTICAL-001', secondExpansionPath);
  assert.ok(['ALLOWED', 'PARTIAL'].includes(second.decision.status));
  const staleRetry = await contextExpandCommand(root, 'CTX-VERTICAL-001', expansionPath);
  assert.equal(staleRetry.decision.status, 'DENIED');
  assert.deepEqual(staleRetry.decision.reason_codes, ['STALE_PARENT']);

  const replay = await contextReplayCommand(root, 'CTX-VERTICAL-001');
  assert.equal(replay.status, 'IDENTICAL');
  assert.equal(replay.freshness, 'MATCHED');
  assert.match(replay.replay_digest, /^sha256:[0-9a-f]{64}$/);
});

test('compiled CLI exposes strict v0.3 context commands without weakening prior help', async () => {
  const root = await contextFixture();
  const bin = fileURLToPath(new URL('./bin.js', import.meta.url));
  const run = (...args: string[]) => spawnSync(process.execPath, [bin, ...args], { cwd: root, encoding: 'utf8' });
  const help = run('--help');
  assert.equal(help.status, 0);
  assert.match(help.stdout, /primecontext context index/);
  assert.match(help.stdout, /primecontext docs search/);

  for (const args of [
    ['context'],
    ['context', 'index', 'extra'],
    ['context', 'plan'],
    ['context', 'plan', '--from'],
    ['context', 'inspect', '../escape'],
    ['context', 'outcome', 'CTX', '--from'],
    ['context', 'ablate', 'CTX', '--candidate'],
    ['context', 'unknown'],
  ]) {
    const result = run(...args);
    assert.equal(result.status, 1, args.join(' '));
    assert.match(result.stderr, /VALIDATION_ERROR|SECURITY_ERROR/, args.join(' '));
  }
});

test('invalid plan input is rejected before optional index I/O', async () => {
  const root = await contextFixture();
  await initCommand(root);
  const invalid = 'invalid-context-request.json';
  await writeFile(join(root, invalid), JSON.stringify({ ...requestValue(), budget: { max_items: 0 } }));
  await assert.rejects(() => contextPlanCommand(root, invalid), /VALIDATION_ERROR/);
});

test('outcome ledger rejects a previously tampered digest before replacement', async () => {
  const root = await contextFixture();
  await initCommand(root);
  const indexed = await contextIndexCommand(root);
  const requestPath = 'context-request.json';
  await writeFile(join(root, requestPath), JSON.stringify(requestValue(indexed.worktree_digest, indexed.repository_id)));
  await contextPlanCommand(root, requestPath);
  const inspected = await contextInspectCommand(root, 'CTX-VERTICAL-001');
  const candidateId = inspected.envelope.items[0]?.id as string;
  const outcomePath = 'outcome.json';
  const declaration = {
    schema_version: '0.3', run_id: 'RUN-TAMPER', task_id: 'CTX-VERTICAL-001',
    selection_digest: inspected.envelope.selection_digest, snapshot: inspected.envelope.snapshot,
    started_at: '2026-08-12T11:59:00.000Z', recorded_at: '2026-08-12T12:00:00.000Z',
    used_candidate_ids: [candidateId], touched_paths: ['src/compiler.ts'], test_status: 'PASS',
    review_status: 'NOT_RUN', completion_status: 'PASS', metrics: {}, source: 'tool',
  };
  await writeFile(join(root, outcomePath), JSON.stringify(declaration));
  const first = await contextOutcomeCommand(root, 'CTX-VERTICAL-001', outcomePath);
  const ledgerPath = resolve(root, first.outcome_path);
  const record = JSON.parse((await readFile(ledgerPath, 'utf8')).trim()) as {
    receipt?: Record<string, unknown>;
  };
  assert.ok(record.receipt);
  record.receipt.outcome_digest = `sha256:${'0'.repeat(64)}`;
  await writeFile(ledgerPath, `${JSON.stringify(record)}\n`);
  await assert.rejects(
    () => contextOutcomeCommand(root, 'CTX-VERTICAL-001', outcomePath),
    /OutcomeReceipt digest|STATE_ERROR/,
  );
});

test('outcome ledger rejects duplicate runs and detects removal or reordering through its digest chain', async () => {
  const root = await contextFixture();
  await initCommand(root);
  const indexed = await contextIndexCommand(root);
  const requestPath = 'context-request.json';
  await writeFile(join(root, requestPath), JSON.stringify(requestValue(indexed.worktree_digest, indexed.repository_id)));
  await contextPlanCommand(root, requestPath);
  const inspected = await contextInspectCommand(root, 'CTX-VERTICAL-001');
  const candidateId = inspected.envelope.items[0]?.id as string;
  const outcomePath = 'outcome.json';
  const declaration = (runId: string, minute: number) => ({
    schema_version: '0.3', run_id: runId, task_id: 'CTX-VERTICAL-001',
    selection_digest: inspected.envelope.selection_digest, snapshot: inspected.envelope.snapshot,
    started_at: `2026-08-12T11:${String(minute).padStart(2, '0')}:00.000Z`,
    recorded_at: `2026-08-12T12:${String(minute).padStart(2, '0')}:00.000Z`,
    used_candidate_ids: [candidateId], touched_paths: ['src/compiler.ts'], test_status: 'PASS',
    review_status: 'NOT_RUN', completion_status: 'PASS', metrics: {}, source: 'tool',
  });
  for (const [index, runId] of ['RUN-CHAIN-001', 'RUN-CHAIN-002', 'RUN-CHAIN-003'].entries()) {
    await writeFile(join(root, outcomePath), JSON.stringify(declaration(runId, index + 1)));
    const result = await contextOutcomeCommand(root, 'CTX-VERTICAL-001', outcomePath);
    assert.match(result.ledger_digest, /^sha256:[0-9a-f]{64}$/);
  }

  await writeFile(join(root, outcomePath), JSON.stringify(declaration('RUN-CHAIN-002', 4)));
  await assert.rejects(
    () => contextOutcomeCommand(root, 'CTX-VERTICAL-001', outcomePath),
    /duplicate.*run_id|run_id.*duplicate/i,
  );

  const ledgerPath = join(root, '.primecontext', 'context', 'outcomes', 'CTX-VERTICAL-001.jsonl');
  const original = (await readFile(ledgerPath, 'utf8')).trim().split('\n');
  assert.equal(original.length, 3);
  await writeFile(ledgerPath, `${[original[0], original[2]].join('\n')}\n`);
  await writeFile(join(root, outcomePath), JSON.stringify(declaration('RUN-CHAIN-004', 4)));
  await assert.rejects(() => contextOutcomeCommand(root, 'CTX-VERTICAL-001', outcomePath), /chain|sequence|digest/i);

  await writeFile(ledgerPath, `${[original[1], original[0], original[2]].join('\n')}\n`);
  await assert.rejects(() => contextOutcomeCommand(root, 'CTX-VERTICAL-001', outcomePath), /chain|sequence|digest/i);
});

test('outcome ledger accepts validated legacy receipts only as a prefix and anchors the next chained record', async () => {
  const root = await contextFixture();
  await initCommand(root);
  const indexed = await contextIndexCommand(root);
  await writeFile(
    join(root, 'context-request.json'),
    JSON.stringify(requestValue(indexed.worktree_digest, indexed.repository_id)),
  );
  await contextPlanCommand(root, 'context-request.json');
  const inspected = await contextInspectCommand(root, 'CTX-VERTICAL-001');
  const candidateId = inspected.envelope.items[0]?.id as string;
  const outcome = (runId: string, recordedAt: string) => ({
    schema_version: '0.3', run_id: runId, task_id: 'CTX-VERTICAL-001',
    selection_digest: inspected.envelope.selection_digest, snapshot: inspected.envelope.snapshot,
    started_at: '2026-08-12T11:59:00.000Z', recorded_at: recordedAt,
    used_candidate_ids: [candidateId], touched_paths: [], test_status: 'PASS', review_status: 'NOT_RUN',
    completion_status: 'PASS', metrics: {}, source: 'imported',
  });
  await writeFile(join(root, 'outcome.json'), JSON.stringify(outcome('RUN-LEGACY-001', '2026-08-12T12:00:00.000Z')));
  const first = await contextOutcomeCommand(root, 'CTX-VERTICAL-001', 'outcome.json');
  const ledgerPath = resolve(root, first.outcome_path);
  const wrapper = JSON.parse((await readFile(ledgerPath, 'utf8')).trim()) as { receipt: unknown };
  await writeFile(ledgerPath, `${JSON.stringify(wrapper.receipt)}\n`);

  await writeFile(join(root, 'outcome.json'), JSON.stringify(outcome('RUN-LEGACY-002', '2026-08-12T12:01:00.000Z')));
  const appended = await contextOutcomeCommand(root, 'CTX-VERTICAL-001', 'outcome.json');
  assert.match(appended.ledger_digest, /^sha256:[0-9a-f]{64}$/);
  const lines = (await readFile(ledgerPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(lines.length, 2);
  assert.equal(lines[0]?.run_id, 'RUN-LEGACY-001');
  assert.equal(lines[1]?.sequence, 2);
  assert.match(String(lines[1]?.previous_record_digest), /^sha256:[0-9a-f]{64}$/);
});

test('linked capsule enforces boundaries and adds declared documents and code targets without excluding root policy', async () => {
  const root = await contextFixture();
  await mkdir(join(root, 'src', 'private'), { recursive: true });
  await writeFile(join(root, 'AGENTS.md'), '# Root instructions\n\nAlways preserve the root policy.\n');
  await writeFile(join(root, 'docs', 'capsule-evidence.md'), '# Capsule evidence\n\nDeclared document proof.\n');
  await writeFile(join(root, 'docs', 'contract.json'), '{"contract":true}\n');
  await writeFile(join(root, 'docs', 'decision.md'), '# Decision\n\nAccepted decision proof.\n');
  await writeFile(join(root, 'src', 'capsule-target.ts'), 'export const capsuleTarget = true;\n');
  await writeFile(join(root, 'src', 'private', 'forbidden.ts'), 'export const forbiddenTarget = true;\n');
  await initCommand(root);
  const indexed = await contextIndexCommand(root);
  const capsule = {
    schema_version: '0.1', task_id: 'CTX-VERTICAL-001', goal: 'Compile proof-carrying context',
    task_type: 'module_feature',
    boundaries: { allowed_paths: ['docs', 'src'], forbidden_paths: ['src/private'] },
    documents: ['docs/capsule-evidence.md'], code_targets: ['src/capsule-target.ts'],
    contracts: ['docs/contract.json', 'https://example.invalid/not-a-repository-path'],
    decisions: [
      { source: 'docs/decision.md', summary: 'Repository decision' },
      { source: 'Decision recorded in meeting notes', summary: 'Non-path decision reference' },
    ],
    acceptance: ['Capsule declarations are enforced'],
    context_budget: { initial_tokens: 6000, soft_limit_tokens: 12000, hard_limit_tokens: 24000 },
  };
  await writeFile(join(root, '.primecontext', 'capsules', 'CTX-VERTICAL-001.json'), JSON.stringify(capsule));
  const request: ContextPlanRequestV03 = {
    ...requestValue(indexed.worktree_digest, indexed.repository_id),
    capsule_digest: hashContextJson(capsule),
    task: {
      ...requestValue(indexed.worktree_digest, indexed.repository_id).task,
      query: 'capsule forbidden target proof',
      hints: { paths: ['src/private/forbidden.ts'], symbols: [], terms: ['forbidden'] },
      acceptance_criteria: [
        ...requestValue(indexed.worktree_digest, indexed.repository_id).task.acceptance_criteria,
        { id: 'AC-CAPSULE', text: 'Capsule declarations are enforced' },
      ],
    },
  };
  const prepared = await compilePreparedContext(root, request);
  const paths = prepared.envelope.items.map((item) => item.path);
  assert.ok(paths.includes('AGENTS.md'));
  assert.ok(paths.includes('docs/capsule-evidence.md'));
  assert.ok(paths.includes('src/capsule-target.ts'));
  assert.equal(paths.includes('src/private/forbidden.ts'), false);
  assert.ok(prepared.request.required_sources?.includes('docs/capsule-evidence.md'));
  assert.ok(prepared.request.required_sources?.includes('docs/contract.json'));
  assert.ok(prepared.request.required_sources?.includes('docs/decision.md'));
  assert.equal(prepared.request.required_sources?.includes('https://example.invalid/not-a-repository-path'), false);
  assert.equal(prepared.request.required_sources?.includes('Decision recorded in meeting notes'), false);
  assert.ok(prepared.request.task.hints?.paths?.includes('src/capsule-target.ts'));
});

test('linked capsule leaves recognized policy applicability to Core outside exact path boundaries', async () => {
  const root = await contextFixture();
  await mkdir(join(root, 'src', 'nested'), { recursive: true });
  await writeFile(join(root, 'AGENTS.md'), '# Root policy\n\nrootpolicyproof\n');
  await writeFile(join(root, 'SECURITY.md'), '# Security policy\n\nsecuritypolicyproof\n');
  await writeFile(join(root, 'CODE_OF_CONDUCT.md'), '# Governance\n\ngovernanceproof\n');
  await writeFile(join(root, 'src', 'nested', 'AGENTS.md'), '# Nested policy\n\nnestedpolicyproof\n');
  await writeFile(join(root, 'src', 'nested', 'target.ts'), 'export const xssproof = true;\n');
  await initCommand(root);
  const indexed = await contextIndexCommand(root);
  const base = requestValue(indexed.worktree_digest, indexed.repository_id);
  const goal = 'Prevent cross-site scripting in xssproof';
  const acceptance = 'The target evidence is selected';
  const capsule = {
    schema_version: '0.1', task_id: base.task.task_id, goal, task_type: base.task.task_type,
    boundaries: {
      allowed_paths: ['src/nested/target.ts'],
      forbidden_paths: ['SECURITY.md', 'CODE_OF_CONDUCT.md', 'src/nested/AGENTS.md'],
    },
    documents: [], code_targets: ['src/nested/target.ts'], contracts: [], decisions: [],
    acceptance: [acceptance],
    context_budget: { initial_tokens: 6000, soft_limit_tokens: 12000, hard_limit_tokens: 24000 },
  };
  await writeFile(
    join(root, '.primecontext', 'capsules', `${base.task.task_id}.json`),
    JSON.stringify(capsule),
  );
  const request: ContextPlanRequestV03 = {
    ...base,
    capsule_digest: hashContextJson(capsule),
    task: {
      ...base.task,
      goal,
      query: 'xssproof cross-site scripting',
      hints: { paths: ['src/nested/target.ts'], symbols: [], terms: ['xssproof'] },
      acceptance_criteria: [{ id: 'AC-POLICY', text: acceptance, required_terms: ['xssproof'] }],
    },
  };

  const prepared = await compilePreparedContext(root, request);
  const selected = new Map(prepared.envelope.items.map((item) => [item.path, item]));
  assert.equal(selected.get('AGENTS.md')?.mandatory, true);
  assert.equal(selected.get('SECURITY.md')?.mandatory, true);
  assert.equal(selected.get('src/nested/AGENTS.md')?.mandatory, true);
  assert.ok(selected.has('src/nested/target.ts'));
  assert.equal(selected.has('CODE_OF_CONDUCT.md'), false);
  assert.equal(prepared.envelope.source_failures.some((failure) => failure.security_control), false);
});

test('linked capsule goal and every acceptance criterion must match the request exactly', async () => {
  const root = await contextFixture();
  await initCommand(root);
  const indexed = await contextIndexCommand(root);
  const capsulePath = join(root, '.primecontext', 'capsules', 'CTX-VERTICAL-001.json');
  const baseCapsule = {
    schema_version: '0.1' as const,
    task_id: 'CTX-VERTICAL-001',
    goal: 'A different goal',
    task_type: 'module_feature' as const,
    boundaries: { allowed_paths: [], forbidden_paths: [] },
    acceptance: ['Capsule-only acceptance'],
    context_budget: { initial_tokens: 6000, soft_limit_tokens: 12000, hard_limit_tokens: 24000 },
  };
  await writeFile(capsulePath, JSON.stringify(baseCapsule));
  const request = {
    ...requestValue(indexed.worktree_digest, indexed.repository_id),
    capsule_digest: hashContextJson(baseCapsule),
  };

  await assert.rejects(() => compilePreparedContext(root, request), (error: unknown) => {
    assert.equal(error instanceof PrimeContextError, true);
    assert.equal((error as PrimeContextError).code, 'STATE_ERROR');
    return true;
  });

  const matchingGoal = { ...baseCapsule, goal: request.task.goal };
  await writeFile(capsulePath, JSON.stringify(matchingGoal));
  await assert.rejects(
    () => compilePreparedContext(root, { ...request, capsule_digest: hashContextJson(matchingGoal) }),
    (error: unknown) => {
      assert.equal(error instanceof PrimeContextError, true);
      assert.equal((error as PrimeContextError).code, 'STATE_ERROR');
      return true;
    },
  );
});

test('selected physical sources are reread, screened, and rehashed before plan persistence', async () => {
  const root = await contextFixture();
  await initCommand(root);
  const observation = await createContextPreparationObservation(root);
  const request = requestValue(observation.live.snapshot.worktree_digest, observation.live.repository_id);
  request.required_sources = ['src/compiler.ts'];
  await writeFile(join(root, 'src', 'compiler.ts'), 'export const changedAfterObservation = true;\n');

  await assert.rejects(() => compilePreparedContext(root, request, observation), (error: unknown) => {
    assert.equal(error instanceof PrimeContextError, true);
    assert.equal((error as PrimeContextError).code, 'FRESHNESS_ERROR');
    return true;
  });
  await assert.rejects(() => contextIndexCommand(root, observation), (error: unknown) => {
    assert.equal(error instanceof PrimeContextError, true);
    assert.equal((error as PrimeContextError).code, 'FRESHNESS_ERROR');
    return true;
  });
  await assert.rejects(
    readFile(join(root, '.primecontext', 'context', 'plans', 'CTX-VERTICAL-001', 'package.json')),
    /ENOENT/,
  );

  const securityObservation = await createContextPreparationObservation(root);
  const securityRequest = requestValue(
    securityObservation.live.snapshot.worktree_digest,
    securityObservation.live.repository_id,
  );
  securityRequest.required_sources = ['src/compiler.ts'];
  await writeFile(
    join(root, 'src', 'compiler.ts'),
    'export const token = "Authorization: Basic dXNlcjpwYXNzd29yZA==";\n',
  );
  await assert.rejects(
    () => compilePreparedContext(root, securityRequest, securityObservation),
    (error: unknown) => {
      assert.equal(error instanceof PrimeContextError, true);
      assert.equal((error as PrimeContextError).code, 'SECURITY_ERROR');
      assert.doesNotMatch((error as Error).message, /compiler\.ts|dXNlcj/i);
      return true;
    },
  );
});

test('full accepted-source freshness rejects gain, loss, rehash, and screened-policy drift before persistence', async (t) => {
  const mutations: Array<{
    name: string;
    apply(root: string): Promise<void>;
  }> = [
    {
      name: 'gain',
      apply: (root) => writeFile(join(root, 'src', 'new-source.py'), 'def newly_added():\n    return True\n'),
    },
    {
      name: 'loss',
      apply: (root) => rm(join(root, 'src', 'unselected.py')),
    },
    {
      name: 'unselected rehash',
      apply: (root) => writeFile(join(root, 'src', 'unselected.py'), 'def changed_unselected():\n    return False\n'),
    },
    {
      name: 'screened policy gain',
      apply: (root) => writeFile(
        join(root, 'src', 'AGENTS.md'),
        '# Policy\nAuthorization: Basic dXNlcjpwYXNzd29yZA==\n',
      ),
    },
  ];

  for (const mutation of mutations) {
    await t.test(mutation.name, async () => {
      const root = await contextFixture();
      await writeFile(join(root, 'src', 'unselected.py'), 'def unrelated_source():\n    return True\n');
      await initCommand(root);
      const observation = await createContextPreparationObservation(root);
      const request = requestValue(observation.live.snapshot.worktree_digest, observation.live.repository_id);
      request.task.goal = 'Compile repository evidence';
      request.task.query = 'compiler';
      request.task.hints = { paths: ['src/compiler.ts'], symbols: [], terms: ['compiler'] };
      request.task.acceptance_criteria = [{ id: 'AC-COMPILER', text: 'Compiler evidence', required_terms: ['compiler'] }];
      await mutation.apply(root);

      await assert.rejects(() => compilePreparedContext(root, request, observation), (error: unknown) => {
        assert.equal(error instanceof PrimeContextError, true);
        assert.equal((error as PrimeContextError).code, 'FRESHNESS_ERROR');
        return true;
      });
      await assert.rejects(
        readFile(join(root, '.primecontext', 'context', 'plans', request.task.task_id, 'package.json')),
        /ENOENT/,
      );
    });
  }
});

test('index verifies the full accepted-source manifest before publishing state', async () => {
  const root = await contextFixture();
  await initCommand(root);
  const observation = await createContextPreparationObservation(root);
  await writeFile(join(root, 'src', 'new-source.py'), 'def newly_added():\n    return True\n');

  await assert.rejects(() => contextIndexCommand(root, observation), (error: unknown) => {
    assert.equal(error instanceof PrimeContextError, true);
    assert.equal((error as PrimeContextError).code, 'FRESHNESS_ERROR');
    return true;
  });
  await assert.rejects(
    readFile(join(root, '.primecontext', 'context', 'index-manifest.json')),
    /ENOENT/,
  );
  await assert.rejects(
    readFile(join(root, '.primecontext', 'context', 'index.sqlite')),
    /ENOENT/,
  );
});

test('mutated observation state directories are rejected before index or plan writes', async (t) => {
  for (const operation of ['index', 'plan'] as const) {
    await t.test(operation, async () => {
      const root = await contextFixture();
      await initCommand(root);
      const observation = await createContextPreparationObservation(root);
      const request = requestValue(observation.live.snapshot.worktree_digest, observation.live.repository_id);
      observation.config.state_dir = 'tracked-state';

      const attempted = operation === 'index'
        ? contextIndexCommand(root, observation)
        : compilePreparedContext(root, request, observation);
      await assert.rejects(attempted, (error: unknown) => {
        assert.equal(error instanceof PrimeContextError, true);
        assert.equal((error as PrimeContextError).code, 'FRESHNESS_ERROR');
        return true;
      });
      await assert.rejects(stat(join(root, 'tracked-state')), /ENOENT/);
    });
  }
});

test('tampered observation selection data is rejected before candidates or plan writes', async (t) => {
  type Observation = Awaited<ReturnType<typeof createContextPreparationObservation>>;
  const mutations: Array<{
    name: string;
    marker: string;
    apply(observation: Observation): void;
  }> = [
    {
      name: 'filesystem body with retained source hash',
      marker: 'forged_body_observation_proof',
      apply(observation) {
        const source = observation.live.filesystem_sources.find((candidate) => candidate.path === 'src/compiler.ts');
        assert.ok(source);
        source.content = 'export const forged_body_observation_proof = true;\n';
      },
    },
    {
      name: 'document title with retained source hash',
      marker: 'forged_title_observation_proof',
      apply(observation) {
        const source = observation.live.documents.sources.find((candidate) => candidate.relative_path === 'README.md');
        assert.ok(source);
        source.metadata.title = 'forged_title_observation_proof';
      },
    },
    {
      name: 'source locator with retained source hash',
      marker: 'forged_locator_observation_proof',
      apply(observation) {
        const source = observation.live.filesystem_sources.find((candidate) => candidate.path === 'src/compiler.ts');
        assert.ok(source);
        source.locator = { start_line: 1, end_line: 1, symbol: 'forged_locator_observation_proof' };
      },
    },
    {
      name: 'code graph removal with retained source hashes',
      marker: 'compiler',
      apply(observation) {
        assert.ok(observation.live.graph);
        observation.live.graph = undefined;
      },
    },
  ];

  for (const mutation of mutations) {
    await t.test(mutation.name, async () => {
      const root = await contextFixture();
      await initCommand(root);
      const observation = await createContextPreparationObservation(root);
      const request = requestValue(observation.live.snapshot.worktree_digest, observation.live.repository_id);
      request.task.goal = `Compile ${mutation.marker}`;
      request.task.query = mutation.marker;
      request.task.hints = { paths: ['src/compiler.ts'], symbols: [], terms: [mutation.marker] };
      request.task.acceptance_criteria = [{
        id: 'AC-OBSERVATION-INTEGRITY',
        text: `Select ${mutation.marker}`,
        required_terms: [mutation.marker],
      }];
      mutation.apply(observation);

      await assert.rejects(() => compilePreparedContext(root, request, observation), (error: unknown) => {
        assert.equal(error instanceof PrimeContextError, true);
        assert.equal((error as PrimeContextError).code, 'FRESHNESS_ERROR');
        return true;
      });
      await assert.rejects(
        readFile(join(root, '.primecontext', 'context', 'plans', request.task.task_id, 'package.json')),
        /ENOENT/,
      );
    });
  }
});

test('an untouched observation remains deterministically reusable', async () => {
  const root = await contextFixture();
  await initCommand(root);
  const observation = await createContextPreparationObservation(root);
  const request = requestValue(observation.live.snapshot.worktree_digest, observation.live.repository_id);

  const first = await compilePreparedContext(root, request, observation);
  const second = await compilePreparedContext(root, structuredClone(request), observation);

  assert.deepEqual(second, first);
});

test('safe filesystem fallback indexes non-TypeScript sources and binds them to freshness', async () => {
  const root = await contextFixture();
  await writeFile(join(root, 'src', 'worker.py'), 'def unique_python_worker():\n    return "python-proof"\n');
  await initCommand(root);
  const indexed = await contextIndexCommand(root);
  const requestPath = 'python-request.json';
  const request = requestValue(indexed.worktree_digest, indexed.repository_id);
  request.task.query = 'unique python worker';
  request.task.hints = { paths: ['src/worker.py'], symbols: [], terms: ['python-proof'] };
  request.task.acceptance_criteria = [{ id: 'AC-PY', text: 'Python worker', required_terms: ['python'] }];
  await writeFile(join(root, requestPath), JSON.stringify(request));
  await contextPlanCommand(root, requestPath);
  const inspected = await contextInspectCommand(root, 'CTX-VERTICAL-001');
  assert.ok(inspected.envelope.items.some((item) => item.provider === 'filesystem' && item.path === 'src/worker.py'));

  await writeFile(join(root, 'src', 'worker.py'), 'def unique_python_worker():\n    return "changed"\n');
  const changed = await contextIndexCommand(root);
  assert.notEqual(changed.worktree_digest, indexed.worktree_digest);
});

test('outcome must use the stored snapshot and selected candidate ids', async () => {
  const root = await contextFixture();
  await initCommand(root);
  const indexed = await contextIndexCommand(root);
  const requestPath = 'context-request.json';
  await writeFile(join(root, requestPath), JSON.stringify(requestValue(indexed.worktree_digest, indexed.repository_id)));
  await contextPlanCommand(root, requestPath);
  const inspected = await contextInspectCommand(root, 'CTX-VERTICAL-001');
  const outcomePath = 'bad-outcome.json';
  await writeFile(join(root, outcomePath), JSON.stringify({
    schema_version: '0.3', run_id: 'RUN-BAD', task_id: 'CTX-VERTICAL-001',
    selection_digest: inspected.envelope.selection_digest,
    snapshot: { ...inspected.envelope.snapshot, worktree_digest: `sha256:${'f'.repeat(64)}` },
    started_at: '2026-08-12T11:59:00.000Z', recorded_at: '2026-08-12T12:00:00.000Z',
    used_candidate_ids: [`sha256:${'e'.repeat(64)}`], touched_paths: [], metrics: {},
    test_status: 'PASS', review_status: 'NOT_RUN', completion_status: 'PASS', source: 'tool',
  }));
  await assert.rejects(() => contextOutcomeCommand(root, 'CTX-VERTICAL-001', outcomePath), /stored context selection/i);
});

test('expansion retries are idempotent and a ninth unique request is rejected', async () => {
  const root = await contextFixture();
  await initCommand(root);
  const indexed = await contextIndexCommand(root);
  const requestPath = 'context-request.json';
  await writeFile(join(root, requestPath), JSON.stringify(requestValue(indexed.worktree_digest, indexed.repository_id)));
  await contextPlanCommand(root, requestPath);
  let inspected = await contextInspectCommand(root, 'CTX-VERTICAL-001');
  let firstDecision: Awaited<ReturnType<typeof contextExpandCommand>> | undefined;
  for (let index = 0; index < 8; index += 1) {
    const path = `expansion-${index}.json`;
    await writeFile(join(root, path), JSON.stringify({
      schema_version: '0.3', task_id: 'CTX-VERTICAL-001',
      previous_selection_digest: inspected.envelope.selection_digest,
      known_candidate_ids: inspected.envelope.items.map((item) => item.id), reason: 'MISSING_TERM',
      requested_paths: [], requested_symbols: [], requested_terms: [`missing${index}`],
      additional_budget: { max_items: 1, max_bytes: 1024, max_estimated_tokens: 256 },
    }));
    const decision = await contextExpandCommand(root, 'CTX-VERTICAL-001', path);
    if (index === 0) {
      firstDecision = decision;
      assert.deepEqual(await contextExpandCommand(root, 'CTX-VERTICAL-001', path), decision);
    }
    inspected = await contextInspectCommand(root, 'CTX-VERTICAL-001');
  }
  assert.ok(firstDecision);
  const ninth = 'expansion-9.json';
  await writeFile(join(root, ninth), JSON.stringify({
    schema_version: '0.3', task_id: 'CTX-VERTICAL-001',
    previous_selection_digest: inspected.envelope.selection_digest,
    known_candidate_ids: inspected.envelope.items.map((item) => item.id), reason: 'MISSING_TERM',
    requested_paths: [], requested_symbols: [], requested_terms: ['ninth'],
    additional_budget: { max_items: 1, max_bytes: 1024, max_estimated_tokens: 256 },
  }));
  await assert.rejects(() => contextExpandCommand(root, 'CTX-VERTICAL-001', ninth), /expansion count limit/i);
});

test('replay rejects a tampered expansion ledger instead of hiding corrupt state', async () => {
  const root = await contextFixture();
  await initCommand(root);
  const indexed = await contextIndexCommand(root);
  const requestPath = 'context-request.json';
  await writeFile(join(root, requestPath), JSON.stringify(requestValue(indexed.worktree_digest, indexed.repository_id)));
  await contextPlanCommand(root, requestPath);
  const stored = await contextInspectCommand(root, 'CTX-VERTICAL-001');
  const expansionPath = 'tamper-expansion.json';
  await writeFile(join(root, expansionPath), JSON.stringify({
    schema_version: '0.3', task_id: 'CTX-VERTICAL-001', previous_selection_digest: stored.envelope.selection_digest,
    known_candidate_ids: stored.envelope.items.map((item) => item.id), reason: 'MISSING_TERM',
    requested_paths: [], requested_symbols: [], requested_terms: ['absent'],
    additional_budget: { max_items: 1, max_bytes: 1024, max_estimated_tokens: 256 },
  }));
  await contextExpandCommand(root, 'CTX-VERTICAL-001', expansionPath);
  const ledger = join(root, '.primecontext', 'context', 'plans', 'CTX-VERTICAL-001', 'expansions.jsonl');
  const record = JSON.parse((await readFile(ledger, 'utf8')).trim()) as Record<string, unknown>;
  record.record_digest = `sha256:${'0'.repeat(64)}`;
  await writeFile(ledger, `${JSON.stringify(record)}\n`);
  await assert.rejects(() => contextReplayCommand(root, 'CTX-VERTICAL-001'), /STATE_ERROR|expansion ledger/i);
});

test('expansion retry rejects a coherently rehashed ledger that is not anchored to the stored plan', async () => {
  const root = await contextFixture();
  await initCommand(root);
  const indexed = await contextIndexCommand(root);
  const requestPath = 'context-request.json';
  await writeFile(join(root, requestPath), JSON.stringify(requestValue(indexed.worktree_digest, indexed.repository_id)));
  await contextPlanCommand(root, requestPath);
  const stored = await contextInspectCommand(root, 'CTX-VERTICAL-001');
  const expansionPath = 'anchored-expansion.json';
  const expansion = {
    schema_version: '0.3', task_id: 'CTX-VERTICAL-001', previous_selection_digest: stored.envelope.selection_digest,
    known_candidate_ids: stored.envelope.items.map((item) => item.id), reason: 'MISSING_TERM',
    requested_paths: [], requested_symbols: [], requested_terms: ['originally-absent'],
    additional_budget: { max_items: 1, max_bytes: 1024, max_estimated_tokens: 256 },
  };
  await writeFile(join(root, expansionPath), JSON.stringify(expansion));
  await contextExpandCommand(root, 'CTX-VERTICAL-001', expansionPath);

  const ledger = join(root, '.primecontext', 'context', 'plans', 'CTX-VERTICAL-001', 'expansions.jsonl');
  const record = JSON.parse((await readFile(ledger, 'utf8')).trim()) as {
    schema_version: '0.3'; request: typeof expansion; decision: Record<string, unknown>; record_digest: string;
  };
  record.request.requested_terms = ['coherently-forged'];
  record.record_digest = hashContextJson({
    schema_version: '0.3', request: record.request, decision: record.decision,
  });
  await writeFile(ledger, `${JSON.stringify(record)}\n`);
  const forgedPath = 'forged-expansion.json';
  await writeFile(join(root, forgedPath), JSON.stringify(record.request));

  await assert.rejects(
    () => contextExpandCommand(root, 'CTX-VERTICAL-001', forgedPath),
    /STATE_ERROR|ledger.*anchor|ledger.*digest/i,
  );
});

test('replay is unavailable when the stored snapshot requires a Git head but Git metadata disappears', async () => {
  const root = await contextFixture();
  for (const args of [
    ['init', '-q'],
    ['config', 'user.email', 'primecontext@example.invalid'],
    ['config', 'user.name', 'PrimeContext Test'],
    ['add', '.'],
    ['commit', '-qm', 'fixture'],
  ]) {
    const git = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(git.status, 0, git.stderr);
  }
  await initCommand(root);
  const indexed = await contextIndexCommand(root);
  assert.ok(indexed.head);
  const base = requestValue(indexed.worktree_digest, indexed.repository_id);
  const request = { ...base, snapshot: { ...base.snapshot, head: indexed.head } };
  const requestPath = 'headed-request.json';
  await writeFile(join(root, requestPath), JSON.stringify(request));
  await contextPlanCommand(root, requestPath);
  await rm(join(root, '.git'), { recursive: true, force: true });

  const replay = await contextReplayCommand(root, 'CTX-VERTICAL-001');
  assert.equal(replay.status, 'UNREPLAYABLE');
  assert.equal(replay.freshness, 'UNAVAILABLE');
  assert.ok(replay.source_failures.some((failure) => (
    failure.provider === 'git' && failure.code === 'REPLAY_HEAD_UNAVAILABLE'
  )));
});

test('fresh index reuse does not acquire the rebuild lock or rewrite valid state', async (t) => {
  const root = await contextFixture();
  await initCommand(root);
  const indexed = await contextIndexCommand(root);
  if (indexed.fallback_used) {
    t.skip('SQLite FTS capability is unavailable in this Node runtime');
    return;
  }
  const indexPath = join(root, '.primecontext', 'context', 'index.sqlite');
  const manifestPath = join(root, '.primecontext', 'context', 'index-manifest.json');
  const beforeIndex = await readFile(indexPath);
  const beforeManifest = await readFile(manifestPath, 'utf8');
  const lockPath = `${indexPath}.lock`;
  await writeFile(lockPath, 'held by concurrent test');

  const reused = await contextIndexCommand(root) as Awaited<ReturnType<typeof contextIndexCommand>> & {
    fallback_used?: boolean;
    source_failures?: Array<{ provider: string; code: string }>;
  };
  assert.deepEqual(await readFile(indexPath), beforeIndex);
  assert.equal(await readFile(manifestPath, 'utf8'), beforeManifest);
  assert.equal(reused.reused, true);
  assert.equal(reused.fallback_used, false);
  assert.equal(reused.source_failures?.some((failure) => failure.provider === 'fts'), false);
  await rm(lockPath, { force: true });
});

test('manifest publication failure rolls the FTS database back to the prior valid bytes', {
  skip: process.platform !== 'win32' && 'Windows read-only replacement semantics are required for this fault injection',
}, async (t) => {
  const root = await contextFixture();
  await initCommand(root);
  const indexed = await contextIndexCommand(root);
  if (indexed.fallback_used) {
    t.skip('SQLite FTS capability is unavailable in this Node runtime');
    return;
  }
  const indexPath = join(root, '.primecontext', 'context', 'index.sqlite');
  const manifestPath = join(root, '.primecontext', 'context', 'index-manifest.json');
  const beforeIndex = await readFile(indexPath);
  const beforeManifest = await readFile(manifestPath, 'utf8');
  await writeFile(join(root, 'src', 'compiler.ts'), 'export const changedAfterIndex = true;\n');
  await chmod(manifestPath, 0o444);
  try {
    await assert.rejects(() => contextIndexCommand(root), /IO_ERROR|replace repository file atomically/i);
    assert.deepEqual(await readFile(indexPath), beforeIndex);
    assert.equal(await readFile(manifestPath, 'utf8'), beforeManifest);
  } finally {
    await chmod(manifestPath, 0o666);
  }
});

test('document candidate cap prioritizes required sources and exposes provider truncation', async () => {
  const root = await contextFixture();
  await mkdir(join(root, 'docs', 'generated'), { recursive: true });
  for (let index = 0; index < 1_025; index += 1) {
    await writeFile(
      join(root, 'docs', 'generated', `bulk-${String(index).padStart(4, '0')}.md`),
      `# Bulk ${index}\n\nsharedneedle evidence ${index}.`,
    );
  }
  await writeFile(join(root, 'docs', 'z-required.md'), '# Required\n\nsharedneedle required proof.');
  await writeFile(
    join(root, 'src', 'many-symbols.ts'),
    Array.from({ length: 1_025 }, (_value, index) => (
      `export const symbol${index} = "sharedneedle";`
    )).join('\n'),
  );
  await initCommand(root);
  const indexed = await contextIndexCommand(root);
  const base = requestValue(indexed.worktree_digest, indexed.repository_id);
  const request = {
    ...base,
    task: {
      ...base.task,
      query: 'sharedneedle',
      acceptance_criteria: [{ id: 'AC-DOC', text: 'Shared document evidence', required_terms: ['sharedneedle'] }],
      hints: { paths: [], symbols: [], terms: ['sharedneedle'] },
    },
    required_sources: ['docs/z-required.md'],
    budget: { max_items: 8, max_bytes: 32_768, max_estimated_tokens: 8_192 },
  };
  const requestPath = 'document-cap-request.json';
  await writeFile(join(root, requestPath), JSON.stringify(request));
  await contextPlanCommand(root, requestPath);
  const stored = await contextInspectCommand(root, 'CTX-VERTICAL-001');
  assert.ok(stored.envelope.items.some((item) => item.path === 'docs/z-required.md'));
  assert.equal(stored.envelope.missing_required_sources.includes('docs/z-required.md'), false);
  assert.equal(stored.envelope.truncation.source_truncated, true);
  assert.ok(stored.envelope.truncation.truncation_reasons?.includes('PROVIDER_RESULT_LIMIT'));
  assert.ok(stored.envelope.truncation.truncation_reasons?.includes('CANDIDATE_SET_LIMIT'));
  assert.ok(stored.envelope.truncation.considered_candidates <= 2_048);
});

test('filesystem collection caps never silently omit an applicable AGENTS policy', async (t) => {
  for (const scenario of ['count', 'total-bytes', 'oversize-policy'] as const) {
    await t.test(scenario, () => {
      const result = runFilesystemPolicyCapacityScenario(scenario);
      assert.equal(result.target_selected, true, JSON.stringify(result));
      assert.equal(
        result.policy_selected || result.security_failure,
        true,
        `applicable policy must be selected or fail closed: ${JSON.stringify(result)}`,
      );
      assert.equal(
        result.evidence_status === 'READY' && !result.policy_selected,
        false,
        `READY cannot omit an applicable policy: ${JSON.stringify(result)}`,
      );
      if (result.policy_selected) assert.equal(result.policy_mandatory, true, JSON.stringify(result));
    });
  }
});

test('filesystem provider cap never silently omits an applicable policy after 1,024 candidates', () => {
  const result = runFilesystemPolicyCapacityScenario('provider');
  assert.equal(result.observation_policy_present, true, JSON.stringify(result));
  assert.equal(result.target_selected, true, JSON.stringify(result));
  assert.equal(
    result.policy_selected || result.security_failure,
    true,
    `applicable policy must be selected or fail closed: ${JSON.stringify(result)}`,
  );
  assert.equal(
    result.evidence_status === 'READY' && !result.policy_selected,
    false,
    `READY cannot omit an applicable policy: ${JSON.stringify(result)}`,
  );
  if (result.policy_selected) assert.equal(result.policy_mandatory, true, JSON.stringify(result));
});

test('aggregate candidate cap never lets a required non-policy candidate displace applicable policy', () => {
  const result = runFilesystemPolicyCapacityScenario('aggregate');
  assert.equal(result.observation_policy_present, true, JSON.stringify(result));
  assert.equal(result.required_selected, true, JSON.stringify(result));
  assert.equal(
    result.policy_selected || result.security_failure,
    true,
    `applicable aggregate-omitted policy must fail closed: ${JSON.stringify(result)}`,
  );
  assert.equal(
    result.evidence_status === 'READY' && !result.policy_selected,
    false,
    `READY cannot omit an applicable aggregate policy: ${JSON.stringify(result)}`,
  );
  if (result.policy_selected) assert.equal(result.policy_mandatory, true, JSON.stringify(result));
});

test('source collection bounds carry an explicit reason without relabeling short excerpts', async () => {
  const root = await contextFixture();
  await writeFile(join(root, 'src', 'selected.py'), 'def collectionproof():\n    return True\n');
  await writeFile(join(root, 'src', 'oversized.py'), `safe = "${'x'.repeat(1024 * 1024)}"\n`);
  await initCommand(root);
  const indexed = await contextIndexCommand(root);
  const request = requestValue(indexed.worktree_digest, indexed.repository_id);
  request.task.query = 'collectionproof';
  request.task.hints = { paths: ['src/selected.py'], symbols: [], terms: ['collectionproof'] };
  request.task.acceptance_criteria = [{ id: 'AC-COLLECTION', text: 'Collection proof', required_terms: ['collectionproof'] }];
  const prepared = await compilePreparedContext(root, request);
  const selected = prepared.envelope.items.find((item) => item.path === 'src/selected.py');
  assert.ok(selected);
  assert.deepEqual(selected.discovery.truncation_reasons, ['SOURCE_COLLECTION_LIMIT']);
  assert.equal(selected.discovery.truncated, true);
});

test('replanning a task invalidates its prior expansion chain', async () => {
  const root = await contextFixture();
  await initCommand(root);
  const indexed = await contextIndexCommand(root);
  const requestPath = 'context-request.json';
  const firstRequest = requestValue(indexed.worktree_digest, indexed.repository_id);
  await writeFile(join(root, requestPath), JSON.stringify(firstRequest));
  await contextPlanCommand(root, requestPath);
  const first = await contextInspectCommand(root, 'CTX-VERTICAL-001');
  const expansionPath = 'old-expansion.json';
  const oldExpansion = {
    schema_version: '0.3', task_id: 'CTX-VERTICAL-001', previous_selection_digest: first.envelope.selection_digest,
    known_candidate_ids: first.envelope.items.map((item) => item.id), reason: 'MISSING_TERM',
    requested_paths: [], requested_symbols: [], requested_terms: ['absent'],
    additional_budget: { max_items: 1, max_bytes: 1024, max_estimated_tokens: 256 },
  };
  await writeFile(join(root, expansionPath), JSON.stringify(oldExpansion));
  await contextExpandCommand(root, 'CTX-VERTICAL-001', expansionPath);
  await writeFile(join(root, requestPath), JSON.stringify({ ...firstRequest, policy_version: '0.3-replanned' }));
  await contextPlanCommand(root, requestPath);
  const retried = await contextExpandCommand(root, 'CTX-VERTICAL-001', expansionPath);
  assert.equal(retried.decision.status, 'DENIED');
  assert.deepEqual(retried.decision.reason_codes, ['STALE_PARENT']);
});

test('fallback excerpt is bounded around a relevant term beyond line 400', async () => {
  const root = await contextFixture();
  const lines = Array.from({ length: 1_000 }, (_value, index) => index === 899 ? 'deepneedle proof' : `safe line ${index}`);
  await writeFile(join(root, 'src', 'deep.py'), lines.join('\n'));
  await initCommand(root);
  const indexed = await contextIndexCommand(root);
  if (!indexed.fallback_used) await rm(join(root, '.primecontext', 'context', 'index.sqlite'));
  const requestPath = 'deep-request.json';
  const request = requestValue(indexed.worktree_digest, indexed.repository_id);
  request.task.query = 'deepneedle';
  request.task.acceptance_criteria = [{ id: 'AC-DEEP', text: 'Deep evidence', required_terms: ['deepneedle'] }];
  request.task.hints = { paths: ['src/deep.py'], symbols: [], terms: ['deepneedle'] };
  await writeFile(join(root, requestPath), JSON.stringify(request));
  await contextPlanCommand(root, requestPath);
  const stored = await contextInspectCommand(root, 'CTX-VERTICAL-001');
  const selected = stored.envelope.items.find((item) => item.path === 'src/deep.py');
  assert.ok(selected);
  assert.match(selected.excerpt, /deepneedle/);
  assert.ok(selected.excerpt.split(/\r?\n/u).length <= 400);
  assert.deepEqual(selected.discovery.truncation_reasons, ['EXCERPT_BOUND']);
});

test('relevant excerpt anchors by NFKC-normalized line without offset drift', async () => {
  const root = await contextFixture();
  const expandingPrefix = Array.from(
    { length: 700 },
    (_value, index) => `${String(index).padStart(4, '0')} ${'ﬃ'.repeat(80)}`,
  );
  const lines = [
    ...expandingPrefix,
    'normalizedneedle proof is on the intended line',
    ...Array.from({ length: 500 }, (_value, index) => `tail ${index}`),
  ];
  await writeFile(join(root, 'src', 'normalized.py'), lines.join('\n'));
  await initCommand(root);
  const indexed = await contextIndexCommand(root);
  if (!indexed.fallback_used) await rm(join(root, '.primecontext', 'context', 'index.sqlite'));
  const request = requestValue(indexed.worktree_digest, indexed.repository_id);
  request.task.query = 'normalizedneedle';
  request.task.acceptance_criteria = [{ id: 'AC-NFKC', text: 'Normalized evidence', required_terms: ['normalizedneedle'] }];
  request.task.hints = { paths: ['src/normalized.py'], symbols: [], terms: ['normalizedneedle'] };
  await writeFile(join(root, 'normalized-request.json'), JSON.stringify(request));
  await contextPlanCommand(root, 'normalized-request.json');
  const stored = await contextInspectCommand(root, 'CTX-VERTICAL-001');
  const selected = stored.envelope.items.find((item) => item.path === 'src/normalized.py');
  assert.ok(selected);
  assert.match(selected.excerpt, /normalizedneedle/);
  assert.ok(selected.excerpt.split(/\r?\n/u).length <= 400);
});

test('blocked required evidence yields a sanitized explicit source failure', async () => {
  const root = await contextFixture();
  await writeFile(join(root, '.env'), 'SECRET_VALUE=do-not-disclose\n');
  await initCommand(root);
  const indexed = await contextIndexCommand(root);
  const request = {
    ...requestValue(indexed.worktree_digest, indexed.repository_id),
    required_sources: ['.env'],
  };
  await writeFile(join(root, 'blocked-required.json'), JSON.stringify(request));
  await contextPlanCommand(root, 'blocked-required.json');
  const stored = await contextInspectCommand(root, 'CTX-VERTICAL-001');
  const failure = stored.envelope.source_failures.find((item) => item.code === 'REQUIRED_SOURCE_BLOCKED');
  assert.ok(failure);
  assert.equal(failure.security_control, true);
  assert.equal(JSON.stringify(failure).includes('SECRET_VALUE'), false);
  assert.equal(JSON.stringify(failure).includes('do-not-disclose'), false);
});
