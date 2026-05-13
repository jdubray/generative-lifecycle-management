# GLM Solo CLI

Standalone CLI for **GLM Solo mode** — a single developer authors and regenerates sekkeis from the terminal, using Claude Code as the LLM agent and a local GLM server as the persistence backend.

> Status: **Phase 1 scaffold.** The binary runs, prints help, and exposes the command list. Command bodies are stubs that print "not yet implemented" — see `IMPLEMENTATION_PLAN.md` for the rollout.

---

## Why a separate project?

The main GLM repo is a Bun + Hono web server. This CLI:

- Talks to GLM **only over HTTP** (`http://localhost:${PORT}`). No code-level dependency on the server's internals.
- Spawns the `claude` binary as a subprocess for vibe design, reverse engineering, and node refinement.
- Has a separate release cadence and can be pinned independently.

See [`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md) for the architecture, phased delivery, and acceptance criteria.

---

## Prerequisites

- **Bun** ≥ 1.1.0
- **Claude Code CLI** on `PATH` (`claude --version` works)
- **GLM server** running locally (`bun run src/server/server.ts` from the main repo)

---

## Quickstart (current phase)

```bash
cd integrations/cli
bun install
bun run src/bin/glm.ts --help
bun run src/bin/glm.ts --version
```

To put it on your `PATH` once Phase 2 lands:

```bash
bun link
glm --help
```

---

## Commands (target — see `IMPLEMENTATION_PLAN.md` for status)

| Command | Phase | Status |
|---------|------:|--------|
| `glm --help` / `glm --version` | 1 | ✅ implemented |
| `glm status` | 2 | ✅ implemented |
| `glm vibe` | 4 | ✅ implemented |
| `glm init` | 4.5 | ✅ implemented |
| `glm vibe --from-dir <path>` | 7 | ✅ implemented |
| `glm verify` | 5 | ✅ implemented |
| `glm generate --component <id>` | 6 | ✅ implemented (cross-platform; Windows runs are slower) |
| `glm refine --node <id>` | 8 | ✅ implemented |
| `glm import-sekkei <file>` | 8 | ✅ implemented |

---

## Configuration

All commands read configuration from (in order):

1. CLI flags (`--port`, `--workspace`, `--token`)
2. Environment variables (`PORT`, `GLM_WORKSPACE`, `GLM_SOLO_TOKEN`, `GLM_CLAUDE_MODEL`)
3. `~/.glm/config.json`

Defaults: `port=3000`, `workspace=default`, `model=claude-sonnet-4-6`.

---

## Platform support

| Command | macOS / Linux | Windows |
|---|---|---|
| `init`, `status`, `verify`, `import-sekkei` | ✅ | ✅ |
| `vibe`, `refine` | ✅ | ✅ |
| `generate` | ✅ | ✅ (slower; see note) |

**Windows generation note.** `glm generate` on Windows runs to completion but produces no on-screen output while claude is generating — the CLI captures stdout only at exit. A 4-file generation on a large component spec takes roughly **8–12 minutes** on Sonnet 4.6; you'll see the `generate: invoking ...` line and then nothing until claude finishes. We earlier mistakenly added a Windows block to this command; that block has been removed.

If you want progress visibility while testing, you can watch claude's process state from another terminal:

```powershell
Get-Process claude -ErrorAction SilentlyContinue | Format-Table Id, CPU, StartTime
```

On parse failure (claude emits prose instead of `=== FILE: <path> ===` blocks), the CLI preserves the raw response in a temp directory printed in the error — `cat` it to debug.

---

## Tests

```bash
bun test              # unit + e2e
bun test:unit         # unit only (no network, no claude binary)
RUN_E2E=1 bun test:e2e
```

---

## References

- **Spec:** [`../../docs/solo-mode-spec.md`](../../docs/solo-mode-spec.md)
- **Authoring skill (loaded into Claude's system prompt for vibe design):** [`../../docs/sekkei-authoring.md`](../../docs/sekkei-authoring.md)
- **User manual:** [`../../docs/user-manual.md`](../../docs/user-manual.md)
