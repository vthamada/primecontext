import { lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PrimeContextError } from '@primecontext/core';
import {
  validateContextIntent,
  type ContextIntentV03,
} from '@primecontext/schemas';
import { CONFIG_FILE, loadConfig } from './config.js';
import {
  compilePreparedContext,
  createContextPreparationObservation,
  prepareContextRequest,
  type PreparedContextResultV03,
} from './context.js';
import { isStateDirectoryIgnored, readCommandJsonInput } from './safe-io.js';

export interface PrimeContextCapabilitiesV03 {
  schema_version: '0.3';
  protocol: 'process-json';
  capabilities: {
    zero_config_setup: true;
    human_prepare: true;
    context_prepare: true;
    context_plan: true;
    context_expand: true;
    context_outcome: true;
    context_replay: true;
    context_ablate: true;
  };
  commands: {
    setup: 'primecontext setup';
    human_prepare: 'primecontext prepare <goal> [--type <task-type>] [--accept <criterion>]... [--path <path>]... [--term <term>]... [--full]';
    doctor: 'primecontext doctor';
    prepare: 'primecontext context prepare --from <intent.json|-> [--compact]';
    inspect: 'primecontext context inspect <task-id>';
  };
  contracts: {
    context_intent: 'v0.3/context-intent.schema.json';
    context_plan_request: 'v0.3/context-plan-request.schema.json';
    context_envelope: 'v0.3/context-envelope.schema.json';
    selection_receipt: 'v0.3/selection-receipt.schema.json';
  };
  input_modes: ['argv', 'repository_file', 'stdin'];
  contract_versions: ['0.1', '0.2', '0.3'];
  optional_accelerators: ['sqlite_fts', 'typescript_codegraph'];
  network_required: false;
  interactive: false;
}

export interface PrimeContextDoctorV03 {
  schema_version: '0.3';
  status: 'READY' | 'DEGRADED' | 'BLOCKED';
  runtime: { node_version: string; supported: boolean; minimum: '22.13.0' };
  repository: { initialized: boolean; config_valid: boolean; state_dir_ignored: boolean };
  capabilities: PrimeContextCapabilitiesV03['capabilities'];
  next_actions: string[];
}

function supportedNodeVersion(): boolean {
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  return major > 22 || (major === 22 && minor >= 13);
}

export function capabilitiesCommand(_root = process.cwd()): PrimeContextCapabilitiesV03 {
  return {
    schema_version: '0.3',
    protocol: 'process-json',
    capabilities: {
      zero_config_setup: true,
      human_prepare: true,
      context_prepare: true,
      context_plan: true,
      context_expand: true,
      context_outcome: true,
      context_replay: true,
      context_ablate: true,
    },
    commands: {
      setup: 'primecontext setup',
      human_prepare: 'primecontext prepare <goal> [--type <task-type>] [--accept <criterion>]... [--path <path>]... [--term <term>]... [--full]',
      doctor: 'primecontext doctor',
      prepare: 'primecontext context prepare --from <intent.json|-> [--compact]',
      inspect: 'primecontext context inspect <task-id>',
    },
    contracts: {
      context_intent: 'v0.3/context-intent.schema.json',
      context_plan_request: 'v0.3/context-plan-request.schema.json',
      context_envelope: 'v0.3/context-envelope.schema.json',
      selection_receipt: 'v0.3/selection-receipt.schema.json',
    },
    input_modes: ['argv', 'repository_file', 'stdin'],
    contract_versions: ['0.1', '0.2', '0.3'],
    optional_accelerators: ['sqlite_fts', 'typescript_codegraph'],
    network_required: false,
    interactive: false,
  };
}

export async function doctorCommand(root: string): Promise<PrimeContextDoctorV03> {
  const resolvedRoot = resolve(root);
  let initialized = false;
  let configValid = false;
  let stateDirectoryIgnored = false;
  let config: Awaited<ReturnType<typeof loadConfig>> | undefined;
  try {
    const stat = await lstat(resolve(resolvedRoot, CONFIG_FILE));
    initialized = stat.isFile() && !stat.isSymbolicLink();
    if (initialized) {
      config = await loadConfig(resolvedRoot);
      configValid = true;
    }
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
    if (code !== 'ENOENT' && initialized) configValid = false;
  }
  if (configValid && config !== undefined) {
    try {
      stateDirectoryIgnored = await isStateDirectoryIgnored(resolvedRoot, config.state_dir);
    } catch {
      stateDirectoryIgnored = false;
    }
  }
  const runtimeSupported = supportedNodeVersion();
  const nextActions: string[] = [];
  if (!runtimeSupported) nextActions.push('Install Node.js 22.13 or newer');
  if (!initialized) nextActions.push('Run primecontext setup');
  else if (!configValid) nextActions.push('Repair primecontext.config.json');
  else if (!stateDirectoryIgnored) nextActions.push('Run primecontext setup to protect the local state directory');
  if (nextActions.length === 0) nextActions.push('Run primecontext prepare "<goal>"');
  return {
    schema_version: '0.3',
    status: runtimeSupported && initialized && configValid && stateDirectoryIgnored ? 'READY' : 'BLOCKED',
    runtime: { node_version: process.versions.node, supported: runtimeSupported, minimum: '22.13.0' },
    repository: { initialized, config_valid: configValid, state_dir_ignored: stateDirectoryIgnored },
    capabilities: capabilitiesCommand(resolvedRoot).capabilities,
    next_actions: nextActions,
  };
}

export async function contextPrepareCommand(root: string, from: string): Promise<PreparedContextResultV03> {
  if (from !== '-' && !/\.json$/i.test(from)) {
    throw new PrimeContextError('VALIDATION_ERROR', 'ContextIntent file must use the .json extension');
  }
  const value = await readCommandJsonInput(resolve(root), from);
  const validation = validateContextIntent(value);
  if (!validation.valid) {
    throw new PrimeContextError('VALIDATION_ERROR', 'Invalid ContextIntent', validation.errors);
  }
  const resolvedRoot = resolve(root);
  const observation = await createContextPreparationObservation(resolvedRoot);
  const request = await prepareContextRequest(
    resolvedRoot,
    structuredClone(value) as ContextIntentV03,
    observation,
  );
  return compilePreparedContext(resolvedRoot, request, observation);
}
