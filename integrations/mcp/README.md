# @glm/mcp — GLM MCP server for Claude Code

A stdio MCP server that exposes GLM sekkei + verifier + provenance operations as tools, so Claude Code can drive solo-mode generation directly from a user's interactive session.

See `docs/mcp-fork-plan.md` for the architectural overview and `IMPLEMENTATION_PLAN.md` for the phased build.

## Status

Phases A–E complete. Read + verify + write surface in place, plus slash command templates.

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

## Install the slash commands

The `commands/` directory ships slash command templates that orchestrate the MCP tools into one-line invocations. Copy them to your Claude Code commands directory:

```bash
# User-wide (works in every project)
cp commands/glm-*.md ~/.claude/commands/

# Or project-scoped (only active in this repo)
mkdir -p .claude/commands
cp commands/glm-*.md .claude/commands/
```

After copying, restart Claude Code (or run `/reload`) and the commands become available:

- `/glm-status [workspace]` — workspace summary
- `/glm-list-components [workspace]` — enumerate components
- `/glm-verify [workspace]` — run the 7-gate verifier
- `/glm-generate <component_id>` — full generate loop (resolve spec → write files → run acceptance verifier → record provenance, with up to 3 verifier retries)
- `/glm-refine <glm_id>` — patch a node body via RFC-6902 JSON-Patch (acquire lock → PUT → release lock)
- `/glm-ready [workspace]` — the "Definition of Ready to Code" gate: is the sekkei complete enough to build on auto-pilot? (read-only)
- `/glm-build [workspace]` — auto-pilot: generate every component in dependency order, retry, record provenance, until the tree is green (stop-on-first-failure). See `docs/glm-cli-process.md`.

## Available MCP tools

Phases A–D land all eight tools:

| Tool | Purpose |
|---|---|
| `glm_status` | Workspace summary (counts, last verifier run) |
| `glm_list_components` | Enumerate components in a workspace |
| `glm_get_node` | Fetch one node by glm_id (JSON code block) |
| `glm_get_component_spec` | Resolved generation spec: prompt + acceptance + context bundle + hard constraints + source_dir |
| `glm_verify` | Run the 7-gate sekkei verifier |
| `glm_run_acceptance_verifier` | Run a component's `verifier.command` with cwd = source_dir |
| `glm_record_generation` | Attest a completed generation (provenance + audit) |
| `glm_apply_patch` | Apply RFC-6902 JSON-Patch to a node body |

## Auth

The server validates the bearer via the existing solo-token short-circuit in `src/server/middleware/auth.ts` — identical path to the CLI. `GLM_SOLO_TOKEN` must be set on the GLM server (or written to `.env` via `glm init --write-env`).
