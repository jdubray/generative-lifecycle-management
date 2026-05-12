#!/usr/bin/env bun
/**
 * `bun run scripts/export-sekkei.ts --workspace=<slug|id> --out=./sekkei.exported`
 *
 * Round-trip companion to `scripts/import-sekkei.ts`. Walks every node in a
 * workspace and writes one YAML file per node under
 *
 *   <out>/nodes/<stratum>/<safeGlmId>.yaml
 *
 * `safeGlmId` replaces `:` with `__` (matches the importer / yaml-store).
 *
 * Flags:
 *   --workspace=<slug|id>   required
 *   --out=<dir>             defaults to ./sekkei.<workspace-slug>
 *   --db=<path>             defaults to $GLM_DB_PATH or ./data/glm.db
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { exportWorkspaceResolved } from '../src/import/export.ts';
import { openDb } from '../src/repository/db.ts';
import { NodeRepository } from '../src/repository/node-repository.ts';
import { WorkspaceRepository } from '../src/repository/workspace-repository.ts';

interface Args {
  workspace: string;
  outDir?: string;
  dbPath?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { workspace: '' };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (arg.startsWith('--workspace=')) args.workspace = arg.slice('--workspace='.length);
    else if (arg.startsWith('--out=')) args.outDir = arg.slice('--out='.length);
    else if (arg.startsWith('--db=')) args.dbPath = arg.slice('--db='.length);
  }
  if (!args.workspace) {
    console.error('--workspace=<slug|id> is required');
    process.exit(2);
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv);
  const db = openDb({ path: args.dbPath ?? process.env.GLM_DB_PATH ?? './data/glm.db' });
  const workspaces = new WorkspaceRepository(db);
  const ws =
    workspaces.findById(args.workspace) ?? workspaces.findBySlug(args.workspace);
  if (!ws) {
    console.error(`workspace ${args.workspace} not found`);
    process.exit(2);
  }

  const outDir = resolve(args.outDir ?? `./sekkei.${ws.slug}`);
  const docs = exportWorkspaceResolved(new NodeRepository(db), ws.id);
  for (const doc of docs) {
    const path = join(outDir, doc.filename);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, doc.content, 'utf8');
  }
  console.log(`exported ${docs.length} node(s) from ${ws.slug} to ${outDir}`);
}

main();
