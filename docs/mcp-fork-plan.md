# MCP Fork — Server-side LLM call replaced by Claude-Code MCP tools

**Status:** Plan + scaffolding · **Branch:** `main`
**Owner:** Full-stack
**Companion plan:** `integrations/mcp/IMPLEMENTATION_PLAN.md`

---

## 1. Motivation

Solo-mode UC-02 originally had the GLM server spawn `claude --print` server-side and capture its multi-file output. On Windows, this hangs: a child `claude.exe` launched from inside a long-running Bun.serve fetch handler produces zero bytes for the full 240 s timeout. The same spawn from a one-shot `bun -e` script returns in ~5 s. The hang is reproducible only when the parent has the full GLM server state open (SQLite WAL handles, websocket upgrade infrastructure, registered routes); a minimal `Bun.serve({fetch}) + spawn` reproducer in `bun -e` does **not** hang.

Rather than chase the exact Windows handle-inheritance trigger, this fork **inverts the control flow**: the server no longer spawns Claude. Claude Code running in the user's interactive session calls GLM tools through an MCP server.

## 2. Architecture change

```
Before (broken on Windows):

  user CLI  ───►  GLM server  ───►  spawns claude.exe  (HANGS)
                       │
                       └──► writes files, records provenance, runs verifier

After:

  user types /glm-generate in Claude Code
       │
       ▼
  Claude Code (user's terminal, already OAuth-authenticated)
       │
       │ MCP stdio
       ▼
  glm-mcp ───────► GLM HTTP API (data + verifier + provenance)
       │
       ▼
  Claude Code uses its built-in Write tool to write files locally,
  calls glm_record_generation to attest server-side
```

Claude Code is the LLM caller. It already works on every OS because the user's interactive shell is the auth context that has always worked. The GLM server stops spawning Claude entirely; it becomes a pure data layer plus verifier orchestrator plus provenance ledger.

## 3. Why this works without an Anthropic API key

The user is already running Claude Code locally. Claude Code's OAuth/keychain auth works in their shell — proven by every `claude --print …` invocation throughout debugging. The MCP server `glm-mcp` is a thin process launched by Claude Code via stdio; it never makes an LLM call. It only translates MCP tool requests into GLM HTTP requests. The LLM call happens inside Claude Code, using Claude Code's own auth.

No `ANTHROPIC_API_KEY` is required on the server or on the developer's machine.

## 4. Roles

| Component | Today (broken) | After fork |
|---|---|---|
| GLM server | Spawns claude, writes files, runs verifier, records provenance | Serves sekkei data, runs verifier on request, records provenance via API |
| CLI (`glm`) | `init`, `status`, `vibe`, `verify`, `generate`, `refine`, `import-sekkei` | Same minus `generate` (which moves to `/glm-generate` slash command) |
| Claude Code | Spawned by server in UC-02 (hangs) | User's interactive LLM, drives generation locally via MCP tools |
| **`glm-mcp` (new)** | — | Stdio MCP server; thin HTTP client to GLM; exposes tools to Claude Code |
| `.claude/commands/glm-*.md` (new) | — | Slash-command shims that orchestrate MCP tool calls |

## 5. Tool surface (initial)

Read-only:
- `glm_status` — workspace summary
- `glm_list_components` — enumerate components
- `glm_get_node` — fetch any node by glm_id
- `glm_get_component_spec` — composite: `{ component, spec.prompt, spec.acceptance, context_bundle (resolved), outputs[], hard_constraints, source_dir }`

Verifier:
- `glm_verify` — run the 7-gate sekkei verifier
- `glm_run_acceptance_verifier` — run a component's `verifier.command` with cwd = source_dir

Mutating:
- `glm_record_generation` — `{ component_id, files: [{ path, sha256, bytes }], verifier_exit_code }` → inserts provenance + audit
- `glm_apply_patch` — JSON Patch to a node body (for refine flows)

## 6. Generation flow (replaces server-side `solo-generate.ts`)

User: `/glm-generate petco:web.shop.cart.cart_manager`

Slash-command template expands to roughly:

1. Call `glm_get_component_spec(component_id=$1)`.
2. Follow the returned `prompt_template + hard_constraints`. Generate each file in `outputs[]` using the Write tool, under `source_dir`.
3. Call `glm_run_acceptance_verifier(component_id=$1)`.
4. If exit==0, call `glm_record_generation` with file hashes. Done.
5. If exit!=0, examine the error, fix the relevant files, re-run the verifier.

Claude Code already does this kind of orchestration natively. No `--system-prompt-file`, no multi-file `=== FILE: <path> ===` delimiter parsing, no subprocess.

## 7. What gets removed from the server

- `src/generation/solo-generate.ts` — server-side LLM call. Removed entirely.
- `src/server/routes/solo-generate.ts` — `POST /workspaces/:id/solo-generate` route. Removed.
- `tests/integration/server/solo-generate.test.ts` — removed.
- `integrations/cli/src/commands/generate.ts` — replaced with a stub that prints "use `/glm-generate` in Claude Code." Or removed entirely if we're confident no script depends on it.

## 8. What gets added to the server

- `POST /api/v1/workspaces/:id/acceptance-verify` — runs an arbitrary verifier command in a workspace's `source_dir`. Reuses the existing `defaultVerifierRunner` logic (which works fine — was never the spawn-hang case).
- `POST /api/v1/workspaces/:id/record-generation` — accepts the file-hashes + verifier-exit payload, inserts provenance + audit rows. Reuses existing `provenance-repository.ts` and `audit-repository.ts`.
- `GET /api/v1/workspaces/:id/components/:glm_id/spec` — composite endpoint returning prompt+acceptance+resolved-context-bundle in one shot, so `glm_get_component_spec` is a single HTTP call.

These additions are tiny — each is ~30-50 lines wrapping existing repos.

## 9. Auth model (unchanged)

`glm-mcp` reads `~/.glm/config.json` at startup for `port`, `workspace`, and `token`. Each HTTP call sends `Authorization: Bearer <token>`. The server validates via the existing solo-token short-circuit in `src/server/middleware/auth.ts` — same path the CLI uses today.

## 10. Migration

Out of scope for this fork (keep working as-is):
- CLI commands: `init`, `status`, `vibe`, `verify`, `refine`, `import-sekkei`. These either don't spawn Claude server-side, or spawn it client-side (vibe) where it works.

Removed:
- CLI `generate` command. User-facing migration message: "Use `/glm-generate` in Claude Code." (For CI scripts that need headless generation: a future Phase J could add an `ANTHROPIC_API_KEY`-mode opt-in. Not v1.)

Added:
- `integrations/mcp/` package.
- `.claude/commands/glm-*.md` slash command shims (installable to `~/.claude/commands/`).

## 11. Open design questions

1. **Distribution.** v1: in-repo, install via `bun link`. Future: publish `@glm/mcp` to npm so `npx @glm/mcp@latest` works from any project.
2. **Multi-workspace.** Tools accept optional `workspace_id` arg defaulting to `~/.glm/config.json`. Sufficient for v1.
3. **Slash command installation.** Provide a `glm install-claude-commands` CLI subcommand that copies `.claude/commands/glm-*.md` into `~/.claude/commands/`? Or document a manual `cp`? v1: document the `cp`; tooling later.

## 12. Phasing

See `integrations/mcp/IMPLEMENTATION_PLAN.md` for the phase breakdown and per-phase deliverables.
