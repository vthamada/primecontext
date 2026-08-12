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
}

export interface AutomatedPrepareResultV03 extends PreparedContextResultV03 {
  automation: {
    setup: PrimeContextSetupResultV03;
    index: {
      attempted: true;
      status: 'READY' | 'UNAVAILABLE';
      fallback_used: boolean;
      error_code?: PrimeContextErrorCode;
    };
  };
}

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
    task_type: 'small_code_fix',
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

  let index: AutomatedPrepareResultV03['automation']['index'];
  try {
    const result = await contextIndexCommand(resolvedRoot);
    if (result.fallback_used) {
      const reported = result.source_failures.find((failure) => failure.provider === 'fts')?.message;
      if (!reported || !['CAPABILITY_ERROR', 'CATALOG_ERROR', 'STATE_ERROR'].includes(reported)) {
        throw new PrimeContextError('STATE_ERROR', 'Optional index fallback did not report an allowed failure code');
      }
      const errorCode = reported as PrimeContextErrorCode;
      index = { attempted: true, status: 'UNAVAILABLE', fallback_used: true, error_code: errorCode };
    } else {
      index = { attempted: true, status: 'READY', fallback_used: false };
    }
  } catch (error) {
    const errorCode = optionalIndexErrorForAutomation(error);
    if (!errorCode) throw error;
    index = { attempted: true, status: 'UNAVAILABLE', fallback_used: true, error_code: errorCode };
  }

  const request = await prepareContextRequest(resolvedRoot, intent);
  const prepared = await compilePreparedContext(resolvedRoot, request);
  return { ...prepared, automation: { setup, index } };
}
