import { resolve } from 'node:path';
import type { Database } from 'bun:sqlite';
import { runMigrations } from '../../src/repository/db.ts';
import { Database as SqliteDatabase } from 'bun:sqlite';

export const MIGRATIONS_DIR = resolve(import.meta.dir, '..', '..', 'migrations');

/** Open a fresh in-memory DB with WAL/FK pragmas applied and all migrations run. */
export function openTestDb(): Database {
  const db = new SqliteDatabase(':memory:');
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  runMigrations(db, MIGRATIONS_DIR);
  return db;
}

export function seedUser(
  db: Database,
  id = 'user-1',
  email = 'alice@example.com',
): void {
  db.prepare(
    `INSERT INTO users (id, email, display_name, role, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(id, email, 'Alice', 'editor', new Date().toISOString());
}

export function seedWorkspace(db: Database, id = 'ws-1', slug = 'demo'): void {
  db.prepare(
    `INSERT INTO workspaces (id, slug, name, created_at) VALUES (?, ?, ?, ?)`,
  ).run(id, slug, 'Demo Workspace', new Date().toISOString());
}
