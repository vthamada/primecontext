import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import type { Stats } from 'node:fs';
import { access, chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { hostname, platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  ensureSafeDirectory,
  isStateDirectoryIgnored,
  sameFileSnapshot,
  stateDirectoryIgnoreEntry,
  withInternalExclusiveLock,
  writeInternalText,
  writeInternalTextAtomic,
  writeInternalTextIfAbsentAtomic,
} from './safe-io.js';

function fileSnapshot(overrides: Partial<Pick<Stats, 'dev' | 'ino' | 'size' | 'mtimeMs' | 'ctimeMs'>> = {}): Stats {
  return {
    dev: 41,
    ino: 73,
    size: 101,
    mtimeMs: 202,
    ctimeMs: 303,
    isFile: () => true,
    ...overrides,
  } as Stats;
}

test('stable internal reads tolerate an unavailable device id but not a comparable device change', () => {
  assert.equal(sameFileSnapshot(fileSnapshot({ dev: 0 }), fileSnapshot({ dev: 3_230_446_999 })), true);
  assert.equal(sameFileSnapshot(fileSnapshot({ dev: 1 }), fileSnapshot({ dev: 2 })), false);
  assert.equal(sameFileSnapshot(fileSnapshot(), fileSnapshot({ ino: 74 })), false);
});

test('state ignore verification follows Git case and trailing-space negation semantics', async (t) => {
  const root = await fixture();
  const gitEnvironment = {
    ...process.env,
    GIT_CONFIG_GLOBAL: join(root, 'empty-global-gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
  };
  const runGit = (arguments_: string[]) => spawnSync('git', arguments_, {
    cwd: root,
    encoding: 'utf8',
    env: gitEnvironment,
  });

  try {
    const initialized = runGit(['init', '--quiet']);
    if (initialized.error && 'code' in initialized.error && initialized.error.code === 'ENOENT') {
      t.skip('Git is unavailable in this runtime');
      return;
    }
    assert.equal(initialized.status, 0, initialized.stderr);
    const configured = runGit(['config', 'core.ignorecase', 'true']);
    assert.equal(configured.status, 0, configured.stderr);

    await writeFile(
      join(root, '.gitignore'),
      '.primecontext/\n!.PRIMECONTEXT/\n!.PRIMECONTEXT/**\n',
    );
    await mkdir(join(root, '.primecontext'), { recursive: true });
    await writeFile(join(root, '.primecontext', 'state.json'), '{}\n');

    const gitExposesState = (): boolean => {
      const visible = runGit(['ls-files', '--others', '--exclude-standard']);
      assert.equal(visible.status, 0, visible.stderr);
      return visible.stdout.split(/\r?\n/u).includes('.primecontext/state.json');
    };

    assert.equal(gitExposesState(), true);
    assert.equal(await isStateDirectoryIgnored(root, '.primecontext'), false);

    await writeFile(
      join(root, '.gitignore'),
      '.primecontext/\n!.PRIMECONTEXT/   \n!.PRIMECONTEXT/**   \n',
    );
    assert.equal(gitExposesState(), true);
    assert.equal(await isStateDirectoryIgnored(root, '.primecontext'), false);

    await writeFile(
      join(root, '.gitignore'),
      '.primecontext/\n!.PRIMECONTEXT/\\ \n!.PRIMECONTEXT/**\\ \n',
    );
    assert.equal(gitExposesState(), false);
    assert.equal(await isStateDirectoryIgnored(root, '.primecontext'), true);

    await writeFile(
      join(root, '.gitignore'),
      '.primecontext/\n!.PRIMECONTEXT/   \n!.PRIMECONTEXT/**   \n.primecontext/\n',
    );
    assert.equal(gitExposesState(), false);
    assert.equal(await isStateDirectoryIgnored(root, '.primecontext'), true);

    await writeFile(join(root, '.gitignore'), '.primecontext/\n');
    assert.equal(gitExposesState(), false);
    assert.equal(await isStateDirectoryIgnored(root, '.primecontext'), true);

    const customStateDirectory = '.prime[context]';
    await writeFile(
      join(root, '.gitignore'),
      `${stateDirectoryIgnoreEntry(customStateDirectory)}\n`,
    );
    await mkdir(join(root, customStateDirectory), { recursive: true });
    await writeFile(join(root, customStateDirectory, 'state.json'), '{}\n');
    const customStateCheck = runGit([
      'check-ignore', '--no-index', '--quiet', '--', `${customStateDirectory}/state.json`,
    ]);
    assert.equal(customStateCheck.status, 0, customStateCheck.stderr);
    assert.equal(await isStateDirectoryIgnored(root, customStateDirectory), true);

    const customIgnoreEntry = stateDirectoryIgnoreEntry(customStateDirectory);
    await writeFile(
      join(root, '.gitignore'),
      `${customIgnoreEntry}\n!${customIgnoreEntry}\n!${customIgnoreEntry}**\n`,
    );
    const customStateNegationCheck = runGit([
      'check-ignore', '--no-index', '--quiet', '--', `${customStateDirectory}/state.json`,
    ]);
    assert.equal(customStateNegationCheck.status, 1, customStateNegationCheck.stderr);
    assert.equal(await isStateDirectoryIgnored(root, customStateDirectory), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('state ignore verification follows descendant Git ignore precedence', async (t) => {
  const root = await fixture();
  const gitEnvironment = {
    ...process.env,
    GIT_CONFIG_GLOBAL: join(root, 'empty-global-gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
  };
  const runGit = (arguments_: string[]) => spawnSync('git', arguments_, {
    cwd: root,
    encoding: 'utf8',
    env: gitEnvironment,
  });

  try {
    const initialized = runGit(['init', '--quiet']);
    if (initialized.error && 'code' in initialized.error && initialized.error.code === 'ENOENT') {
      t.skip('Git is unavailable in this runtime');
      return;
    }
    assert.equal(initialized.status, 0, initialized.stderr);

    const nestedStateDirectory = 'cache/pcstate';
    const nestedStatePath = `${nestedStateDirectory}/state.json`;
    await writeFile(
      join(root, '.gitignore'),
      `${stateDirectoryIgnoreEntry(nestedStateDirectory)}\n`,
    );
    await mkdir(join(root, nestedStateDirectory), { recursive: true });
    await writeFile(join(root, 'cache', '.gitignore'), '!pcstate/\n!pcstate/**\n');
    await writeFile(join(root, nestedStatePath), '{}\n');

    const gitExposes = (path: string): boolean => {
      const visible = runGit(['ls-files', '--others', '--exclude-standard', '--', path]);
      assert.equal(visible.status, 0, visible.stderr);
      return visible.stdout.split(/\r?\n/u).includes(path);
    };

    assert.equal(gitExposes(nestedStatePath), true);
    assert.equal(await isStateDirectoryIgnored(root, nestedStateDirectory), false);

    await writeFile(join(root, 'cache', '.gitignore'), '!pcstate/\n!pcstate/**\npcstate/\n');
    assert.equal(gitExposes(nestedStatePath), false);
    assert.equal(await isStateDirectoryIgnored(root, nestedStateDirectory), true);

    await writeFile(join(root, 'cache', '.gitignore'), '!pcstate/\n!pcstate/**\npcstate/\n![\n');
    assert.equal(gitExposes(nestedStatePath), false);
    assert.equal(await isStateDirectoryIgnored(root, nestedStateDirectory), false);

    const defaultStatePath = '.primecontext/state.json';
    await writeFile(
      join(root, '.gitignore'),
      `${stateDirectoryIgnoreEntry(nestedStateDirectory)}\n${stateDirectoryIgnoreEntry('.primecontext')}\n`,
    );
    await mkdir(join(root, '.primecontext'), { recursive: true });
    await writeFile(join(root, defaultStatePath), '{}\n');
    assert.equal(gitExposes(defaultStatePath), false);
    assert.equal(await isStateDirectoryIgnored(root, '.primecontext'), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('positive Git glob lookalikes never restore state protection', async (t) => {
  const root = await fixture();
  const gitEnvironment = {
    ...process.env,
    GIT_CONFIG_GLOBAL: join(root, 'empty-global-gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
  };
  const runGit = (arguments_: string[]) => spawnSync('git', arguments_, {
    cwd: root,
    encoding: 'utf8',
    env: gitEnvironment,
  });

  try {
    const initialized = runGit(['init', '--quiet']);
    if (initialized.error && 'code' in initialized.error && initialized.error.code === 'ENOENT') {
      t.skip('Git is unavailable in this runtime');
      return;
    }
    assert.equal(initialized.status, 0, initialized.stderr);

    const cases = [
      { stateDirectory: 'foo/x/bar/baz', pattern: 'foo**bar/baz/' },
      { stateDirectory: 'foo/x/bar/baz', pattern: 'foo***bar/baz/' },
      { stateDirectory: 'foo/bar/baz', pattern: 'foo[/]bar/baz/' },
    ];
    for (const { stateDirectory, pattern } of cases) {
      await t.test(pattern, async () => {
        const statePath = `${stateDirectory}/state.json`;
        const ignoreEntry = stateDirectoryIgnoreEntry(stateDirectory);
        await mkdir(join(root, stateDirectory), { recursive: true });
        await writeFile(join(root, statePath), '{}\n');
        await writeFile(
          join(root, '.gitignore'),
          `${ignoreEntry}\n!${ignoreEntry}\n!${ignoreEntry}**\n${pattern}\n`,
        );
        const visible = runGit(['ls-files', '--others', '--exclude-standard', '--', statePath]);
        assert.equal(visible.status, 0, visible.stderr);
        assert.equal(visible.stdout.split(/\r?\n/u).includes(statePath), true);
        assert.equal(await isStateDirectoryIgnored(root, stateDirectory), false);
      });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('adversarial Git globs fail closed without backtracking', async (t) => {
  const root = await fixture();
  const gitEnvironment = {
    ...process.env,
    GIT_CONFIG_GLOBAL: join(root, 'empty-global-gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
  };
  const runGit = (arguments_: string[]) => spawnSync('git', arguments_, {
    cwd: root,
    encoding: 'utf8',
    env: gitEnvironment,
  });

  try {
    const initialized = runGit(['init', '--quiet']);
    if (initialized.error && 'code' in initialized.error && initialized.error.code === 'ENOENT') {
      t.skip('Git is unavailable in this runtime');
      return;
    }
    assert.equal(initialized.status, 0, initialized.stderr);

    const stateDirectory = `cache/${'a'.repeat(100)}`;
    const statePath = `${stateDirectory}/state.json`;
    const ignoreEntry = stateDirectoryIgnoreEntry(stateDirectory);
    const adversarialPattern = `${'*a'.repeat(16)}*b`;
    await writeFile(
      join(root, '.gitignore'),
      `${ignoreEntry}\n!${ignoreEntry}\n!${ignoreEntry}**\n${adversarialPattern}\n`,
    );
    await mkdir(join(root, stateDirectory), { recursive: true });
    await writeFile(join(root, statePath), '{}\n');
    const visible = runGit(['ls-files', '--others', '--exclude-standard', '--', statePath]);
    assert.equal(visible.status, 0, visible.stderr);
    assert.equal(visible.stdout.split(/\r?\n/u).includes(statePath), true);

    const moduleUrl = new URL('./safe-io.js', import.meta.url).href;
    const program = [
      `import { isStateDirectoryIgnored } from ${JSON.stringify(moduleUrl)};`,
      `const result = await isStateDirectoryIgnored(${JSON.stringify(root)}, ${JSON.stringify(stateDirectory)});`,
      'process.stdout.write(String(result));',
    ].join('\n');
    const checked = spawnSync(process.execPath, ['--input-type=module', '--eval', program], {
      encoding: 'utf8',
      timeout: 2_000,
    });
    assert.equal(checked.error, undefined, checked.error?.message);
    assert.equal(checked.status, 0, checked.stderr);
    assert.equal(checked.stdout, 'false');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('state ignore verification scales with long state directories and many literal rules', async () => {
  const root = await fixture();
  const stateDirectory = 'a'.repeat(30_000);
  const ignoreEntry = stateDirectoryIgnoreEntry(stateDirectory);

  try {
    await writeFile(
      join(root, '.gitignore'),
      `${ignoreEntry}\n${'!z\n'.repeat(30_000)}`,
    );

    const moduleUrl = new URL('./safe-io.js', import.meta.url).href;
    const program = [
      `import { isStateDirectoryIgnored } from ${JSON.stringify(moduleUrl)};`,
      `const result = await isStateDirectoryIgnored(${JSON.stringify(root)}, 'a'.repeat(30_000));`,
      'process.stdout.write(String(result));',
    ].join('\n');
    const checked = spawnSync(process.execPath, ['--input-type=module', '--eval', program], {
      encoding: 'utf8',
      timeout: 2_500,
    });
    assert.equal(checked.error, undefined, checked.error?.message);
    assert.equal(checked.status, 0, checked.stderr);
    assert.equal(checked.stdout, 'true');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('double-star negation can reinclude a root state directory', async (t) => {
  const root = await fixture();
  const gitEnvironment = {
    ...process.env,
    GIT_CONFIG_GLOBAL: join(root, 'empty-global-gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
  };
  const runGit = (arguments_: string[]) => spawnSync('git', arguments_, {
    cwd: root,
    encoding: 'utf8',
    env: gitEnvironment,
  });

  try {
    const initialized = runGit(['init', '--quiet']);
    if (initialized.error && 'code' in initialized.error && initialized.error.code === 'ENOENT') {
      t.skip('Git is unavailable in this runtime');
      return;
    }
    assert.equal(initialized.status, 0, initialized.stderr);

    const stateDirectory = 'foo';
    const statePath = `${stateDirectory}/state.json`;
    const ignoreEntry = stateDirectoryIgnoreEntry(stateDirectory);
    await writeFile(
      join(root, '.gitignore'),
      `${ignoreEntry}\n!**/${ignoreEntry}\n!**/${ignoreEntry}**\n`,
    );
    await mkdir(join(root, stateDirectory), { recursive: true });
    await writeFile(join(root, statePath), '{}\n');
    const visible = runGit(['ls-files', '--others', '--exclude-standard', '--', statePath]);
    assert.equal(visible.status, 0, visible.stderr);
    assert.equal(visible.stdout.split(/\r?\n/u).includes(statePath), true);
    assert.equal(await isStateDirectoryIgnored(root, stateDirectory), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('state ignore verification rejects POSIX separator ambiguity', {
  skip: platform() === 'win32' && 'Backslashes are native separators on Windows',
}, async () => {
  const root = await fixture();
  try {
    const configuredStateDirectory = 'cache\\pcstate';
    await writeFile(
      join(root, '.gitignore'),
      `${stateDirectoryIgnoreEntry(configuredStateDirectory)}\n`,
    );
    await mkdir(join(root, configuredStateDirectory), { recursive: true });
    await writeFile(join(root, configuredStateDirectory, 'state.json'), '{}\n');
    assert.equal(await isStateDirectoryIgnored(root, configuredStateDirectory), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function fixture(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'primecontext-safe-io-'));
}

function lockRecord(pid: number, ownerHost = hostname(), operation = 'state-test'): string {
  return `${JSON.stringify({
    schema_version: 'primecontext-lock-v1',
    pid,
    hostname: ownerHost,
    created_at: '2026-08-14T12:00:00.000Z',
    operation,
    owner_token: '00000000-0000-4000-8000-000000000001',
  })}\n`;
}

test('exclusive locks publish bounded owner metadata and remove only their own record', async () => {
  const root = await fixture();
  await ensureSafeDirectory(root, '.primecontext');
  let enteredResolve!: () => void;
  let releaseResolve!: () => void;
  const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
  const release = new Promise<void>((resolve) => { releaseResolve = resolve; });

  const pending = withInternalExclusiveLock(root, '.primecontext/state.lock', async () => {
    enteredResolve();
    await release;
    return 42;
  }, { operation: 'bounded-state-test' });
  await entered;

  const raw = await readFile(join(root, '.primecontext', 'state.lock'), 'utf8');
  assert.equal(Buffer.byteLength(raw, 'utf8') <= 4_096, true);
  const record = JSON.parse(raw) as Record<string, unknown>;
  assert.deepEqual(Object.keys(record).sort(), ['created_at', 'hostname', 'operation', 'owner_token', 'pid', 'schema_version']);
  assert.equal(record.schema_version, 'primecontext-lock-v1');
  assert.equal(record.pid, process.pid);
  assert.equal(record.hostname, hostname());
  assert.equal(record.operation, 'bounded-state-test');
  assert.match(String(record.owner_token), /^[0-9a-f-]{36}$/);
  assert.equal(typeof record.created_at === 'string' && Number.isFinite(Date.parse(record.created_at)), true);

  releaseResolve();
  assert.equal(await pending, 42);
  await assert.rejects(access(join(root, '.primecontext', 'state.lock')));
});

test('existing locks fail closed unless ownership is absent', async () => {
  const root = await fixture();
  await ensureSafeDirectory(root, '.primecontext');
  const path = join(root, '.primecontext', 'state.lock');

  await writeFile(path, 'not-json\n');
  await assert.rejects(
    withInternalExclusiveLock(root, '.primecontext/state.lock', async () => true),
    /active writer|malformed|unverifiable/i,
  );

  await writeFile(path, lockRecord(2_147_483_647, `${hostname()}-other`));
  await assert.rejects(
    withInternalExclusiveLock(root, '.primecontext/state.lock', async () => true),
    /active writer|host|unverifiable/i,
  );

  await writeFile(path, lockRecord(process.pid));
  await assert.rejects(
    withInternalExclusiveLock(root, '.primecontext/state.lock', async () => true),
    /active writer/i,
  );

  await writeFile(path, lockRecord(2_147_483_647));
  let entered = false;
  await assert.rejects(
    withInternalExclusiveLock(
      root,
      '.primecontext/state.lock',
      async () => { entered = true; },
      { operation: 'dead-owner-test' },
    ),
    /dead process|manual removal/i,
  );
  assert.equal(entered, false);
  assert.equal(await readFile(path, 'utf8'), lockRecord(2_147_483_647));
});

test('concurrent stale-lock claimants never enter the critical section', async () => {
  const root = await fixture();
  await ensureSafeDirectory(root, '.primecontext');
  const path = join(root, '.primecontext', 'state.lock');
  const staleRecord = lockRecord(2_147_483_647);
  await writeFile(path, staleRecord);
  let active = 0;
  let maxActive = 0;
  let entries = 0;

  const results = await Promise.allSettled(Array.from({ length: 32 }, async () => (
    withInternalExclusiveLock(root, '.primecontext/state.lock', async () => {
      entries += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 25));
      active -= 1;
    }, { operation: 'concurrent-dead-owner-test' })
  )));

  assert.equal(results.every((result) => result.status === 'rejected'), true);
  assert.equal(entries, 0);
  assert.equal(maxActive, 0);
  assert.equal(await readFile(path, 'utf8'), staleRecord);
});

test('lock cleanup leaves an unverifiable replacement blocking instead of unlinking it', async () => {
  const root = await fixture();
  await ensureSafeDirectory(root, '.primecontext');
  const path = join(root, '.primecontext', 'state.lock');

  await withInternalExclusiveLock(root, '.primecontext/state.lock', async () => {
    await writeFile(path, lockRecord(process.pid, `${hostname()}-replacement`, 'replacement'));
  }, { operation: 'replacement-race-test' });

  assert.match(await readFile(path, 'utf8'), /replacement/);
  await assert.rejects(
    withInternalExclusiveLock(root, '.primecontext/state.lock', async () => true),
    /host|unverifiable|active writer/i,
  );
});

test('create-only atomic internal writes publish complete bytes without replacing a winner', async () => {
  const root = await fixture();
  try {
    assert.equal(
      await writeInternalTextIfAbsentAtomic(
        root,
        'primecontext.config.json',
        '{"writer":1}\n',
        { temporaryDirectory: '.primecontext' },
      ),
      true,
    );
    assert.equal(await readFile(join(root, 'primecontext.config.json'), 'utf8'), '{"writer":1}\n');
    assert.equal(
      await writeInternalTextIfAbsentAtomic(
        root,
        'primecontext.config.json',
        '{"writer":2}\n',
        { temporaryDirectory: '.primecontext' },
      ),
      false,
    );
    assert.equal(await readFile(join(root, 'primecontext.config.json'), 'utf8'), '{"writer":1}\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('create-only atomic internal writes reject containment and link ambiguity', async (t) => {
  const root = await fixture();
  try {
    await assert.rejects(
      writeInternalTextIfAbsentAtomic(
        root,
        '../outside.json',
        '{}\n',
        { temporaryDirectory: '.primecontext' },
      ),
      /outside|repository|root/i,
    );
    await mkdir(join(root, 'directory-target'));
    await assert.rejects(
      writeInternalTextIfAbsentAtomic(
        root,
        'directory-target',
        '{}\n',
        { temporaryDirectory: '.primecontext' },
      ),
      /regular file/i,
    );

    await writeFile(join(root, 'winner.json'), '{"winner":true}\n');
    try {
      await symlink(join(root, 'winner.json'), join(root, 'linked-config.json'), 'file');
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'EPERM') {
        t.diagnostic('symlink creation is not permitted in this runtime');
        return;
      }
      throw error;
    }
    await assert.rejects(
      writeInternalTextIfAbsentAtomic(
        root,
        'linked-config.json',
        '{}\n',
        { temporaryDirectory: '.primecontext' },
      ),
      /symbolic|link/i,
    );
    assert.equal(await readFile(join(root, 'winner.json'), 'utf8'), '{"winner":true}\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('new internal state directories and atomic files request private POSIX modes', {
  skip: platform() === 'win32' ? 'Windows ACLs are not represented by POSIX mode bits' : false,
}, async () => {
  const root = await fixture();
  const directory = await ensureSafeDirectory(root, '.primecontext/private');
  await writeInternalTextAtomic(root, '.primecontext/private/state.json', '{}\n');
  await writeInternalTextIfAbsentAtomic(
    root,
    '.primecontext/private/create-only.json',
    '{}\n',
    { temporaryDirectory: '.primecontext/private' },
  );

  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal((await stat(join(directory, 'state.json'))).mode & 0o777, 0o600);
  assert.equal((await stat(join(directory, 'create-only.json'))).mode & 0o777, 0o600);
});

test('pre-existing state directories and directly written files are hardened on POSIX', {
  skip: platform() === 'win32' ? 'Windows state ACL hardening requires platform-native ACL verification' : false,
}, async () => {
  const root = await fixture();
  const directory = join(root, '.primecontext', 'legacy');
  const file = join(directory, 'state.json');
  await mkdir(directory, { recursive: true, mode: 0o755 });
  await chmod(directory, 0o755);
  await writeFile(file, '{}\n', { mode: 0o644 });
  await chmod(file, 0o644);

  await ensureSafeDirectory(root, '.primecontext/legacy');
  await writeInternalText(root, '.primecontext/legacy/state.json', '{"hardened":true}\n');

  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
});
