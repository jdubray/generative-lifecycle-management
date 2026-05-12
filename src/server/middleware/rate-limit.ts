import type { MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { AppEnv } from './auth.ts';

/**
 * In-process token-bucket rate limiter.
 *
 *   - Scope: one bucket per (principal-id or peer-ip) per route prefix.
 *   - Cost model: every request costs one token; buckets refill at `refillPerSec`
 *     up to `capacity`.
 *   - Failures surface as 429 with `Retry-After` set to the time until the
 *     next token is available.
 *
 * Suitable for a single-process Bun server (the v1 deployment shape). A
 * multi-process deployment would back this with Redis; the middleware
 * surface is stable.
 */

export interface RateLimitOptions {
  /** Max tokens in the bucket. Default 60. */
  capacity?: number;
  /** Tokens refilled per second. Default 10. */
  refillPerSec?: number;
  /** Route prefix filter (e.g. `/api/v1/auth/`). Default matches everything. */
  scope?: string;
  /** Function deriving the bucket key. Defaults to user-id || peer-ip || "anon". */
  key?: (c: Parameters<MiddlewareHandler<AppEnv>>[0]) => string;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export function rateLimit(options: RateLimitOptions = {}): MiddlewareHandler<AppEnv> {
  const capacity = options.capacity ?? 60;
  const refillPerSec = options.refillPerSec ?? 10;
  const scope = options.scope ?? '';
  const buckets = new Map<string, Bucket>();

  const keyOf =
    options.key ??
    ((c) => {
      const id = c.var.principal?.user.id;
      if (id) return `u:${id}`;
      const ip = c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip') ?? 'anon';
      return `ip:${ip}`;
    });

  return async (c, next) => {
    if (scope && !c.req.path.startsWith(scope)) return next();
    const now = Date.now();
    const bucketKey = `${scope}|${keyOf(c)}`;
    const bucket = buckets.get(bucketKey) ?? { tokens: capacity, updatedAt: now };
    const elapsed = (now - bucket.updatedAt) / 1000;
    bucket.tokens = Math.min(capacity, bucket.tokens + elapsed * refillPerSec);
    bucket.updatedAt = now;
    if (bucket.tokens < 1) {
      const waitMs = Math.ceil(((1 - bucket.tokens) / refillPerSec) * 1000);
      buckets.set(bucketKey, bucket);
      const retryAfterSec = Math.max(1, Math.round(waitMs / 1000));
      throw new HTTPException(429, {
        res: new Response(
          JSON.stringify({
            error: { code: 'rate_limited', message: 'rate limit exceeded', scope, retryAfterMs: waitMs },
          }),
          {
            status: 429,
            headers: {
              'content-type': 'application/json',
              'Retry-After': String(retryAfterSec),
            },
          },
        ),
      });
    }
    bucket.tokens -= 1;
    buckets.set(bucketKey, bucket);
    return next();
  };
}
