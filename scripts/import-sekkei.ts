#!/usr/bin/env bun
/**
 * `bun run scripts/import-sekkei.ts --path=./sekkei --workspace-slug=glm-self \
 *   --workspace-name="GLM (self)" --owner=alice@example.com [--dry-run]`
 *
 * Bootstraps a workspace from an on-disk sekkei tree. Idempotent: a re-run
 * against an unchanged tree leaves the DB untouched; against an edited tree
 * it updates only nodes whose canonical body hash changed.
 *
 * Flags:
 *   --path=<dir>             root of the sekkei (default: ./sekkei)
 *   --workspace-slug=<slug>  required
 *   --workspace-name="..."   required (with quotes if spaces)
 *   --owner=<email>          optional; auto-creates the user + owner membership
 *   --db=<path>              sqlite path (default: $GLM_DB_PATH or ./data/glm.db)
 *   --dry-run                walk + parse + report; no DB writes
 */

import { openDb } from '../src/repository/db.ts';
import { runImport, type ImportSummary } from '../src/import/importer.ts';
import { AuditRepository } from '../src/repository/audit-repository.ts';
import { NodeRepository } from '../src/repository/node-repository.ts';
import { UserRepository } from '../src/repository/user-repository.ts';
import { WorkspaceRepository } from '../src/repository/workspace-repository.ts';

interface Args {
  path: string;
  workspaceSlug: string;
  workspaceName: string;
  ownerEmail?: string;
  dbPath?: string;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    path: './sekkei',
    workspaceSlug: '',
    workspaceName: '',
    dryRun: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (arg.startsWith('--path=')) args.path = arg.slice('--path='.length);
    else if (arg.startsWith('--workspace-slug=')) args.workspaceSlug = arg.slice('--workspace-slug='.length);
    else if (arg.startsWith('--workspace-name=')) args.workspaceName = arg.slice('--workspace-name='.length);
    else if (arg.startsWith('--owner=')) args.ownerEmail = arg.slice('--owner='.length);
    else if (arg.startsWith('--db=')) args.dbPath = arg.slice('--db='.length);
    else if (arg === '--dry-run') args.dryRun = true;
  }
  if (!args.workspaceSlug) {
    console.error('--workspace-slug=<slug> is required');
    process.exit(2);
  }
  if (!args.workspaceName) {
    args.workspaceName = args.workspaceSlug;
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv);
  const db = openDb({ path: args.dbPath ?? process.env.GLM_DB_PATH ?? './data/glm.db' });

  const summary: ImportSummary = runImport(
    {
      db,
      repos: {
        workspaces: new WorkspaceRepository(db),
        users: new UserRepository(db),
        nodes: new NodeRepository(db),
        audit: new AuditRepository(db),
      },
    },
    {
      source: { kind: 'directory', path: args.path },
      workspace: { slug: args.workspaceSlug, name: args.workspaceName },
      owner: args.ownerEmail ? { email: args.ownerEmail } : undefined,
      dryRun: args.dryRun,
    },
  );

  console.log(`workspace: ${summary.workspace.slug} (${summary.workspace.id})`);
  console.log(`  files scanned:          ${summary.filesScanned}`);
  console.log(`  nodes inserted:         ${summary.nodesInserted}`);
  console.log(`  nodes updated:          ${summary.nodesUpdated}`);
  console.log(`  nodes unchanged:        ${summary.nodesUnchanged}`);
  console.log(`  derives_from resolved:  ${summary.derivesFromResolved}`);
  if (summary.derivesFromMissing.length > 0) {
    console.log(`  derives_from missing:   ${summary.derivesFromMissing.length}`);
    for (const m of summary.derivesFromMissing.slice(0, 10)) {
      console.log(`    - ${m.glmId} → ${m.missingTarget}`);
    }
    if (summary.derivesFromMissing.length > 10) {
      console.log(`    … and ${summary.derivesFromMissing.length - 10} more`);
    }
  }
  if (summary.warnings.length > 0) {
    console.log(`  warnings:               ${summary.warnings.length}`);
    for (const w of summary.warnings.slice(0, 10)) console.log(`    - ${w}`);
    if (summary.warnings.length > 10) {
      console.log(`    … and ${summary.warnings.length - 10} more`);
    }
  }
  if (summary.dryRun) console.log('dry-run: no changes persisted');
  else console.log('import ok.');
}

main();
