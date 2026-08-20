import { basename, resolve } from 'node:path';
import { posix } from 'node:path';
import {
  PrimeContextError,
  type FileSystemPort,
  type GitPort,
  type GitState,
  type RepoModule,
  type RepoModuleKind,
  type SemanticRepoMap,
  type WalkResult,
} from '@primecontext/core';
import { validateRepoMap } from '@primecontext/schemas';

const conventionalRoles: Readonly<Record<string, { kind: RepoModuleKind; role: string }>> = {
  src: { kind: 'source', role: 'Primary source-code boundary.' },
  source: { kind: 'source', role: 'Primary source-code boundary.' },
  test: { kind: 'tests', role: 'Automated test boundary.' },
  tests: { kind: 'tests', role: 'Automated test boundary.' },
  docs: { kind: 'documentation', role: 'Project documentation and architecture knowledge.' },
  documentation: { kind: 'documentation', role: 'Project documentation and architecture knowledge.' },
  config: { kind: 'configuration', role: 'Repository configuration boundary.' },
  configuration: { kind: 'configuration', role: 'Repository configuration boundary.' },
  examples: { kind: 'examples', role: 'Runnable or illustrative project examples.' },
  benchmarks: { kind: 'benchmarks', role: 'Benchmark inputs, fixtures, and evidence.' },
};

function moduleId(kind: RepoModuleKind, path: string, name?: string): string {
  const raw = `${kind}:${name ?? path}`.toLowerCase();
  return raw.replace(/[^a-z0-9@/_:.-]+/g, '-');
}

function ordinalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function packageModule(root: string, manifestPath: string, fsPort: FileSystemPort): Promise<RepoModule | undefined> {
  try {
    const content = await fsPort.readText(root, manifestPath, 512 * 1024);
    const manifest = JSON.parse(content) as { name?: unknown; description?: unknown };
    if (typeof manifest.name !== 'string' || !manifest.name) return undefined;
    const directory = manifestPath === 'package.json' ? '.' : posix.dirname(manifestPath);
    const description = typeof manifest.description === 'string' && manifest.description.trim()
      ? manifest.description.trim()
      : `Package ${manifest.name}.`;
    return {
      id: moduleId('workspace_package', directory, manifest.name),
      path: directory,
      kind: 'workspace_package',
      role: description,
      evidence: [`package.json name=${manifest.name}`, ...(typeof manifest.description === 'string' && manifest.description.trim() ? ['package.json description'] : [])],
    };
  } catch {
    return undefined;
  }
}

export interface RepoMapObservation {
  walk: WalkResult;
  git?: GitState;
}

async function buildRepoMap(
  root: string,
  fsPort: FileSystemPort,
  observation: RepoMapObservation,
): Promise<SemanticRepoMap> {
  const resolvedRoot = resolve(root);
  const { walk, git } = observation;
  const modules = new Map<string, RepoModule>();

  for (const item of walk.paths) {
    if (item.kind === 'file' && (item.relative_path === 'package.json' || item.relative_path.endsWith('/package.json'))) {
      const module = await packageModule(resolvedRoot, item.relative_path, fsPort);
      if (module) modules.set(module.path, module);
    }
  }

  for (const item of walk.paths) {
    if (item.kind !== 'directory' || item.relative_path.includes('/')) continue;
    const conventional = conventionalRoles[item.relative_path.toLowerCase()];
    if (!conventional || modules.has(item.relative_path)) continue;
    modules.set(item.relative_path, {
      id: moduleId(conventional.kind, item.relative_path),
      path: item.relative_path,
      kind: conventional.kind,
      role: conventional.role,
      evidence: [`conventional directory: ${item.relative_path}`],
    });
  }

  const sortedModules = [...modules.values()].sort((a, b) => ordinalCompare(a.path, b.path));
  const map: SemanticRepoMap = {
    schema_version: '0.1',
    generated_at: new Date().toISOString(),
    repository: {
      root: resolvedRoot,
      name: basename(resolvedRoot),
      ...(git?.branch ? { branch: git.branch } : {}),
      ...(git?.head ? { head: git.head } : {}),
    },
    modules: sortedModules,
    summary: {
      module_count: sortedModules.length,
      discovered_path_count: walk.paths.length,
      excluded_path_count: walk.excluded_path_count,
    },
  };

  const validation = validateRepoMap(map);
  if (!validation.valid) throw new PrimeContextError('VALIDATION_ERROR', 'Generated Semantic Repo Map is invalid', validation.errors);
  return map;
}

export async function generateRepoMapFromObservation(
  root: string,
  fsPort: FileSystemPort,
  observation: RepoMapObservation,
): Promise<SemanticRepoMap> {
  return buildRepoMap(root, fsPort, observation);
}

export async function generateRepoMap(root: string, fsPort: FileSystemPort, gitPort: GitPort): Promise<SemanticRepoMap> {
  const resolvedRoot = resolve(root);
  const [walk, git] = await Promise.all([
    fsPort.walk(resolvedRoot),
    gitPort.inspect(resolvedRoot),
  ]);
  return buildRepoMap(resolvedRoot, fsPort, { walk, ...(git ? { git } : {}) });
}
