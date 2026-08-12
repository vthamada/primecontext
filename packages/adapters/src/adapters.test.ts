import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { isSensitivePath, NodeFileSystemAdapter, NodeGitAdapter } from './index.js';

test('safe walk excludes secrets and symlinks before exposure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'primecontext-adapter-'));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src', 'index.ts'), 'export const ok = true;');
  await writeFile(join(root, '.env'), 'SECRET=never-read');
  await writeFile(join(root, 'credentials.json'), '{"token":"secret"}');
  await symlink(tmpdir(), join(root, 'outside-link'), platform() === 'win32' ? 'junction' : 'dir');

  const fs = new NodeFileSystemAdapter();
  const result = await fs.walk(root);
  const paths = result.paths.map((p) => p.relative_path);

  assert.ok(paths.includes('src'));
  assert.ok(paths.includes('src/index.ts'));
  assert.equal(paths.some((p) => p.includes('.env')), false);
  assert.equal(paths.some((p) => p.includes('credentials')), false);
  assert.equal(paths.some((p) => p.includes('outside-link')), false);
  assert.ok(result.excluded_path_count >= 3);
});

test('readText blocks sensitive files and path traversal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'primecontext-read-'));
  await writeFile(join(root, '.env'), 'SECRET=x');
  const fs = new NodeFileSystemAdapter();

  await assert.rejects(() => fs.readText(root, '.env'), /SECURITY_ERROR/);
  await assert.rejects(() => fs.readText(root, '../outside.txt'), /SECURITY_ERROR/);
});

test('readText rejects an intermediate symlink or junction before reading', async () => {
  const root = await mkdtemp(join(tmpdir(), 'primecontext-read-root-'));
  const outside = await mkdtemp(join(tmpdir(), 'primecontext-read-outside-'));
  await writeFile(join(outside, 'visible-name.json'), '{"secret":"must-not-be-read"}');
  await symlink(outside, join(root, 'linked-directory'), platform() === 'win32' ? 'junction' : 'dir');

  const fs = new NodeFileSystemAdapter();
  await assert.rejects(() => fs.readText(root, 'linked-directory/visible-name.json'), /SECURITY_ERROR/);
});

test('walk rejects a symbolic-link or junction repository root', async () => {
  const realRoot = await mkdtemp(join(tmpdir(), 'primecontext-real-root-'));
  const aliasParent = await mkdtemp(join(tmpdir(), 'primecontext-alias-parent-'));
  const aliasRoot = join(aliasParent, 'repo-link');
  await writeFile(join(realRoot, 'visible.txt'), 'must not be discovered through a link');
  await symlink(realRoot, aliasRoot, platform() === 'win32' ? 'junction' : 'dir');

  await assert.rejects(() => new NodeFileSystemAdapter().walk(aliasRoot), /SECURITY_ERROR/);
});

test('walk rejects a repository root beneath a linked ancestor', async () => {
  const realParent = await mkdtemp(join(tmpdir(), 'primecontext-real-parent-'));
  const realRoot = join(realParent, 'repo');
  await mkdir(realRoot);
  await writeFile(join(realRoot, 'visible.txt'), 'must not be discovered through an ancestor link');
  const aliasParent = await mkdtemp(join(tmpdir(), 'primecontext-ancestor-alias-'));
  const linkedAncestor = join(aliasParent, 'linked-parent');
  await symlink(realParent, linkedAncestor, platform() === 'win32' ? 'junction' : 'dir');

  await assert.rejects(
    () => new NodeFileSystemAdapter().walk(join(linkedAncestor, 'repo')),
    /SECURITY_ERROR/,
  );
});

test('walk classifies a non-directory repository root as IO_ERROR', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'primecontext-invalid-root-'));
  const root = join(parent, 'file.txt');
  await writeFile(root, 'not a directory');
  await assert.rejects(() => new NodeFileSystemAdapter().walk(root), /IO_ERROR/);
});

test('sensitive path policy covers required credential and private-data classes', () => {
  const sensitive = [
    '.env.production',
    'config/api-key.txt',
    'auth/access_token.json',
    'exports/passwords.csv',
    'session/cookies.json',
    'exports/private-dump.json',
    'data/pii.csv',
    'storage/private-uploads/customer.pdf',
    '.git./config',
    'config/credentials.json.',
    'src/file.txt:private-stream',
    'CON',
    'docs/COM¹.md',
    'docs/bad?.md',
    'docs/bad|name.md',
  ];
  for (const path of sensitive) assert.equal(isSensitivePath(path), true, path);
  assert.equal(isSensitivePath('src/tokenizer.ts'), false);
  assert.equal(isSensitivePath('docs/cookie-policy.md'), false);
});

test('Git adapter reports branch and head when available', async () => {
  const root = await mkdtemp(join(tmpdir(), 'primecontext-git-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'PrimeContext Test'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@local'], { cwd: root });
  await writeFile(join(root, 'README.md'), '# test');
  execFileSync('git', ['add', 'README.md'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: root, stdio: 'ignore' });

  const state = await new NodeGitAdapter().inspect(root);
  assert.equal(state?.branch, 'main');
  assert.match(state?.head ?? '', /^[a-f0-9]{40}$/);
});


test('walk honors configured repository-relative exclude prefixes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'primecontext-exclude-'));
  await mkdir(join(root, 'generated-private'));
  await writeFile(join(root, 'generated-private', 'payload.json'), '{}');
  await writeFile(join(root, 'visible.txt'), 'ok');
  const result = await new NodeFileSystemAdapter(['generated-private']).walk(root);
  assert.equal(result.paths.some((item) => item.relative_path.startsWith('generated-private')), false);
  assert.ok(result.paths.some((item) => item.relative_path === 'visible.txt'));
});

test('walk enforces a bounded entry count with a PrimeContext error', async () => {
  const root = await mkdtemp(join(tmpdir(), 'primecontext-entry-limit-'));
  await writeFile(join(root, 'one.txt'), '1');
  await writeFile(join(root, 'two.txt'), '2');

  await assert.rejects(
    () => new NodeFileSystemAdapter([], { maxEntries: 1 }).walk(root),
    /SECURITY_ERROR: Repository discovery entry limit exceeded/,
  );
});

test('walk enforces a bounded repository depth with a PrimeContext error', async () => {
  const root = await mkdtemp(join(tmpdir(), 'primecontext-depth-limit-'));
  await mkdir(join(root, 'level-one', 'level-two'), { recursive: true });

  await assert.rejects(
    () => new NodeFileSystemAdapter([], { maxDepth: 1 }).walk(root),
    /SECURITY_ERROR: Repository discovery depth limit exceeded/,
  );
});

test('adapter rejects excessive configured excludes before discovery', () => {
  assert.throws(
    () => new NodeFileSystemAdapter(['generated-one', 'generated-two'], { maxExcludes: 1 }),
    /SECURITY_ERROR: Repository exclude limit exceeded/,
  );
});

test('walk ordering is ordinal and independent of host locale', async () => {
  const root = await mkdtemp(join(tmpdir(), 'primecontext-ordinal-walk-'));
  await writeFile(join(root, 'alpha.txt'), 'a');
  await writeFile(join(root, 'Zeta.txt'), 'z');

  const result = await new NodeFileSystemAdapter().walk(root);
  assert.deepEqual(result.paths.map((item) => item.relative_path), ['Zeta.txt', 'alpha.txt']);
});

test('Git adapter remains fail-open when metadata is unavailable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'primecontext-no-git-'));
  await writeFile(join(root, '.git'), 'invalid git metadata');
  assert.equal(await new NodeGitAdapter().inspect(root), undefined);
});
