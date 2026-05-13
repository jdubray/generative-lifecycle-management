# GLM Solo CLI — Implementation Plan

**Target spec:** `docs/solo-mode-spec.md`
**Authoring skill (consumed by Claude CLI):** `docs/sekkei-authoring.md`
**Status:** Plan + scaffolding · **Branch:** `main`
**Owner:** Full-stack

---

## 1. Goal

Deliver a standalone `glm` CLI binary that lets a single developer author and regenerate sekkeis from the terminal — Claude Code CLI as the LLM agent, a local GLM server (Bun + Hono) as the persistence and verification backend.

Five user-flows must work end-to-end:

| UC | Command | Outcome |
|----|--------|--------|
| UC-01 | `glm vibe` | Plain-language → sekkei YAML → imported into local DB |
| UC-02 | `glm generate --component <id>` | Resolve `spec.prompt` context bundle → Claude CLI → files on disk + verifier green + provenance row |
| UC-03 | `glm verify` | Stream 6-gate verifier output |
| UC-04 | `glm vibe --from-dir <path>` | Walk an existing codebase → reverse-engineered sekkei |
| UC-05 | `glm refine --node <id>` | One-node JSON-Patch refinement via Claude CLI |

Plus supporting commands: `glm init`, `glm status`, `glm import-sekkei`.

## 2. Why a standalone project (`integrations/cli/`)

The main GLM repo is a Bun + Hono web server. The Solo CLI:

- Talks to GLM **only over HTTP** (`http://localhost:${PORT}`). No code-level dependency on `src/` modules.
- Spawns `claude` as a child process. The main server does not.
- Has a separate release cadence — CLI users may pin to an older `glm` server.
- Is installable as its own npm package (`@glm/cli` or similar) without dragging in the server.

Standalone means: own `package.json`, own `tsconfig.json`, own test suite, own README. The only shared artifact is the **HTTP contract** — defined in the solo-mode spec.

Files in this repo that the CLI references at runtime:
- `docs/sekkei-authoring.md` — loaded as Claude's system prompt for vibe design
- `specification/sekkei.schema.json` — JSON schema for sekkei validation

These are resolved via the `GLM_REPO_ROOT` env var (defaults to walking up from the CLI binary's location).

## 3. Architecture

```
┌────────────────┐    HTTP/SSE        ┌──────────────────┐
│    glm CLI     │  ───────────────►  │   GLM server     │
│  (this proj)   │                    │  (main repo)     │
│                │  ◄───────────────  │  Bun + Hono      │
│                │                    │  bun:sqlite      │
└────────┬───────┘                    └────────┬─────────┘
         │                                     │
         │ spawnSync / spawn                   │ spawnSync (when called by server-side)
         ▼                                     ▼
   ┌──────────────┐                     ┌──────────────┐
   │  claude CLI  │ ◄ user-facing       │  claude CLI  │ ◄ server-side
   │  --print     │   for UC-01/04/05   │  --print     │   for UC-02 generation
   │  stream-json │                     │              │
   └──────────────┘                     └──────────────┘
```

Two Claude CLI invocation paths:

- **CLI-side** (UC-01 vibe, UC-04 reverse-engineer, UC-05 refine): the local `glm` binary spawns `claude` itself, posts the result to GLM via `POST /workspaces/:id/import-sekkei` (or `/refine`). Keeps generation traffic out of the server process.
- **Server-side** (UC-02 generate): the GLM server spawns `claude` so it can attach provenance and run the verifier inside the workspace's source dir. The CLI just streams SSE.

Both paths use the same prompts (defined in `prompts/`) so behavior is identical.

## 4. Project structure

```
integrations/cli/
├── IMPLEMENTATION_PLAN.md          ← this doc
├── README.md
├── package.json
├── tsconfig.json
├── biome.json
├── .gitignore
├── src/
│   ├── bin/
│   │   └── glm.ts                  ← entrypoint (#!/usr/bin/env bun)
│   ├── commands/
│   │   ├── index.ts                ← command registry + dispatcher
│   │   ├── help.ts
│   │   ├── version.ts
│   │   ├── init.ts                 ← UC bootstrap
│   │   ├── status.ts
│   │   ├── vibe.ts                 ← UC-01 / UC-04
│   │   ├── verify.ts               ← UC-03
│   │   ├── generate.ts             ← UC-02
│   │   ├── refine.ts               ← UC-05
│   │   └── import-sekkei.ts
│   ├── lib/
│   │   ├── glm-client.ts           ← HTTP wrapper around GLM REST API
│   │   ├── claude-cli.ts           ← subprocess wrapper (one-shot + stream-json)
│   │   ├── sse.ts                  ← SSE consumer (fetch stream → async iterator)
│   │   ├── prompts.ts              ← builds vibe / generate / refine prompts
│   │   ├── config.ts               ← loads ~/.glm/config.json + env overrides
│   │   ├── argv.ts                 ← argv parser (no external dep)
│   │   └── errors.ts               ← typed errors with exit-code mapping
│   └── prompts/
│       ├── vibe-design.txt         ← UC-01 system prompt scaffold
│       ├── reverse-engineer.txt    ← UC-04 system prompt scaffold
│       └── refine.txt              ← UC-05 system prompt scaffold
├── tests/
│   ├── unit/
│   │   ├── argv.test.ts
│   │   ├── glm-client.test.ts      ← mocked fetch
│   │   ├── claude-cli.test.ts      ← mock `claude` binary on PATH
│   │   └── prompts.test.ts
│   └── e2e/
│       └── smoke.test.ts           ← spawns real CLI; no network
└── scripts/
    └── install.sh                  ← optional: symlink to /usr/local/bin
```

## 5. Phased delivery

Each phase is one PR-sized chunk. Each ends with `bun test` green and a working subset of `glm`.

### Phase 1 — Scaffolding *(this PR — about to land)*

- Directory structure, `package.json`, `tsconfig.json`, `biome.json`, `.gitignore`, README.
- Entrypoint `src/bin/glm.ts` that prints `--version` and `--help`.
- Argv parser (`src/lib/argv.ts`) — small handwritten parser; no external dep.
- One smoke test proving the binary runs.

**Done when:** `bun run src/bin/glm.ts --help` prints the command table.

### Phase 2 — HTTP client + config (`glm status`)

- `glm-client.ts`: typed wrappers for `GET /health`, `GET /workspaces/:id`, `GET /workspaces/:id/verify`.
- Auth: reads `GLM_SOLO_TOKEN` from env or `~/.glm/config.json`; sends `Authorization: Bearer …`.
- `glm status` command: probes server, prints workspace summary + verifier pass/fail counts.

**Done when:** Against a running GLM server with a seeded workspace, `glm status` shows node counts.

### Phase 3 — Claude CLI subprocess wrapper

- `claude-cli.ts`: typed `runOneShot({ systemPromptFile, userText, model })` → stdout string. Spawns `claude --print --model … --system-prompt-file …`.
- Windows-safe termination (use `taskkill /pid <PID> /T /F` on win32; `SIGTERM` elsewhere).
- Error handling: detect "claude not on PATH", surface as typed error with exit-code mapping.
- Stream-json variant (`runInteractive`) deferred to Phase 6.

**Done when:** Unit test using a mock `claude` script (echoes input to stdout) passes; "not on PATH" produces the spec'd error.

### Phase 4 — Vibe design (UC-01)

- Prompts: `prompts/vibe-design.txt` concatenates with `docs/sekkei-authoring.md` + `specification/sekkei.schema.json` at runtime.
- `glm vibe` command: interactive prompt for description (or `--description-file`), spawns Claude, streams the YAML output, posts to `POST /workspaces/:id/import-sekkei`, prints the import summary.
- **Server-side dep:** `POST /workspaces/:id/import-sekkei` already exists in `src/server/routes/import.ts`. No server changes needed for Phase 4.
- **New server endpoint required:** `POST /workspaces/:id/vibe` only if we want server-side spawning. For CLI-only UC-01, we don't; spawn locally.

**Done when:** `glm vibe` round-trips a one-paragraph description into a multi-node sekkei imported in the local DB.

### Phase 5 — Verifier streaming (UC-03)

- `glm verify` command: hits `GET /workspaces/:id/verify`, consumes the SSE stream, prints each gate result line-by-line with color (TTY only).
- **Server-side dep:** `/verify` endpoint exists but currently returns JSON. Convert to SSE in `src/server/routes/verifier.ts` (additive — keep JSON shape behind `Accept: application/json`).

**Done when:** `glm verify` prints gates 1–6 as they complete; final exit code reflects pass/fail.

### Phase 6 — Code generation (UC-02)

- New server endpoint: `POST /workspaces/:id/generate { component_id, dry_run }` → SSE stream per spec §5.2.
- Server logic: resolve `spec.prompt.body.context_bundle`, build prompt (server-side, never sent to CLI), spawn `claude --print`, write files to `workspaces.source_dir`, run `spec.acceptance.body.verifier.command`, record `provenance_events` row.
- CLI: `glm generate --component <id>` consumes the SSE, prints per-file written + verifier output + provenance event id.

**Done when:** Generating a Component produces real files and a `provenance_events` row with non-null `content_hash` and `artifacts`.

### Phase 7 — Reverse-engineer (UC-04)

- `glm vibe --from-dir <path>` scans the directory respecting `.gitignore`, builds a tree + up-to-20-file content excerpt, appends to the reverse-engineer prompt, dispatches via the same vibe path.
- File excerpt strategy: prefer README/package.json/tsconfig/main entry points; truncate at 200 lines per file.

**Done when:** Pointing `glm vibe --from-dir` at the GLM repo itself produces a sekkei that maps the workbench + engine sub-systems.

### Phase 8 — Refine + remaining commands (UC-05)

- `glm refine --node <id>`: reads the node, prompts for instruction, spawns Claude with refine prompt, applies returned JSON-Patch via `PATCH /workspaces/:id/nodes/:nodeId`.
- `glm init [--name <name>] [--port <port>]`: scaffolds `~/.glm/config.json`, generates `GLM_SOLO_TOKEN`, optionally `bun run` the server in the foreground.
- `glm import-sekkei <file.yaml>`: thin wrapper over the existing import endpoint.

**Done when:** All commands in spec §3.2 are implemented; the user manual gets a "Solo CLI" section.

### Phase 9 — Polish

- Color output (`NO_COLOR` respected).
- `--json` flag for machine-readable output on every command.
- E2E test that spins up a real GLM server, runs vibe→verify→generate.
- Publish to npm under `@glm/cli` (deferred; tag-only release first).

## 6. Test strategy

| Layer | Tool | What it covers |
|------|------|---------------|
| **Unit** | `bun test` | Argv parsing, prompt assembly, SSE consumer, GLM client (mocked fetch), Claude CLI wrapper (mock `claude` script via `PATH` override) |
| **Integration** | `bun test` | CLI commands against a stub HTTP server (Hono in-memory, no real DB) |
| **E2E** | `bun test` (slow tier) | Spin up real GLM server + temp SQLite DB + a fake `claude` binary; full vibe→verify→generate flow |

Unit/integration tests must run with no network and no `claude` binary installed. E2E tests are gated by `RUN_E2E=1`.

## 7. Server-side changes required (tracked separately)

Phases 5–6 require small additions to the main GLM repo:

1. **Phase 5:** `src/server/routes/verifier.ts` — add SSE response when `Accept: text/event-stream`.
2. **Phase 6:** new `src/server/routes/solo-generate.ts` — `POST /workspaces/:id/generate`, spawns `claude`, streams progress, records provenance. Distinct from the existing `/generation` routes which queue server-side LLM jobs.
3. **Phase 6:** `migrations/0015_workspace_source_dir.sql` — adds `source_dir TEXT` to `workspaces`.
4. **Phase 6:** auth middleware short-circuit when `GLM_SOLO_TOKEN` env var matches the `Authorization` header — implement once, used by all solo endpoints.

These will land as separate PRs to the main repo *after* the CLI scaffold proves the contract.

## 8. Out of scope (v0.1)

- Multi-user collaboration via the CLI (it's solo by definition).
- Remote GLM servers (HTTPS, real auth) — `localhost` only.
- Sekkei.lock distribution / variant management.
- Puffin GUI integration (separate workstream; Puffin uses the same REST API).
- Migrating away from `ANTHROPIC_API_KEY` to `claude` CLI's own credential store (open question #3 in the spec).

## 9. Open questions (deferred to in-flight decisions)

These come straight from `docs/solo-mode-spec.md` §7. Marking them so we don't re-discover them mid-implementation:

1. **Multi-doc YAML vs file-tree output for vibe design.** Plan: emit multi-doc YAML in Phase 4 (simpler). Add file-tree mode in Phase 9 only if multi-doc proves too large for `--print`.
2. **Streaming vs one-shot for large sekkeis.** Plan: one-shot for v0.1. Promote to stream-json if the timeout becomes a problem during dogfooding.
3. **Anthropic API key vs Claude CLI credentials.** Plan: rely on `claude` CLI's own credential store (the user is already authenticated to use `claude`). The GLM server never sees `ANTHROPIC_API_KEY`.
4. **sekkei.lock auto-update on generate.** Plan: do not auto-update in v0.1. Leave lock management to `glm` server's existing variant-publish flow.

## 10. Acceptance for v0.1

The CLI is considered complete when, on a clean machine with `bun`, `claude`, and `git` installed:

```bash
git clone <glm-repo> && cd glm
bun install
bun run src/server/server.ts &              # in another terminal
cd integrations/cli && bun install
bun link                                    # makes `glm` available globally
glm init --name todo-mvc
glm vibe --description "A TodoMVC clone with bun:sqlite and Hono"
glm verify                                  # all 6 gates pass
glm generate --component todo-mvc.repository
# → files written under ./todo-mvc/src/
# → bun test in that directory exits 0
# → provenance_event row exists in glm.db
```
