import assert from 'node:assert/strict';
import test from 'node:test';
import {
  allocateContextBudget,
  assertValidHandoff,
  assertValidMetricRecord,
  createTaskCapsule,
  experimentalBudgetDefaults,
  hashContextJson,
  hashContextText,
  PrimeContextError,
} from './index.js';

test('allocates the experimental module feature budget', () => {
  assert.deepEqual(allocateContextBudget('module_feature'), {
    initial_tokens: 6000,
    soft_limit_tokens: 12000,
    hard_limit_tokens: 24000,
  });
});

test('rejects a context budget whose limits are out of order', () => {
  assert.throws(
    () => allocateContextBudget('small_code_fix', { initial_tokens: 9000, soft_limit_tokens: 8000 }),
    /initial_tokens must be <= soft_limit_tokens/,
  );
});

test('creates a validated task capsule with optional worktree metadata', () => {
  const capsule = createTaskCapsule({
    task_id: 'PROP-014',
    goal: 'Implement immutable proposal versioning',
    task_type: 'module_feature',
    boundaries: { allowed_paths: ['src/Proposal'], forbidden_paths: ['src/Pricing'] },
    acceptance: ['Previous versions are not overwritten'],
  }, { branch: 'feat/proposals', root: '/repo', head: 'abc123' });

  assert.equal(capsule.schema_version, '0.1');
  assert.equal(capsule.context_budget.initial_tokens, 6000);
  assert.equal(capsule.worktree?.branch, 'feat/proposals');
});

test('rejects an invalid compact handoff at the core boundary', () => {
  assert.throws(() => assertValidHandoff({ schema_version: '0.1', task_id: 'X' }), /VALIDATION_ERROR/);
});

test('accepts metric records whose estimate labels name measurable fields', () => {
  const record = assertValidMetricRecord({
    schema_version: '0.1', task_id: 'X', recorded_at: new Date().toISOString(),
    input_tokens: 100, agent_output_tokens: 75,
    estimated_fields: ['agent_output_tokens', 'input_tokens'], test_status: 'PASS',
  });
  assert.equal(record.input_tokens, 100);
  assert.equal(record.agent_output_tokens, 75);
  assert.deepEqual(record.estimated_fields, ['agent_output_tokens', 'input_tokens']);
});

test('preserves a validated completion status without aliasing the input', () => {
  const input = {
    schema_version: '0.1', task_id: 'X', recorded_at: new Date().toISOString(), completion_status: 'PASS',
  };
  const record = assertValidMetricRecord(input);
  input.completion_status = 'FAIL';
  assert.equal(record.completion_status, 'PASS');
});

test('preserves a complete metric run environment without aliasing input', () => {
  const runEnvironment = {
    commit: '80bf4f08b6da7b74368b105215cc7a7d91f17629',
    worktree_digest: `sha256:${'a'.repeat(64)}`,
    agent: 'codex', model: 'gpt-5', reasoning_effort: 'high', permissions: 'workspace-write',
    runtime: 'node-v22.13.1', lockfile_hash: `sha256:${'b'.repeat(64)}`, time_limit_ms: 120000,
    test_command: 'npm test', rubric: 'rubric-v1',
  };
  const record = assertValidMetricRecord({
    schema_version: '0.1', task_id: 'PROP-014', recorded_at: new Date().toISOString(),
    run_environment: runEnvironment,
  });
  runEnvironment.model = 'mutated';
  assert.equal(record.run_environment?.model, 'gpt-5');
});

test('rejects a zero metric run time limit at the Core boundary', () => {
  assert.throws(() => assertValidMetricRecord({
    schema_version: '0.1', task_id: 'PROP-014', recorded_at: new Date().toISOString(),
    run_environment: {
      commit: '80bf4f08b6da7b74368b105215cc7a7d91f17629',
      worktree_digest: `sha256:${'a'.repeat(64)}`,
      agent: 'codex', model: 'gpt-5', reasoning_effort: 'high', permissions: 'workspace-write',
      runtime: 'node-v22.13.1', lockfile_hash: `sha256:${'b'.repeat(64)}`, time_limit_ms: 0,
      test_command: 'npm test', rubric: 'rubric-v1',
    },
  }), /time_limit_ms.*positive/i);
});

test('derives an omitted hard limit from the effective soft limit', () => {
  assert.deepEqual(allocateContextBudget('small_ui', { soft_limit_tokens: 7000 }), {
    initial_tokens: 3000,
    soft_limit_tokens: 7000,
    hard_limit_tokens: 14000,
  });
  assert.deepEqual(allocateContextBudget('small_ui', { soft_limit_tokens: 7000, hard_limit_tokens: 15000 }), {
    initial_tokens: 3000,
    soft_limit_tokens: 7000,
    hard_limit_tokens: 15000,
  });
});

test('rejects an unsupported task type even with complete budget overrides', () => {
  assert.throws(
    () => allocateContextBudget('unsupported' as never, {
      initial_tokens: 1,
      soft_limit_tokens: 2,
      hard_limit_tokens: 4,
    }),
    /task type/i,
  );
});

test('returns a Task Capsule that does not alias mutable input state', () => {
  const boundaries = { allowed_paths: ['src'], forbidden_paths: ['private'] };
  const acceptance = ['tests pass'];
  const decisions = [{ source: 'ADR-001', summary: 'Keep the boundary local' }];
  const metadata = { labels: ['safe'] };
  const worktree = { root: '/repo', branch: 'main' };
  const capsule = createTaskCapsule({
    task_id: 'SAFE-001', goal: 'Create a safe capsule', task_type: 'small_code_fix',
    boundaries, acceptance, decisions, metadata,
  }, worktree);

  boundaries.allowed_paths[0] = '../outside';
  acceptance[0] = '';
  decisions[0]!.summary = 'changed';
  metadata.labels[0] = 'changed';
  worktree.root = '/other';

  assert.deepEqual(capsule.boundaries.allowed_paths, ['src']);
  assert.deepEqual(capsule.acceptance, ['tests pass']);
  assert.equal(capsule.decisions?.[0]?.summary, 'Keep the boundary local');
  assert.deepEqual(capsule.metadata, { labels: ['safe'] });
  assert.equal(capsule.worktree?.root, '/repo');
});

test('keeps exported budget defaults deeply immutable', () => {
  assert.equal(Object.isFrozen(experimentalBudgetDefaults), true);
  assert.equal(Object.isFrozen(experimentalBudgetDefaults.small_ui), true);
  const original = experimentalBudgetDefaults.small_ui.initial_tokens;
  try {
    assert.equal(Reflect.set(experimentalBudgetDefaults.small_ui, 'initial_tokens', 1), false);
  } finally {
    Reflect.set(experimentalBudgetDefaults.small_ui, 'initial_tokens', original);
  }
  assert.equal(allocateContextBudget('small_ui').initial_tokens, original);
});

test('validated handoffs and metrics do not alias their input objects', () => {
  const handoffInput = {
    schema_version: '0.1', task_id: 'SAFE-001', status: 'PASS', changed_files: ['src/index.ts'],
    tests: { passed: 1, failed: 0 }, risks: [], next_unblocked: [],
  };
  const metricInput = {
    schema_version: '0.1', task_id: 'SAFE-001', recorded_at: new Date().toISOString(),
    input_tokens: 100, estimated_fields: ['input_tokens'],
  };
  const handoff = assertValidHandoff(handoffInput);
  const metric = assertValidMetricRecord(metricInput);

  handoffInput.changed_files[0] = '../outside';
  metricInput.input_tokens = 999;

  assert.deepEqual(handoff.changed_files, ['src/index.ts']);
  assert.equal(metric.input_tokens, 100);
});

test('represents optional Git unavailability with the documented error code', () => {
  const error = new PrimeContextError('GIT_UNAVAILABLE', 'Git metadata is unavailable');
  assert.equal(error.code, 'GIT_UNAVAILABLE');
  assert.match(error.message, /^GIT_UNAVAILABLE:/);
});

test('escapes terminal control sequences in error messages and public structured details', () => {
  const rawDetail = 'bad\u001b[31m\nkey\u009b2J';
  const error = new PrimeContextError('VALIDATION_ERROR', 'invalid\rinput', [rawDetail]);
  assert.doesNotMatch(error.message, /[\u0000-\u001f\u007f-\u009f]/);
  assert.match(error.message, /invalid\\u000dinput/);
  assert.match(error.message, /bad\\u001b\[31m\\u000akey\\u009b2J/);
  assert.deepEqual(error.details, ['bad\\u001b[31m\\u000akey\\u009b2J']);
  assert.doesNotMatch(JSON.stringify(error), /\u001b|\u009b/);

  assert.throws(
    () => assertValidHandoff({
      schema_version: '0.1', task_id: 'SAFE-001', status: 'PASS', changed_files: [],
      tests: { passed: 1, failed: 0 }, risks: [], next_unblocked: [],
      ['unknown\u001b[2J']: true,
    }),
    (thrown: unknown) => {
      assert.ok(thrown instanceof PrimeContextError);
      assert.doesNotMatch(thrown.message, /[\u0000-\u001f\u007f-\u009f]/);
      assert.match(thrown.message, /unknown\\u001b\[2J/);
      return true;
    },
  );
});

test('never stores or serializes raw credential details in a PrimeContextError', () => {
  const secret = 'sk-live-PrimeContextSecret123456789';
  const opaqueSecret = 'PrimeContextOpaqueSecret123456789';
  const error = new PrimeContextError(
    'SECURITY_ERROR',
    `Authorization: Bearer ${secret}`,
    [`api_key=${secret}`, `failed with opaque value ${opaqueSecret}`],
  );
  const serialized = JSON.stringify(error);

  for (const credential of [secret, opaqueSecret]) {
    assert.doesNotMatch(error.message, new RegExp(credential));
    assert.doesNotMatch(error.details.join('\n'), new RegExp(credential));
    assert.doesNotMatch(serialized, new RegExp(credential));
  }
  assert.match(error.message, /\[REDACTED\]/);
  assert.ok(error.details.every((detail) => detail.includes('[REDACTED]')));
});

test('redacts complete Basic and short Bearer authorization values at every public error surface', () => {
  for (const [publicErrorText, credential] of [
    ['Authorization: Basic dXNlcjpwYXNz', 'dXNlcjpwYXNz'],
    ['authorization="Bearer tiny7"', 'tiny7'],
    ['Authorization header: Basic c2hvcnQ6cHc=', 'c2hvcnQ6cHc='],
    ['authentication failed with Basic dXNlcjpwdw==', 'dXNlcjpwdw=='],
    ['authentication failed with Bearer short-token', 'short-token'],
    ['credentials rejected: Basic dXNlcjpwYXNz', 'dXNlcjpwYXNz'],
    ['HTTP 401 (Basic dTpw)', 'dTpw'],
    ['Basic dTpw', 'dTpw'],
    ['Basic dTpw\r\n', 'dTpw'],
    ['HTTP 401 (Basic dTpw\0)', 'dTpw'],
    ['HTTP 401 (Bearer tiny7)', 'tiny7'],
  ] as const) {
    const error = new PrimeContextError(
      'SECURITY_ERROR',
      publicErrorText,
      [publicErrorText],
    );
    const publicText = `${error.message}\n${error.details.join('\n')}\n${JSON.stringify(error)}`;

    assert.doesNotMatch(publicText, new RegExp(credential));
    assert.match(publicText, /\[REDACTED\]/);
  }

  for (const publicErrorText of [
    'Use the Basic example in the documentation',
    'Basic authentication support',
    'Basic concepts',
  ]) {
    const unrelated = new PrimeContextError('VALIDATION_ERROR', publicErrorText);
    assert.match(unrelated.message, new RegExp(`${publicErrorText}$`));
    assert.doesNotMatch(unrelated.message, /\[REDACTED\]/);
  }
});

test('bounds opaque-secret redaction work for public validation errors', () => {
  const hostileKey = `${'a.'.repeat(16_384)}a`;
  const startedAt = performance.now();

  assert.throws(
    () => assertValidHandoff({
      schema_version: '0.1', task_id: 'SAFE-001', status: 'PASS', changed_files: [],
      tests: { passed: 1, failed: 0 }, risks: [], next_unblocked: [],
      [hostileKey]: true,
    }),
    (error: unknown) => {
      assert.ok(error instanceof PrimeContextError);
      assert.equal(error.details.some((detail) => detail.includes(hostileKey)), true);
      return true;
    },
  );

  const elapsedMs = performance.now() - startedAt;
  assert.ok(elapsedMs < 1_000, `public error redaction took ${elapsedMs.toFixed(2)}ms`);
});

test('canonical hashing rejects every non-JSON own property without invoking it', () => {
  const withUndefined = { safe: true, missing: undefined };
  assert.throws(() => hashContextJson(withUndefined), /unsupported value/i);

  const withSymbol = { safe: true } as Record<PropertyKey, unknown>;
  withSymbol[Symbol('hidden')] = 'secret';
  assert.throws(() => hashContextJson(withSymbol), /symbol properties/i);

  const withHidden = { safe: true };
  Object.defineProperty(withHidden, 'hidden', { enumerable: false, value: 'secret' });
  assert.throws(() => hashContextJson(withHidden), /enumerable data properties/i);

  const withArrayExtra = ['safe'] as string[] & { extra?: string };
  withArrayExtra.extra = 'secret';
  assert.throws(() => hashContextJson(withArrayExtra), /array properties/i);

  const withNumericArrayExtra = ['safe'];
  Object.defineProperty(withNumericArrayExtra, '4294967295', { enumerable: true, value: 'secret' });
  assert.throws(() => hashContextJson(withNumericArrayExtra), /array properties/i);
});

test('canonical hashing represents __proto__ as data without collisions or prototype mutation', () => {
  const withProtoKey = JSON.parse('{"__proto__":{"polluted":true}}') as Record<string, unknown>;
  const emptyDigest = hashContextJson({});
  const protoDigest = hashContextJson(withProtoKey);

  assert.notEqual(protoDigest, emptyDigest);
  assert.equal(({} as { polluted?: boolean }).polluted, undefined);
  assert.equal(hashContextJson(withProtoKey), protoDigest);
});

test('canonical hashing accepts contract-valid strings above the context excerpt limit', () => {
  const maximumPublicString = 'x'.repeat(32 * 1024);
  assert.doesNotThrow(() => hashContextJson({ excerpt: maximumPublicString }));
  assert.doesNotThrow(() => hashContextJson({ role: `${maximumPublicString}x` }));
  assert.notEqual(
    hashContextJson({ role: maximumPublicString }),
    hashContextJson({ role: `${maximumPublicString}x` }),
  );
});

test('canonical string accounting matches JSON escaping for values and keys', () => {
  for (const value of [
    'plain', '\u0000\b\t\n\f\r"\\', 'é😀', '\ud800', '\udc00',
  ]) {
    assert.equal(hashContextJson(value), hashContextText(JSON.stringify(value)));
  }

  const escapedKey = '\u0000-key-😀-\ud800';
  const keyedValue = { [escapedKey]: 'safe' };
  assert.equal(hashContextJson(keyedValue), hashContextText(JSON.stringify(keyedValue)));
});

test('canonical hashing bounds one oversized string by its serialized aggregate bytes', () => {
  const maximumCanonicalBytes = 128 * 1024 * 1024;
  const marker = 'DO-NOT-ECHO-CANONICAL-INPUT';
  const oversizedEscapedString = `${marker}${'\u0000'.repeat(Math.floor((maximumCanonicalBytes - 2) / 6) + 1)}`;

  assert.throws(
    () => hashContextJson({ role: oversizedEscapedString }),
    (error: unknown) => {
      assert.ok(error instanceof PrimeContextError);
      assert.equal(error.code, 'VALIDATION_ERROR');
      assert.match(error.message, /Canonical JSON exceeds its byte limit/i);
      assert.deepEqual(error.details, []);
      assert.doesNotMatch(JSON.stringify(error), new RegExp(marker));
      return true;
    },
  );
});

test('canonical hashing bounds aggregate serialized bytes independently of value count', () => {
  const maximumPublicString = '\u0000'.repeat(32 * 1024);
  const oversizedCanonicalValue = new Array(683).fill(maximumPublicString);
  assert.throws(() => hashContextJson(oversizedCanonicalValue), /byte limit/i);
});
