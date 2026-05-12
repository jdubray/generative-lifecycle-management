#!/usr/bin/env bun
/**
 * `bun run scripts/restore.ts --backup=<path> --db=<dest>`
 *
 * Restores a backup created by `scripts/backup.ts` over the live DB path.
 * Refuses to overwrite a non-empty destination unless `--force` is passed,
 * and runs an `integrity_check` after copying to confirm the restored file
 * is consistent.
 */

import { copyFileSync, existsSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { Database } from 'bun:sqlite';

interface Args {
  backup: string;
  dbPath: string;
  force: boolean;
}

function parseArgs(argv: string[]): Args {
  let backup = '';
  let dbPath = process.env.GLM_DB_PATH ?? '';
  let force = false;
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (arg.startsWith('--backup=')) backup = arg.slice('--backup='.length);
    else if (arg === '--backup') backup = argv[++i] ?? '';
    else if (arg.startsWith('--db=')) dbPath = arg.slice('--db='.length);
    else if (arg === '--db') dbPath = argv[++i] ?? '';
    else if (arg === '--force') force = true;
  }
  if (!backup || !dbPath) {
    console.error('usage: bun run scripts/restore.ts --backup=<path> --db=<dest> [--force]');
    process.exit(2);
  }
  return { backup, dbPath, force };
}

async function main() {
  const { backup, dbPath, force } = parseArgs(process.argv);
  let source = backup;
  if (backup.endsWith('.gz')) {
    source = backup.replace(/\.gz$/, '.restoring');
    const r = spawnSync('gunzip', ['-c', backup], { encoding: 'buffer' });
    if (r.status !== 0) {
      console.error('gunzip failed:', r.stderr?.toString());
      process.exit(1);
    }
    await Bun.write(source, r.stdout);
  } else if (!existsSync(backup)) {
    console.error(`backup not found: ${backup}`);
    process.exit(2);
  }

  if (existsSync(dbPath) && !force) {
    const sz = statSync(dbPath).size;
    if (sz > 0) {
      console.error(`destination ${dbPath} is non-empty; pass --force to overwrite`);
      process.exit(2);
    }
  }

  // Copy to a sibling temp file FIRST and run integrity_check against it,
  // so a corrupt backup never replaces a healthy live DB. Only on success
  // do we atomically rename over `dbPath`.
  const stagingPath = `${dbPath}.restoring`;
  if (existsSync(stagingPath)) unlinkSync(stagingPath);
  copyFileSync(source, stagingPath);

  const db = new Database(stagingPath, { readonly: true });
  const check = db.prepare('PRAGMA integrity_check').all() as Array<{ integrity_check: string }>;
  db.close();
  const ok = check.length === 1 && check[0]?.integrity_check === 'ok';
  if (!ok) {
    console.error('integrity_check failed on staged copy; live DB is untouched:', check);
    try { unlinkSync(stagingPath); } catch {}
    process.exit(1);
  }

  // Atomic swap. On Windows renameSync fails if the destination exists, so
  // remove the previous file first (we already passed the --force guard).
  if (existsSync(dbPath)) unlinkSync(dbPath);
  renameSync(stagingPath, dbPath);
  if (source !== backup) try { unlinkSync(source); } catch {}
  console.log(`restore ok: ${dbPath}`);
}

main();
