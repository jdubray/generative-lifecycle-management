#!/usr/bin/env bun
/**
 * glm — GLM Solo CLI entrypoint.
 *
 * Phase 1: prints help / version and dispatches to subcommand stubs.
 * See ../IMPLEMENTATION_PLAN.md for the per-phase rollout.
 */
import { parseCommandLine } from '../lib/argv.ts';
import { dispatch } from '../commands/index.ts';

async function main(): Promise<number> {
  const args = parseCommandLine(process.argv.slice(2));
  const result = dispatch(args);
  return await Promise.resolve(result);
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`glm: unhandled error: ${message}\n`);
    process.exit(1);
  });
