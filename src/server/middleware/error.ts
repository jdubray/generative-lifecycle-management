import type { ErrorHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { ContentHashMismatchError } from '../../domain/content-hash.ts';
import { NodeBodyValidationError } from '../../domain/node.ts';
import { InvalidScrTransitionError } from '../../domain/scr.ts';
import { ForbiddenError } from '../../auth/roles.ts';
import { UnauthorizedError } from './auth.ts';
import type { AppEnv } from './auth.ts';

/**
 * Domain exception → HTTP mapping. Anything not listed becomes a 500 with
 * a stable JSON body; the original message is included only outside of
 * production to avoid leaking stack details to clients.
 */
export const errorHandler: ErrorHandler<AppEnv> = (err, c) => {
  if (err instanceof HTTPException) {
    const res = err.getResponse();
    if (res.headers.get('content-type')?.includes('application/json')) return res;
    return c.json({ error: { code: 'http_exception', message: err.message } }, err.status);
  }
  if (err instanceof UnauthorizedError) {
    return c.json({ error: { code: 'unauthenticated', message: err.message } }, 401);
  }
  if (err instanceof ForbiddenError) {
    return c.json({ error: { code: 'forbidden', action: err.action, message: err.message } }, 403);
  }
  if (err instanceof NodeBodyValidationError) {
    return c.json(
      { error: { code: 'invalid_body', stratum: err.stratum, issues: err.issues, message: err.message } },
      422,
    );
  }
  if (err instanceof InvalidScrTransitionError) {
    return c.json(
      { error: { code: 'invalid_scr_transition', from: err.from, event: err.event, message: err.message } },
      409,
    );
  }
  if (err instanceof ContentHashMismatchError) {
    return c.json(
      { error: { code: 'content_hash_mismatch', expected: err.expected, actual: err.actual } },
      500,
    );
  }

  const message =
    process.env.NODE_ENV === 'production' ? 'internal server error' : (err.message ?? String(err));
  if (process.env.NODE_ENV !== 'test') {
    console.error('[error]', err);
  }
  return c.json({ error: { code: 'internal', message } }, 500);
};

/** Throwable shortcut: `throw httpError(404, 'node not found')`. */
export type HttpErrorStatus =
  | 400
  | 401
  | 403
  | 404
  | 409
  | 410
  | 422
  | 423
  | 429
  | 500;

export function httpError(
  status: HttpErrorStatus,
  message: string,
  extra: Record<string, unknown> = {},
): HTTPException {
  return new HTTPException(status, {
    res: new Response(JSON.stringify({ error: { code: codeFor(status), message, ...extra } }), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  });
}

function codeFor(status: number): string {
  switch (status) {
    case 400:
      return 'bad_request';
    case 401:
      return 'unauthenticated';
    case 403:
      return 'forbidden';
    case 404:
      return 'not_found';
    case 409:
      return 'conflict';
    case 410:
      return 'gone';
    case 422:
      return 'unprocessable';
    case 423:
      return 'locked';
    case 429:
      return 'rate_limited';
    default:
      return 'internal';
  }
}
