# @glm/mcp — GLM MCP server for Claude Code

A stdio MCP server that exposes GLM sekkei + verifier + provenance operations as tools, so Claude Code can drive solo-mode generation directly from a user's interactive session.

See `docs/mcp-fork-plan.md` for the architectural overview and `IMPLEMENTATION_PLAN.md` for the phased build.

## Status

Phase A — scaffolding + `glm_status` tool. Read-only.

## Install (local development)

From the repo root:

```bash
cd integrations/mcp
bun install
bun link
```

## Wire into Claude Code

Add an `mcpServers.glm` entry to `~/.claude/settings.json` (or per-project `.claude/settings.json`):

```json
{
  "mcpServers": {
    "glm": {
      "command": "bun",
      "args": ["run", "<absolute-path-to-this-repo>/integrations/mcp/src/bin/glm-mcp.ts"]
    }
  }
}
```

The MCP server reads `~/.glm/config.json` (populated by `glm init`) for `port`, `workspace`, and `token`.

## Available tools (Phase A)

- `glm_status` — return the current workspace summary (counts by stratum/status, last verifier run)

More tools land in Phase B onward — see `IMPLEMENTATION_PLAN.md`.

## Auth

The server validates the bearer via the existing solo-token short-circuit in `src/server/middleware/auth.ts` — identical path to the CLI. `GLM_SOLO_TOKEN` must be set on the GLM server (or written to `.env` via `glm init --write-env`).
