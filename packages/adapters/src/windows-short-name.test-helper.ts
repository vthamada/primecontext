import { spawnSync } from 'node:child_process';
import { platform } from 'node:os';

export function windowsShortNameFor(parentDirectory: string, longName: string): string | undefined {
  if (platform() !== 'win32') return undefined;
  const listing = spawnSync(process.env.ComSpec ?? 'cmd.exe', [
    '/d',
    '/c',
    'dir',
    '/x',
    '/a',
    parentDirectory,
  ], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (listing.status !== 0) return undefined;
  const line = listing.stdout
    .split(/\r?\n/u)
    .find((candidate) => candidate.trimEnd().endsWith(` ${longName}`));
  const shortName = line?.trim().split(/\s+/u).at(-2);
  return shortName && shortName !== '<DIR>' ? shortName : undefined;
}
