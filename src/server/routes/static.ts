import { Hono } from 'hono';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, normalize, resolve, sep } from 'node:path';
import type { AppEnv } from '../middleware/auth.ts';

/**
 * Static file serving for the PWA shell.
 *
 * Serves:
 *   GET  /              → public/index.html
 *   GET  /login         → public/login.html
 *   GET  /manifest.json → public/manifest.json
 *   GET  /sw.js         → public/sw.js  (with Service-Worker-Allowed: /)
 *   GET  /public/*      → public/<rest>  (assets, JS, CSS)
 *
 * Path traversal is blocked by resolving the requested path and re-checking
 * that it stays inside the configured public root.
 */
export interface StaticRoutesOptions {
  publicDir?: string;
}

const TYPE_MAP: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

export function staticRoutes(opts: StaticRoutesOptions = {}): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const publicDir = resolve(opts.publicDir ?? join(process.cwd(), 'public'));

  app.get('/', (c) => serveFile(c, publicDir, 'index.html'));
  app.get('/login', (c) => serveFile(c, publicDir, 'login.html'));
  app.get('/manifest.json', (c) => serveFile(c, publicDir, 'manifest.json'));
  app.get('/sw.js', (c) => {
    const res = serveFile(c, publicDir, 'sw.js');
    res.headers.set('Service-Worker-Allowed', '/');
    res.headers.set('Cache-Control', 'no-cache');
    return res;
  });
  app.get('/public/*', (c) => {
    const rest = c.req.path.slice('/public/'.length);
    return serveFile(c, publicDir, rest);
  });

  return app;
}

function serveFile(
  c: { newResponse: (...args: never[]) => Response } | Parameters<Parameters<Hono['get']>[1]>[0],
  publicDir: string,
  relative: string,
): Response {
  const safeRel = normalize(relative).replace(/^([\\/])+/, '');
  const absolute = resolve(publicDir, safeRel);
  if (!absolute.startsWith(publicDir + sep) && absolute !== publicDir) {
    return new Response('forbidden', { status: 403 });
  }
  if (!existsSync(absolute)) return new Response('not found', { status: 404 });
  const stat = statSync(absolute);
  if (stat.isDirectory()) return new Response('not found', { status: 404 });
  const ext = '.' + (safeRel.split('.').pop() ?? '');
  const contentType = TYPE_MAP[ext] ?? 'application/octet-stream';
  const bytes = readFileSync(absolute);
  return new Response(bytes, {
    status: 200,
    headers: {
      'content-type': contentType,
      'content-length': String(bytes.length),
    },
  });
}
