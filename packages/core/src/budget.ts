import { validateContextBudget } from '@primecontext/schemas';
import { PrimeContextError } from './errors.js';
import type { ContextBudget, TaskType } from './types.js';

export const experimentalBudgetDefaults: Readonly<Record<TaskType, ContextBudget>> = {
  small_ui: { initial_tokens: 3000, soft_limit_tokens: 6000, hard_limit_tokens: 12000 },
  small_code_fix: { initial_tokens: 4000, soft_limit_tokens: 8000, hard_limit_tokens: 16000 },
  module_feature: { initial_tokens: 6000, soft_limit_tokens: 12000, hard_limit_tokens: 24000 },
  integration: { initial_tokens: 8000, soft_limit_tokens: 16000, hard_limit_tokens: 32000 },
  qa: { initial_tokens: 6000, soft_limit_tokens: 12000, hard_limit_tokens: 24000 },
  orchestration: { initial_tokens: 10000, soft_limit_tokens: 20000, hard_limit_tokens: 40000 },
};

export function allocateContextBudget(taskType: TaskType, overrides: Partial<ContextBudget> = {}): ContextBudget {
  const budget: ContextBudget = { ...experimentalBudgetDefaults[taskType], ...overrides };
  const validation = validateContextBudget(budget);
  if (!validation.valid) throw new PrimeContextError('VALIDATION_ERROR', 'Invalid context budget', validation.errors);
  return budget;
}
