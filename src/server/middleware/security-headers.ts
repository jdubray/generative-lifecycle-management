import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from './auth.ts';

/**
 * Static security headers applied to every response.
 *
 * - Content-Security-Policy is restrictive: same-origin scripts only, the
 *   `unsafe-inline` allowance covers the login form's `<script type="module">`.
 *   Future tightening (nonce-based CSP) ships with a real auth provider.
 * - Referrer-Policy: same-origin keeps Referer leaks contained.
 * - X-Content-Type-Options + X-Frame-Options block MIME-sniffing + clickjacking.
 * - Strict-Transport-Security only emitted when the request came in via HTTPS;
 *   set behind a reverse proxy this hook honours `x-forwarded-proto`.
 */

const DEFAULT_CSP = [
  "default-src 'self'",
  "img-src 'self' data:",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self' ws: wss:",
  "font-src 'self' data:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

export interface SecurityHeadersOptions {
  contentSecurityPolicy?: string;
  /** When true, send HSTS regardless of scheme (use behind a TLS-terminating proxy). */
  forceHsts?: boolean;
}

export function securityHeaders(opts: SecurityHeadersOptions = {}): MiddlewareHandler<AppEnv> {
  const csp = opts.contentSecurityPolicy ?? DEFAULT_CSP;
  return async (c, next) => {
    // Wrap in try/finally so headers attach to error responses (the
    // errorHandler / HTTPException path) just as they do to 2xx ones.
    try {
      await next();
    } finally {
      if (!c.res.headers.has('content-security-policy')) {
        c.header('Content-Security-Policy', csp);
      }
      c.header('Referrer-Policy', 'same-origin');
      c.header('X-Content-Type-Options', 'nosniff');
      c.header('X-Frame-Options', 'DENY');
      c.header('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
      const forwarded = c.req.header('x-forwarded-proto');
      const isHttps = c.req.url.startsWith('https://') || forwarded === 'https';
      if (opts.forceHsts || isHttps) {
        c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
      }
    }
  };
}
