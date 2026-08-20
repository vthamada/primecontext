import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { platform, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { validateRepoMap, validateTaskCapsule } from '@primecontext/schemas';
import {
  handoffValidateCommand,
  defaultConfig,
  initCommand,
  inspectCommand,
  mapCommand,
  metricsCommand,
  parseConfig,
  recordMetricCommand,
  taskCommand,
} from './index.js';

async function repoFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'primecontext-cli-'));
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'cli-fixture' }));
  await writeFile(join(root, 'README.md'), '# fixture');
  return root;
}

test('init is idempotent and does not overwrite configuration', async () => {
  const root = await repoFixture();
  const first = await initCommand(root);
  const original = await readFile(first.config_path, 'utf8');
  await initCommand(root);
  const second = await readFile(first.config_path, 'utf8');
  assert.equal(second, original);
  assert.match(await readFile(join(root, '.gitignore'), 'utf8'), /\.primecontext\//);
});

test('init publishes and verifies the ignore rule before creating state or its lock', async () => {
  const root = await repoFixture();
  const releasePath = join(root, 'release-ignore-publication');
  const commandsUrl = new URL('./commands.js', import.meta.url).href;
  const childScript = `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const originalRename = fs.promises.rename.bind(fs.promises);
    fs.promises.rename = async (source, target) => {
      if (String(target).endsWith('.gitignore')) {
        process.stdout.write('BEFORE_GITIGNORE_RENAME\\n');
        while (!fs.existsSync(process.argv[2])) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return originalRename(source, target);
    };
    syncBuiltinESMExports();
    const { initCommand: childInitCommand } = await import(${JSON.stringify(commandsUrl)});
    await childInitCommand(process.argv[1]);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', childScript, root, releasePath], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  const reachedPublication = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`init child did not reach publication: ${stderr}`)), 5_000);
    child.stdout.on('data', () => {
      if (!stdout.includes('BEFORE_GITIGNORE_RENAME')) return;
      clearTimeout(timeout);
      resolve();
    });
    child.once('exit', (code, signal) => {
      if (stdout.includes('BEFORE_GITIGNORE_RENAME')) return;
      clearTimeout(timeout);
      reject(new Error(`init child exited before publication: code=${code} signal=${signal} ${stderr}`));
    });
  });

  try {
    await reachedPublication;
    await assert.rejects(access(join(root, 'primecontext.config.json')), /ENOENT/);
    await assert.rejects(access(join(root, '.primecontext')), /ENOENT/);
    await assert.rejects(access(join(root, '.gitignore')), /ENOENT/);
    const customConfig = { ...defaultConfig(), state_dir: '.custom-primecontext' };
    const customConfigBytes = `${JSON.stringify(customConfig, null, 2)}\n`;
    await writeFile(join(root, 'primecontext.config.json'), customConfigBytes);
    await writeFile(releasePath, 'release');
    if (child.exitCode === null && child.signalCode === null) await once(child, 'exit');
    assert.equal(child.exitCode, 0, stderr);
    assert.equal(await readFile(join(root, 'primecontext.config.json'), 'utf8'), customConfigBytes);
    await assert.rejects(access(join(root, '.primecontext')), /ENOENT/);
    await access(join(root, '.custom-primecontext', 'capsules'));
    await access(join(root, '.custom-primecontext', 'tasks'));
    assert.match(await readFile(join(root, '.gitignore'), 'utf8'), /^\.custom-primecontext\/$/mu);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await once(child, 'exit');
    }
    await rm(root, { recursive: true, force: true });
  }
});

test('init preserves a genuine ignore-publication EPERM when no concurrent writer completed it', async () => {
  const root = await repoFixture();
  const commandsUrl = new URL('./commands.js', import.meta.url).href;
  const childScript = `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const originalRename = fs.promises.rename.bind(fs.promises);
    fs.promises.rename = async (source, target) => {
      if (String(target).endsWith('.gitignore')) {
        const error = new Error('synthetic isolated ignore publication failure');
        error.code = 'EPERM';
        throw error;
      }
      return originalRename(source, target);
    };
    syncBuiltinESMExports();
    const { initCommand: childInitCommand } = await import(${JSON.stringify(commandsUrl)});
    try {
      await childInitCommand(process.argv[1]);
      process.stdout.write('RESULT:UNEXPECTED_SUCCESS\\n');
    } catch (error) {
      process.stdout.write('RESULT:' + String(error) + '\\n');
    }
  `;
  const child = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', childScript, root],
    { cwd: root, encoding: 'utf8', windowsHide: true },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /RESULT:PrimeContextError: IO_ERROR:/u);
  assert.doesNotMatch(child.stdout, /active writer/iu);
  await assert.rejects(access(join(root, 'primecontext.config.json')), /ENOENT/);
  await assert.rejects(access(join(root, '.primecontext')), /ENOENT/);
});

test('init never overwrites an external configuration published at its atomic boundary', async () => {
  const root = await repoFixture();
  const commandsUrl = new URL('./commands.js', import.meta.url).href;
  const customConfig = { ...defaultConfig(), state_dir: '.external-primecontext' };
  const customConfigBytes = `${JSON.stringify(customConfig, null, 2)}\n`;
  const childScript = `
    import fs from 'node:fs';
    import path from 'node:path';
    import { syncBuiltinESMExports } from 'node:module';
    const root = process.argv[1];
    const externalBytes = ${JSON.stringify(customConfigBytes)};
    let injected = false;
    const injectExternalConfig = async (target) => {
      if (injected || !String(target).endsWith('primecontext.config.json')) return;
      injected = true;
      await fs.promises.writeFile(target, externalBytes, { flag: 'wx' });
    };
    const originalRename = fs.promises.rename.bind(fs.promises);
    fs.promises.rename = async (source, target) => {
      await injectExternalConfig(target);
      return originalRename(source, target);
    };
    const originalLink = fs.promises.link.bind(fs.promises);
    fs.promises.link = async (source, target) => {
      if (String(target).endsWith('primecontext.config.json')) {
        const relativeSource = path.relative(root, String(source)).replaceAll('\\\\', '/');
        if (!relativeSource.startsWith('.primecontext/')) {
          throw new Error('configuration temporary file escaped ignored state: ' + relativeSource);
        }
      }
      await injectExternalConfig(target);
      return originalLink(source, target);
    };
    syncBuiltinESMExports();
    const { initCommand: childInitCommand } = await import(${JSON.stringify(commandsUrl)});
    try {
      await childInitCommand(root);
      process.stdout.write('RESULT:UNEXPECTED_SUCCESS\\n');
    } catch (error) {
      process.stdout.write('RESULT:' + String(error) + '\\n');
    }
  `;

  try {
    const child = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', childScript, root],
      { cwd: root, encoding: 'utf8', windowsHide: true },
    );
    assert.equal(child.status, 0, child.stderr);
    assert.match(child.stdout, /RESULT:PrimeContextError: STATE_ERROR: Repository configuration changed during initialization; retry/u);
    assert.equal(await readFile(join(root, 'primecontext.config.json'), 'utf8'), customConfigBytes);
    await assert.rejects(access(join(root, '.primecontext', 'capsules')), /ENOENT/);
    await assert.rejects(access(join(root, '.primecontext', 'tasks')), /ENOENT/);

    const retried = await initCommand(root);
    assert.equal(retried.created_config, false);
    assert.equal(retried.state_dir, join(root, '.external-primecontext'));
    assert.equal(await readFile(join(root, 'primecontext.config.json'), 'utf8'), customConfigBytes);
    await access(join(root, '.external-primecontext', 'capsules'));
    await access(join(root, '.external-primecontext', 'tasks'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('init revalidates configuration and ignore after creating state directories', async () => {
  const root = await repoFixture();
  const commandsUrl = new URL('./commands.js', import.meta.url).href;
  const customConfig = { ...defaultConfig(), state_dir: '.late-primecontext' };
  const customConfigBytes = `${JSON.stringify(customConfig, null, 2)}\n`;
  const childScript = `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const root = process.argv[1];
    const externalBytes = ${JSON.stringify(customConfigBytes)};
    const originalMkdir = fs.promises.mkdir.bind(fs.promises);
    let injected = false;
    fs.promises.mkdir = async (path, options) => {
      const result = await originalMkdir(path, options);
      const normalized = String(path).replaceAll('\\\\', '/');
      if (!injected && normalized.endsWith('/.primecontext/tasks')) {
        injected = true;
        await fs.promises.writeFile(root + '/primecontext.config.json', externalBytes);
      }
      return result;
    };
    syncBuiltinESMExports();
    const { initCommand: childInitCommand } = await import(${JSON.stringify(commandsUrl)});
    try {
      await childInitCommand(root);
      process.stdout.write('RESULT:UNEXPECTED_SUCCESS\\n');
    } catch (error) {
      process.stdout.write('RESULT:' + String(error) + '\\n');
    }
  `;

  try {
    const child = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', childScript, root],
      { cwd: root, encoding: 'utf8', windowsHide: true },
    );
    assert.equal(child.status, 0, child.stderr);
    assert.match(child.stdout, /RESULT:PrimeContextError: STATE_ERROR: Repository configuration changed during initialization; retry/u);
    assert.equal(await readFile(join(root, 'primecontext.config.json'), 'utf8'), customConfigBytes);

    const retried = await initCommand(root);
    assert.equal(retried.created_config, false);
    assert.equal(retried.state_dir, join(root, '.late-primecontext'));
    await access(join(root, '.late-primecontext', 'capsules'));
    await access(join(root, '.late-primecontext', 'tasks'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('concurrent init attempts leave one ignore rule and retryable initialized state', async () => {
  const root = await repoFixture();
  const attempts = await Promise.allSettled([initCommand(root), initCommand(root)]);
  assert.ok(attempts.some((result) => result.status === 'fulfilled'));
  for (const result of attempts) {
    if (result.status === 'rejected') assert.match(String(result.reason), /active writer/i);
  }
  await initCommand(root);
  const ignoreLines = (await readFile(join(root, '.gitignore'), 'utf8')).split(/\r?\n/u);
  assert.equal(ignoreLines.filter((line) => line === '.primecontext/').length, 1);
  await access(join(root, '.primecontext', 'capsules'));
  await access(join(root, '.primecontext', 'tasks'));
});

test('cross-process init serializes configuration publication behind the state writer lock', async () => {
  const root = await repoFixture();
  const releasePath = join(root, 'release-config-publication');
  const commandsUrl = new URL('./commands.js', import.meta.url).href;
  const childScript = `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const root = process.argv[1];
    const releasePath = process.argv[2];
    const worker = process.argv[3];
    const originalLink = fs.promises.link.bind(fs.promises);
    fs.promises.link = async (source, target) => {
      if (String(target).endsWith('primecontext.config.json')) {
        process.stdout.write('CONFIG_PUBLISH_READY:' + worker + '\\n');
        while (!fs.existsSync(releasePath)) await new Promise((resolve) => setTimeout(resolve, 10));
        if (worker === 'second') {
          const error = new Error('synthetic concurrent configuration publication');
          error.code = 'EPERM';
          throw error;
        }
      }
      return originalLink(source, target);
    };
    syncBuiltinESMExports();
    const { initCommand: childInitCommand } = await import(${JSON.stringify(commandsUrl)});
    try {
      await childInitCommand(root);
      process.stdout.write('RESULT:OK\\n');
    } catch (error) {
      process.stdout.write('RESULT:ERROR:' + String(error) + '\\n');
    }
  `;
  const startWorker = (worker: string) => {
    const child = spawn(process.execPath, [
      '--input-type=module', '-e', childScript, root, releasePath, worker,
    ], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    return { child, stdout: () => stdout, stderr: () => stderr };
  };
  const waitForOutput = (
    worker: ReturnType<typeof startWorker>,
    pattern: RegExp,
  ): Promise<void> => new Promise((resolve, reject) => {
    const check = () => {
      if (!pattern.test(worker.stdout())) return;
      clearTimeout(timeout);
      worker.child.stdout.off('data', check);
      resolve();
    };
    const timeout = setTimeout(() => {
      worker.child.stdout.off('data', check);
      reject(new Error(`init worker did not reach ${pattern}: ${worker.stdout()} ${worker.stderr()}`));
    }, 5_000);
    worker.child.stdout.on('data', check);
    check();
  });
  const waitForExit = async (worker: ReturnType<typeof startWorker>): Promise<void> => {
    if (worker.child.exitCode === null && worker.child.signalCode === null) await once(worker.child, 'exit');
  };

  const first = startWorker('first');
  let second: ReturnType<typeof startWorker> | undefined;
  try {
    await waitForOutput(first, /CONFIG_PUBLISH_READY:first/u);
    second = startWorker('second');
    await waitForOutput(second, /CONFIG_PUBLISH_READY:second|RESULT:/u);
    await writeFile(releasePath, 'release');
    await Promise.all([waitForExit(first), waitForExit(second)]);
    const results = [first.stdout(), second.stdout()];
    assert.ok(results.some((output) => output.includes('RESULT:OK')), JSON.stringify(results));
    for (const output of results) {
      const error = output.match(/RESULT:ERROR:(.*)/u)?.[1];
      if (error !== undefined) assert.match(error, /active writer/i);
    }
  } finally {
    for (const worker of [first, second]) {
      if (worker && worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill();
    }
    await Promise.all([first, second].filter((worker) => worker !== undefined).map(async (worker) => {
      if (worker.child.exitCode === null && worker.child.signalCode === null) await once(worker.child, 'exit');
    }));
    await rm(root, { recursive: true, force: true });
  }
});

test('map writes a schema-valid semantic repo map', async () => {
  const root = await repoFixture();
  await initCommand(root);
  const result = await mapCommand(root);
  const map = JSON.parse(await readFile(result.map_path, 'utf8')) as unknown;
  assert.equal(validateRepoMap(map).valid, true);
  assert.equal(JSON.stringify(map).includes('.primecontext'), false);
});

test('task generates a valid capsule using configured budget defaults', async () => {
  const root = await repoFixture();
  await initCommand(root);
  const taskFile = join(root, 'task.json');
  await writeFile(taskFile, JSON.stringify({
    task_id: 'MAXSOUND-PILOT-001', goal: 'Prepare a safe product module context', task_type: 'module_feature',
    boundaries: { allowed_paths: ['src'], forbidden_paths: ['private'] }, acceptance: ['Capsule validates'],
  }));
  const result = await taskCommand(root, 'MAXSOUND-PILOT-001', taskFile);
  const capsule = JSON.parse(await readFile(result.capsule_path, 'utf8')) as unknown;
  assert.equal(validateTaskCapsule(capsule).valid, true);
  assert.equal((capsule as { context_budget: { soft_limit_tokens: number } }).context_budget.soft_limit_tokens, 12000);
});

test('inspect rejects a corrupted stored capsule', async () => {
  const root = await repoFixture();
  const init = await initCommand(root);
  const capsuleDir = join(init.state_dir, 'capsules');
  await import('node:fs/promises').then(({ mkdir }) => mkdir(capsuleDir, { recursive: true }));
  await writeFile(join(capsuleDir, 'BAD.json'), '{"schema_version":"0.1"}');
  await assert.rejects(() => inspectCommand(root, 'BAD'), /VALIDATION_ERROR/);
});

test('handoff validate rejects malformed handoffs', async () => {
  const root = await repoFixture();
  const file = join(root, 'handoff.json');
  await writeFile(file, JSON.stringify({ schema_version: '0.1', task_id: 'X' }));
  await assert.rejects(() => handoffValidateCommand(file, root), /VALIDATION_ERROR/);
});

test('metrics returns an empty evidence summary when no records exist', async () => {
  const root = await repoFixture();
  await initCommand(root);
  const summary = await metricsCommand(root);
  assert.equal(summary.record_count, 0);
  assert.deepEqual(summary.totals, {});
});

test('every v0.1 state command rejects a state directory that is no longer ignored', async () => {
  const root = await repoFixture();
  await initCommand(root);
  await writeFile(join(root, '.gitignore'), '');
  const taskFile = join(root, 'ignored-state-task.json');
  await writeFile(taskFile, JSON.stringify({
    task_id: 'IGNORED-STATE-001', goal: 'require ignored state', task_type: 'small_code_fix',
    boundaries: { allowed_paths: ['src'], forbidden_paths: [] }, acceptance: ['State remains private'],
  }));
  const metricFile = join(root, 'ignored-state-metric.json');
  await writeFile(metricFile, JSON.stringify({
    schema_version: '0.1', task_id: 'IGNORED-STATE-001', recorded_at: '2026-08-14T12:00:00.000Z',
    input_tokens: 1,
  }));

  for (const operation of [
    () => mapCommand(root),
    () => taskCommand(root, 'IGNORED-STATE-001', taskFile),
    () => inspectCommand(root, 'IGNORED-STATE-001'),
    () => metricsCommand(root),
    () => recordMetricCommand(root, metricFile),
  ]) {
    await assert.rejects(operation, /state_dir must be ignored/i);
  }
});

test('task and inspect reject traversal task ids before any outside read or write', async () => {
  const root = await repoFixture();
  await initCommand(root);
  const outsideFile = join(dirname(root), 'primecontext-outside-sentinel.json');
  await writeFile(outsideFile, '{"sentinel":true}');
  const unsafeTaskId = '../../../primecontext-outside-sentinel';
  const taskFile = join(root, 'unsafe-task.json');
  await writeFile(taskFile, JSON.stringify({
    task_id: unsafeTaskId,
    goal: 'must be rejected',
    task_type: 'small_code_fix',
    boundaries: { allowed_paths: ['src'], forbidden_paths: [] },
    acceptance: ['No outside write'],
  }));

  await assert.rejects(() => taskCommand(root, unsafeTaskId, taskFile), /SECURITY_ERROR|VALIDATION_ERROR/);
  await assert.rejects(() => inspectCommand(root, unsafeTaskId), /SECURITY_ERROR|VALIDATION_ERROR/);
  assert.equal(await readFile(outsideFile, 'utf8'), '{"sentinel":true}');
});

test('task input cannot escape through an intermediate junction', async () => {
  const root = await repoFixture();
  await initCommand(root);
  const outside = await mkdtemp(join(tmpdir(), 'primecontext-cli-outside-'));
  await writeFile(join(outside, 'task.json'), JSON.stringify({
    task_id: 'SAFE-001', goal: 'outside input', task_type: 'small_code_fix',
    boundaries: { allowed_paths: ['src'], forbidden_paths: [] }, acceptance: ['Rejected'],
  }));
  await symlink(outside, join(root, 'linked-input'), platform() === 'win32' ? 'junction' : 'dir');

  await assert.rejects(() => taskCommand(root, 'SAFE-001', 'linked-input/task.json'), /SECURITY_ERROR/);
  await assert.rejects(() => taskCommand(root, 'SAFE-001', join(outside, 'task.json')), /SECURITY_ERROR/);
});

test('task output cannot escape through a junction inside generated state', async () => {
  const root = await repoFixture();
  const init = await initCommand(root);
  const outside = await mkdtemp(join(tmpdir(), 'primecontext-cli-output-'));
  const capsuleDir = join(init.state_dir, 'capsules');
  await rm(capsuleDir, { recursive: true });
  await symlink(outside, capsuleDir, platform() === 'win32' ? 'junction' : 'dir');
  const taskFile = join(root, 'safe-task.json');
  await writeFile(taskFile, JSON.stringify({
    task_id: 'SAFE-OUTPUT', goal: 'stay inside state', task_type: 'small_code_fix',
    boundaries: { allowed_paths: ['src'], forbidden_paths: [] }, acceptance: ['No linked write'],
  }));

  await assert.rejects(() => taskCommand(root, 'SAFE-OUTPUT', taskFile), /SECURITY_ERROR/);
  await assert.rejects(() => readFile(join(outside, 'SAFE-OUTPUT.json'), 'utf8'));
});

test('init rejects a configured state directory that is a junction', async () => {
  const root = await repoFixture();
  const outside = await mkdtemp(join(tmpdir(), 'primecontext-cli-state-'));
  const config = {
    schema_version: '0.1', state_dir: 'state', exclude: [],
    budgets: Object.fromEntries(['small_ui','small_code_fix','module_feature','integration','qa','orchestration'].map((type) => [type, {
      initial_tokens: 1, soft_limit_tokens: 2, hard_limit_tokens: 4,
    }])),
  };
  await writeFile(join(root, 'primecontext.config.json'), JSON.stringify(config));
  await symlink(outside, join(root, 'state'), platform() === 'win32' ? 'junction' : 'dir');

  await assert.rejects(() => initCommand(root), /SECURITY_ERROR/);
  await assert.rejects(() => access(join(outside, 'capsules')));
});

test('init classifies native state-directory failures as IO_ERROR', async () => {
  const root = await repoFixture();
  const config = {
    schema_version: '0.1', state_dir: 'occupied/child', exclude: [],
    budgets: Object.fromEntries(['small_ui','small_code_fix','module_feature','integration','qa','orchestration'].map((type) => [type, {
      initial_tokens: 1, soft_limit_tokens: 2, hard_limit_tokens: 4,
    }])),
  };
  await writeFile(join(root, 'primecontext.config.json'), JSON.stringify(config));
  await writeFile(join(root, 'occupied'), 'not a directory');
  await assert.rejects(() => initCommand(root), /IO_ERROR/);
});

test('configuration rejects unsafe state directories and unknown properties', () => {
  const config = {
    schema_version: '0.1',
    state_dir: '.primecontext',
    exclude: [],
    budgets: Object.fromEntries(['small_ui','small_code_fix','module_feature','integration','qa','orchestration'].map((type) => [type, {
      initial_tokens: 1, soft_limit_tokens: 2, hard_limit_tokens: 4,
    }])),
  };
  assert.throws(() => parseConfig({ ...config, state_dir: '..' }), /CONFIG_ERROR/);
  assert.throws(() => parseConfig({ ...config, state_dir: '.' }), /CONFIG_ERROR/);
  assert.throws(() => parseConfig({ ...config, state_dir: '.git' }), /CONFIG_ERROR/);
  for (const state_dir of ['.git.', '.git ', 'C:state', 'state:stream', 'CON', 'state/PRN.txt', 'state/COM¹.txt']) {
    assert.throws(() => parseConfig({ ...config, state_dir }), /CONFIG_ERROR/, state_dir);
  }
  assert.throws(() => parseConfig({ ...config, unexpected: true }), /CONFIG_ERROR/);
});

test('configuration loading uses the bounded structural JSON parser', async () => {
  const root = await repoFixture();
  let nested: Record<string, unknown> = {};
  for (let depth = 0; depth < 80; depth += 1) nested = { child: nested };
  await writeFile(join(root, 'primecontext.config.json'), JSON.stringify({ unexpected: nested }));
  await assert.rejects(() => mapCommand(root), /CONFIG_ERROR.*nesting depth/);
});

test('task definition rejects present optional fields with invalid types', async () => {
  const root = await repoFixture();
  await initCommand(root);
  const taskFile = join(root, 'invalid-optional.json');
  await writeFile(taskFile, JSON.stringify({
    task_id: 'SAFE-002', goal: 'reject invalid optional input', task_type: 'small_code_fix', module: 42,
    boundaries: { allowed_paths: ['src'], forbidden_paths: [] }, acceptance: ['Rejected'],
  }));
  await assert.rejects(() => taskCommand(root, 'SAFE-002', taskFile), /VALIDATION_ERROR/);
});

test('structured JSON inputs are rejected when nesting exceeds the bounded parser depth', async () => {
  const root = await repoFixture();
  await initCommand(root);
  let nested: Record<string, unknown> = {};
  for (let depth = 0; depth < 80; depth += 1) nested = { child: nested };
  const taskFile = join(root, 'deep-task.json');
  await writeFile(taskFile, JSON.stringify({
    task_id: 'SAFE-DEEP', goal: 'reject pathological nesting', task_type: 'small_code_fix', metadata: nested,
    boundaries: { allowed_paths: ['src'], forbidden_paths: [] }, acceptance: ['Rejected'],
  }));

  await assert.rejects(() => taskCommand(root, 'SAFE-DEEP', taskFile), /VALIDATION_ERROR.*nesting depth/);
});

test('metrics distinguishes missing evidence from I/O errors and can record validated evidence', async () => {
  const root = await repoFixture();
  const init = await initCommand(root);
  await mkdir(join(init.state_dir, 'metrics.jsonl'));
  await assert.rejects(() => metricsCommand(root), /IO_ERROR/);

  const secondRoot = await repoFixture();
  await initCommand(secondRoot);
  const metricFile = join(secondRoot, 'metric.json');
  await writeFile(metricFile, JSON.stringify({
    schema_version: '0.1', task_id: 'BENCH-001', recorded_at: '2026-08-11T12:00:00.000Z',
    arm: 'A', input_tokens: 100, agent_output_tokens: 40,
    estimated_fields: ['agent_output_tokens'], test_status: 'PASS', review_status: 'PASS',
  }));
  await recordMetricCommand(secondRoot, metricFile);
  const summary = await metricsCommand(secondRoot);
  assert.equal(summary.record_count, 1);
  assert.equal(summary.totals.input_tokens, 100);
  assert.equal(summary.totals.agent_output_tokens, 40);
  assert.deepEqual(summary.estimated_fields, ['agent_output_tokens']);
});

test('metrics rejects aggregate totals that exceed the safe integer range', async () => {
  const root = await repoFixture();
  const init = await initCommand(root);
  const record = JSON.stringify({
    schema_version: '0.1', task_id: 'BENCH-SAFE-MAX', recorded_at: '2026-08-11T12:00:00.000Z',
    input_tokens: Number.MAX_SAFE_INTEGER,
  });
  await writeFile(join(init.state_dir, 'metrics.jsonl'), `${record}\n${record}\n`);
  await assert.rejects(() => metricsCommand(root), /VALIDATION_ERROR.*safe integer/);
});

test('compiled CLI exposes help and returns non-zero for an invalid handoff', async () => {
  const root = await repoFixture();
  const bin = fileURLToPath(new URL('./bin.js', import.meta.url));
  const help = spawnSync(process.execPath, [bin, '--help'], { cwd: root, encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /primecontext handoff validate/);

  const handoff = join(root, 'invalid-handoff.json');
  await writeFile(handoff, '{"schema_version":"0.1"}');
  const invalid = spawnSync(process.execPath, [bin, 'handoff', 'validate', handoff], { cwd: root, encoding: 'utf8' });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /VALIDATION_ERROR/);
});

test('compiled CLI rejects unknown, extra, duplicate, and valueless arguments', async () => {
  const root = await repoFixture();
  const bin = fileURLToPath(new URL('./bin.js', import.meta.url));
  const run = (...args: string[]) => spawnSync(process.execPath, [bin, ...args], { cwd: root, encoding: 'utf8' });
  for (const args of [
    ['init', 'extra'],
    ['inspect', 'SAFE', 'extra'],
    ['task', 'SAFE', '--from'],
    ['task', 'SAFE', '--unknown', 'task.json'],
    ['benchmark', '--a', 'a.json', '--a', 'again.json', '--b', 'b.json'],
    ['metrics', 'unexpected'],
  ]) {
    const result = run(...args);
    assert.equal(result.status, 1, args.join(' '));
    assert.match(result.stderr, /VALIDATION_ERROR/, args.join(' '));
  }
});

test('compiled CLI completes the v0.1 vertical command flow', async () => {
  const root = await repoFixture();
  const bin = fileURLToPath(new URL('./bin.js', import.meta.url));
  const run = (...args: string[]) => spawnSync(process.execPath, [bin, ...args], { cwd: root, encoding: 'utf8' });

  assert.equal(run('init').status, 0);
  assert.equal(run('map').status, 0);

  await writeFile(join(root, 'task.json'), JSON.stringify({
    task_id: 'VERTICAL-001', goal: 'exercise the public CLI', task_type: 'small_code_fix',
    boundaries: { allowed_paths: ['src'], forbidden_paths: ['private'] }, acceptance: ['All commands succeed'],
  }));
  assert.equal(run('task', 'VERTICAL-001', '--from', 'task.json').status, 0);
  assert.equal(run('inspect', 'VERTICAL-001').status, 0);

  await writeFile(join(root, 'handoff.json'), JSON.stringify({
    schema_version: '0.1', task_id: 'VERTICAL-001', status: 'PASS', changed_files: [],
    tests: { passed: 1, failed: 0 }, risks: [], next_unblocked: [],
  }));
  assert.equal(run('handoff', 'validate', 'handoff.json').status, 0);

  const metricBase = {
    schema_version: '0.1', task_id: 'VERTICAL-001', recorded_at: '2026-08-11T12:00:00.000Z',
    input_tokens: 10, test_status: 'PASS', review_status: 'PASS',
  };
  await writeFile(join(root, 'arm-a.json'), JSON.stringify({ ...metricBase, arm: 'A' }));
  await writeFile(join(root, 'arm-b.json'), JSON.stringify({ ...metricBase, arm: 'B', input_tokens: 9 }));
  assert.equal(run('metrics', 'record', 'arm-a.json').status, 0);
  assert.equal(run('metrics').status, 0);
  assert.equal(run('benchmark', '--a', 'arm-a.json', '--b', 'arm-b.json').status, 0);
});
