import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GitPort, GitState } from '@primecontext/core';

const execFileAsync = promisify(execFile);

async function git(root: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd: root, windowsHide: true });
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
