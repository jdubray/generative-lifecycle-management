import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { generateSecret } from '../../src/auth/session.ts';
import { runMigrations } from '../../src/repository/db.ts';
import { createApp } from '../../src/server/app.ts';
import { MIGRATIONS_DIR } from '../integration/helpers.ts';

function makeApp() {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  runMigrations(db, MIGRATIONS_DIR);
  return createApp({ db, sessionSecret: generateSecret(), cookieSecure: false });
}

describe('phase 0 smoke', () => {
  test('createApp returns a Hono app', () => {
    const { app } = makeApp();
    expect(app).toBeDefined();
    expect(typeof app.fetch).toBe('function');
  });

  test('GET /api/v1/health returns ok payload', async () => {
    const { app } = makeApp();
    const res = await app.request('/api/v1/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; service: string };
    expect(body.ok).toBe(true);
    expect(body.service).toBe('glm');
  });

  test('unknown route is a 404', async () => {
    const { app } = makeApp();
    const res = await app.request('/api/v1/does-not-exist');
    expect(res.status).toBe(404);
  });
});
