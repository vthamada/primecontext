import type { Stats } from 'node:fs';

export function sameRegularFileSnapshot(left: Stats, right: Stats): boolean {
  const comparableDevice = left.dev !== 0 && right.dev !== 0;
  return left.isFile()
    && right.isFile()
    && (!comparableDevice || left.dev === right.dev)
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}
