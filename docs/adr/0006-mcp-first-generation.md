# ADR 0006 — MCP-first generation (client drives the LLM, server stays data-only)

**Status:** Accepted
**Date:** 2026-05-13
**Deciders:** Full-stack thread
**Phase:** Solo-mode MCP fork (Phases A–H, see `integrations/mcp/IMPLEMENTATION_PLAN.md`)

## Context

The original Solo-mode UC-02 had the GLM server spawn `claude --print` from inside a Hono fetch handler, capture its multi-file response, write files, run the verifier, and record provenance — all server-side. On macOS and Linux this worked. On Windows it hung: a child `claude.exe` launched from inside the long-running `Bun.serve` produced zero bytes for the full 240 s timeout. A minimal `Bun.serve({fetch}) + spawn` reproducer in `bun -e` did **not** hang; the hang only manifested when the parent had the full GLM server state open (SQLite WAL handles, websocket upgrade infrastructure, all registered routes).

Three constraints turned this from "annoying bug" into "architectural pressure":

1. **Windows is a first-class developer surface.** The user runs Windows. Many enterprise sekkei authors run Windows. A Solo-mode flow that works on POSIX but hangs on Windows is not shippable.
2. **The original Solo-mode flow assumes a server-held `ANTHROPIC_API_KEY`.** This is the wrong economics for individual developers — they already pay for Claude Code's subscription, and asking them to provision and manage a separate API key inside a localhost server is friction the team product doesn't have.
3. **The GLM server is a multi-user product first.** Embedding LLM orchestration inside the server couples its operational profile (uptime, memory) to slow, bursty LLM calls. Even on POSIX, server-side spawning was a poor fit.

Late-stage end-to-end debugging revealed the "Windows hang" was partly misdiagnosed: claude was actually generating, just slowly (~21 min on a 4-file petshop component). The 240 s server-side timeout was killing it mid-flight. But by then the inversion was already the better architecture for the three reasons above, so we did not revert.

## Decision

Invert the control flow. The server stops spawning Claude. Two client-driven entry points cover UC-02:

- **CLI path.** `glm generate --component <id> --source-dir <dir>` spawns `claude --print` in the user's interactive shell — the same shell where their `claude` already authenticates. The CLI fetches a composite spec from the server, builds the prompt locally, writes files locally, then calls back to the server only for verification and provenance.
- **Claude Code path.** `/glm-generate <id>` is a slash-command template (`integrations/mcp/commands/glm-generate.md`). The user runs it inside Claude Code; Claude itself reads the component spec via MCP tools, uses its built-in `Write` tool to produce files under `source_dir`, runs the verifier through `glm_run_acceptance_verifier`, then records provenance through `glm_record_generation`. No subprocess at all — Claude's own LLM loop drives the generation.

To support both paths the server gained three small endpoints (each ~30–50 LOC, all reusing existing repos):

- `GET /api/v1/workspaces/:id/components/:glm_id/spec` — composite returning `{ prompt, acceptance, context_bundle (resolved), outputs[], hard_constraints, source_dir }` in one call.
- `POST /api/v1/workspaces/:id/acceptance-verify` — runs an arbitrary verifier command with `cwd = source_dir`.
- `POST /api/v1/workspaces/:id/record-generation` — inserts `provenance_events` + `audit` rows from a `{ files: [{ path, sha256, bytes }], verifier_exit_code }` payload.

The server-side `solo-generate.ts` module is **stashed but retained** as commented-out code in `src/generation/solo-generate.ts` along with a working Puffin recipe (`node:child_process.spawn` with `shell: true`). If a future Phase J needs headless CI-mode generation, it has a starting point. v1 does not ship that path.

A new package `integrations/mcp/` houses the MCP stdio server (`glm-mcp`) and the five slash-command templates (`glm-status`, `glm-list-components`, `glm-verify`, `glm-generate`, `glm-refine`). The MCP server is a thin HTTP client to the GLM REST API; it never makes an LLM call. The LLM call happens inside Claude Code, using Claude Code's own OAuth credentials.

## Alternatives considered

- **Keep server-side spawning and chase the Windows root cause.** The handle-inheritance specifics under `Bun.serve` are non-trivial; even with a fix, we'd still ship a flow that requires `ANTHROPIC_API_KEY` on the server and couples uptime to LLM latency. Rejected; the Windows hang surfaced a deeper architecture problem.
- **Adopt the Puffin recipe (`node:child_process.spawn` with `shell: true`) for server-side generation.** Puffin uses this same recipe and it works on Windows in their process model. We stashed the recipe in `solo-generate.ts` for reference, but did not adopt it as the production path — see reasons above. Available as a Phase J fallback if CI-mode demand materializes.
- **Anthropic SDK in the server.** Removes the spawn problem but doubles down on the "server holds the API key" anti-pattern. Rejected for Solo mode.
- **HTTP-transport MCP instead of stdio.** Would let one `glm-mcp` instance serve many editors. Overkill for v1; stdio per-Claude-Code-session is simpler and identical to the way every other MCP server in the ecosystem ships.
- **Generate via streaming `--input-format stream-json` server-side.** Same spawn-hang root cause; doesn't help. Rejected.

## Consequences

- **Positive:** No `ANTHROPIC_API_KEY` is required on the server or the developer's machine. Claude Code's existing OAuth/keychain is the only credential.
- **Positive:** UC-02 works on macOS, Linux, WSL, and native Windows. Validated end-to-end against the petshop `cart_manager` component on WSL (4 files, verifier PASS, provenance recorded).
- **Positive:** The GLM server stays a pure data layer + verifier orchestrator + provenance ledger. Its operational profile is no longer coupled to LLM latency or quotas.
- **Positive:** `/glm-generate` inside Claude Code is the canonical user-facing entry — feels native to where the user already does LLM-driven work.
- **Positive:** The CLI `glm generate` works as the non-interactive twin of `/glm-generate` for terminal-first developers and scripted regenerations.
- **Negative:** No headless / CI-only generation path in v1. A future Phase J would re-enable server-side generation behind an `ANTHROPIC_API_KEY`-mode opt-in.
- **Negative:** On Windows the CLI captures `claude --print` stdout in one shot at exit — no progress output during the run. A typical 4-file component takes 8–21+ minutes on Sonnet 4.6. Documented in the user manual; a follow-up could stream stdout to stderr.
- **Negative:** Two surfaces (CLI + slash command) means the prompt-construction logic has to live in two places: `integrations/cli/src/lib/generate-spec.ts` for the CLI, and `integrations/mcp/commands/glm-generate.md` for Claude Code. We accept the duplication for v1 — the markdown template is short, and the CLI path is the canonical reference.

## Follow-ups

- **Stream claude stdout to stderr during CLI generate.** Makes Windows runs less anxiety-inducing. ~30 min of work.
- **Phase J — server-side `ANTHROPIC_API_KEY`-mode endpoint** for CI / scripted regeneration. The Puffin spawn recipe stashed in `solo-generate.ts` is the starting point. Gated behind opt-in env vars; off by default.
- **Publish `@glm/mcp` to npm** so Claude Code users can wire it up with `npx -y @glm/mcp@latest` instead of an absolute path to a `bun run`.
- **Single `glm install-claude-commands` subcommand** that copies `integrations/mcp/commands/glm-*.md` into the user's `~/.claude/commands/`. v1 documents the `cp`; tooling later.
