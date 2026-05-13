import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Database } from 'bun:sqlite';

/** Resolved on first use; reset by `closeDb()`. Tests can also call `openDb(...)` directly. */
let _instance: Database | null = null;

export interface OpenDbOptions {
  /** Filesystem path to the SQLite DB. Use `:memory:` for ephemeral test DBs. */
  path?: string;
  /** Directory containing numbered `.sql` migration files. */
  migrationsDir?: string;
  /** If true, the migration runner is skipped (caller will run migrations manually). */
  skipMigrations?: boolean;
}

export interface MigrationRecord {
  version: number;
  name: string;
  appliedAt: string;
}

/**
 * Open (or reuse) the singleton GLM database. Applies the standard pragmas
 * and runs any pending migrations under `migrationsDir`. Safe to call many
 * times; only the first call opens a connection.
 *
 * Pragmas applied:
 *   - journal_mode = WAL         (concurrent readers + one writer)
 *   - synchronous  = NORMAL      (durable enough for our soft-lock model)
 *   - foreign_keys = ON          (FKs are mandatory in this schema)
 *   - busy_timeout = 5000        (5 s of automatic retry on lock contention)
 */
export function openDb(options: OpenDbOptions = {}): Database {
  if (_instance) return _instance;

  // Outside test mode, refuse to silently fall back to `:memory:`. A server
  // booted without a persistent path loses every workspace, user, and API
  // token on the next restart — a footgun that bit us during initial
  // dogfooding (server inherited no GLM_DB_PATH from its launch shell,
  // ran in :memory:, and the next foreground restart had nothing).
  const path = options.path ?? process.env.GLM_DB_PATH ?? ':memory:';
  if (path === ':memory:' && process.env.NODE_ENV !== 'test') {
    throw new Error(
      'GLM database path is not set. Refusing to start with `:memory:` outside NODE_ENV=test — ' +
        'all workspaces and tokens would be lost on restart. ' +
        'Set GLM_DB_PATH in your .env (e.g. `GLM_DB_PATH=./data/glm.db`) or pass --db-path to scripts.',
    );
  }
  // SQLite creates the DB file but not its parent directory; ensure it
  // exists so the first boot under a freshly-cloned tree just works.
  if (path !== ':memory:') {
    mkdirSync(dirname(resolve(path)), { recursive: true });
  }
  const db = new Database(path, { create: true });

  // `WAL` is invalid for in-memory DBs; SQLite silently keeps the default.
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');

  if (!options.skipMigrations) {
    const dir = options.migrationsDir ?? defaultMigrationsDir();
    runMigrations(db, dir);
  }

  _instance = db;
  return db;
}

/** Close the singleton connection (if any) and forget it. Primarily for tests. */
export function closeDb(): void {
  if (_instance) {
    _instance.close();
    _instance = null;
  }
}

/** Return the open singleton or throw if it has not been opened yet. */
export function requireDb(): Database {
  if (!_instance) {
    throw new Error('Database has not been opened; call openDb() first.');
  }
  return _instance;
}

/**
 * Apply every migration in `dir` that has not yet been recorded in
 * `schema_migrations`. Each `.sql` file must be named `NNNN_<slug>.sql`
 * where `NNNN` is a zero-padded integer version. Files apply in ascending
 * numeric order. The whole file is executed inside a single transaction;
 * a failure rolls back so the DB never lands in a half-migrated state.
 */
export function runMigrations(db: Database, dir: string): MigrationRecord[] {
  ensureMigrationsTable(db);

  const applied = new Set(
    db.query<{ version: number }, []>('SELECT version FROM schema_migrations').all().map((r) => r.version),
  );

  const files = listMigrationFiles(dir);
  const records: MigrationRecord[] = [];

  for (const file of files) {
    if (applied.has(file.version)) continue;

    const sql = readFileSync(file.path, 'utf8');
    const appliedAt = new Date().toISOString();

    const tx = db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        file.version,
        file.name,
        appliedAt,
      );
    });
    tx();

    records.push({ version: file.version, name: file.name, appliedAt });
  }

  return records;
}

/** Read `schema_migrations` and return the applied set in version order. */
export function appliedMigrations(db: Database): MigrationRecord[] {
  ensureMigrationsTable(db);
  return db
    .query<{ version: number; name: string; applied_at: string }, []>(
      'SELECT version, name, applied_at FROM schema_migrations ORDER BY version ASC',
    )
    .all()
    .map((r) => ({ version: r.version, name: r.name, appliedAt: r.applied_at }));
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

function ensureMigrationsTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
}

interface MigrationFile {
  version: number;
  name: string;
  path: string;
}

function listMigrationFiles(dir: string): MigrationFile[] {
  const entries = readdirSync(dir);
  const files: MigrationFile[] = [];

  for (const entry of entries) {
    if (!entry.endsWith('.sql')) continue;
    const match = entry.match(/^(\d+)_(.+)\.sql$/);
    if (!match) {
      throw new Error(`Migration file ${entry} does not match NNNN_<slug>.sql`);
    }
    const versionStr = match[1];
    const name = match[2];
    if (versionStr === undefined || name === undefined) {
      throw new Error(`Migration file ${entry} could not be parsed`);
    }
    files.push({
      version: Number.parseInt(versionStr, 10),
      name,
      path: join(dir, entry),
    });
  }

  files.sort((a, b) => a.version - b.version);

  for (let i = 0; i < files.length; i++) {
    const expected = i + 1;
    const current = files[i];
    if (current && current.version !== expected) {
      throw new Error(
        `Migration version gap: expected ${expected} but found ${current.version} (${current.name})`,
      );
    }
  }

  return files;
}

function defaultMigrationsDir(): string {
  return resolve(process.cwd(), 'migrations');
}
