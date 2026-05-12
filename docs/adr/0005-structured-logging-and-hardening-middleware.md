# ADR 0005 — Structured logging + hardening middleware shape

**Status:** Accepted
**Date:** 2026-05-11
**Deciders:** Full-stack thread
**Phase:** 10 (Hardening)

## Context

Phase 10 added three pieces of operational glue to the Hono pipeline: request logging, security headers, and rate limiting. The pieces are small but order-sensitive — `identify()` must run after `context()` but before any role check; rate limiting must see `principal` to derive a per-user bucket; structured logs need the request id available on every response (including errors).

## Decision

The middleware stack registered in `createApp` is, in execution order:

1. **`context()`** — publishes `RuntimeDeps` + `Repositories` on `c.var`.
2. **`requestLogging()`** — assigns an `X-Request-Id`, captures the request, emits one JSON line on completion. Skipped when `NODE_ENV=test` to keep the test runner quiet, and skipped for static paths so log volume stays bounded.
3. **`securityHeaders()`** — emits CSP / Referrer-Policy / nosniff / DENY framing / Permissions-Policy on every response, plus HSTS when behind TLS (detected via `x-forwarded-proto` or scheme).
4. **`identify()`** — extracts the principal from Bearer / cookie / `x-test-user-id` and sets `c.var.principal`.
5. **`rateLimit({ scope: '/api/v1/auth/' })`** — applied only to the auth namespace at 12 attempts / 5 min (refill 0.2 token/s, capacity 12). Other namespaces are unrestricted in v1; the API tokens already carry their own quota story.

Log lines are single-line JSON with fields `{ ts, request_id, method, path, status, duration_ms, user_id }` so any log shipper (Loki, CloudWatch, journald) ingests them with no parser.

## Alternatives considered

- **A single `httpMiddleware()` wrapper.** Hides the order, harder to test. Rejected — explicit ordering is documentation.
- **CSP with `nonce` instead of `'unsafe-inline'`.** Stricter, but our PWA's `login.html` ships a small inline module. We accept `'unsafe-inline'` as a trade-off until a real auth provider lands; ADR-0006 (future) will tighten.
- **Per-route rate limiting.** Easy to reach for, but the spec's threat model is brute-force on `/auth/login`. Tighter scoping is reserved for any future write endpoint that becomes hot.

## Consequences

- **Positive:** Every API response carries an `X-Request-Id` users can quote when reporting bugs.
- **Positive:** OWASP A05 (security misconfiguration) baseline is in place; the integration suite (`tests/integration/server/security-headers.test.ts`) keeps it from regressing.
- **Positive:** Auth-brute-force is bounded at 12 requests / 5 min / IP-or-user; legitimate users get a fresh token every five seconds via the refill rate.
- **Negative:** In-process rate-limit state does not survive a restart and does not scale across replicas. v1 is single-process; multi-process replacement is a Redis adapter behind the same middleware interface.
- **Negative:** `'unsafe-inline'` weakens CSP. Documented and tracked as a follow-up tightening.

## Follow-ups

- ADR-0006: nonce-based CSP once auth ships with a server-rendered shell.
- Once a Redis backend is provisioned, replace the in-process bucket with a Lua script that does atomic refill + decrement.
