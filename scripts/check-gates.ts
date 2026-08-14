#!/usr/bin/env bun
/**
 * `bun run scripts/check-gates.ts --workspace=<id> [--issues] [--db=<path>]`
 *
 * Read-only gate runner: loads a workspace and calls `runGates()` directly,
 * printing per-gate pass/fail without writing a `verification_runs` row.
 *
 * Companion to `scripts/verify.ts`, which persists its run (and currently
 * throws — it builds a `RunnerDeps` without a `workspaces` repository).
 */
import { Database } from 'bun:sqlite';
import { NodeRepository } from '../src/repository/node-repository.ts';
import { runGates } from '../src/verifier/gates.ts';

interface Args {
  workspace: string;
  dbPath: string;
  showIssues: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    workspace: '',
    dbPath: process.env.GLM_DB_PATH ?? './data/glm.db',
    showIssues: false,
  };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--workspace=')) args.workspace = arg.slice('--workspace='.length);
    else if (arg.startsWith('--db=')) args.dbPath = arg.slice('--db='.length);
    else if (arg === '--issues') args.showIssues = true;
  }
  if (!args.workspace) {
    console.error('--workspace=<id> is required');
    process.exit(2);
  }
  return args;
}

function main(): void {
  const args = parseArgs(process.argv);
  const db = new Database(args.dbPath, { readonly: true });
  const nodes = new NodeRepository(db).listByWorkspace(args.workspace);
  const { gates, overallPass } = runGates({ nodes, sourceDir: null });

  const passed = gates.filter((g) => g.passed).length;
  console.log(
    `${overallPass ? 'PASS' : 'FAIL'} (${passed}/${gates.length} gates) over ${nodes.length} nodes\n`,
  );
  for (const g of gates) {
    const count = g.issues.length > 0 ? `  (${g.issues.length} issues)` : '';
    console.log(`[${g.passed ? 'PASS' : 'FAIL'}] ${g.name}${count}`);
    if (args.showIssues) {
      for (const issue of g.issues) console.log(`         ${issue}`);
    }
  }
  process.exit(overallPass ? 0 : 1);
}

main();
