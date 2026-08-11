import { validateTaskCapsule } from '@primecontext/schemas';
import { allocateContextBudget } from './budget.js';
import { PrimeContextError } from './errors.js';
import type { ContextBudget, TaskCapsule, TaskDefinitionInput, WorktreeMetadata } from './types.js';

export function createTaskCapsule(
  input: TaskDefinitionInput,
  worktree?: WorktreeMetadata,
  budgetOverrides?: Partial<ContextBudget>,
): TaskCapsule {
  const capsule: TaskCapsule = {
    schema_version: '0.1',
    task_id: input.task_id,
    goal: input.goal,
    task_type: input.task_type,
    boundaries: input.boundaries,
    acceptance: input.acceptance,
    context_budget: allocateContextBudget(input.task_type, budgetOverrides),
    ...(input.module ? { module: input.module } : {}),
    ...(input.priority ? { priority: input.priority } : {}),
    ...(input.decisions ? { decisions: input.decisions } : {}),
    ...(input.contracts ? { contracts: input.contracts } : {}),
    ...(input.documents ? { documents: input.documents } : {}),
    ...(input.code_targets ? { code_targets: input.code_targets } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
    ...(worktree ? { worktree } : {}),
  };
  const validation = validateTaskCapsule(capsule);
  if (!validation.valid) throw new PrimeContextError('VALIDATION_ERROR', 'Invalid Task Capsule', validation.errors);
  return capsule;
}
