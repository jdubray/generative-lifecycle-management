import type { Context, MiddlewareHandler } from 'hono';
import { InvalidApiTokenError, readBearer, validateApiToken } from '../../auth/api-token.ts';
import { InvalidSessionError, readSessionCookie, verifySession } from '../../auth/session.ts';
import type { User } from '../../types.ts';
import type { Repositories, RuntimeDeps } from '../deps.ts';

export interface Principal {
  user: User;
  via: 'session' | 'token' | 'test-header';
}

export type AppEnv = {
  Variables: {
    principal: Principal | null;
    deps: RuntimeDeps;
    repos: Repositories;
  };
};

export class UnauthorizedError extends Error {
  constructor(message = 'unauthenticated') {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

/**
 * Identify the caller. Sets `c.var.principal` for downstream handlers.
 *
 * Order of precedence:
 *   1. `Authorization: Bearer <token>` (CLI / programmatic)
 *   2. Session cookie (browser)
 *   3. `x-test-user-id` header (only when `deps.allowTestAuthHeader === true`)
 *
 * Does NOT reject anonymous requests — `requireAuth` does that. This split
 * lets endpoints like `/api/v1/health` and the login flow stay public.
 */
export function identify(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const deps = c.var.deps;
    const repos = c.var.repos;
    c.set('principal', null);

    const bearer = readBearer(c.req.header('authorization') ?? null);
    if (bearer) {
      try {
        const row = validateApiToken(repos.apiTokens, bearer, deps.clock());
        const user = repos.users.findById(row.userId);
        if (user) {
          c.set('principal', { user, via: 'token' });
          return next();
        }
      } catch (e) {
        if (!(e instanceof InvalidApiTokenError)) throw e;
        // Fall through to other auth modes; the route can still reject.
      }
    }

    const cookie = readSessionCookie(c.req.header('cookie') ?? null);
    if (cookie) {
      try {
        const payload = verifySession(cookie, deps.sessionSecret, deps.clock().getTime());
        const user = repos.users.findById(payload.userId);
        if (user) {
          c.set('principal', { user, via: 'session' });
          return next();
        }
      } catch (e) {
        if (!(e instanceof InvalidSessionError)) throw e;
      }
    }

    if (deps.allowTestAuthHeader) {
      const id = c.req.header('x-test-user-id');
      if (id) {
        const user = repos.users.findById(id);
        if (user) {
          c.set('principal', { user, via: 'test-header' });
          return next();
        }
      }
    }

    return next();
  };
}

/** Reject anonymous requests with 401. Must run after `identify()`. */
export function requireAuth(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!c.var.principal) throw new UnauthorizedError();
    return next();
  };
}

/** Convenience: read the principal or throw a 401. */
export function requirePrincipal(c: Context<AppEnv>): Principal {
  const p = c.var.principal;
  if (!p) throw new UnauthorizedError();
  return p;
}
