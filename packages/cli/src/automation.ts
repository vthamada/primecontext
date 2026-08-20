import { resolve } from 'node:path';
import {
  hashContextJson,
  PrimeContextError,
  type PrimeContextErrorCode,
} from '@primecontext/core';
import {
  validateContextIntent,
  type ContextIntentV03,
} from '@primecontext/schemas';
import { initCommand } from './commands.js';
import {
  compilePreparedContext,
  contextIndexCommand,
  createContextPreparationObservation,
  prepareContextRequest,
  type PreparedContextResultV03,
} from './context.js';
import {
  capabilitiesCommand,
  doctorCommand,
  type PrimeContextCapabilitiesV03,
  type PrimeContextDoctorV03,
} from './onboarding.js';
import { CONFIG_FILE, defaultConfig, loadConfig } from './config.js';
import {
  MAX_JSON_INPUT_BYTES,
  readInternalText,
  stateDirectoryIgnoreEntry,
} from './safe-io.js';

export interface PrimeContextSetupResultV03 {
  schema_version: '0.3';
  status: 'READY' | 'BLOCKED';
  config_path: string;
  state_dir: string;
  created_config: boolean;
  gitignore_updated: boolean;
  diagnostics: PrimeContextDoctorV03;
  capabilities: PrimeContextCapabilitiesV03;
}

export interface PrepareGoalOptionsV03 {
  acceptance?: string[];
  paths?: string[];
  terms?: string[];
  task_type?: ContextIntentV03['task_type'];
}

export interface AutomatedPrepareResultV03 extends PreparedContextResultV03 {
  automation: {
    setup: PrimeContextSetupResultV03;
    index: {
      attempted: true;
      status: 'READY' | 'UNAVAILABLE';
      fallback_used: boolean;
      reused: boolean;
      error_code?: PrimeContextErrorCode;
    };
    collection: { observations: 1 };
  };
}

export const MAX_COMPACT_PREPARE_OUTPUT_BYTES = 1024 * 1024;

export interface CompactAutomatedPrepareResultV03 {
  schema_version: '0.3';
  task_id: string;
  selection_digest: string;
  accepted_source_digest: string;
  envelope: PreparedContextResultV03['envelope'];
  warnings: string[];
  missing_evidence: {
    required_sources: string[];
    required_terms: string[];
    criteria_ids: string[];
  };
  receipt_summary: {
    receipt_digest: string;
    decision_counts: { included: number; omitted: number };
    conflict_count: number;
    source_failure_count: number;
  };
  receipt_ref: { path: string; json_pointer: '/receipt' };
  next_commands: string[];
  output_ceiling_bytes: number;
  automation: AutomatedPrepareResultV03['automation'];
}

export type CompactPreparedContextResultV03 = Omit<
  CompactAutomatedPrepareResultV03,
  'automation'
>;

function ordinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function exactUnique(values: readonly string[] | undefined, field: string): string[] | undefined {
  if (values === undefined) return undefined;
  if (!Array.isArray(values) || values.some((value) => typeof value !== 'string' || value.trim().length === 0)) {
    throw new PrimeContextError('VALIDATION_ERROR', `${field} must contain non-empty strings`);
  }
  if (new Set(values).size !== values.length) {
    throw new PrimeContextError('VALIDATION_ERROR', `${field} must not contain duplicates`);
  }
  return [...values];
}

function sortedUnique(values: readonly string[] | undefined, field: string): string[] | undefined {
  return exactUnique(values, field)?.sort(ordinal);
}

function generatedTaskId(input: Omit<ContextIntentV03, 'task_id'>): string {
  const digest = hashContextJson(input).slice('sha256:'.length, 'sha256:'.length + 16).toUpperCase();
  return `AUTO-${digest}`;
}

function assertValidIntent(intent: ContextIntentV03): void {
  const validation = validateContextIntent(intent);
  if (!validation.valid) {
    throw new PrimeContextError('VALIDATION_ERROR', 'Generated ContextIntent is invalid', validation.errors);
  }
}

export async function setupCommand(root: string): Promise<PrimeContextSetupResultV03> {
  const resolvedRoot = resolve(root);
  const existingConfig = await readInternalText(
    resolvedRoot,
    CONFIG_FILE,
    MAX_JSON_INPUT_BYTES,
    { allowMissing: true },
  );
  const configBefore = existingConfig === undefined ? defaultConfig() : await loadConfig(resolvedRoot);
  const ignoreBefore = await readInternalText(
    resolvedRoot,
    '.gitignore',
    MAX_JSON_INPUT_BYTES,
    { allowMissing: true },
  ) ?? '';
  const ignoreEntry = stateDirectoryIgnoreEntry(configBefore.state_dir);
  const wasIgnored = ignoreBefore.split(/\r?\n/).includes(ignoreEntry);

  const initialized = await initCommand(resolvedRoot);
  const diagnostics = await doctorCommand(resolvedRoot);
  const capabilities = capabilitiesCommand(resolvedRoot);
  return {
    schema_version: '0.3',
    status: diagnostics.status === 'READY' ? 'READY' : 'BLOCKED',
    config_path: initialized.config_path,
    state_dir: initialized.state_dir,
    created_config: initialized.created_config,
    gitignore_updated: !wasIgnored,
    diagnostics,
    capabilities,
  };
}

function intentFromGoal(goal: string, options: PrepareGoalOptionsV03): ContextIntentV03 {
  if (typeof goal !== 'string' || goal.trim().length === 0) {
    throw new PrimeContextError('VALIDATION_ERROR', 'prepare requires a non-empty goal');
  }
  const acceptance = exactUnique(options.acceptance, 'acceptance') ?? [goal];
  const paths = sortedUnique(options.paths, 'paths');
  const terms = sortedUnique(options.terms, 'terms');
  const withoutId: Omit<ContextIntentV03, 'task_id'> = {
    schema_version: '0.3',
    task_type: options.task_type ?? 'small_code_fix',
    goal,
    acceptance,
    query: goal,
    ...(paths ? { paths } : {}),
    ...(terms ? { terms } : {}),
  };
  assertValidIntent({ ...withoutId, task_id: 'AUTO-0000000000000000' });
  const intent: ContextIntentV03 = { ...withoutId, task_id: generatedTaskId(withoutId) };
  assertValidIntent(intent);
  return intent;
}

export function optionalIndexErrorForAutomation(error: unknown): PrimeContextErrorCode | undefined {
  if (!(error instanceof PrimeContextError)) return undefined;
  if (error.code === 'CAPABILITY_ERROR' || error.code === 'CATALOG_ERROR') return error.code;
  if (error.code === 'STATE_ERROR'
      && error.message === 'STATE_ERROR: Context state already has an active writer') return error.code;
  return undefined;
}

export async function prepareGoalCommand(
  root: string,
  goal: string,
  options: PrepareGoalOptionsV03 = {},
): Promise<AutomatedPrepareResultV03> {
  const resolvedRoot = resolve(root);
  const intent = intentFromGoal(goal, options);
  const setup = await setupCommand(resolvedRoot);
  if (setup.status !== 'READY') {
    throw new PrimeContextError('CONFIG_ERROR', 'PrimeContext setup did not reach READY status');
  }

  const observation = await createContextPreparationObservation(resolvedRoot);

  let index: AutomatedPrepareResultV03['automation']['index'];
  try {
    const result = await contextIndexCommand(resolvedRoot, observation);
    if (result.fallback_used) {
      const reported = result.source_failures.find((failure) => failure.provider === 'fts')?.message;
      if (!reported || !['CAPABILITY_ERROR', 'CATALOG_ERROR', 'STATE_ERROR'].includes(reported)) {
        throw new PrimeContextError('STATE_ERROR', 'Optional index fallback did not report an allowed failure code');
      }
      const errorCode = reported as PrimeContextErrorCode;
      index = {
        attempted: true, status: 'UNAVAILABLE', fallback_used: true,
        reused: result.reused, error_code: errorCode,
      };
    } else {
      index = { attempted: true, status: 'READY', fallback_used: false, reused: result.reused };
    }
  } catch (error) {
    const errorCode = optionalIndexErrorForAutomation(error);
    if (!errorCode) throw error;
    index = { attempted: true, status: 'UNAVAILABLE', fallback_used: true, reused: false, error_code: errorCode };
  }

  const request = await prepareContextRequest(resolvedRoot, intent, observation);
  const prepared = await compilePreparedContext(resolvedRoot, request, observation);
  return { ...prepared, automation: { setup, index, collection: { observations: 1 } } };
}

export function compactContextPrepareResult(
  prepared: PreparedContextResultV03,
): CompactPreparedContextResultV03 {
  const included = prepared.receipt.decisions.filter((decision) => decision.status === 'INCLUDED').length;
  const omitted = prepared.receipt.decisions.length - included;
  const warnings = [
    ...(prepared.envelope.truncation.source_truncated ? ['SOURCE_COLLECTION_TRUNCATED'] : []),
    ...prepared.envelope.source_failures.map((failure) => `${failure.provider}:${failure.code}`),
    ...(prepared.envelope.conflicts.length > 0 ? ['AUTHORITY_REVIEW_REQUIRED'] : []),
  ].slice(0, 32);
  const result: CompactPreparedContextResultV03 = {
    schema_version: '0.3',
    task_id: prepared.envelope.task_id,
    selection_digest: prepared.envelope.selection_digest,
    accepted_source_digest: prepared.envelope.snapshot.worktree_digest,
    envelope: structuredClone(prepared.envelope),
    warnings,
    missing_evidence: {
      required_sources: [...prepared.envelope.missing_required_sources],
      required_terms: [...prepared.envelope.missing_required_terms],
      criteria_ids: prepared.envelope.criteria_coverage
        .filter((criterion) => criterion.status !== 'COVERED')
        .map((criterion) => criterion.criterion_id),
    },
    receipt_summary: {
      receipt_digest: prepared.receipt.receipt_digest,
      decision_counts: { included, omitted },
      conflict_count: prepared.receipt.conflicts.length,
      source_failure_count: prepared.receipt.source_failures.length,
    },
    receipt_ref: { path: prepared.plan_path, json_pointer: '/receipt' },
    next_commands: [
      `primecontext context inspect ${prepared.envelope.task_id}`,
      `primecontext context expand ${prepared.envelope.task_id} --from <request.json>`,
    ],
    output_ceiling_bytes: MAX_COMPACT_PREPARE_OUTPUT_BYTES,
  };
  if (Buffer.byteLength(`${JSON.stringify(result, null, 2)}\n`, 'utf8') > MAX_COMPACT_PREPARE_OUTPUT_BYTES) {
    throw new PrimeContextError('CAPABILITY_ERROR', 'Compact prepare output exceeds its explicit 1 MiB ceiling');
  }
  return result;
}

export function compactPrepareResult(
  prepared: AutomatedPrepareResultV03,
): CompactAutomatedPrepareResultV03 {
  const result: CompactAutomatedPrepareResultV03 = {
    ...compactContextPrepareResult(prepared),
    automation: structuredClone(prepared.automation),
  };
  if (Buffer.byteLength(`${JSON.stringify(result, null, 2)}\n`, 'utf8') > MAX_COMPACT_PREPARE_OUTPUT_BYTES) {
    throw new PrimeContextError('CAPABILITY_ERROR', 'Compact prepare output exceeds its explicit 1 MiB ceiling');
  }
  return result;
}
