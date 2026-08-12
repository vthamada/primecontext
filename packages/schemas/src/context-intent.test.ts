import assert from 'node:assert/strict';
import test from 'node:test';
import {
  contextIntentSchema,
  type ContextIntentV03,
  validateContextIntent,
} from './index.js';

const minimalIntent: ContextIntentV03 = {
  schema_version: '0.3',
  task_id: 'ONBOARD-001',
  task_type: 'module_feature',
  goal: 'Prepare trustworthy context for an implementation task',
  acceptance: [
    'The selected evidence is inspectable',
    'The selection receipt is linked to the context envelope',
  ],
};

test('exports the strict versioned ContextIntent v0.3 contract', () => {
  assert.match(contextIntentSchema.$id, /\/v0\.3\/context-intent\.schema\.json$/);
  assert.deepEqual(validateContextIntent(minimalIntent), { valid: true, errors: [] });
});

test('accepts the complete human-friendly intent without requiring compiler internals', () => {
  const complete: ContextIntentV03 = {
    ...minimalIntent,
    query: 'receipt compiler evidence',
    paths: ['src/compiler.ts', 'docs/security.md'],
    symbols: ['compileContext', 'SelectionReceipt'],
    terms: ['receipt', 'security'],
    required_sources: ['docs/security.md'],
  };

  assert.deepEqual(validateContextIntent(complete), { valid: true, errors: [] });
  assert.equal(Object.hasOwn(complete, 'budget'), false);
  assert.equal(Object.hasOwn(complete, 'snapshot'), false);
  assert.equal(Object.hasOwn(complete, 'policy_version'), false);
});

test('rejects malformed, unbounded, unsafe, and non-canonical intents', () => {
  const invalidValues: unknown[] = [
    { ...minimalIntent, extra: true },
    { ...minimalIntent, acceptance: [] },
    { ...minimalIntent, acceptance: [''] },
    { ...minimalIntent, goal: '' },
    { ...minimalIntent, query: '' },
    { ...minimalIntent, task_id: '../escape' },
    { ...minimalIntent, task_type: 'unknown' },
    { ...minimalIntent, paths: ['../secret.txt'] },
    { ...minimalIntent, required_sources: ['/absolute.md'] },
    { ...minimalIntent, terms: ['valid', 7] },
    { ...minimalIntent, goal: 'x'.repeat(4_097) },
    { ...minimalIntent, acceptance: ['x'.repeat(1_025)] },
    { ...minimalIntent, goal: 'line one\nline two' },
    { ...minimalIntent, acceptance: ['criterion\twith control'] },
    { ...minimalIntent, query: 'query\u007fcontrol' },
    { ...minimalIntent, symbols: ['symbol\u0085control'] },
    { ...minimalIntent, terms: ['term\u0000control'] },
  ];

  for (const value of invalidValues) {
    assert.equal(validateContextIntent(value).valid, false, JSON.stringify(value).slice(0, 160));
  }
});

test('rejects accessors and sparse acceptance arrays at the public validation boundary', () => {
  const accessor = { ...minimalIntent } as Record<string, unknown>;
  Object.defineProperty(accessor, 'goal', {
    enumerable: true,
    get: () => minimalIntent.goal,
  });
  assert.equal(validateContextIntent(accessor).valid, false);

  const sparse = new Array(1);
  assert.equal(validateContextIntent({ ...minimalIntent, acceptance: sparse }).valid, false);
});
