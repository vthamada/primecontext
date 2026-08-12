import { taskTypes, validateContextBudget } from '@primecontext/schemas';
import { PrimeContextError } from './errors.js';
import type { ContextBudget, TaskType } from './types.js';

function frozenBudget(initial_tokens: number, soft_limit_tokens: number): Readonly<ContextBudget> {
  return Object.freeze({ initial_tokens, soft_limit_tokens, hard_limit_tokens: 2 * soft_limit_tokens });
}

export const experimentalBudgetDefaults: Readonly<Record<TaskType, Readonly<ContextBudget>>> = Object.freeze({
  small_ui: frozenBudget(3000, 6000),
  small_code_fix: frozenBudget(4000, 8000),
  module_feature: frozenBudget(6000, 12000),
  integration: frozenBudget(8000, 16000),
  qa: frozenBudget(6000, 12000),
  orchestration: frozenBudget(10000, 20000),
});

export function allocateContextBudget(taskType: TaskType, overrides: Partial<ContextBudget> = {}): ContextBudget {
  if (!(taskTypes as readonly unknown[]).includes(taskType)) {
    throw new PrimeContextError('VALIDATION_ERROR', 'Invalid task type for context budget');
  }
  if (typeof overrides !== 'object' || overrides === null || Array.isArray(overrides)) {
    throw new PrimeContextError('VALIDATION_ERROR', 'Context budget overrides must be an object');
  }

  const defaults = experimentalBudgetDefaults[taskType];
  const effectiveSoftLimit = overrides.soft_limit_tokens ?? defaults.soft_limit_tokens;
  const budget: ContextBudget = {
    ...defaults,
    ...overrides,
    hard_limit_tokens: overrides.hard_limit_tokens ?? 2 * effectiveSoftLimit,
  };
  const validation = validateContextBudget(budget);
  if (!validation.valid) throw new PrimeContextError('VALIDATION_ERROR', 'Invalid context budget', validation.errors);
  return budget;
}
