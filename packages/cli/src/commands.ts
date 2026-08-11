import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { NodeFileSystemAdapter, NodeGitAdapter, assertPathInsideRoot } from '@primecontext/adapters';
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
import { taskTypes, validateTaskCapsule } from '@primecontext/schemas';
import { CONFIG_FILE, defaultConfig, loadConfig, writeDefaultConfig } from './config.js';

async function exists(path: string): Promise<boolean> {
  try { await readFile(path); return true; } catch { return false; }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function readJson(path: string): Promise<unknown> {
  try { return JSON.parse(await readFile(path, 'utf8')) as unknown; }
  catch (error) {
    throw new PrimeContextError('IO_ERROR', `Unable to read JSON: ${path}`, [error instanceof Error ? error.message : String(error)]);
  }
}

function stateDir(root: string, configured: string): string {
  return assertPathInsideRoot(resolve(root), configured);
}

export async function initCommand(root: string): Promise<{ config_path: string; state_dir: string; created_config: boolean }> {
  const resolvedRoot = resolve(root);
  const configPath = join(resolvedRoot, CONFIG_FILE);
  let createdConfig = false;
  if (!(await exists(configPath))) {
    await writeDefaultConfig(configPath);
    createdConfig = true;
  }
  const config = await loadConfig(resolvedRoot);
  const localState = stateDir(resolvedRoot, config.state_dir);
  await mkdir(join(localState, 'capsules'), { recursive: true });
  await mkdir(join(localState, 'tasks'), { recursive: true });

  const ignorePath = join(resolvedRoot, '.gitignore');
  let ignore = '';
  try { ignore = await readFile(ignorePath, 'utf8'); } catch { /* create below */ }
  const ignoreEntry = `${config.state_dir.replace(/\\/g, '/').replace(/\/$/, '')}/`;
  if (!ignore.split(/\r?\n/).includes(ignoreEntry)) {
    const prefix = ignore.length > 0 && !ignore.endsWith('\n') ? '\n' : '';
    await appendFile(ignorePath, `${prefix}${ignoreEntry}\n`);
  }
  return { config_path: configPath, state_dir: localState, created_config: createdConfig };
}

export async function mapCommand(root: string): Promise<{ map_path: string; module_count: number }> {
  const resolvedRoot = resolve(root);
  const config = await loadConfig(resolvedRoot);
  const localState = stateDir(resolvedRoot, config.state_dir);
  await mkdir(localState, { recursive: true });
  const map = await generateRepoMap(resolvedRoot, new NodeFileSystemAdapter(config.exclude), new NodeGitAdapter());
  const mapPath = join(localState, 'repo-map.json');
  await writeJson(mapPath, map);
  return { map_path: mapPath, module_count: map.summary.module_count };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new PrimeContextError('VALIDATION_ERROR', `${field} must be an array of strings`);
  return [...value] as string[];
}

function parseTaskDefinition(value: unknown, expectedTaskId: string): TaskDefinitionInput {
  if (!isObject(value)) throw new PrimeContextError('VALIDATION_ERROR', 'Task definition must be an object');
  if (value.task_id !== expectedTaskId) throw new PrimeContextError('VALIDATION_ERROR', `Task definition task_id must equal ${expectedTaskId}`);
  if (typeof value.goal !== 'string' || !value.goal) throw new PrimeContextError('VALIDATION_ERROR', 'Task definition goal is required');
  if (!(taskTypes as readonly unknown[]).includes(value.task_type)) throw new PrimeContextError('VALIDATION_ERROR', 'Task definition task_type is invalid');
  if (!isObject(value.boundaries)) throw new PrimeContextError('VALIDATION_ERROR', 'Task definition boundaries are required');
  const boundaries = {
    allowed_paths: stringArray(value.boundaries.allowed_paths, 'boundaries.allowed_paths'),
    forbidden_paths: stringArray(value.boundaries.forbidden_paths, 'boundaries.forbidden_paths'),
  };
  const acceptance = stringArray(value.acceptance, 'acceptance');
  if (acceptance.length === 0) throw new PrimeContextError('VALIDATION_ERROR', 'acceptance must contain at least one criterion');

  const task: TaskDefinitionInput = {
    task_id: expectedTaskId,
    goal: value.goal,
    task_type: value.task_type as TaskType,
    boundaries,
    acceptance,
  };
  if (typeof value.module === 'string' && value.module) task.module = value.module;
  if (typeof value.priority === 'string' && value.priority) task.priority = value.priority;
  if (value.contracts !== undefined) task.contracts = stringArray(value.contracts, 'contracts');
  if (value.documents !== undefined) task.documents = stringArray(value.documents, 'documents');
  if (value.code_targets !== undefined) task.code_targets = stringArray(value.code_targets, 'code_targets');
  if (isObject(value.metadata)) task.metadata = value.metadata;
  if (value.decisions !== undefined) {
    if (!Array.isArray(value.decisions)) throw new PrimeContextError('VALIDATION_ERROR', 'decisions must be an array');
    task.decisions = value.decisions.map((decision, index) => {
      if (!isObject(decision) || typeof decision.source !== 'string' || !decision.source || typeof decision.summary !== 'string' || !decision.summary) {
        throw new PrimeContextError('VALIDATION_ERROR', `decisions[${index}] must contain source and summary`);
      }
      return { source: decision.source, summary: decision.summary };
    });
  }
  return task;
}

export async function taskCommand(root: string, taskId: string, fromFile?: string): Promise<{ capsule_path: string }> {
  const resolvedRoot = resolve(root);
  const config = await loadConfig(resolvedRoot);
  const localState = stateDir(resolvedRoot, config.state_dir);
  const sourcePath = fromFile
    ? (isAbsolute(fromFile) ? fromFile : resolve(resolvedRoot, fromFile))
    : join(localState, 'tasks', `${taskId}.json`);
  const definition = parseTaskDefinition(await readJson(sourcePath), taskId);
  const git = await new NodeGitAdapter().inspect(resolvedRoot);
  const capsule = createTaskCapsule(
    definition,
    { root: resolvedRoot, ...(git?.branch ? { branch: git.branch } : {}), ...(git?.head ? { head: git.head } : {}) },
    config.budgets[definition.task_type] as ContextBudget,
  );
  const capsuleDir = join(localState, 'capsules');
  await mkdir(capsuleDir, { recursive: true });
  const capsulePath = join(capsuleDir, `${taskId}.json`);
  await writeJson(capsulePath, capsule);
  return { capsule_path: capsulePath };
}

export async function inspectCommand(root: string, taskId: string): Promise<{ task_id: string; goal: string; task_type: string; context_budget: ContextBudget }> {
  const config = await loadConfig(root);
  const capsulePath = join(stateDir(root, config.state_dir), 'capsules', `${taskId}.json`);
  const capsule = await readJson(capsulePath);
  const validation = validateTaskCapsule(capsule);
  if (!validation.valid) throw new PrimeContextError('VALIDATION_ERROR', 'Stored Task Capsule is invalid', validation.errors);
  const typed = capsule as { task_id: string; goal: string; task_type: string; context_budget: ContextBudget };
  return { task_id: typed.task_id, goal: typed.goal, task_type: typed.task_type, context_budget: typed.context_budget };
}

export async function handoffValidateCommand(file: string): Promise<{ valid: true; task_id: string; status: string }> {
  const handoff = assertValidHandoff(await readJson(resolve(file)));
  return { valid: true, task_id: handoff.task_id, status: handoff.status };
}

const numericMetricFields: readonly MetricNumericField[] = [
  'input_tokens','cached_input_tokens','output_tokens','tool_calls','file_reads','codegraph_calls',
  'context_expansions','duration_ms','selected_context_tokens','rework_count',
];

export async function metricsCommand(root: string): Promise<{ record_count: number; totals: Partial<Record<MetricNumericField, number>>; estimated_fields: MetricNumericField[] }> {
  const config = await loadConfig(root);
  const metricsPath = join(stateDir(root, config.state_dir), 'metrics.jsonl');
  let content: string;
  try { content = await readFile(metricsPath, 'utf8'); }
  catch { return { record_count: 0, totals: {}, estimated_fields: [] }; }
  const lines = content.split(/\r?\n/).filter(Boolean);
  const totals: Partial<Record<MetricNumericField, number>> = {};
  const estimated = new Set<MetricNumericField>();
  for (const line of lines) {
    let parsed: unknown;
    try { parsed = JSON.parse(line) as unknown; } catch { throw new PrimeContextError('VALIDATION_ERROR', 'metrics.jsonl contains invalid JSON'); }
    const record = assertValidMetricRecord(parsed);
    for (const field of numericMetricFields) if (typeof record[field] === 'number') totals[field] = (totals[field] ?? 0) + record[field];
    for (const field of record.estimated_fields ?? []) estimated.add(field);
  }
  return { record_count: lines.length, totals, estimated_fields: [...estimated].sort() };
}

export async function benchmarkCommand(armAFile: string, armBFile: string): Promise<BenchmarkComparison> {
  const armA = assertValidMetricRecord(await readJson(resolve(armAFile)));
  const armB = assertValidMetricRecord(await readJson(resolve(armBFile)));
  return compareBenchmarkArms(armA, armB);
}

export function configPreview(): ReturnType<typeof defaultConfig> { return defaultConfig(); }
export function repositoryName(root: string): string { return basename(resolve(root)); }
