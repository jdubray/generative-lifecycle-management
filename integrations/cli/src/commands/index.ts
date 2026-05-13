import { runHelp, runVersion } from './help.ts';
import { runStatus } from './status.ts';
import { runVibe } from './vibe.ts';
import { runInit } from './init.ts';
import { runVerify } from './verify.ts';
import type { ParsedArgs } from '../lib/argv.ts';

/**
 * Command registry + dispatcher. Each command body is a thin wrapper that may
 * be expanded into its own file as the implementation lands (see
 * IMPLEMENTATION_PLAN.md phase table).
 */

export type CommandResult = Promise<number> | number;

export type CommandFn = (args: ParsedArgs) => CommandResult;

const COMMANDS: Record<string, CommandFn> = {
  help: () => {
    runHelp();
    return 0;
  },
  version: () => {
    runVersion();
    return 0;
  },
  status: (args) => runStatus(args),
  vibe: (args) => runVibe(args),
  verify: (args) => runVerify(args),
  generate: notYetImplemented('generate', 6),
  refine: notYetImplemented('refine', 8),
  'import-sekkei': notYetImplemented('import-sekkei', 8),
  init: (args) => runInit(args),
};

function notYetImplemented(name: string, phase: number): CommandFn {
  return () => {
    process.stderr.write(
      `'glm ${name}' is not yet implemented (planned for Phase ${phase}). ` +
        `See integrations/cli/IMPLEMENTATION_PLAN.md.\n`,
    );
    return 2;
  };
}

export function dispatch(args: ParsedArgs): CommandResult {
  if (args.flags.help === true || args.flags.h === true) {
    runHelp();
    return 0;
  }
  if (args.flags.version === true || args.flags.v === true) {
    runVersion();
    return 0;
  }

  const command = args.command;
  if (command === undefined) {
    runHelp();
    return 0;
  }

  const fn = COMMANDS[command];
  if (fn === undefined) {
    process.stderr.write(`Unknown command: ${command}\n\nRun 'glm --help' to see available commands.\n`);
    return 64; // EX_USAGE
  }

  return fn(args);
}
