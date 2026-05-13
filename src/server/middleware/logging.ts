import { randomUUID } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from './auth.ts';

/**
 * Structured request logging.
 *
 * Each request gets:
 *   - a request id (echoed back as `X-Request-Id` so clients can correlate)
 *   - a single JSON line on completion with method, path, status, duration
 *
 * Logs go to `console.log` so any container runtime can collect them by
 * stdout. Suppressed under `NODE_ENV=test` so the test runner stays tidy.
 *
 * Skipped for `GET /public/*` and the static shell so log volume is bounded
 * to real API traffic.
 */
export function requestLogging(opts: { sink?: (line: string) => void } = {}): MiddlewareHandler<AppEnv> {
  const sink = opts.sink ?? ((line) => console.log(line));
  const enabled = process.env.NODE_ENV !== 'test';
  return async (c, next) => {
    const id = c.req.header('x-request-id') ?? randomUUID();
    c.header('X-Request-Id', id);
    if (!enabled) return next();

    const path = c.req.path;
    if (path.startsWith('/public/') || path === '/' || path === '/login' || path === '/manifest.json' || path === '/sw.js') {
      return next();
    }
    const started = performance.now();
    // Emit a "request_start" line immediately so long-running endpoints
    // (e.g. /solo-generate, /vibe) are visible in the log before they return.
    sink(
      JSON.stringify({
        ts: new Date().toISOString(),
        request_id: id,
        event: 'request_start',
        method: c.req.method,
        path,
      }),
    );
    let err: unknown = null;
    try {
      await next();
    } catch (e) {
      err = e;
      throw e;
    } finally {
      const duration_ms = Math.round(performance.now() - started);
      const line = JSON.stringify({
        ts: new Date().toISOString(),
        request_id: id,
        method: c.req.method,
        path,
        status: err ? 500 : c.res.status,
        duration_ms,
        user_id: c.var.principal?.user.id ?? null,
      });
      sink(line);
    }
  };
}
