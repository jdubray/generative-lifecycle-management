#!/usr/bin/env bun
/**
 * `bun run seed`
 *
 * First-boot helper that creates a demo workspace (slug `demo`) if one does
 * not already exist, and enrolls every user currently in the DB as an owner.
 * Idempotent — safe to re-run.
 *
 * Flags:
 *   --slug=<slug>     workspace slug (default: demo)
 *   --name="<name>"   display name (default: "Demo Workspace")
 *   --db=<path>       sqlite path (default: $GLM_DB_PATH or ./data/glm.db)
 *   --user=<email>    enroll only this user (default: all existing users)
 */

import { randomUUID } from 'node:crypto';
import { openDb } from '../src/repository/db.ts';
import { WorkspaceRepository } from '../src/repository/workspace-repository.ts';

interface Args {
  slug: string;
  name: string;
  dbPath?: string;
  userEmail?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { slug: 'demo', name: 'Demo Workspace' };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (arg.startsWith('--slug=')) args.slug = arg.slice('--slug='.length);
    else if (arg.startsWith('--name=')) args.name = arg.slice('--name='.length);
    else if (arg.startsWith('--db=')) args.dbPath = arg.slice('--db='.length);
    else if (arg.startsWith('--user=')) args.userEmail = arg.slice('--user='.length);
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv);
  const db = openDb({ path: args.dbPath ?? process.env.GLM_DB_PATH ?? './data/glm.db' });
  const workspaces = new WorkspaceRepository(db);

  let workspace = workspaces.findBySlug(args.slug);
  if (!workspace) {
    workspace = workspaces.insert({
      id: randomUUID(),
      slug: args.slug,
      name: args.name,
    });
    console.log(`✓ created workspace ${workspace.slug} (${workspace.id})`);
  } else {
    console.log(`• workspace ${workspace.slug} already exists (${workspace.id})`);
  }

  // Enroll users so a future membership filter still finds them.
  const usersQuery = args.userEmail
    ? db.prepare('SELECT id, email FROM users WHERE email = ?')
    : db.prepare('SELECT id, email FROM users');
  const userRows = (args.userEmail ? usersQuery.all(args.userEmail) : usersQuery.all()) as Array<{
    id: string;
    email: string;
  }>;

  if (userRows.length === 0) {
    console.log('• no users in the DB yet — log in once via /login, then re-run this script.');
    return;
  }

  let added = 0;
  let already = 0;
  for (const user of userRows) {
    const existing = workspaces.findMember(workspace.id, user.id);
    if (existing) {
      already++;
      continue;
    }
    workspaces.addMember({
      workspaceId: workspace.id,
      userId: user.id,
      role: 'owner',
    });
    added++;
    console.log(`✓ added ${user.email} as owner`);
  }
  console.log(`done — ${added} new, ${already} already member.`);
}

main();
