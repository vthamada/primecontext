import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PrimeContextError } from '@primecontext/core';
import {
  DEFAULT_DOCUMENT_DISCOVERY_LIMITS,
  NodeDocumentSourceAdapter,
  NodeSha256Hasher,
  readSafeRepositoryText,
} from './index.js';

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
