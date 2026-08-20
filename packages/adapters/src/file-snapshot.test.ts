import assert from 'node:assert/strict';
import type { Stats } from 'node:fs';
import test from 'node:test';
import { sameRegularFileSnapshot } from './file-snapshot.js';

function snapshot(overrides: Partial<Pick<Stats, 'dev' | 'ino' | 'size' | 'mtimeMs' | 'ctimeMs'>> = {}): Stats {
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

test('treats a zero device id as unavailable across path and handle stat APIs', () => {
  assert.equal(sameRegularFileSnapshot(snapshot({ dev: 0 }), snapshot({ dev: 3_230_446_999 })), true);
  assert.equal(sameRegularFileSnapshot(snapshot({ dev: 3_230_446_999 }), snapshot({ dev: 0 })), true);
});

test('still rejects comparable device changes and every stable-file identity change', () => {
  assert.equal(sameRegularFileSnapshot(snapshot({ dev: 1 }), snapshot({ dev: 2 })), false);
  assert.equal(sameRegularFileSnapshot(snapshot(), snapshot({ ino: 74 })), false);
  assert.equal(sameRegularFileSnapshot(snapshot(), snapshot({ size: 102 })), false);
  assert.equal(sameRegularFileSnapshot(snapshot(), snapshot({ mtimeMs: 203 })), false);
  assert.equal(sameRegularFileSnapshot(snapshot(), snapshot({ ctimeMs: 304 })), false);
});
