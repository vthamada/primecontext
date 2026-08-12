import { isAbsolute, resolve } from 'node:path';
import { isSensitivePath } from '@primecontext/adapters';
import { allocateContextBudget, PrimeContextError, type ContextBudget, type TaskType } from '@primecontext/core';
import { taskTypes, validatePrimeContextConfig } from '@primecontext/schemas';
import { MAX_JSON_INPUT_BYTES, parseBoundedJson, readInternalText } from './safe-io.js';

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

function assertSafeStateDirectory(value: string): void {
  const normalized = value.replaceAll('\\', '/').replace(/\/$/, '');
  const segments = normalized.split('/');
  const hasUnsafePortableSegment = segments.some((segment) => (
    !segment
    || segment === '.'
    || segment === '..'
    || /[<>:"|?*]/.test(segment)
    || /[. ]$/.test(segment)
    || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])[ .]*(?:\.|$)/i.test(segment)
  ));
  if (
    isAbsolute(value)
    || normalized === '.'
    || normalized.length === 0
    || /[\u0000-\u001f\u007f-\u009f]/.test(normalized)
    || hasUnsafePortableSegment
    || (normalized !== '.primecontext' && isSensitivePath(normalized))
  ) {
    throw new PrimeContextError('CONFIG_ERROR', 'state_dir must be a safe repository-relative directory');
  }
}

export function parseConfig(value: unknown): PrimeContextConfig {
  const validation = validatePrimeContextConfig(value);
  if (!validation.valid) throw new PrimeContextError('CONFIG_ERROR', 'Invalid PrimeContext configuration', validation.errors);
  const typed = value as {
    schema_version: '0.1'; state_dir: string; exclude: string[];
    budgets: Record<TaskType, ContextBudget>;
  };
  assertSafeStateDirectory(typed.state_dir);

  const budgets = {} as Record<TaskType, ContextBudget>;
  for (const taskType of taskTypes) {
    try {
      budgets[taskType] = allocateContextBudget(taskType, typed.budgets[taskType]);
    } catch (error) {
      throw new PrimeContextError('CONFIG_ERROR', `Invalid budget for ${taskType}`, [error instanceof Error ? error.message : String(error)]);
    }
  }
  return { schema_version: '0.1', state_dir: typed.state_dir, exclude: [...typed.exclude], budgets };
}

export async function loadConfig(root: string): Promise<PrimeContextConfig> {
  const content = await readInternalText(resolve(root), CONFIG_FILE, MAX_JSON_INPUT_BYTES, { allowMissing: true });
  if (content === undefined) throw new PrimeContextError('CONFIG_ERROR', `Missing ${CONFIG_FILE}; run primecontext init`);
  try { return parseConfig(parseBoundedJson(content, 'CONFIG_ERROR', CONFIG_FILE)); }
  catch (error) {
    if (error instanceof PrimeContextError) throw error;
    throw new PrimeContextError('CONFIG_ERROR', `Invalid JSON in ${CONFIG_FILE}`);
  }
}
