import { basename, join, resolve } from 'node:path';
import { NodeFileSystemAdapter, NodeGitAdapter } from '@primecontext/adapters';
import { compareBenchmarkArms, type BenchmarkComparison } from '@primecontext/benchmark';
import {
  PrimeContextError,
  assertValidHandoff,
  assertValidMetricRecord,
  createTaskCapsule,
  type ContextBudget,
  type MetricNumericField,
  type TaskDefinitionInput,
  type TaskType,
} from '@primecontext/core';
import { generateRepoMap } from '@primecontext/repo-map';
import { isValidTaskId, taskTypes, validateTaskCapsule } from '@primecontext/schemas';
import {
  CONFIG_FILE,
  defaultConfig,
  loadConfig,
  parseConfig,
  type PrimeContextConfig,
} from './config.js';
import {
  assertStateDirectoryIgnored,
  ensureSafeDirectory,
  MAX_JSON_INPUT_BYTES,
  MAX_METRIC_RECORDS,
  MAX_METRICS_BYTES,
  parseBoundedJson,
  readInternalJson,
  readInternalText,
  readRepositoryJson,
  repositoryRelativePath,
  stateDirectoryIgnoreEntry,
  withInternalExclusiveLock,
  writeInternalJson,
  writeInternalTextAtomic,
  writeInternalTextIfAbsentAtomic,
} from './safe-io.js';

function stateRelativePath(root: string, configured: string): string {
  return repositoryRelativePath(resolve(root), configured, 'state_dir');
}

function absoluteRepositoryPath(root: string, relativePath: string): string {
  return resolve(root, repositoryRelativePath(root, relativePath));
}

function assertSafeTaskId(taskId: unknown): asserts taskId is string {
  if (!isValidTaskId(taskId)) throw new PrimeContextError('SECURITY_ERROR', 'task_id must be a safe bounded identifier');
}

async function publishStateDirectoryIgnore(root: string, configuredStateDirectory: string): Promise<void> {
  const ignorePath = '.gitignore';
  const ignore = await readInternalText(root, ignorePath, MAX_JSON_INPUT_BYTES, { allowMissing: true }) ?? '';
  const ignoreEntry = stateDirectoryIgnoreEntry(configuredStateDirectory);
  if (!ignore.split(/\r?\n/).includes(ignoreEntry)) {
    const prefix = ignore.length > 0 && !ignore.endsWith('\n') ? '\n' : '';
    try {
      await writeInternalTextAtomic(root, ignorePath, `${ignore}${prefix}${ignoreEntry}\n`);
    } catch (error) {
      let concurrentlyPublished = false;
      try {
        const current = await readInternalText(root, ignorePath, MAX_JSON_INPUT_BYTES, { allowMissing: true });
        concurrentlyPublished = current?.split(/\r?\n/).includes(ignoreEntry) === true;
      } catch { /* preserve the publication failure */ }
      if (!concurrentlyPublished) throw error;
    }
  }
  await assertStateDirectoryIgnored(root, configuredStateDirectory);
}

interface InitializationConfigObservation {
  config: PrimeContextConfig;
  exists: boolean;
  identity: string;
}

async function observeInitializationConfig(root: string): Promise<InitializationConfigObservation> {
  const content = await readInternalText(root, CONFIG_FILE, MAX_JSON_INPUT_BYTES, { allowMissing: true });
  const config = content === undefined
    ? defaultConfig()
    : parseConfig(parseBoundedJson(content, 'CONFIG_ERROR', CONFIG_FILE));
  return { config, exists: content !== undefined, identity: JSON.stringify(config) };
}

export async function initCommand(root: string): Promise<{ config_path: string; state_dir: string; created_config: boolean }> {
  const resolvedRoot = resolve(root);
  const configPath = join(resolvedRoot, CONFIG_FILE);
  let observation = await observeInitializationConfig(resolvedRoot);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await publishStateDirectoryIgnore(resolvedRoot, observation.config.state_dir);
    const confirmed = await observeInitializationConfig(resolvedRoot);
    if (confirmed.identity !== observation.identity) {
      observation = confirmed;
      continue;
    }

    const localStateRelative = stateRelativePath(resolvedRoot, observation.config.state_dir);
    await assertStateDirectoryIgnored(resolvedRoot, observation.config.state_dir);
    return withInternalExclusiveLock(resolvedRoot, join(localStateRelative, 'init.lock'), async () => {
      const locked = await observeInitializationConfig(resolvedRoot);
      if (locked.identity !== observation.identity) {
        throw new PrimeContextError('STATE_ERROR', 'Repository configuration changed during initialization; retry');
      }
      let createdConfig = false;
      if (!locked.exists) {
        createdConfig = await writeInternalTextIfAbsentAtomic(
          resolvedRoot,
          CONFIG_FILE,
          `${JSON.stringify(observation.config, null, 2)}\n`,
          { temporaryDirectory: localStateRelative },
        );
      }
      const published = await observeInitializationConfig(resolvedRoot);
      if (!published.exists || published.identity !== observation.identity) {
        throw new PrimeContextError('STATE_ERROR', 'Repository configuration changed during initialization; retry');
      }
      await assertStateDirectoryIgnored(resolvedRoot, observation.config.state_dir);
      const localState = await ensureSafeDirectory(resolvedRoot, localStateRelative);
      await ensureSafeDirectory(resolvedRoot, join(localStateRelative, 'capsules'));
      await ensureSafeDirectory(resolvedRoot, join(localStateRelative, 'tasks'));
      const finalized = await observeInitializationConfig(resolvedRoot);
      if (!finalized.exists || finalized.identity !== observation.identity) {
        throw new PrimeContextError('STATE_ERROR', 'Repository configuration changed during initialization; retry');
      }
      await assertStateDirectoryIgnored(resolvedRoot, finalized.config.state_dir);
      return { config_path: configPath, state_dir: localState, created_config: createdConfig };
    }, { operation: 'initialize-state-ignore' });
  }
  throw new PrimeContextError('STATE_ERROR', 'Repository configuration changed repeatedly during initialization; retry');
}

export async function mapCommand(root: string): Promise<{ map_path: string; module_count: number }> {
  const resolvedRoot = resolve(root);
  const config = await loadConfig(resolvedRoot);
  const localState = stateRelativePath(resolvedRoot, config.state_dir);
  await assertStateDirectoryIgnored(resolvedRoot, config.state_dir);
  await ensureSafeDirectory(resolvedRoot, localState);
  const map = await generateRepoMap(
    resolvedRoot,
    new NodeFileSystemAdapter([...new Set([...config.exclude, config.state_dir])]),
    new NodeGitAdapter(),
  );
  const mapRelativePath = join(localState, 'repo-map.json');
  await withInternalExclusiveLock(resolvedRoot, join(localState, 'repo-map.lock'), async () => {
    await writeInternalJson(resolvedRoot, mapRelativePath, map);
  }, { operation: 'replace-repository-map' });
  return { map_path: absoluteRepositoryPath(resolvedRoot, mapRelativePath), module_count: map.summary.module_count };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw new PrimeContextError('VALIDATION_ERROR', `${field} must be an array of non-empty strings`);
  }
  return [...value] as string[];
}

function parseTaskDefinition(value: unknown, expectedTaskId: string): TaskDefinitionInput {
  assertSafeTaskId(expectedTaskId);
  if (!isObject(value)) throw new PrimeContextError('VALIDATION_ERROR', 'Task definition must be an object');
  const allowed = new Set([
    'task_id','goal','task_type','module','priority','boundaries','acceptance','contracts','documents',
    'code_targets','metadata','decisions',
  ]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new PrimeContextError('VALIDATION_ERROR', `Task definition property is not allowed: ${key}`);
  if (value.task_id !== expectedTaskId) throw new PrimeContextError('VALIDATION_ERROR', `Task definition task_id must equal ${expectedTaskId}`);
  assertSafeTaskId(value.task_id);
  if (typeof value.goal !== 'string' || !value.goal) throw new PrimeContextError('VALIDATION_ERROR', 'Task definition goal is required');
  if (!(taskTypes as readonly unknown[]).includes(value.task_type)) throw new PrimeContextError('VALIDATION_ERROR', 'Task definition task_type is invalid');
  if (!isObject(value.boundaries)) throw new PrimeContextError('VALIDATION_ERROR', 'Task definition boundaries are required');
  const boundaries = {
    allowed_paths: stringArray(value.boundaries.allowed_paths, 'boundaries.allowed_paths'),
    forbidden_paths: stringArray(value.boundaries.forbidden_paths, 'boundaries.forbidden_paths'),
  };
  for (const key of Object.keys(value.boundaries)) {
    if (key !== 'allowed_paths' && key !== 'forbidden_paths') throw new PrimeContextError('VALIDATION_ERROR', `boundaries.${key} is not allowed`);
  }
  const acceptance = stringArray(value.acceptance, 'acceptance');
  if (acceptance.length === 0) throw new PrimeContextError('VALIDATION_ERROR', 'acceptance must contain at least one criterion');

  const task: TaskDefinitionInput = {
    task_id: expectedTaskId,
    goal: value.goal,
    task_type: value.task_type as TaskType,
    boundaries,
    acceptance,
  };
  if (value.module !== undefined) {
    if (typeof value.module !== 'string' || !value.module) throw new PrimeContextError('VALIDATION_ERROR', 'module must be a non-empty string');
    task.module = value.module;
  }
  if (value.priority !== undefined) {
    if (typeof value.priority !== 'string' || !value.priority) throw new PrimeContextError('VALIDATION_ERROR', 'priority must be a non-empty string');
    task.priority = value.priority;
  }
  if (value.contracts !== undefined) task.contracts = stringArray(value.contracts, 'contracts');
  if (value.documents !== undefined) task.documents = stringArray(value.documents, 'documents');
  if (value.code_targets !== undefined) task.code_targets = stringArray(value.code_targets, 'code_targets');
  if (value.metadata !== undefined) {
    if (!isObject(value.metadata)) throw new PrimeContextError('VALIDATION_ERROR', 'metadata must be an object');
    task.metadata = value.metadata;
  }
  if (value.decisions !== undefined) {
    if (!Array.isArray(value.decisions)) throw new PrimeContextError('VALIDATION_ERROR', 'decisions must be an array');
    task.decisions = value.decisions.map((decision, index) => {
      if (!isObject(decision) || typeof decision.source !== 'string' || !decision.source || typeof decision.summary !== 'string' || !decision.summary) {
        throw new PrimeContextError('VALIDATION_ERROR', `decisions[${index}] must contain source and summary`);
      }
      for (const key of Object.keys(decision)) if (key !== 'source' && key !== 'summary') throw new PrimeContextError('VALIDATION_ERROR', `decisions[${index}].${key} is not allowed`);
      return { source: decision.source, summary: decision.summary };
    });
  }
  return task;
}

export async function taskCommand(root: string, taskId: string, fromFile?: string): Promise<{ capsule_path: string }> {
  const resolvedRoot = resolve(root);
  assertSafeTaskId(taskId);
  const config = await loadConfig(resolvedRoot);
  const localState = stateRelativePath(resolvedRoot, config.state_dir);
  await assertStateDirectoryIgnored(resolvedRoot, config.state_dir);
  const definitionInput = fromFile
    ? await readRepositoryJson(resolvedRoot, fromFile)
    : await readInternalJson(resolvedRoot, join(localState, 'tasks', `${taskId}.json`));
  const definition = parseTaskDefinition(definitionInput, taskId);
  const git = await new NodeGitAdapter().inspect(resolvedRoot);
  const capsule = createTaskCapsule(
    definition,
    { root: resolvedRoot, ...(git?.branch ? { branch: git.branch } : {}), ...(git?.head ? { head: git.head } : {}) },
    config.budgets[definition.task_type] as ContextBudget,
  );
  const capsuleDir = join(localState, 'capsules');
  await ensureSafeDirectory(resolvedRoot, capsuleDir);
  const capsulePath = join(capsuleDir, `${taskId}.json`);
  await withInternalExclusiveLock(resolvedRoot, join(capsuleDir, `${taskId}.lock`), async () => {
    await writeInternalJson(resolvedRoot, capsulePath, capsule);
  }, { operation: 'replace-task-capsule' });
  return { capsule_path: absoluteRepositoryPath(resolvedRoot, capsulePath) };
}

export async function inspectCommand(root: string, taskId: string): Promise<{ task_id: string; goal: string; task_type: string; context_budget: ContextBudget }> {
  assertSafeTaskId(taskId);
  const config = await loadConfig(root);
  await assertStateDirectoryIgnored(root, config.state_dir);
  const capsulePath = join(stateRelativePath(root, config.state_dir), 'capsules', `${taskId}.json`);
  const capsule = await readInternalJson(root, capsulePath);
  const validation = validateTaskCapsule(capsule);
  if (!validation.valid) throw new PrimeContextError('VALIDATION_ERROR', 'Stored Task Capsule is invalid', validation.errors);
  const typed = capsule as { task_id: string; goal: string; task_type: string; context_budget: ContextBudget };
  return { task_id: typed.task_id, goal: typed.goal, task_type: typed.task_type, context_budget: typed.context_budget };
}

export async function handoffValidateCommand(file: string, root = process.cwd()): Promise<{ valid: true; task_id: string; status: string }> {
  const handoff = assertValidHandoff(await readRepositoryJson(root, file));
  return { valid: true, task_id: handoff.task_id, status: handoff.status };
}

const numericMetricFields: readonly MetricNumericField[] = [
  'input_tokens','cached_input_tokens','output_tokens','tool_calls','file_reads','codegraph_calls',
  'context_expansions','duration_ms','selected_context_tokens','agent_output_tokens','rework_count',
];

function parseMetricLines(content: string): ReturnType<typeof assertValidMetricRecord>[] {
  const lines = content.split(/\r?\n/).filter(Boolean);
  if (lines.length > MAX_METRIC_RECORDS) throw new PrimeContextError('IO_ERROR', `metrics.jsonl exceeds the ${MAX_METRIC_RECORDS} record limit`);
  return lines.map((line, index) => {
    let parsed: unknown;
    try { parsed = JSON.parse(line) as unknown; }
    catch { throw new PrimeContextError('VALIDATION_ERROR', `metrics.jsonl line ${index + 1} contains invalid JSON`); }
    return assertValidMetricRecord(parsed);
  });
}

export async function metricsCommand(root: string): Promise<{ record_count: number; totals: Partial<Record<MetricNumericField, number>>; estimated_fields: MetricNumericField[] }> {
  const resolvedRoot = resolve(root);
  const config = await loadConfig(resolvedRoot);
  await assertStateDirectoryIgnored(resolvedRoot, config.state_dir);
  const metricsPath = join(stateRelativePath(resolvedRoot, config.state_dir), 'metrics.jsonl');
  const content = await readInternalText(resolvedRoot, metricsPath, MAX_METRICS_BYTES, { allowMissing: true });
  if (content === undefined) return { record_count: 0, totals: {}, estimated_fields: [] };
  const records = parseMetricLines(content);
  const totals: Partial<Record<MetricNumericField, number>> = {};
  const estimated = new Set<MetricNumericField>();
  for (const record of records) {
    for (const field of numericMetricFields) {
      const measurement = record[field];
      if (typeof measurement !== 'number') continue;
      const total = (totals[field] ?? 0) + measurement;
      if (!Number.isSafeInteger(total)) {
        throw new PrimeContextError('VALIDATION_ERROR', `Metric aggregate exceeds the safe integer range: ${field}`);
      }
      totals[field] = total;
    }
    for (const field of record.estimated_fields ?? []) estimated.add(field);
  }
  return { record_count: records.length, totals, estimated_fields: [...estimated].sort() };
}

export async function recordMetricCommand(root: string, file: string): Promise<{ metrics_path: string; record_count: number }> {
  const resolvedRoot = resolve(root);
  const config = await loadConfig(resolvedRoot);
  await assertStateDirectoryIgnored(resolvedRoot, config.state_dir);
  const record = assertValidMetricRecord(await readRepositoryJson(resolvedRoot, file));
  const metricsPath = join(stateRelativePath(resolvedRoot, config.state_dir), 'metrics.jsonl');
  const lockPath = join(stateRelativePath(resolvedRoot, config.state_dir), 'metrics.lock');
  return withInternalExclusiveLock(resolvedRoot, lockPath, async () => {
    const existing = await readInternalText(resolvedRoot, metricsPath, MAX_METRICS_BYTES, { allowMissing: true }) ?? '';
    const records = parseMetricLines(existing);
    if (records.length >= MAX_METRIC_RECORDS) throw new PrimeContextError('IO_ERROR', `metrics.jsonl reached the ${MAX_METRIC_RECORDS} record limit`);
    const next = `${existing}${existing.length > 0 && !existing.endsWith('\n') ? '\n' : ''}${JSON.stringify(record)}\n`;
    if (Buffer.byteLength(next, 'utf8') > MAX_METRICS_BYTES) throw new PrimeContextError('IO_ERROR', 'metrics.jsonl would exceed the byte limit');
    await writeInternalTextAtomic(resolvedRoot, metricsPath, next);
    return { metrics_path: absoluteRepositoryPath(resolvedRoot, metricsPath), record_count: records.length + 1 };
  }, { operation: 'append-metric-record' });
}

export async function benchmarkCommand(armAFile: string, armBFile: string, root = process.cwd()): Promise<BenchmarkComparison> {
  const armA = assertValidMetricRecord(await readRepositoryJson(root, armAFile, 'BENCHMARK_ERROR'));
  const armB = assertValidMetricRecord(await readRepositoryJson(root, armBFile, 'BENCHMARK_ERROR'));
  return compareBenchmarkArms(armA, armB);
}

export function configPreview(): ReturnType<typeof defaultConfig> { return defaultConfig(); }
export function repositoryName(root: string): string { return basename(resolve(root)); }
