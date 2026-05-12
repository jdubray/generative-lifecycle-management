import { Database } from 'bun:sqlite';
import { generateSecret } from '../../../src/auth/session.ts';
import { runMigrations } from '../../../src/repository/db.ts';
import { createApp } from '../../../src/server/app.ts';
import type { RuntimeDeps } from '../../../src/server/deps.ts';
import { MIGRATIONS_DIR } from '../helpers.ts';

export interface TestServer {
  app: ReturnType<typeof createApp>['app'];
  deps: RuntimeDeps;
  db: Database;
  /** Fetch helper that auto-injects `x-test-user-id` and JSON content-type. */
  request(method: string, path: string, opts?: { body?: unknown; userId?: string; headers?: Record<string, string> }): Promise<Response>;
}

export function makeTestServer(opts: { seedUser?: { id: string; email: string }; seedWorkspace?: { id: string; slug: string } } = {}): TestServer {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  runMigrations(db, MIGRATIONS_DIR);

  // Seed a default user + workspace so most tests can skip the boilerplate.
  const userId = opts.seedUser?.id ?? 'user-1';
  const email = opts.seedUser?.email ?? 'alice@example.com';
  const workspaceId = opts.seedWorkspace?.id ?? 'ws-1';
  const slug = opts.seedWorkspace?.slug ?? 'demo';
  const now = '2026-05-11T00:00:00.000Z';
  db.prepare('INSERT INTO users (id, email, display_name, role, created_at) VALUES (?, ?, ?, ?, ?)').run(
    userId,
    email,
    'Alice',
    'editor',
    now,
  );
  db.prepare('INSERT INTO workspaces (id, slug, name, created_at) VALUES (?, ?, ?, ?)').run(
    workspaceId,
    slug,
    'Demo Workspace',
    now,
  );

  const { app, deps } = createApp({
    db,
    sessionSecret: generateSecret(),
    cookieSecure: false,
    allowTestAuthHeader: true,
  });

  const request: TestServer['request'] = async (method, path, opts2 = {}) => {
    const headers: Record<string, string> = {
      'x-test-user-id': opts2.userId ?? userId,
      ...(opts2.headers ?? {}),
    };
    let body: BodyInit | undefined;
    if (opts2.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(opts2.body);
    }
    return app.request(path, { method, headers, body });
  };

  return { app, deps, db, request };
}
