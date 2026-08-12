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

function usage(): string {
  return [
    'PrimeContext source checkout (v0.1 foundations + v0.2 document retrieval)',
    '  primecontext init',
    '  primecontext map',
    '  primecontext docs index',
    '  primecontext docs search <query> [--limit <1-50>] [--authority <authority>] [--module <module>] [--topic <topic>]',
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
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  if (process.env.PRIMECONTEXT_DEBUG === '1' && error instanceof Error) console.error(error.stack);
  process.exitCode = 1;
});
