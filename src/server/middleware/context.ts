import type { MiddlewareHandler } from 'hono';
import type { RuntimeDeps } from '../deps.ts';
import type { AppEnv } from './auth.ts';

/** Attach runtime deps + repositories to every request context. */
export function context(deps: RuntimeDeps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    c.set('deps', deps);
    c.set('repos', deps.repos);
    return next();
  };
}
