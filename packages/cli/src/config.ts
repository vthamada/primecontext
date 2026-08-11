import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { allocateContextBudget, PrimeContextError, type ContextBudget, type TaskType } from '@primecontext/core';
import { taskTypes } from '@primecontext/schemas';

export interface PrimeContextConfig {
  schema_version: '0.1';
  state_dir: string;
  exclude: string[];
  budgets: Record<TaskType, ContextBudget>;
}

export const CONFIG_FILE = 'primecontext.config.json';

export function defaultConfig(): PrimeContextConfig {
  const budgets = Object.fromEntries(
    taskTypes.map((taskType) => [taskType, allocateContextBudget(taskType)]),
  ) as Record<TaskType, ContextBudget>;
  return { schema_version: '0.1', state_dir: '.primecontext', exclude: [], budgets };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseConfig(value: unknown): PrimeContextConfig {
  if (!isObject(value)) throw new PrimeContextError('CONFIG_ERROR', 'Configuration must be an object');
  if (value.schema_version !== '0.1') throw new PrimeContextError('CONFIG_ERROR', 'Unsupported configuration schema_version');
  if (typeof value.state_dir !== 'string' || !value.state_dir) throw new PrimeContextError('CONFIG_ERROR', 'state_dir must be a non-empty string');
  if (!Array.isArray(value.exclude) || value.exclude.some((item) => typeof item !== 'string')) throw new PrimeContextError('CONFIG_ERROR', 'exclude must be an array of strings');
  if (!isObject(value.budgets)) throw new PrimeContextError('CONFIG_ERROR', 'budgets must be an object');

  const budgets = {} as Record<TaskType, ContextBudget>;
  for (const taskType of taskTypes) {
    const raw = value.budgets[taskType];
    if (!isObject(raw)) throw new PrimeContextError('CONFIG_ERROR', `Missing budget for ${taskType}`);
    try {
      budgets[taskType] = allocateContextBudget(taskType, raw as unknown as Partial<ContextBudget>);
    } catch (error) {
      throw new PrimeContextError('CONFIG_ERROR', `Invalid budget for ${taskType}`, [error instanceof Error ? error.message : String(error)]);
    }
  }
  return { schema_version: '0.1', state_dir: value.state_dir, exclude: [...value.exclude] as string[], budgets };
}

export async function loadConfig(root: string): Promise<PrimeContextConfig> {
  const path = join(resolve(root), CONFIG_FILE);
  let content: string;
  try { content = await readFile(path, 'utf8'); }
  catch { throw new PrimeContextError('CONFIG_ERROR', `Missing ${CONFIG_FILE}; run primecontext init`); }
  try { return parseConfig(JSON.parse(content) as unknown); }
  catch (error) {
    if (error instanceof PrimeContextError) throw error;
    throw new PrimeContextError('CONFIG_ERROR', `Invalid JSON in ${CONFIG_FILE}`);
  }
}

export async function writeDefaultConfig(path: string): Promise<void> {
  await writeFile(path, `${JSON.stringify(defaultConfig(), null, 2)}\n`, { flag: 'wx' });
}
