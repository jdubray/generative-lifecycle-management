# ADR 0001 — Use Bun + Hono for the server runtime

**Status:** Accepted
**Date:** 2026-05-11
**Deciders:** Full-stack thread
**Phase:** 0 (Bootstrap)

## Context

GLM needs a small server process that serves three surfaces from one origin:

1. A REST API under `/api/v1/...` against `bun:sqlite`.
2. A single WebSocket per workspace at `/ws/:workspace_id`.
3. The static PWA bundle from `/public`.

The deployment target is "single binary behind a thin reverse proxy" — one process per organization, designed for 1–50 concurrent editors per sekkei. Phase 0 must boot a runnable health endpoint without committing to heavy infrastructure.

## Decision

Use **Bun 1.1+** as the runtime and **Hono v4** as the HTTP layer.

- Bun gives us native SQLite (`bun:sqlite`), native WebSocket (`Bun.serve`), TypeScript without a build step, and `bun test` for unit/integration tests.
- Hono is a tiny router that runs natively on `Bun.serve`'s `fetch` handler. The same `Hono` app can be exercised in-process via `app.request(...)` for tests, which keeps integration tests fast and hermetic.
- The reference TodoMVC implementation in this repository (`todo-mvc/src/`) already proves Bun + Hono + Playwright at the size and shape of the GLM workload.

## Alternatives considered

- **Node + Express / Fastify.** Battle-tested, but requires choosing a separate SQLite binding (better-sqlite3), a separate test runner, and a TS compilation step. More moving parts than Bun gives for free.
- **Deno + Oak / Fresh.** Comparable to Bun on most axes but lacks the native synchronous SQLite story we want for the repository layer. The plan also leans on `bun:sqlite`'s WAL/FK defaults.
- **Cloudflare Workers / edge runtimes.** Excluded by the spec: GLM is single-tenant per org and stores its DB on local disk; edge constraints (no persistent fs, request-bounded execution) are incompatible with the variant-resolution pipeline.

## Consequences

- **Positive:** Zero-config TS, one runtime to install, fast test loop, single dependency tree.
- **Positive:** `Bun.build` produces a single-file executable for Phase 10 deployment.
- **Negative:** Smaller ecosystem than Node; some Node-only libraries may need shimming.
- **Negative:** Bun's API surface is still evolving (1.x); we pin a minimum version in `package.json#engines` and CI uses `1.1`.
- **Risk mitigation:** All I/O (SQLite, git CLI, fs) is encapsulated in `src/repository/` and `src/git/`. Swapping to Node later would touch those directories only.

## Follow-ups

- Phase 1 introduces `src/repository/db.ts` against `bun:sqlite`.
- Phase 3 introduces the WebSocket multiplexer on `Bun.serve.upgrade`.
- Phase 10 evaluates `bun build --compile` for production deployment.
