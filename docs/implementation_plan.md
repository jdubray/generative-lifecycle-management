# GLM — Implementation Plan

**Companion to:** [`glm_functional_technical_spec.md`](./glm_functional_technical_spec.md)  
**Companion to:** [`glm-with-git.md`](./glm-with-git.md)  
**Version:** 1.1  
**Date:** 2026-05-12  
**Status:** Draft

---

## Table of Contents

1. [Overview](#1-overview)
2. [Technology Stack](#2-technology-stack)
3. [Project Directory Structure](#3-project-directory-structure)
4. [Phase Roadmap](#4-phase-roadmap)
5. [Phase Details](#5-phase-details)
6. [Acceptance Criteria Coverage](#6-acceptance-criteria-coverage)
7. [Risks & Mitigations](#7-risks--mitigations)
8. [Architecture Decisions](#8-architecture-decisions)
9. [Default Branch Structure](#9-default-branch-structure)
10. [Remaining Open Questions](#10-remaining-open-questions)
11. [First Sprint (Week 1)](#11-first-sprint-week-1)

---

## 1. Overview

This plan translates the functional/technical specification into an ordered, phased build. The goal is a working v1 GLM that:

- Lets 1–50 engineers collaborate on a sekkei in near-real-time
- Persists every change to git as conventional ECN commits
- Resolves variants, validates constraints, and emits content-addressed `sekkei.lock` files
- Drives the generation pipeline against a content-addressed cache
- Reconciles drift between the sekkei and the realization repo
- Emits signed in-toto attestations for every generation event
- Installs as a PWA with offline-read support

### 1.1 Build Philosophy

- **TDD throughout.** Every module ships with tests written before or alongside the code (per project coding preferences).
- **Vertical slices.** Each phase delivers an end-to-end capability (data → API → UI) rather than horizontal layers.
- **Mockup is the design.** The `mockup/` directory remains untouched as the visual/interaction reference. The PWA port mirrors the mockup component-by-component but in production form (vanilla ES modules, no Babel-in-browser, no CDN React).
- **Git is the source of truth.** SQLite is a derived index. Every write goes through git; the DB is rebuildable from the repo.
- **No premature abstraction.** Build the minimum the spec requires; refactor when patterns are clear.

### 1.2 Out of Scope for v1

- Cross-org sharing
- General-purpose CRDT/OT collaboration engine (soft-lock + LWW is the design)
- Custom LLM hosting (delegated to external provider)
- Mobile-first UI (PWA is desktop-optimized; mobile is "best effort")
- Multi-region deployment (single Bun process per org)

---

## 2. Technology Stack

| Layer | Choice | Rationale |
|-------|--------|-----------|
| Runtime | **Bun 1.1+** | Single binary, native SQLite, native WebSocket, fast TS execution |
| Web framework | **Hono v4** | Lightweight, designed for Bun, edge-ready |
| Persistence | **bun:sqlite** (WAL, NORMAL sync, FK ON) | Single-file DB per workspace, embedded, transactional |
| Frontend | **Vanilla ES modules** (no bundler) | Mirrors the mockup; installable as PWA without build step |
| Styling | **Hand-written CSS + design tokens** | Already proven in the mockup |
| WebSocket | **Bun built-in** | One socket per workspace |
| LLM provider | **Anthropic Claude API** | Claude Sonnet 4.6 / Opus 4.7 for generation; prompt caching for cost |
| Signing | **DSSE + Sigstore (Fulcio + Rekor)** | Industry-standard supply-chain attestations |
| Git layer | **Shell-out to `git` CLI** | Simpler than libgit2 bindings; portable |
| Test framework | **`bun:test`** | Native, fast, no extra deps |
| E2E | **Playwright** | Already proven in this repo |
| Lint/format | **Biome** | Single tool, fast, no plugin sprawl |
| CI | **GitHub Actions** (existing) | Already wired up |
| Deploy | **Single binary + systemd/Docker** | Bun compiles to a single executable |

---

## 3. Project Directory Structure

Existing folders are left in place. Newly created folders are marked **[new]**.

```
glm/
├── .claude/                    [existing] Claude Code config
├── .github/                    [existing] CI workflows
├── .puffin/                    [existing] Puffin branch context
├── docs/                       [existing] Human-readable documentation
│   ├── glm_functional_technical_spec.md
│   ├── glm-with-git.md
│   ├── implementation_plan.md  ← this file
│   └── adr/                    [new] Architecture Decision Records
├── mockup/                     [existing] Visual/interaction reference prototype
│                                          — DO NOT MODIFY; ports go to public/
├── specification/              [existing] Sekkei formal specification
│                                          (schema, validator, gate definitions)
├── sekkei/                     [existing] Example sekkei used during development
│
├── src/                        [new] Server-side TypeScript source
│   ├── server/
│   │   ├── app.ts              Hono app factory
│   │   ├── server.ts           Bun.serve entrypoint
│   │   ├── middleware/         auth, logging, error mapping
│   │   └── routes/             REST endpoints by domain
│   │       ├── nodes.ts
│   │       ├── scrs.ts
│   │       ├── variants.ts
│   │       ├── drift.ts
│   │       ├── generation.ts
│   │       └── provenance.ts
│   ├── ws/                     WebSocket layer
│   │   ├── workspace-socket.ts
│   │   └── event-bus.ts
│   ├── domain/                 Pure business logic (no I/O)
│   │   ├── node.ts             Node entity + body-shape invariants
│   │   ├── scr.ts              SCR state machine
│   │   ├── variant.ts          Variant resolution pipeline (6 steps)
│   │   ├── drift.ts            Drift detection logic
│   │   ├── relationships.ts    Where-Used traversal
│   │   └── content-hash.ts     Canonical YAML hashing
│   ├── repository/             SQLite persistence
│   │   ├── db.ts               Singleton + migration runner
│   │   ├── node-repository.ts
│   │   ├── scr-repository.ts
│   │   ├── variant-repository.ts
│   │   ├── drift-repository.ts
│   │   ├── provenance-repository.ts
│   │   ├── audit-repository.ts
│   │   └── change-log-repository.ts
│   ├── git/                    Git integration layer
│   │   ├── git-client.ts       Thin wrapper around the git CLI
│   │   ├── ecn-commit.ts       Build ECN-format commit messages
│   │   ├── sekkei-lock.ts      Read/write sekkei.lock YAML
│   │   ├── git-notes.ts        refs/notes/generation operations
│   │   ├── yaml-store.ts       Node ↔ YAML file sync
│   │   └── hook-installer.ts   pre-commit / pre-receive setup
│   ├── generation/             LLM pipeline
│   │   ├── queue.ts            In-process worker queue
│   │   ├── llm-client.ts       Anthropic provider with prompt caching
│   │   ├── cache.ts            Content-addressed generation cache
│   │   ├── pipeline.ts         Closure walk → binding → cache → LLM
│   │   └── attestation.ts      in-toto Statement + DSSE envelope
│   ├── auth/
│   │   ├── session.ts          Signed-cookie sessions
│   │   ├── api-token.ts        Bearer token validation
│   │   └── roles.ts            Role-based authorization gates
│   ├── verifier/
│   │   ├── gates.ts            6-gate + v1.1.9 gate 2.b verifier
│   │   └── runner.ts           Scheduling + verification_runs persistence
│   └── types.ts                Shared TypeScript types
│
├── public/                     [new] PWA frontend (no bundler)
│   ├── index.html
│   ├── manifest.json           PWA manifest
│   ├── sw.js                   Service worker (offline read + queue)
│   ├── styles/
│   │   ├── tokens.css          Design tokens (ported from mockup)
│   │   └── components.css      Component styles
│   ├── js/
│   │   ├── app.js              Shell + router + cross-view state
│   │   ├── api.js              REST client
│   │   ├── ws.js               WebSocket client + reconnect
│   │   ├── store.js            Shared view state (replaces window.__glm)
│   │   ├── components/         Shared UI primitives
│   │   │   ├── status-pill.js
│   │   │   ├── stratum-tag.js
│   │   │   ├── hash.js
│   │   │   ├── section.js
│   │   │   ├── kv.js
│   │   │   ├── diff-block.js
│   │   │   └── yaml-block.js
│   │   └── views/              One per nav item
│   │       ├── dashboard.js
│   │       ├── sekkei-browser.js
│   │       ├── change-management.js
│   │       ├── variant-resolution.js
│   │       ├── where-used.js
│   │       ├── effectivity.js
│   │       ├── drift.js
│   │       ├── reuse.js
│   │       ├── provenance.js
│   │       └── vibe-mode.js
│   └── assets/                 Icons, fonts (if not from CDN)
│
├── migrations/                 [new] SQLite migrations (numbered .sql files)
│   └── 0001_initial.sql
│
├── tests/                      [new] Tests organized by scope
│   ├── unit/                   Pure-domain tests; no I/O
│   ├── integration/            Real SQLite + real git in a tmpdir
│   └── e2e/                    Playwright; covers AC-01 .. AC-41
│
├── scripts/                    [new] Operational scripts
│   ├── seed.ts                 Seed dev workspace from mockup/data.jsx
│   ├── migrate.ts              Apply migrations
│   └── verify.ts               Run the sekkei verifier
│
├── package.json                [Phase 0] Bun manifest
├── tsconfig.json               [Phase 0]
├── biome.json                  [Phase 0]
├── .env.example                [Phase 0]
└── README.md                   [existing] — update with build/run instructions
```

### 3.1 Directory Conventions

- **`src/domain/`** holds pure logic with no I/O. Functions in this directory are deterministic and trivially unit-testable. This is where the variant-resolution pipeline, SCR state machine, and content-hash algorithm live.
- **`src/repository/`** is the only directory that touches `bun:sqlite`. Domain code talks to repositories through interfaces.
- **`src/git/`** is the only directory that shells out to `git`. All filesystem mutations of the sekkei repo go through here.
- **`src/server/routes/`** translates HTTP requests into domain calls. No business logic here; route handlers are thin.
- **`public/js/`** contains no transpilation. Every file is browser-ready ES2022. The mockup proves this is feasible.
- **`migrations/`** files are immutable once shipped. New schema changes go in new numbered files.
- **`tests/`** mirrors the `src/` tree for unit tests; integration and e2e have their own organization.

---

## 4. Phase Roadmap

| Phase | Duration | Output | Demo-able? |
|-------|----------|--------|------------|
| 0. Bootstrap | 2 days | Bun + Hono + Biome project running; CI green | No |
| 1. Data Layer | 1 week | All tables created; repositories with full CRUD; content hashing | No (CLI only) |
| 2. Domain Model | 1 week | SCR state machine, variant resolution, where-used; all unit-tested | No (CLI only) |
| 3. Server & API | 1.5 weeks | REST endpoints + WebSocket; auth; event bus | Yes (curl) |
| 4. Git Integration | 1 week | YAML store sync; ECN commits; sekkei.lock; git notes | Yes (CLI) |
| 5. Generation Pipeline | 1.5 weeks | Worker queue; LLM client; cache; in-toto + DSSE | Yes (CLI) |
| 6. PWA — Shell & Read Surfaces | 2 weeks | Dashboard, Sekkei Browser, Where-Used, Provenance | Yes (web) |
| 7. PWA — Write Surfaces | 2 weeks | Change Mgmt, Variants, Effectivity, Drift, Reuse | Yes (web) |
| 8. Vibe Mode | 1 week | Conversational agent w/ scripted scenarios + LLM fallback | Yes (web) |
| 9. Verifier | 4 days | 6-gate + 2.b runner; post-merge background job | Yes |
| 10. Hardening | 1.5 weeks | Perf targets, security review, observability, DSSE export | Yes |

**Total:** ~12 weeks for a senior engineer working full-time. Phases 6 and 7 (the largest) can be parallelized with phases 4–5 if a second engineer is available.

---

## 5. Phase Details

### Phase 0 — Bootstrap (2 days)

**Goal:** A repo that boots, lints clean, and runs a smoke test.

**Deliverables:**
- `package.json` with `bun` scripts: `dev`, `test`, `lint`, `build`, `seed`
- `tsconfig.json` — strict, ES2022 target, `bun-types`
- `biome.json` — formatter + linter
- `.env.example` — env vars for `ANTHROPIC_API_KEY`, `SESSION_SECRET`, `SEKKEI_REPO_PATH`, `REALIZATION_REPO_PATH`
- A minimal `src/server/server.ts` that boots Hono and returns `{"ok": true}` on `GET /api/v1/health`
- A failing test in `tests/unit/smoke.test.ts` that imports from `src/`
- A GitHub Actions workflow that runs `bun install && bun test && bun run lint`

**Done when:** CI is green on a no-op PR.

---

### Phase 1 — Data Layer (1 week)

**Goal:** Every table from §3 of the spec exists, has a repository, and has unit tests.

**Deliverables:**
- `migrations/0001_initial.sql` — all 14 tables, indexes, FKs from spec §3
- `src/repository/db.ts` — singleton wrapper around `bun:sqlite` with WAL + FK + migration runner
- One repository file per aggregate (node, scr, variant, drift, provenance, audit, change-log)
- `src/domain/content-hash.ts` — canonical YAML serialization + SHA-256
- Round-trip tests: `write → read → assert(content_hash unchanged)`
- Foreign-key constraint tests
- Index existence tests

**Key design decisions:**
- Canonical YAML uses sorted keys, LF line endings, no trailing whitespace
- `content_hash` is computed on insert and re-verified on every read
- Repositories return plain domain objects, not DB rows

**Done when:** AC-01 (envelope round-trip) passes; `bun test tests/unit/repository` is green.

---

### Phase 2 — Domain Model (1 week)

**Goal:** Pure business logic for SCR workflow, variant resolution, and graph traversal.

**Deliverables:**
- `src/domain/node.ts` — node entity with stratum-specific body validation (§3.2)
- `src/domain/scr.ts` — SCR state machine: Draft → Submitted → Under Review → Approved/Returned/Rejected → Implemented → Released
- `src/domain/variant.ts` — 6-step resolution pipeline (closure walk → binding → constraints → deps → cache keys → lock emission)
- `src/domain/relationships.ts` — Where-Used direct + transitive traversal
- `src/domain/drift.ts` — Hash drift vs. live-state drift classifier
- Unit tests for every state transition and edge case

**Key design decisions:**
- State machines are exhaustive `switch` statements with TS discriminated unions; illegal transitions throw
- Variant resolution is a pure function `resolve(rootId, binding, generatorId) → ResolutionResult`
- CEL-style constraint predicates are evaluated by a minimal interpreter (no full CEL spec; just the operators the mockup uses)

**Done when:** AC-11 through AC-14 (variant resolution behavior) and AC-15 through AC-18 (where-used) pass in unit tests.

---

### Phase 3 — Server & API (1.5 weeks)

**Goal:** Every REST endpoint in spec §7 works against the data layer; WebSocket broadcasts node and SCR changes.

**Deliverables:**
- Hono app with route registration per domain
- `src/server/middleware/auth.ts` — cookie session validator + Bearer token validator
- `src/server/middleware/error.ts` — domain exceptions → HTTP status mapping
- All endpoints from §7.1 implemented
- `src/ws/workspace-socket.ts` — per-workspace socket multiplexer
- `src/ws/event-bus.ts` — in-process pub/sub for cross-request fan-out
- Integration tests hitting a real Bun server with a real SQLite DB in a tmpdir

**Key design decisions:**
- Sessions are 7-day signed cookies (HMAC-SHA256 with `SESSION_SECRET`)
- API tokens stored hashed (Argon2id); the user sees the raw token once on creation
- Lock acquisition is `POST .../lock` with a 30s TTL; heartbeat extends; release on `DELETE`
- WebSocket reconnect replays from `change_log(ts > last_seen_ts)`

**Done when:** AC-07 (audit emission), AC-08 (approval persistence) pass via integration tests; a curl-driven smoke flow creates a node, opens an SCR, approves it.

---

### Phase 4 — Git Integration (1 week)

**Goal:** Every node mutation is reflected in `glm-sekkei/` as an ECN commit; `sekkei.lock` written on variant resolve; provenance via git notes.

**Deliverables:**
- `src/git/git-client.ts` — typed wrapper for `git add/commit/tag/notes/rev-parse/grep` over the configured sekkei repo path
- `src/git/yaml-store.ts` — canonical mapping between a node and its YAML file at `nodes/<stratum>/<glm_id>.yaml`
- `src/git/ecn-commit.ts` — builds the conventional commit message (`ECN: …` + `Affected:` + `Why:` + `Regen required:` + `SCR:` + `Signed-off-by:`)
- `src/git/sekkei-lock.ts` — serialize/parse `sekkei.lock`
- `src/git/git-notes.ts` — attach/read `refs/notes/generation`
- `src/git/hook-installer.ts` — copies pre-commit + pre-receive hooks into a target repo
- Integration tests: spin up a tmp git repo, perform an SCR cycle, assert commit message + tree contents

**Key design decisions:**
- The web app **writes the YAML file** to disk, then `git add` + `git commit` with the ECN message
- On startup, the app runs `git log -p nodes/` and reconciles SQLite against the repo (drift between DB and git is itself an error)
- Variant branches are real git branches; the app does `git checkout` against a worktree per workspace to keep operations isolated

**Done when:** A full SCR cycle (Draft → Implemented) produces a single ECN commit on `next`; `git log --grep="SCR-2090"` finds it.

---

### Phase 5 — Generation Pipeline (1.5 weeks)

**Goal:** Approved SCOs trigger regeneration; outputs written to `glm-realization/`; in-toto attestations signed and attached.

**Deliverables:**
- `src/generation/queue.ts` — in-process FIFO queue with concurrency cap
- `src/generation/llm-client.ts` — Anthropic client using prompt caching (5-minute TTL); model defaults to `claude-sonnet-4-6`
- `src/generation/cache.ts` — content-addressed cache (`sha256(content_hash || binding_hash || generator_identity)` → artifact bytes); backed by a local content-addressed directory
- `src/generation/pipeline.ts` — orchestrates: probe cache → on miss, invoke LLM → run verifier → emit attestation → write `REGENERATED_FROM`
- `src/generation/attestation.ts` — builds the in-toto Statement per spec §5.9 and wraps in DSSE
- Integration tests with a mocked LLM client

**Key design decisions:**
- Each generation event produces exactly one row in `provenance_events`; cache hits get `tokens_in=tokens_out=0`
- DSSE signing uses an ephemeral Fulcio cert in dev; in prod, configured KMS key
- Verifier failure (`spec.acceptance.verifier.command` non-zero) marks the generation `INCOMPLETE` and opens an issue rather than committing

**Done when:** AC-32 through AC-36 (provenance behavior) pass; cost telemetry recorded.

---

### Phase 6 — PWA Shell & Read Surfaces (2 weeks)

**Goal:** A browser-installable PWA with the four read-only views.

**Deliverables:**
- `public/index.html` + service worker
- `public/manifest.json` for PWA install
- `public/js/app.js` — router + topbar + nav rail (matches mockup's three-zone layout, §4.1)
- `public/js/components/*` — all 9 shared UI primitives from spec §4.5
- `public/js/store.js` — replaces `window.__glm` with a proper observable store
- Views: **Dashboard** (00), **Sekkei Browser** (01), **Where-Used** (04), **Provenance & Audit** (08)
- WebSocket-driven live updates for activity feed and node detail
- E2E tests covering AC-01 through AC-05, AC-15 through AC-18, AC-32 through AC-36

**Key design decisions:**
- Vanilla ES modules (no React, no bundler) — the mockup proves this works at the spec's scale
- Components are small classes exporting `render(props) → HTMLElement`
- Service worker caches the shell + static API responses (workspace metadata, stratum colors)
- IndexedDB stores the last-seen `change_log` cursor for WebSocket replay

**Done when:** A user can browse all sekkei nodes, follow Where-Used links, and watch live activity in Dashboard — all offline-readable.

---

### Phase 7 — PWA Write Surfaces (2 weeks)

**Goal:** All five write/orchestration views functional.

**Deliverables:**
- **Change Management** (02): SCR create/edit/transition forms, diff editor, approval flow
- **Variant Resolution** (03): parameter binding panel, pipeline visualization, `sekkei.lock` preview + copy
- **Effectivity & Rollout** (05): rollout table with advance button, pin-policy editor, channel promotion
- **Drift Reconciliation** (06): drift list with resolution actions (heal / SCR / waiver / suspend)
- **Reuse & Inheritance** (07): candidate list, promotion lifecycle stepper, steward assignment
- Soft-lock UI: "locked by X" indicator on nodes; 30s heartbeat
- IndexedDB write queue for offline drafts; flush on reconnect with conflict UI

**Done when:** AC-06 through AC-10, AC-19 through AC-31 pass in e2e.

---

### Phase 8 — Vibe Mode (1 week)

**Goal:** Conversational interface to the GLM agent that respects all approval gates.

**Deliverables:**
- `public/js/views/vibe-mode.js` — chat transcript + process console (spec §5.10)
- Agent rich-card types: `agent_text`, `plan`, `clarifier`, `scr_draft`, `drift_card`, `choice`, `gate`, `resolution_card`, `result`
- Intent classification: regex match → three scripted scenarios + LLM fallback
- Server-side agent endpoint that streams console events over WebSocket
- Enforcement: server **rejects** any agent-initiated transition that would skip an approval gate (Class I auto-approve, drift auto-heal on non-`auto-heal` policy, etc.) — this is mandatory, not just UI restraint
- E2E tests covering AC-37 through AC-41

**Key design decisions:**
- The agent runs server-side as a special principal (`vibe-agent`) with bounded permissions
- Console events use the same `event_bus` as other workspace events; just tagged `source=vibe`
- Suggestion chips disappear after first user message (AC-41) — controlled by the store, not the view

**Done when:** All three scripted scenarios from `mockup/views/vibe.jsx` reproduce end-to-end against the real backend.

---

### Phase 9 — Verifier (4 days)

**Goal:** The 6-gate verifier (from `specification/`) runs on-demand and as a post-merge background job.

**Deliverables:**
- `src/verifier/gates.ts` — port the existing `verify_sekkei.py` logic (or shell out to it; decision recorded in ADR)
- Gate 2.b: validate `system_role` discriminator on `system`-stratum nodes (per v1.1.9)
- `src/verifier/runner.ts` — post-merge trigger via git hook + on-demand REST endpoint
- Results written to `verification_runs` table; surfaced in Dashboard

**Done when:** A merge that violates any gate is blocked at the pre-receive hook; a verifier failure is visible in the UI within one polling interval.

---

### Phase 10 — Hardening (1.5 weeks)

**Goal:** Production-ready.

**Deliverables:**
- **Performance:** profile against spec §8.1 targets; index tuning; query plan review
- **Security:** OWASP top-10 review; CSRF (not applicable to API tokens, but verify cookies); rate limiting; SAML/OIDC integration if needed
- **Observability:** structured logging; audit event coverage check; ensure every state-changing endpoint emits an `audit_events` row
- **Backup/restore:** `bun-sqlite-backup` script; documented restore procedure
- **Documentation:** `README.md` build/run/deploy section; `docs/adr/` entries for major decisions
- **DSSE bundle export:** `POST /provenance/export` produces a valid newline-delimited DSSE bundle
- **Load test:** simulate 50 concurrent editors against the soft-lock + WebSocket fan-out

**Done when:** All NFRs in spec §8 are measured and within target; security review checklist complete.

---

## 6. Acceptance Criteria Coverage

The 41 acceptance criteria from spec §5 map to phases as follows:

| AC range | View | Phase |
|----------|------|-------|
| AC-01..05 | Sekkei Browser | Phase 6 |
| AC-06..10 | Change Management | Phase 7 |
| AC-11..14 | Variant Resolution | Phase 2 (logic) + Phase 7 (UI) |
| AC-15..18 | Where-Used | Phase 2 (logic) + Phase 6 (UI) |
| AC-19..22 | Effectivity & Rollout | Phase 7 |
| AC-23..27 | Drift Reconciliation | Phase 7 |
| AC-28..31 | Reuse & Inheritance | Phase 7 |
| AC-32..36 | Provenance & Audit | Phase 5 (emission) + Phase 6 (UI) |
| AC-37..41 | Vibe Mode | Phase 8 |

Every AC has an e2e test in `tests/e2e/` named `ac-NN-<short>.spec.ts`. The CI must run the full e2e suite on every PR to `next` and `main`.

---

## 7. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Soft-lock + LWW produces silent data loss under contention | Medium | High | Phase 10 load test with 50 concurrent editors; if lost, escalate to short-lived CRDT for body field only |
| Vanilla JS UI becomes hard to maintain past 10 views | Medium | Medium | Component contract is small (`render(props) → HTMLElement`); refactor to lit-html if churn proves it |
| Generation pipeline costs spiral with low cache hit rate | Medium | High | Phase 5 sets `tokens_saved_by_cache` as a first-class metric; alerts if hit rate < 50% |
| Git-as-source-of-truth vs. SQLite-as-cache drift | Low | High | Phase 4 boot-time reconciliation; verifier gate that the DB matches the repo |
| LLM provider availability / latency | Medium | Medium | Queue is async; UI never blocks on generation; graceful degradation in Vibe Mode (AC-40) |
| DSSE / Sigstore integration complexity | Low | Medium | Spike in Phase 5 day 1 to confirm signing flow; fallback to plain JSON-Web-Signature if needed |
| Verifier perf at 200+ nodes | Low | Medium | Profile in Phase 9; pre-compute gate inputs incrementally |
| PWA service-worker offline-write conflict UX | Medium | Medium | Phase 7 dedicates time to the conflict UI; design two-screen merge dialog |

---

## 8. Architecture Decisions

Decisions recorded from the `glm-db-git-architecture.md` review (2026-05-12). These supersede the open questions in that document's §8.

### 8.1 Push policy
**Decision:** Per-workspace flag, default **off**. SCR-implement commits land in the local clone only. Push happens when a user explicitly clicks "Push to origin" in the Workspace settings, or via an optional CI cron. Rationale: teams want to batch several SCRs before triggering a remote push; auto-push would be disruptive during a design session.

**Implementation impact (Phase 4):** The workspace settings view must expose a "Push to origin" button and a "Push on every SCR merge" toggle. `src/git/sekkei-git-service.ts` gates the `git push` call on `workspace.git_auto_push === true`.

### 8.2 Authentication
**Decision:** External auth provider in v1 (SAML/OIDC); GLM does not own credentials. Roles are: `admin`, `contributor`, `reviewer`, `guest` (read-only). Rationale: production teams already have an IdP; re-implementing auth is out of scope and a security liability.

**Implementation impact (Phase 3):** The auth middleware validates the IdP-issued JWT and maps it to the four-role model. Role-based permission checks are enforced at the route layer, not the view layer. A dev-mode bypass (environment variable) allows testing without an IdP.

### 8.3 Conflict resolution on pull
**Decision:** Fast-forward only on pull. If the upstream `next` has diverged, GLM surfaces a workspace-level banner ("Upstream has diverged — resolve before pushing") with a "Resolve" link that opens a dedicated Conflict Resolution UI. No auto-merge of sekkei nodes. Rationale: a sekkei is a structured semantic artifact; a 3-way text merge is not meaningful at the YAML level.

**Implementation impact (Phase 4):** `git pull --ff-only` is the default; on non-fast-forward exit code, insert a `workspace_conflict` row and emit a `conflict.detected` event. The Conflict Resolution UI (Phase 7) presents node-by-node diffs and requires explicit per-node choices.

### 8.4 PR vs. direct commit
**Decision:** If the workspace declares a forge (`git_forge = "github"` or `"gitlab"`), SCR-implement produces a PR via the forge API. Otherwise the ECN commit goes directly to `next` in the local clone. Rationale: PRs add a CI gate and a second-reviewer surface that is the PLM-correct posture; but for local or un-hosted repos, a PR is not meaningful.

**Implementation impact (Phase 4):** `src/git/sekkei-git-service.ts` checks `workspace.git_forge`; if non-null, uses the forge REST API to open a PR after creating the feature branch. The PR URL is stored in `scrs.git_pr_url`.

### 8.5 Realization repo binding
**Decision:** One realization repo per sekkei workspace, named `<sekkei-name>-realization`. For the rare edge case where one workspace generates into multiple realization repos, the per-Component `realization_repo` field on the Component node overrides the default. Rationale: a 1:1 relationship keeps the binding simple and auditable; multi-repo is an escape hatch, not the default.

**Implementation impact (Phase 5):** `REALIZATION_REPO_PATH` in `.env` is the default; the generation pipeline checks `component.realization_repo` first and falls back to the env var.

### 8.6 Generation cache durability
**Decision:** Cache bytes live in `data/cache/<sha256-prefix>/<sha256>.bin` on the server filesystem. Survives DB wipes but not disk loss. An S3-compatible backend behind the `GenerationCache` interface is **Phase 2** (not v1). Rationale: for a single-tenant install, local disk is sufficient and eliminates an external dependency from v1.

**Implementation impact (Phase 5):** `src/generation/cache.ts` implements the `GenerationCache` interface against the local filesystem. The interface is defined such that a future `S3GenerationCache` is a drop-in replacement. Cache path is configurable via `CACHE_DIR` env var.

### 8.7 Self-import (dogfood)
**Decision:** When the attach-git feature ships (Phase 4), the default workspace that imports GLM's own sekkei gets `git_remote = file://./../glm-sekkei` pointing at this repository. This workspace becomes the dogfood case for every git-integration feature. Rationale: building GLM using GLM itself is the most honest integration test.

**Implementation impact (Phase 4):** The `scripts/seed.ts` seed script sets `git_remote` on the self-import workspace to the relative file path. The README documents the dogfood setup.

### 8.8 Spec-diff format for diff-aware regeneration
**Decision:** Structured diff `{ field: string, op: "added" | "removed" | "changed", old?: unknown, new?: unknown }[]` as the primary LLM input. A YAML unified diff is generated alongside as a fallback rendering (used in the UI diff viewer and when the structured format would exceed the context window). Rationale: the structured format allows the LLM to reason about semantic intent rather than raw text changes; the YAML diff is the human-readable audit trail.

**Implementation impact (Phase 5):** `src/generation/spec-diff.ts` computes both representations from two node body objects. The pipeline passes the structured diff to the LLM prompt builder; the YAML diff is stored in `generation_inputs.spec_diff_yaml` for display.

---

## 9. Default Branch Structure

This section defines the **recommended branch layout** for a GLM team of 1–2 people. Teams are free to evolve this structure, but GLM ships this as the out-of-the-box default.

### 9.1 Permanent branches

| Branch | Purpose | Who writes | Who merges |
|--------|---------|-----------|------------|
| `main` | Released trunk. Every commit on `main` is a shipped release. Never commit directly. | CI / release bot | Via PR from `next`, tagged simultaneously |
| `next` | Integration branch. All approved SCRs land here. Always deployable to staging. | ECN commits (from SCR implement), merge commits from `feature/` branches | Author (team of 1) or peer reviewer (team of 2) |
| `variants/<operator>` | Long-lived variant branch per deployment target (e.g., `variants/eu-prod`, `variants/saas-free`). Holds `sekkei.lock` for that operator. | GLM variant-publish action | GLM variant-publish action |

### 9.2 Short-lived branches

| Branch prefix | Created when | Deleted when | Example |
|--------------|-------------|-------------|---------|
| `feature/<scr-id>-<slug>` | SCR transitions to `Implemented` | SCR PR merges to `next` | `feature/SCR-2090-archive-todos` |
| `gen/<timestamp>-<component>` | Generation pipeline writes a new artifact to `glm-realization/` | Realization PR merges | `gen/20260510-0318-filter-engine` |

### 9.3 Release tags

Tags follow the PLM release naming convention from `glm-with-git.md`:

- **Format:** `A.N` where `A` is the release letter and `N` is a monotonic integer (e.g., `A.0`, `A.1`, `B.0`).
- **Signed:** all release tags are GPG-signed annotated tags (`git tag -s`).
- **Immutable on origin:** `main` and release tags are protected. Force-push is rejected by the pre-receive hook.

### 9.4 Team-of-1 simplification

A solo engineer can operate without PRs by setting `git_forge = null` on the workspace. In this mode:

- ECN commits go directly from `feature/<scr-id>-<slug>` → `next` (the feature branch is created, committed, then fast-forward merged locally).
- Variant publish commits go directly to `variants/<operator>`.
- Release cut runs the sign-and-tag script and pushes `main` + tag.
- The branch lifecycle is: `next` is always current; `main` advances only on intentional release.

The two-branch minimal layout for a solo engineer is therefore: **`main` + `next`**, with short-lived `feature/` branches created and deleted automatically by GLM.

### 9.5 Team-of-2 workflow

With two contributors, the PR path is the recommended default:

1. Engineer A creates an SCR, edits nodes, clicks "Submit".
2. Engineer B reviews in GLM (Change Management view), approves; SCR transitions to Approved.
3. Either engineer clicks "Implement" → GLM creates `feature/<scr-id>-<slug>`, writes the ECN commit, opens a PR to `next`.
4. The other engineer reviews the PR (or a time-boxed auto-approve window of 24h is acceptable for low-risk changes).
5. On merge, GLM's `post-merge` hook triggers variant re-resolution and queues generation.
6. When the sprint is ready to ship: `git tag -s A.1 -m "Release A.1 — <summary>"` on `next`; GLM's release workflow merges `next → main` and pushes both.

### 9.6 Three-repo structure

The default layout across repositories:

```
glm-sekkei/          ← source of truth; branches above apply here
  main
  next
  feature/<scr-id>-<slug>  (transient)
  variants/<operator>
  A.0, A.1, …  (signed tags)

glm-realization/     ← generated; never merged back into glm-sekkei
  main               ← stable generated artifacts
  gen/<ts>-<comp>    (transient; each generation lands as a PR)

glm-catalog/         ← shared Standard Parts; pulled via git subtree
  main               ← single protected branch
  v1.0.0, v1.1.0, … (semver tags)
```

### 9.7 Anti-patterns (ship with pre-receive hooks)

The following are rejected by the pre-receive hook that GLM installs:

- Direct push to `main` (always; no exceptions).
- Force-push to `next` or any `variants/` branch.
- Merging `glm-realization/` back into `glm-sekkei/`.
- A commit on `main` without a matching signed release tag.

---

## 10. Remaining Open Questions

These need decisions before or during the corresponding phase:

1. **Worktree per workspace vs. branch checkout per request?** *(Phase 4)* — worktrees scale better with many concurrent variant operations but cost disk. Decide based on expected variant count at integration test time.
2. **CEL interpreter scope.** *(Phase 2)* — does v1 need full CEL semantics, or is the subset used in the mockup (equality, set membership, length, boolean) enough? Recommendation: mockup subset only; document as `glm-cel-subset` so teams have a named target.
3. **Single-tenant DB file vs. shared DB with `workspace_id`?** *(Phase 1)* — the spec says single-tenant per org; recommendation: one SQLite file per org, multi-workspace tables (keeps backup/restore simple).
4. **dBOM repo schema.** *(Phase 5)* — spec mentions `glm-dbom/` as a separate repository but does not define its layout. Defer to a Phase 5 design spike; produce an ADR before coding.
5. **Vibe Mode model choice.** *(Phase 8)* — `claude-sonnet-4-6` for cost / `claude-opus-4-7` for quality? Recommendation: Sonnet 4.6 default with opt-in Opus on disambiguation requests (per-workspace config).
6. **Verifier port: TS rewrite vs. shell out to Python?** *(Phase 9)* — Python validator exists and is tested; shell-out keeps it canonical but adds a runtime dep. Recommendation: shell out for v1, record in ADR, rewrite only if performance demands it.
7. **PWA install prompts.** *(Phase 6)* — how aggressively to surface the install banner? Conservative default: prompt only after two visits. Record UX rationale in ADR.
8. **API versioning policy.** *(Phase 3)* — `/api/v1/...` is in the spec; what triggers a v2 bump? Decision needed: breaking-change policy document before Phase 3 starts.

---

## 11. First Sprint (Week 1)

If we start tomorrow, the first sprint covers Phase 0 + Phase 1:

| Day | Work |
|-----|------|
| 1 | Project bootstrap: package.json, tsconfig, biome, .env.example, Hono health endpoint |
| 2 | CI green; ADR-0001 "Why Bun + Hono"; ADR-0002 "Vanilla ES modules in public/" |
| 3 | `migrations/0001_initial.sql` with all 14 tables; `src/repository/db.ts` |
| 4 | Node + SCR repositories with full CRUD + tests |
| 5 | Variant + drift + provenance + audit repositories with tests |
| 6 | Content-hash module + round-trip tests; `scripts/seed.ts` populates from `mockup/data.jsx` |
| 7 | Demo: a CLI walk of the seeded workspace; PR for Phase 0+1 |

End of Week 1: the repository can be browsed and queried from a CLI; foundation ready for Phase 2.
