#!/usr/bin/env node
import {
  benchmarkCommand,
  handoffValidateCommand,
  initCommand,
  inspectCommand,
  mapCommand,
  metricsCommand,
  taskCommand,
} from './commands.js';

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function usage(): string {
  return [
    'PrimeContext v0.1',
    '  primecontext init',
    '  primecontext map',
    '  primecontext task <task-id> [--from <file>]',
    '  primecontext inspect <task-id>',
    '  primecontext handoff validate <file>',
    '  primecontext benchmark --a <arm-a.json> --b <arm-b.json>',
    '  primecontext metrics',
  ].join('\n');
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  const root = process.cwd();
  let result: unknown;
  switch (command) {
    case 'init': result = await initCommand(root); break;
    case 'map': result = await mapCommand(root); break;
    case 'task': {
      const taskId = args[0]; if (!taskId) throw new Error('task requires <task-id>');
      result = await taskCommand(root, taskId, flagValue(args, '--from')); break;
    }
    case 'inspect': {
      const taskId = args[0]; if (!taskId) throw new Error('inspect requires <task-id>');
      result = await inspectCommand(root, taskId); break;
    }
    case 'handoff': {
      if (args[0] !== 'validate' || !args[1]) throw new Error('handoff requires validate <file>');
      result = await handoffValidateCommand(args[1]); break;
    }
    case 'benchmark': {
      const a = flagValue(args, '--a'); const b = flagValue(args, '--b');
      if (!a || !b) throw new Error('benchmark requires --a <file> --b <file>');
      result = await benchmarkCommand(a, b); break;
    }
    case 'metrics': result = await metricsCommand(root); break;
    case '--help': case '-h': case undefined: console.log(usage()); return;
    default: throw new Error(`Unknown command: ${command}\n${usage()}`);
  }
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  if (process.env.PRIMECONTEXT_DEBUG === '1' && error instanceof Error) console.error(error.stack);
  process.exitCode = 1;
});
