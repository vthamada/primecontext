#!/usr/bin/env node
import { PrimeContextError } from '@primecontext/core';
import { documentAuthorities } from '@primecontext/schemas';
import {
  benchmarkCommand,
  handoffValidateCommand,
  initCommand,
  inspectCommand,
  mapCommand,
  metricsCommand,
  recordMetricCommand,
  taskCommand,
} from './commands.js';
import {
  docsIndexCommand,
  docsSearchCommand,
  type DocsSearchOptions,
} from './documents.js';
import {
  contextAblateCommand,
  contextExpandCommand,
  contextIndexCommand,
  contextInspectCommand,
  contextOutcomeCommand,
  contextPlanCommand,
  contextReplayCommand,
} from './context.js';
import {
  capabilitiesCommand,
  contextPrepareCommand,
  doctorCommand,
} from './onboarding.js';
import {
  prepareGoalCommand,
  setupCommand,
  type PrepareGoalOptionsV03,
} from './automation.js';

function usageError(message: string): never {
  throw new PrimeContextError('VALIDATION_ERROR', message);
}

function requireNoArguments(command: string, args: string[]): void {
  if (args.length > 0) usageError(`${command} does not accept arguments`);
}

function parseRequiredFlags(args: string[], requiredFlags: readonly string[]): Record<string, string> {
  if (args.length % 2 !== 0) usageError('Every flag requires exactly one value');
  const allowed = new Set(requiredFlags);
  const values: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index] as string;
    const value = args[index + 1] as string;
    if (!allowed.has(flag)) usageError(`Unknown flag: ${flag}`);
    if (Object.hasOwn(values, flag)) usageError(`Duplicate flag: ${flag}`);
    if (!value || value.startsWith('--')) usageError(`${flag} requires a value`);
    values[flag] = value;
  }
  for (const flag of requiredFlags) if (!Object.hasOwn(values, flag)) usageError(`Missing required flag: ${flag}`);
  return values;
}

function parseDocsSearchArguments(args: string[]): { query: string; options: DocsSearchOptions } {
  const [query, ...flagArguments] = args;
  if (!query || query.startsWith('--')) usageError('docs search requires exactly one <query> before flags');
  const allowedFlags = new Set(['--limit', '--authority', '--module', '--topic']);
  const seen = new Set<string>();
  const options: DocsSearchOptions = {};

  for (let index = 0; index < flagArguments.length; index += 2) {
    const flag = flagArguments[index] as string;
    if (!flag.startsWith('--')) usageError('docs search accepts only flag/value arguments after <query>');
    if (!allowedFlags.has(flag)) usageError(`Unknown flag: ${flag}`);
    if (seen.has(flag)) usageError(`Duplicate flag: ${flag}`);
    const value = flagArguments[index + 1];
    if (!value || value.startsWith('--')) usageError(`${flag} requires a value`);
    seen.add(flag);

    switch (flag) {
      case '--limit':
        if (!/^(?:[1-9]|[1-4][0-9]|50)$/.test(value)) {
          usageError('--limit must be a canonical integer from 1 through 50');
        }
        options.limit = Number(value);
        break;
      case '--authority':
        if (!(documentAuthorities as readonly string[]).includes(value)) {
          usageError(`--authority is invalid: ${value}`);
        }
        options.authority = value as NonNullable<DocsSearchOptions['authority']>;
        break;
      case '--module': options.module = value; break;
      case '--topic': options.topic = value; break;
    }
  }
  return { query, options };
}

function parseHumanPrepareArguments(args: string[]): { goal: string; options: PrepareGoalOptionsV03 } {
  const [goal, ...flagArguments] = args;
  if (!goal || goal.trim().length === 0 || goal.startsWith('--')) {
    usageError('prepare requires one non-empty <goal> before flags');
  }
  const values: Record<'--accept' | '--path' | '--term', string[]> = {
    '--accept': [], '--path': [], '--term': [],
  };
  for (let index = 0; index < flagArguments.length; index += 2) {
    const flag = flagArguments[index] as keyof typeof values;
    const value = flagArguments[index + 1];
    if (!Object.hasOwn(values, flag)) usageError(`Unknown flag: ${String(flag)}`);
    if (!value || value.trim().length === 0 || value.startsWith('--')) usageError(`${flag} requires a value`);
    if (values[flag].includes(value)) usageError(`Duplicate ${flag} value: ${value}`);
    values[flag].push(value);
  }
  return {
    goal,
    options: {
      ...(values['--accept'].length ? { acceptance: values['--accept'] } : {}),
      ...(values['--path'].length ? { paths: values['--path'] } : {}),
      ...(values['--term'].length ? { terms: values['--term'] } : {}),
    },
  };
}

function usage(): string {
  return [
    'PrimeContext source checkout (v0.1 foundations + v0.2 retrieval + v0.3 context compiler)',
    '  primecontext init',
    '  primecontext setup',
    '  primecontext prepare <goal> [--accept <criterion>]... [--path <path>]... [--term <term>]...',
    '  primecontext capabilities',
    '  primecontext doctor',
    '  primecontext map',
    '  primecontext docs index',
    '  primecontext docs search <query> [--limit <1-50>] [--authority <authority>] [--module <module>] [--topic <topic>]',
    '  primecontext context index',
    '  primecontext context prepare --from <intent.json|->',
    '  primecontext context plan --from <request.json>',
    '  primecontext context inspect <task-id>',
    '  primecontext context expand <task-id> --from <request.json>',
    '  primecontext context outcome <task-id> --from <outcome.json>',
    '  primecontext context replay <task-id>',
    '  primecontext context ablate <task-id> --candidate <candidate-id>',
    '  primecontext task <task-id> [--from <file>]',
    '  primecontext inspect <task-id>',
    '  primecontext handoff validate <file>',
    '  primecontext benchmark --a <arm-a.json> --b <arm-b.json>',
    '  primecontext metrics',
    '  primecontext metrics record <file>',
  ].join('\n');
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  const root = process.cwd();
  let result: unknown;
  switch (command) {
    case 'setup': requireNoArguments(command, args); result = await setupCommand(root); break;
    case 'prepare': {
      const parsed = parseHumanPrepareArguments(args);
      result = await prepareGoalCommand(root, parsed.goal, parsed.options);
      break;
    }
    case 'capabilities': requireNoArguments(command, args); result = capabilitiesCommand(root); break;
    case 'doctor': requireNoArguments(command, args); result = await doctorCommand(root); break;
    case 'init': requireNoArguments(command, args); result = await initCommand(root); break;
    case 'map': requireNoArguments(command, args); result = await mapCommand(root); break;
    case 'docs': {
      const [subcommand, ...documentArgs] = args;
      if (subcommand === 'index') {
        if (documentArgs.length > 0) usageError('docs index does not accept arguments');
        result = await docsIndexCommand(root);
      } else if (subcommand === 'search') {
        const parsed = parseDocsSearchArguments(documentArgs);
        result = await docsSearchCommand(root, parsed.query, parsed.options);
      } else {
        usageError('docs requires index or search');
      }
      break;
    }
    case 'context': {
      const [subcommand, ...contextArgs] = args;
      if (subcommand === 'index') {
        requireNoArguments('context index', contextArgs);
        result = await contextIndexCommand(root);
      } else if (subcommand === 'prepare') {
        const flags = parseRequiredFlags(contextArgs, ['--from']);
        result = await contextPrepareCommand(root, flags['--from'] as string);
      } else if (subcommand === 'plan') {
        const flags = parseRequiredFlags(contextArgs, ['--from']);
        result = await contextPlanCommand(root, flags['--from'] as string);
      } else if (subcommand === 'inspect') {
        if (contextArgs.length !== 1) usageError('context inspect requires exactly one <task-id>');
        result = await contextInspectCommand(root, contextArgs[0] as string);
      } else if (subcommand === 'expand') {
        const [taskId, ...flagArgs] = contextArgs;
        if (!taskId || taskId.startsWith('--')) usageError('context expand requires <task-id>');
        const flags = parseRequiredFlags(flagArgs, ['--from']);
        result = await contextExpandCommand(root, taskId, flags['--from'] as string);
      } else if (subcommand === 'outcome') {
        const [taskId, ...flagArgs] = contextArgs;
        if (!taskId || taskId.startsWith('--')) usageError('context outcome requires <task-id>');
        const flags = parseRequiredFlags(flagArgs, ['--from']);
        result = await contextOutcomeCommand(root, taskId, flags['--from'] as string);
      } else if (subcommand === 'replay') {
        if (contextArgs.length !== 1) usageError('context replay requires exactly one <task-id>');
        result = await contextReplayCommand(root, contextArgs[0] as string);
      } else if (subcommand === 'ablate') {
        const [taskId, ...flagArgs] = contextArgs;
        if (!taskId || taskId.startsWith('--')) usageError('context ablate requires <task-id>');
        const flags = parseRequiredFlags(flagArgs, ['--candidate']);
        result = await contextAblateCommand(root, taskId, flags['--candidate'] as string);
      } else {
        usageError('context requires index, prepare, plan, inspect, expand, outcome, replay, or ablate');
      }
      break;
    }
    case 'task': {
      const [taskId, ...taskArgs] = args;
      if (!taskId) usageError('task requires <task-id>');
      let fromFile: string | undefined;
      if (taskArgs.length > 0) {
        if (taskArgs.length !== 2 || taskArgs[0] !== '--from' || !taskArgs[1] || taskArgs[1].startsWith('--')) {
          usageError('task accepts only [--from <file>] after <task-id>');
        }
        fromFile = taskArgs[1];
      }
      result = await taskCommand(root, taskId, fromFile); break;
    }
    case 'inspect': {
      if (args.length !== 1) usageError('inspect requires exactly one <task-id>');
      const taskId = args[0] as string;
      result = await inspectCommand(root, taskId); break;
    }
    case 'handoff': {
      if (args.length !== 2 || args[0] !== 'validate' || !args[1]) usageError('handoff requires validate <file>');
      result = await handoffValidateCommand(args[1], root); break;
    }
    case 'benchmark': {
      const flags = parseRequiredFlags(args, ['--a', '--b']);
      result = await benchmarkCommand(flags['--a'] as string, flags['--b'] as string, root); break;
    }
    case 'metrics': {
      if (args[0] === 'record') {
        if (args.length !== 2 || !args[1]) usageError('metrics record requires exactly one <file>');
        result = await recordMetricCommand(root, args[1]);
      } else if (args.length === 0) {
        result = await metricsCommand(root);
      } else {
        usageError('metrics accepts no arguments or record <file>');
      }
      break;
    }
    case '--help': case '-h': requireNoArguments(command, args); console.log(usage()); return;
    case undefined: console.log(usage()); return;
    default: usageError(`Unknown command: ${command}. Run primecontext --help.`);
  }
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error: unknown) => {
  const code = error instanceof PrimeContextError ? error.code : 'IO_ERROR';
  const raw = error instanceof Error ? error.message : String(error);
  const sanitized = raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
  const message = [...sanitized].slice(0, 4_096).join('');
  console.error(JSON.stringify({ error: { code, message } }));
  process.exitCode = 1;
});
