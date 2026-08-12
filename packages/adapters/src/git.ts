import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GitPort, GitState } from '@primecontext/core';

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 5_000;
const GIT_MAX_BUFFER_BYTES = 64 * 1024;

async function git(root: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd: root,
      windowsHide: true,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER_BYTES,
      killSignal: 'SIGKILL',
    });
    return stdout.trim();
  } catch {
    return undefined;
  }
}

export class NodeGitAdapter implements GitPort {
  async inspect(root: string): Promise<GitState | undefined> {
    const inside = await git(root, ['rev-parse', '--is-inside-work-tree']);
    if (inside !== 'true') return undefined;
    const head = await git(root, ['rev-parse', 'HEAD']);
    const branchValue = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
    return {
      ...(branchValue && branchValue !== 'HEAD' ? { branch: branchValue } : {}),
      ...(head ? { head } : {}),
    };
  }
}
