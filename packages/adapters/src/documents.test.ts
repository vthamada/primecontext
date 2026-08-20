import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PrimeContextError } from '@primecontext/core';
import {
  DEFAULT_DOCUMENT_DISCOVERY_LIMITS,
  NodeDocumentSourceAdapter,
  NodeFileSystemAdapter,
  NodeSha256Hasher,
  readSafeRepositoryText,
} from './index.js';
import { windowsShortNameFor } from './windows-short-name.test-helper.js';

interface ExpectedDocumentSource {
  relative_path: string;
  content: string;
  size_bytes: number;
  source_hash: string;
  metadata: {
    title: string;
    authority: string;
    modules: string[];
    topics: string[];
  };
}

function sourcePaths(result: { sources: ExpectedDocumentSource[] }): string[] {
  return result.sources.map((source) => source.relative_path);
}

function sourceAt(
  result: { sources: ExpectedDocumentSource[] },
  relativePath: string,
): ExpectedDocumentSource | undefined {
  return result.sources.find((source) => source.relative_path === relativePath);
}

async function repositoryFixture(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'primecontext-documents-'));
}

test('document collection is limited to docs Markdown and canonical root Markdown', async () => {
  const root = await repositoryFixture();
  await mkdir(join(root, 'docs', 'nested'), { recursive: true });
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'README.md'), '# Repository\n');
  await writeFile(join(root, 'AGENTS.md'), '# Agent policy\n');
  await writeFile(join(root, 'SECURITY.md'), '# Security policy\n');
  await writeFile(join(root, 'CONTRIBUTING.md'), '# Contributing\n');
  await writeFile(join(root, 'CODE_OF_CONDUCT.md'), '# Conduct\n');
  await writeFile(join(root, 'CHANGELOG.md'), '# Changes\n');
  await writeFile(join(root, 'docs', 'nested', 'guide.md'), '# Nested guide\nAllowed body.\n');
  await writeFile(join(root, 'docs', 'not-markdown.txt'), 'must remain out');
  await writeFile(join(root, 'src', 'implementation.md'), '# Source note\nmust remain out');
  await writeFile(join(root, 'local-notes.md'), '# Local note\nmust remain out');
  await writeFile(
    join(root, 'PrimeContext — Implementation Continuation.md'),
    '# Local continuation prompt\nmust remain out',
  );

  const result = await new NodeDocumentSourceAdapter().collect(root);
  const paths = sourcePaths(result);

  assert.deepEqual(paths, [
    'AGENTS.md',
    'CHANGELOG.md',
    'CODE_OF_CONDUCT.md',
    'CONTRIBUTING.md',
    'README.md',
    'SECURITY.md',
    'docs/nested/guide.md',
  ]);
  const guide = sourceAt(result, 'docs/nested/guide.md');
  assert.equal(guide?.content, '# Nested guide\nAllowed body.\n');
  assert.equal(guide?.size_bytes, Buffer.byteLength('# Nested guide\nAllowed body.\n'));
  assert.match(guide?.source_hash ?? '', /^sha256:[a-f0-9]{64}$/);
});

test('sensitive paths and configured excludes are rejected before content decoding', async () => {
  const root = await repositoryFixture();
  await mkdir(join(root, 'docs', 'excluded'), { recursive: true });
  await mkdir(join(root, '.primecontext', 'docs'), { recursive: true });
  await writeFile(join(root, 'docs', 'safe.md'), '# Safe\nVisible.\n');
  const invalidUtf8 = Buffer.from([0xc3, 0x28]);
  await writeFile(join(root, 'docs', 'credentials.md'), invalidUtf8);
  await writeFile(join(root, 'docs', '.env.production.md'), invalidUtf8);
  await writeFile(join(root, 'docs', 'excluded', 'private.md'), invalidUtf8);
  await writeFile(join(root, '.primecontext', 'docs', 'generated.md'), '# Generated secret\n');

  const result = await new NodeDocumentSourceAdapter(['docs/excluded']).collect(root);
  const serialized = JSON.stringify(result);

  assert.deepEqual(sourcePaths(result), ['docs/safe.md']);
  assert.equal(result.skipped_binary_count, 0, 'blocked paths must not be decoded as documents');
  assert.ok(result.excluded_path_count >= 4);
  for (const blocked of ['credentials.md', '.env.production.md', 'private.md', 'generated.md']) {
    assert.equal(serialized.includes(blocked), false, blocked);
  }
});

test('safe repository text rejects sensitive paths before attempting a filesystem read', async () => {
  const root = await repositoryFixture();

  for (const relativePath of [
    '.git/config',
    '.primecontext/context.sqlite',
    '.obsidian/workspace.json',
  ]) {
    await assert.rejects(
      readSafeRepositoryText(root, relativePath, 1_024),
      (error: unknown) => {
        assert.equal(error instanceof PrimeContextError, true);
        assert.equal((error as PrimeContextError).code, 'SECURITY_ERROR');
        assert.match((error as Error).message, /sensitive path/i);
        return true;
      },
      relativePath,
    );
  }
});

test('document collection does not follow an intermediate symlink or junction', async () => {
  const root = await repositoryFixture();
  const outside = await repositoryFixture();
  await mkdir(join(root, 'docs'), { recursive: true });
  await writeFile(join(root, 'docs', 'safe.md'), '# Safe\n');
  await writeFile(join(outside, 'outside.md'), '# Outside\nDO-NOT-READ-LINKED-CONTENT\n');
  await symlink(outside, join(root, 'docs', 'linked'), platform() === 'win32' ? 'junction' : 'dir');

  const result = await new NodeDocumentSourceAdapter().collect(root);
  const serialized = JSON.stringify(result);

  assert.deepEqual(sourcePaths(result), ['docs/safe.md']);
  assert.ok(result.excluded_path_count >= 1);
  assert.equal(serialized.includes('outside.md'), false);
  assert.equal(serialized.includes('DO-NOT-READ-LINKED-CONTENT'), false);
});

test('SHA-256 hashing is stable and uses an explicit algorithm prefix', async () => {
  const hash = await new NodeSha256Hasher().hash('abc');
  assert.equal(hash, 'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('UTF-8 BOM is preserved for content hash freshness and ignored only for the first H1 title', async () => {
  const root = await repositoryFixture();
  await mkdir(join(root, 'docs'), { recursive: true });
  const content = '\uFEFF# BOM title\nFresh body.\n';
  await writeFile(join(root, 'docs', 'bom.md'), content, 'utf8');

  const result = await new NodeDocumentSourceAdapter().collect(root);
  const document = sourceAt(result, 'docs/bom.md');

  assert.equal(document?.content, content);
  assert.equal(document?.metadata.title, 'BOM title');
  assert.equal(document?.source_hash, new NodeSha256Hasher().hash(document?.content ?? ''));
});

test('invalid UTF-8 is omitted and counted without exposing decoded replacement data', async () => {
  const root = await repositoryFixture();
  await mkdir(join(root, 'docs'), { recursive: true });
  await writeFile(join(root, 'docs', 'valid.md'), '# Valid\n');
  await writeFile(join(root, 'docs', 'invalid.md'), Buffer.from([0x23, 0x20, 0xc3, 0x28, 0x0a]));

  const result = await new NodeDocumentSourceAdapter().collect(root);
  assert.deepEqual(sourcePaths(result), ['docs/valid.md']);
  assert.equal(result.skipped_binary_count, 1);
  assert.equal(JSON.stringify(result).includes('\ufffd'), false);
});

test('documents containing high-confidence secrets or labelled client PII are omitted without disclosure', async () => {
  const root = await repositoryFixture();
  await mkdir(join(root, 'docs'), { recursive: true });
  await writeFile(join(root, 'docs', 'public.md'), '# Public architecture\nNo private material.\n');
  await writeFile(
    join(root, 'docs', 'deployment-note.md'),
    '# Deployment\nAuthorization: Bearer eyJhbGciOiJIUzI1NiJ9.DO-NOT-EXPOSE.signature\n',
  );
  await writeFile(
    join(root, 'docs', 'basic-auth.md'),
    '# Basic auth\nAuthorization: Basic dXNlcjpwYXNzd29yZA==\n',
  );
  await writeFile(
    join(root, 'docs', 'short-basic-auth.md'),
    '# Short Basic auth\nAuthorization: Basic dTpw\n',
  );
  await writeFile(
    join(root, 'docs', 'inline-basic-auth.md'),
    '# Inline Basic auth\n`Authorization: Basic dXNlcjpwYXNzd29yZA==`\n',
  );
  await writeFile(
    join(root, 'docs', 'encrypted-private-key.md'),
    '# Encrypted key\n-----BEGIN ENCRYPTED PRIVATE KEY-----\nDO-NOT-EXPOSE\n',
  );
  await writeFile(
    join(root, 'docs', 'pgp-private-key.md'),
    '# PGP key\n-----BEGIN PGP PRIVATE KEY BLOCK-----\nDO-NOT-EXPOSE\n',
  );
  await writeFile(
    join(root, 'docs', 'customer-record.md'),
    '# Customer\nclient_cpf=123.456.789-09\n',
  );
  await writeFile(
    join(root, 'docs', 'tax-cpf.md'),
    '# Tax record\n"cpf": "529.982.247-25"\n',
  );
  await writeFile(
    join(root, 'docs', 'tax-cnpj.md'),
    '# Company record\n**CNPJ:** 04.252.011/0001-10\n',
  );
  await writeFile(
    join(root, 'docs', 'identifier-guide.md'),
    '# Identifier guide\nInvalid examples CPF: 111.111.111-11 and CNPJ: 00.000.000/0000-00.\n',
  );
  await writeFile(
    join(root, 'docs', 'json-secret.md'),
    '# JSON example\n{"api_key":"abcdefghijklmnop1234567890"}\n',
  );
  await writeFile(
    join(root, 'docs', 'fine-grained-token.md'),
    '# Fine-grained token\ngithub_pat_SYNTHETIC0123456789abcdef\n',
  );
  await writeFile(
    join(root, 'docs', 'json-pii.md'),
    '# JSON PII\n{"client_email":"sensitive@example.test"}\n',
  );
  await writeFile(
    join(root, 'docs', 'table-cpf.md'),
    '# CPF table\n| CPF | 529.982.247-25 |\n',
  );
  await writeFile(
    join(root, 'docs', 'table-cnpj.md'),
    '# CNPJ table\n| CNPJ | 04.252.011/0001-10 |\n',
  );
  await writeFile(
    join(root, 'docs', 'markdown-secret.md'),
    '# Markdown secret\n**api_key:** P@ssw0rd-long!\n',
  );
  await writeFile(
    join(root, 'docs', 'json-password.md'),
    '# JSON password\n{"password":"P@ssw0rd-long!"}\n',
  );
  await writeFile(
    join(root, 'docs', 'json-alpha-password.md'),
    '# JSON password\n{"password":"CorrectHorseBatteryStaple"}\n',
  );
  await writeFile(
    join(root, 'docs', 'markdown-alpha-password.md'),
    '# Markdown password\n**password:** CorrectHorseBatteryStaple\n',
  );
  await writeFile(
    join(root, 'docs', 'table-numeric-password.md'),
    '# Password table\n| password | 12345678901234567890 |\n',
  );
  await writeFile(
    join(root, 'docs', 'json-passphrase-password.md'),
    '# JSON passphrase\n{"password":"correct horse battery staple"}\n',
  );
  await writeFile(
    join(root, 'docs', 'safe-label-guide.md'),
    [
      '# Safe labels',
      '| api_key | Configuration |',
      '| client_email | Description |',
      '',
      '**client_email:**',
      '{"api_key":"Configuration","required":true}',
      '{"api_key":"","required":true}',
      'Authorization: Basic',
      'Authorization: Basic Q29uZmlndXJhdGlvbg==',
      '',
    ].join('\n'),
  );

  const result = await new NodeDocumentSourceAdapter().collect(root);
  const serialized = JSON.stringify(result);

  assert.deepEqual(sourcePaths(result), [
    'docs/identifier-guide.md',
    'docs/public.md',
    'docs/safe-label-guide.md',
  ]);
  assert.equal(result.skipped_sensitive_content_count, 20);
  for (const blocked of [
    'deployment-note.md',
    'basic-auth.md',
    'short-basic-auth.md',
    'inline-basic-auth.md',
    'encrypted-private-key.md',
    'pgp-private-key.md',
    'customer-record.md',
    'tax-cpf.md',
    'tax-cnpj.md',
    'json-secret.md',
    'fine-grained-token.md',
    'json-pii.md',
    'table-cpf.md',
    'table-cnpj.md',
    'markdown-secret.md',
    'json-password.md',
    'json-alpha-password.md',
    'markdown-alpha-password.md',
    'table-numeric-password.md',
    'json-passphrase-password.md',
    'eyJhbGciOiJIUzI1NiJ9',
    'dXNlcjpwYXNzd29yZA==',
    'dTpw',
    'BEGIN ENCRYPTED PRIVATE KEY',
    'BEGIN PGP PRIVATE KEY BLOCK',
    '123.456.789-09',
    '529.982.247-25',
    '04.252.011/0001-10',
    'abcdefghijklmnop1234567890',
    'github_pat_SYNTHETIC0123456789abcdef',
    'sensitive@example.test',
    'P@ssw0rd-long!',
    'CorrectHorseBatteryStaple',
    '12345678901234567890',
    'correct horse battery staple',
  ]) {
    assert.equal(serialized.includes(blocked), false, blocked);
  }
});

test('document collection reports a bounded blocked-policy count without disclosing policy paths', async () => {
  const root = await repositoryFixture();
  await mkdir(join(root, 'docs'), { recursive: true });
  await writeFile(join(root, 'SECURITY.md'), '# Security\nAuthorization: Basic dXNlcjpwYXNzd29yZA==\n');
  await writeFile(join(root, 'CODE_OF_CONDUCT.md'), '# Conduct\nAuthorization: Basic dXNlcjpwYXNzd29yZA==\n');
  await writeFile(join(root, 'docs', 'private.md'), '# Private\nAuthorization: Basic dXNlcjpwYXNzd29yZA==\n');

  const result = await new NodeDocumentSourceAdapter().collect(root);
  assert.equal(result.skipped_sensitive_content_count, 3);
  assert.equal(result.blocked_policy_count, 2);
  assert.deepEqual(result.blocked_policy_kinds, { operational: 0, security: 1, governance: 1 });
  assert.equal(JSON.stringify(result).includes('SECURITY.md'), false);
  assert.equal(JSON.stringify(result).includes('CODE_OF_CONDUCT.md'), false);
});

test('document collection can audit an opt-in partial repository walk at capacity', async () => {
  const root = await repositoryFixture();
  let nested = root;
  for (let depth = 0; depth < 65; depth += 1) nested = join(nested, 'd');
  await mkdir(nested, { recursive: true });
  const adapter = new NodeDocumentSourceAdapter();

  await assert.rejects(() => adapter.collect(root), /depth limit exceeded/i);
  const partial = await adapter.collect(root, { capacityLimitBehavior: 'truncate' });
  assert.equal(partial.discovery_truncated, true);
  assert.deepEqual(partial.discovery_truncation_reasons, ['MAX_DEPTH']);
  assert.equal((partial.discovery_visited_entry_count ?? 0) > 0, true);
  assert.equal(partial.discovery_capacity_omitted_entry_count, 1);
  assert.equal(partial.blocked_policy_count, 1);
  assert.deepEqual(partial.blocked_policy_kinds, { operational: 1, security: 0, governance: 0 });
});

test('document collection reuses one accepted safe repository observation', async () => {
  const root = await repositoryFixture();
  const observation = await new NodeFileSystemAdapter().walk(
    root,
    { capacityLimitBehavior: 'truncate' },
  );
  await mkdir(join(root, 'docs'), { recursive: true });
  await writeFile(join(root, 'docs', 'created-after-observation.md'), '# Later\n');

  const result = await new NodeDocumentSourceAdapter().collect(root, {
    acceptedRepositoryWalk: observation,
  });

  assert.equal(result.sources.some((source) => source.relative_path === 'docs/created-after-observation.md'), false);
  assert.equal(result.discovered_path_count, observation.paths.length);
  assert.equal(result.blocked_policy_count, 0);
  assert.deepEqual(result.blocked_policy_kinds, { operational: 0, security: 0, governance: 0 });
});

test('accepted repository observations reject non-canonical aliases before selection, exclusion, or reads', async () => {
  const root = await repositoryFixture();
  await mkdir(join(root, 'docs'), { recursive: true });
  await mkdir(join(root, 'benchmarks'), { recursive: true });
  const agentsContent = '# Agent policy\nNONCANONICAL-AGENTS-CONTENT\n';
  const guideContent = '# Guide\nNONCANONICAL-GUIDE-CONTENT\n';
  const excludedContent = '# Private benchmark\nNONCANONICAL-EXCLUDED-CONTENT\n';
  await writeFile(join(root, 'AGENTS.md'), agentsContent);
  await writeFile(join(root, 'docs', 'guide.md'), guideContent);
  await writeFile(join(root, 'benchmarks', 'private.md'), excludedContent);
  const adapter = new NodeDocumentSourceAdapter(['benchmarks']);

  for (const relativePath of [
    'docs/../AGENTS.md',
    'docs/./guide.md',
    'docs//guide.md',
    'docs/../benchmarks/private.md',
  ]) {
    await assert.rejects(
      () => adapter.collect(root, {
        acceptedRepositoryWalk: {
          paths: [{
            relative_path: relativePath,
            kind: 'file',
            size_bytes: Buffer.byteLength(guideContent),
          }],
          excluded_path_count: 0,
          truncated: false,
          truncation_reasons: [],
          visited_entry_count: 1,
          capacity_omitted_entry_count: 0,
        },
      }),
      (error: unknown) => {
        assert.equal(error instanceof PrimeContextError, true);
        assert.equal((error as PrimeContextError).code, 'SECURITY_ERROR');
        const message = (error as Error).message;
        assert.match(message, /non-canonical/i);
        assert.equal(message.includes(relativePath), false);
        assert.equal(message.includes('NONCANONICAL-'), false);
        return true;
      },
      relativePath,
    );
  }

  const canonical = await adapter.collect(root, {
    acceptedRepositoryWalk: {
      paths: [{
        relative_path: 'docs/guide.md',
        kind: 'file',
        size_bytes: Buffer.byteLength(guideContent),
      }],
      excluded_path_count: 0,
      truncated: false,
      truncation_reasons: [],
      visited_entry_count: 1,
      capacity_omitted_entry_count: 0,
    },
  });
  assert.deepEqual(sourcePaths(canonical), ['docs/guide.md']);
  assert.equal(canonical.sources[0]?.content, guideContent);
});

test('accepted repository observations block Windows case and Unicode aliases of configured excludes before reads', {
  skip: platform() === 'win32' ? false : 'Windows path aliases are case-insensitive',
}, async () => {
  const root = await repositoryFixture();
  await mkdir(join(root, 'docs', 'private'), { recursive: true });
  await mkdir(join(root, 'docs', 'ı-private'), { recursive: true });
  const excludedContent = '# Excluded\nDO-NOT-MATERIALIZE-CASE-ALIAS\n';
  const unicodeExcludedContent = '# Excluded\nDO-NOT-MATERIALIZE-UNICODE-ALIAS\n';
  const acceptedContent = '# Accepted\nVisible control.\n';
  const siblingContent = '# Sibling\nPrefix control.\n';
  const decomposedContent = '# Decomposed\nNormalization control.\n';
  await mkdir(join(root, 'docs', 'private-sibling'), { recursive: true });
  await mkdir(join(root, 'docs', 'café'), { recursive: true });
  await writeFile(join(root, 'docs', 'private', 'hidden.md'), excludedContent);
  await writeFile(join(root, 'docs', 'ı-private', 'hidden.md'), unicodeExcludedContent);
  await writeFile(join(root, 'docs', 'private-sibling', 'visible.md'), siblingContent);
  await writeFile(join(root, 'docs', 'café', 'visible.md'), decomposedContent);
  await writeFile(join(root, 'docs', 'accepted-case-control.md'), acceptedContent);
  const adapter = new NodeDocumentSourceAdapter(['docs/private', 'docs/ı-private', 'docs/café']);
  const observation = (relativePath: string, sizeBytes: number) => ({
    paths: [{ relative_path: relativePath, kind: 'file' as const, size_bytes: sizeBytes }],
    excluded_path_count: 0,
    truncated: false,
    truncation_reasons: [],
    visited_entry_count: 1,
    capacity_omitted_entry_count: 0,
  });

  for (const [relativePath, content] of [
    ['docs/private/hidden.md', excludedContent],
    ['DOCS/private/hidden.md', excludedContent],
    ['docs/ı-private/hidden.md', unicodeExcludedContent],
    ['DOCS/I-PRIVATE/hidden.md', unicodeExcludedContent],
  ] as const) {
    await assert.rejects(
      adapter.collect(root, {
        acceptedRepositoryWalk: observation(relativePath, Buffer.byteLength(content)),
      }),
      (error: unknown) => {
        assert.equal(error instanceof PrimeContextError, true);
        assert.equal((error as PrimeContextError).code, 'SECURITY_ERROR');
        assert.doesNotMatch((error as Error).message, /docs|private|hidden|(?:CASE|UNICODE)-ALIAS/i);
        return true;
      },
      relativePath,
    );
  }

  for (const [relativePath, content] of [
    ['docs/private-sibling/visible.md', siblingContent],
    ['docs/café/visible.md', decomposedContent],
    ['docs/accepted-case-control.md', acceptedContent],
  ] as const) {
    const accepted = await adapter.collect(root, {
      acceptedRepositoryWalk: observation(relativePath, Buffer.byteLength(content)),
    });
    assert.deepEqual(sourcePaths(accepted), [relativePath]);
    assert.equal(accepted.sources[0]?.content, content);
  }
});

test('accepted repository observations resolve Windows DOS short names before blocked-path checks and reads', {
  skip: platform() === 'win32' ? false : 'Windows DOS short names are platform-specific',
}, async (t) => {
  const root = await repositoryFixture();
  t.after(async () => rm(root, { recursive: true, force: true }));
  const excluded = '# Excluded\nDOS-SHORT-NAME-EXCLUDED\n';
  const sensitive = '# Settings\nDOS-SHORT-NAME-SENSITIVE\n';
  const accepted = '# Accepted\nDOS short-name control.\n';
  await mkdir(join(root, 'docs', 'private-material'), { recursive: true });
  await mkdir(join(root, 'docs', '.obsidian'), { recursive: true });
  await mkdir(join(root, 'docs', 'public-material'), { recursive: true });
  await writeFile(join(root, 'docs', 'private-material', 'hidden.md'), excluded);
  await writeFile(join(root, 'docs', '.obsidian', 'hidden.md'), sensitive);
  await writeFile(join(root, 'docs', 'public-material', 'visible.md'), accepted);

  const excludedShortName = windowsShortNameFor(join(root, 'docs'), 'private-material');
  const sensitiveShortName = windowsShortNameFor(join(root, 'docs'), '.obsidian');
  const acceptedShortName = windowsShortNameFor(join(root, 'docs'), 'public-material');
  if (!excludedShortName || !sensitiveShortName || !acceptedShortName) {
    t.skip('The test volume does not expose DOS short names');
    return;
  }

  const observation = (relativePath: string, content: string) => ({
    paths: [{ relative_path: relativePath, kind: 'file' as const, size_bytes: Buffer.byteLength(content) }],
    excluded_path_count: 0,
    truncated: false,
    truncation_reasons: [],
    visited_entry_count: 1,
    capacity_omitted_entry_count: 0,
  });
  const adapter = new NodeDocumentSourceAdapter(['docs/private-material']);
  for (const [relativePath, content] of [
    ['docs/private-material/hidden.md', excluded],
    [`docs/${excludedShortName}/hidden.md`, excluded],
    ['docs/.obsidian/hidden.md', sensitive],
    [`docs/${sensitiveShortName}/hidden.md`, sensitive],
  ] as const) {
    await assert.rejects(
      adapter.collect(root, { acceptedRepositoryWalk: observation(relativePath, content) }),
      (error: unknown) => error instanceof PrimeContextError && error.code === 'SECURITY_ERROR',
      relativePath,
    );
  }

  const acceptedPath = `docs/${acceptedShortName}/visible.md`;
  const result = await adapter.collect(root, {
    acceptedRepositoryWalk: observation(acceptedPath, accepted),
  });
  assert.deepEqual(sourcePaths(result), [acceptedPath]);
  assert.equal(result.sources[0]?.content, accepted);
});

test('a truncated accepted walk reports a sanitized potential operational-policy omission without rewalking', async () => {
  const root = await repositoryFixture();
  const readmeContent = '# Readme\nVisible.\n';
  const omittedPolicyContent = '# Agent policy\nOMITTED-AGENTS-CONTENT\n';
  await writeFile(join(root, 'README.md'), readmeContent);
  await writeFile(join(root, 'AGENTS.md'), omittedPolicyContent);

  const result = await new NodeDocumentSourceAdapter().collect(root, {
    acceptedRepositoryWalk: {
      paths: [{
        relative_path: 'README.md',
        kind: 'file',
        size_bytes: Buffer.byteLength(readmeContent),
      }],
      excluded_path_count: 0,
      truncated: true,
      truncation_reasons: ['MAX_ENTRIES'],
      visited_entry_count: 2,
      capacity_omitted_entry_count: 1,
    },
  });

  assert.deepEqual(sourcePaths(result), ['README.md']);
  assert.equal(result.discovery_truncated, true);
  assert.deepEqual(result.discovery_truncation_reasons, ['MAX_ENTRIES']);
  assert.equal(result.discovery_capacity_omitted_entry_count, 1);
  assert.equal(result.blocked_policy_count, 1);
  assert.deepEqual(result.blocked_policy_kinds, { operational: 1, security: 0, governance: 0 });
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('AGENTS.md'), false);
  assert.equal(serialized.includes('OMITTED-AGENTS-CONTENT'), false);
});

test('excessive sensitive-label candidates fail closed within a bounded scan', async () => {
  const root = await repositoryFixture();
  await mkdir(join(root, 'docs'), { recursive: true });
  const labels = Array.from({ length: 1_025 }, () => '{"api_key":"Configuration"}').join(' ');
  await writeFile(join(root, 'docs', 'label-flood.md'), `# Label flood\n${labels}\n`);

  const result = await new NodeDocumentSourceAdapter().collect(root);
  assert.deepEqual(sourcePaths(result), []);
  assert.equal(result.skipped_sensitive_content_count, 1);
  assert.equal(JSON.stringify(result).includes('label-flood.md'), false);
});

test('per-document byte limits omit oversized documents and retain bounded sources', async () => {
  const root = await repositoryFixture();
  await mkdir(join(root, 'docs'), { recursive: true });
  await writeFile(join(root, 'docs', 'small.md'), '# S\n');
  await writeFile(join(root, 'docs', 'large.md'), `# Large\n${'x'.repeat(64)}\n`);

  const result = await new NodeDocumentSourceAdapter([], { maxDocumentBytes: 16 }).collect(root);
  assert.deepEqual(sourcePaths(result), ['docs/small.md']);
  assert.equal(result.skipped_oversize_count, 1);
});

test('total byte and document count hard limits reject partial collection', async () => {
  const root = await repositoryFixture();
  await mkdir(join(root, 'docs'), { recursive: true });
  await writeFile(join(root, 'docs', 'a.md'), '# A\n');
  await writeFile(join(root, 'docs', 'b.md'), '# B\n');

  await assert.rejects(
    () => new NodeDocumentSourceAdapter([], { maxTotalBytes: 6 }).collect(root),
    /SECURITY_ERROR.*(?:total|byte|limit)/i,
  );
  await assert.rejects(
    () => new NodeDocumentSourceAdapter([], { maxDocuments: 1 }).collect(root),
    /SECURITY_ERROR.*(?:document|count|limit)/i,
  );
});

test('opt-in document-count truncation returns a deterministic audited prefix without reading omissions', async () => {
  const root = await repositoryFixture();
  await mkdir(join(root, 'docs'), { recursive: true });
  await writeFile(join(root, 'README.md'), '# Readme\n');
  await writeFile(join(root, 'SECURITY.md'), '# Security\nMust remain unread.\n');
  await writeFile(join(root, 'docs', 'later.md'), '# Later\nMust remain unread.\n');
  const observation = await new NodeFileSystemAdapter().walk(root, {
    capacityLimitBehavior: 'truncate',
  });
  await unlink(join(root, 'SECURITY.md'));
  await unlink(join(root, 'docs', 'later.md'));

  const result = await new NodeDocumentSourceAdapter([], { maxDocuments: 1 }).collect(root, {
    capacityLimitBehavior: 'truncate',
    acceptedRepositoryWalk: observation,
  });

  assert.deepEqual(sourcePaths(result), ['README.md']);
  assert.equal(result.candidate_document_count, 1);
  assert.equal(result.omitted_document_count, 0);
  assert.equal(result.capacity_omitted_document_count, 2);
  assert.equal(result.discovery_truncated, true);
  assert.deepEqual(result.discovery_truncation_reasons, ['MAX_DOCUMENTS']);
  assert.equal(result.blocked_policy_count, 1);
  assert.deepEqual(result.blocked_policy_kinds, { operational: 0, security: 1, governance: 0 });
  assert.equal(JSON.stringify(result).includes('SECURITY.md'), false);
  assert.equal(JSON.stringify(result).includes('later.md'), false);
});

test('opt-in total-byte truncation stops before reading the first over-budget document', async () => {
  const root = await repositoryFixture();
  const firstContent = '# Readme\n';
  await writeFile(join(root, 'README.md'), firstContent);
  await writeFile(join(root, 'SECURITY.md'), '# Security\nMust remain unread.\n');
  const observation = await new NodeFileSystemAdapter().walk(root, {
    capacityLimitBehavior: 'truncate',
  });
  await unlink(join(root, 'SECURITY.md'));

  const result = await new NodeDocumentSourceAdapter([], {
    maxTotalBytes: Buffer.byteLength(firstContent),
  }).collect(root, {
    capacityLimitBehavior: 'truncate',
    acceptedRepositoryWalk: observation,
  });

  assert.deepEqual(sourcePaths(result), ['README.md']);
  assert.equal(result.candidate_document_count, 1);
  assert.equal(result.omitted_document_count, 0);
  assert.equal(result.capacity_omitted_document_count, 1);
  assert.equal(result.total_source_bytes, Buffer.byteLength(firstContent));
  assert.equal(result.discovery_truncated, true);
  assert.deepEqual(result.discovery_truncation_reasons, ['MAX_TOTAL_BYTES']);
  assert.equal(result.blocked_policy_count, 1);
  assert.deepEqual(result.blocked_policy_kinds, { operational: 0, security: 1, governance: 0 });
  assert.equal(JSON.stringify(result).includes('SECURITY.md'), false);
});

test('document discovery hard limits are positive and immutable', () => {
  assert.ok(DEFAULT_DOCUMENT_DISCOVERY_LIMITS.maxDocuments > 0);
  assert.ok(DEFAULT_DOCUMENT_DISCOVERY_LIMITS.maxDocumentBytes > 0);
  assert.ok(DEFAULT_DOCUMENT_DISCOVERY_LIMITS.maxTotalBytes > 0);
  assert.equal(Object.isFrozen(DEFAULT_DOCUMENT_DISCOVERY_LIMITS), true);
  assert.throws(() => new NodeDocumentSourceAdapter([], { maxDocuments: 0 }), /CONFIG_ERROR/);
  assert.throws(
    () => new NodeDocumentSourceAdapter([], {
      maxDocumentBytes: DEFAULT_DOCUMENT_DISCOVERY_LIMITS.maxDocumentBytes + 1,
    }),
    /CONFIG_ERROR/,
  );
});

test('sources use ordinal path order and deterministic title and authority metadata', async () => {
  const root = await repositoryFixture();
  await mkdir(join(root, 'docs', 'adr'), { recursive: true });
  await mkdir(join(root, 'docs', 'specification'), { recursive: true });
  await writeFile(join(root, 'README.md'), '# Repository title\n');
  await writeFile(join(root, 'docs', 'Zeta.md'), '# Zeta title\n');
  await writeFile(join(root, 'docs', 'adr', '0001-decision.md'), '# Decision title\n');
  await writeFile(join(root, 'docs', 'specification', 'feature.md'), '# Feature specification\n');
  await writeFile(join(root, 'docs', 'without-heading.md'), 'Body only.\n');

  const result = await new NodeDocumentSourceAdapter().collect(root);
  assert.deepEqual(sourcePaths(result), [
    'README.md',
    'docs/Zeta.md',
    'docs/adr/0001-decision.md',
    'docs/specification/feature.md',
    'docs/without-heading.md',
  ]);

  const decision = sourceAt(result, 'docs/adr/0001-decision.md');
  assert.deepEqual(decision?.metadata, {
    title: 'Decision title',
    authority: 'adr',
    modules: ['adr'],
    topics: ['0001', 'decision'],
  });
  const specification = sourceAt(result, 'docs/specification/feature.md');
  assert.equal(specification?.metadata.authority, 'specification');
  assert.deepEqual(specification?.metadata.modules, ['specification']);
  assert.deepEqual(specification?.metadata.topics, ['feature']);
  assert.deepEqual(sourceAt(result, 'README.md')?.metadata.modules, ['workspace']);
  const fallback = sourceAt(result, 'docs/without-heading.md');
  assert.equal(fallback?.metadata.title, 'without-heading');
  assert.deepEqual(fallback?.metadata.modules, ['docs']);
  assert.deepEqual(fallback?.metadata.topics, ['heading', 'without']);
});

test('native discovery failures are classified as IO_ERROR', async () => {
  const parent = await repositoryFixture();
  const missingRoot = join(parent, 'missing-repository');
  await assert.rejects(
    () => new NodeDocumentSourceAdapter().collect(missingRoot),
    /IO_ERROR/,
  );
});
