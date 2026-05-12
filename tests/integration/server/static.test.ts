import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { resolve } from 'node:path';
import { generateSecret } from '../../../src/auth/session.ts';
import { runMigrations } from '../../../src/repository/db.ts';
import { createApp } from '../../../src/server/app.ts';
import { MIGRATIONS_DIR } from '../helpers.ts';

const PUBLIC_DIR = resolve(import.meta.dir, '..', '..', '..', 'public');

describe('static file routes', () => {
  let db: Database;
  let app: ReturnType<typeof createApp>['app'];

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON;');
    runMigrations(db, MIGRATIONS_DIR);
    ({ app } = createApp(
      {
        db,
        sessionSecret: generateSecret(),
        cookieSecure: false,
        allowTestAuthHeader: true,
      },
      { publicDir: PUBLIC_DIR },
    ));
  });
  afterEach(() => db.close());

  test('GET / returns the PWA shell HTML', async () => {
    const res = await app.request('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const text = await res.text();
    expect(text).toContain('<div id="root" class="app">');
    expect(text).toContain('/public/js/app.js');
  });

  test('GET /manifest.json returns valid JSON', async () => {
    const res = await app.request('/manifest.json');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string; start_url: string };
    expect(body.name).toBe('Puffin GLM');
    expect(body.start_url).toBe('/');
  });

  test('GET /sw.js advertises Service-Worker-Allowed', async () => {
    const res = await app.request('/sw.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('service-worker-allowed')).toBe('/');
    expect(res.headers.get('content-type')).toContain('application/javascript');
  });

  test('GET /public/js/app.js is served as JS', async () => {
    const res = await app.request('/public/js/app.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/javascript');
    const text = await res.text();
    expect(text).toContain('boot');
  });

  test('GET /public/styles/tokens.css is served as CSS', async () => {
    const res = await app.request('/public/styles/tokens.css');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/css');
  });

  test('all 9 spec UI components have files', async () => {
    const names = [
      'status-pill',
      'stratum-tag',
      'class-badge',
      'hash',
      'section',
      'kv',
      'diff-block',
      'yaml-block',
      'empty',
    ];
    for (const name of names) {
      const res = await app.request(`/public/js/components/${name}.js`);
      expect(res.status).toBe(200);
    }
  });

  test('all 9 view modules are reachable', async () => {
    const views = [
      'dashboard',
      'sekkei-browser',
      'change-management',
      'variants',
      'where-used',
      'effectivity',
      'drift',
      'reuse',
      'provenance',
      'vibe-mode',
    ];
    for (const v of views) {
      const res = await app.request(`/public/js/views/${v}.js`);
      expect(res.status).toBe(200);
    }
  });

  test('path traversal in /public is blocked', async () => {
    const res = await app.request('/public/../../etc/passwd');
    // Hono normalizes the URL; either the route does not match (404) or our
    // resolver refuses it (403). Both are acceptable rejections.
    expect([403, 404]).toContain(res.status);
  });

  test('GET /login returns the dev login page', async () => {
    const res = await app.request('/login');
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('Dev login');
    expect(text).toContain('id="login-form"');
  });
});
