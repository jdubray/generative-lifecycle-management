#!/usr/bin/env bun
/**
 * `bun run scripts/verify.ts --workspace=<id|slug>`
 *
 * CLI entry point used by `package.json#scripts.verify` and by the
 * pre-receive hook (`hook-installer.ts`). Exits non-zero when any gate
 * fails so the hook can reject the push.
 *
 * Required env:
 *   GLM_DB_PATH   — path to the SQLite index for this organization
 */

import { EventBus } from '../src/ws/event-bus.ts';
import { AuditRepository } from '../src/repository/audit-repository.ts';
import { NodeRepository } from '../src/repository/node-repository.ts';
import { VerificationRunRepository } from '../src/repository/verification-run-repository.ts';
import { WorkspaceRepository } from '../src/repository/workspace-repository.ts';
import { openDb } from '../src/repository/db.ts';
import { runWorkspaceVerifier } from '../src/verifier/runner.ts';

interface CliArgs {
  workspace: string;
  dbPath?: string;
}

function parseArgs(argv: string[]): CliArgs {
  let workspace = '';
  let dbPath: string | undefined;
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (arg.startsWith('--workspace=')) workspace = arg.slice('--workspace='.length);
    else if (arg === '--workspace') workspace = argv[++i] ?? '';
    else if (arg.startsWith('--db=')) dbPath = arg.slice('--db='.length);
    else if (arg === '--db') dbPath = argv[++i] ?? undefined;
  }
  if (!workspace) {
    console.error('usage: bun run scripts/verify.ts --workspace=<id|slug> [--db=<path>]');
    process.exit(2);
  }
  return { workspace, dbPath };
}

async function main() {
  const args = parseArgs(process.argv);
  const db = openDb({ path: args.dbPath ?? process.env.GLM_DB_PATH });
  const workspaces = new WorkspaceRepository(db);
  const workspace =
    workspaces.findById(args.workspace) ?? workspaces.findBySlug(args.workspace);
  if (!workspace) {
    console.error(`workspace ${args.workspace} not found`);
    process.exit(2);
  }

  const run = await runWorkspaceVerifier(
    {
      repos: {
        nodes: new NodeRepository(db),
        verificationRuns: new VerificationRunRepository(db),
        audit: new AuditRepository(db),
      },
      events: new EventBus(),
    },
    { workspaceId: workspace.id, userId: 'cli' },
  );

  const gates = (run.gateResults as { gates: Array<{ name: string; passed: boolean; issues: string[] }> }).gates;
  console.log(`Verification run ${run.id}`);
  console.log(`  workspace: ${workspace.slug} (${workspace.id})`);
  console.log(`  ts:        ${run.ts}`);
  for (const g of gates) {
    const tag = g.passed ? 'PASS' : 'FAIL';
    console.log(`  ${tag}  ${g.name}${g.passed ? '' : ` (${g.issues.length} issue(s))`}`);
    if (!g.passed) {
      for (const issue of g.issues.slice(0, 5)) console.log(`        - ${issue}`);
      if (g.issues.length > 5) console.log(`        … and ${g.issues.length - 5} more`);
    }
  }
  console.log(`Overall: ${run.overallPass ? 'PASS' : 'FAIL'}`);
  process.exit(run.overallPass ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
