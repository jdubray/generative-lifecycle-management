#!/usr/bin/env bun
/**
 * `bun run scripts/backup.ts --db=<path> --out=<dest>`
 *
 * Creates a consistent point-in-time backup of the GLM SQLite index using
 * `VACUUM INTO`, which is safe to run while readers are active and produces
 * a single-file copy with no WAL segments dangling.
 *
 * If `--out` ends in `.gz` the backup file is gzipped after the copy.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { Database } from 'bun:sqlite';

interface Args {
  dbPath: string;
  outPath: string;
}

function parseArgs(argv: string[]): Args {
  let dbPath = process.env.GLM_DB_PATH ?? '';
  let outPath = '';
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (arg.startsWith('--db=')) dbPath = arg.slice('--db='.length);
    else if (arg === '--db') dbPath = argv[++i] ?? '';
    else if (arg.startsWith('--out=')) outPath = arg.slice('--out='.length);
    else if (arg === '--out') outPath = argv[++i] ?? '';
  }
  if (!dbPath) {
    console.error('usage: bun run scripts/backup.ts --db=<path> --out=<dest>');
    process.exit(2);
  }
  if (!outPath) {
    outPath = `${dbPath}.${new Date().toISOString().replace(/[:.]/g, '-')}.backup`;
  }
  return { dbPath, outPath };
}

function main() {
  const { dbPath, outPath } = parseArgs(process.argv);
  if (!existsSync(dbPath)) {
    console.error(`source DB not found: ${dbPath}`);
    process.exit(2);
  }
  mkdirSync(dirname(outPath), { recursive: true });
  // VACUUM INTO writes the snapshot directly; the .gz suffix (if any) is
  // applied by gzip in a second step, so the SQLite target is always the
  // un-gzipped path.
  const wantGz = outPath.endsWith('.gz');
  const dbTarget = wantGz ? outPath.replace(/\.gz$/, '') : outPath;
  if (existsSync(dbTarget)) rmSync(dbTarget, { force: true });
  if (wantGz && existsSync(outPath)) rmSync(outPath, { force: true });

  // VACUUM is a write op, so the source connection cannot be readonly.
  const db = new Database(dbPath);
  db.exec(`VACUUM INTO '${dbTarget.replace(/'/g, "''")}'`);
  db.close();

  let final = dbTarget;
  if (wantGz) {
    // gzip -f overwrites the .gz target and removes the source file.
    const r = spawnSync('gzip', ['-f', dbTarget], { encoding: 'utf8' });
    if (r.status !== 0) {
      console.error('gzip failed:', r.stderr);
      process.exit(1);
    }
    final = outPath;
  }

  const bytes = statSync(final).size;
  console.log(`backup ok: ${final} (${(bytes / 1024).toFixed(1)} KiB)`);
}

main();
