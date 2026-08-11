import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { NodeFileSystemAdapter, NodeGitAdapter } from './index.js';

test('safe walk excludes secrets and symlinks before exposure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'primecontext-adapter-'));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src', 'index.ts'), 'export const ok = true;');
  await writeFile(join(root, '.env'), 'SECRET=never-read');
  await writeFile(join(root, 'credentials.json'), '{"token":"secret"}');
  await symlink(tmpdir(), join(root, 'outside-link'));

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
