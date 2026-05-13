# GLM MCP Server — Implementation Plan

**Companion to:** `docs/mcp-fork-plan.md`
**Status:** Phases A–H complete · **Branch:** `main`
**Owner:** Full-stack

---

## 1. Goal

Ship `glm-mcp`, a stdio MCP server that lets Claude Code call GLM operations as tools. Replaces server-side LLM spawning (which hangs on Windows) with client-side LLM via Claude Code's existing OAuth session.

## 2. Project structure

```
integrations/mcp/
├── IMPLEMENTATION_PLAN.md          ← this doc
├── README.md
├── package.json
├── tsconfig.json
├── biome.json
├── .gitignore
├── src/
│   ├── bin/
│   │   └── glm-mcp.ts              ← stdio entry, registers tools, connects transport
│   ├── lib/
│   │   ├── version.ts
│   │   ├── config.ts               ← loads ~/.glm/config.json + env overrides (mirrors CLI)
│   │   ├── glm-client.ts           ← typed HTTP wrapper around GLM REST API
│   │   └── errors.ts
│   └── tools/
│       ├── index.ts                ← registers all tools with the McpServer
│       ├── status.ts               ← glm_status
│       ├── list-components.ts      ← glm_list_components       (Phase B)
│       ├── get-node.ts             ← glm_get_node              (Phase B)
│       ├── get-component-spec.ts   ← glm_get_component_spec    (Phase B)
│       ├── verify.ts               ← glm_verify                (Phase C)
│       ├── run-acceptance-verifier.ts ← glm_run_acceptance_verifier (Phase C)
│       ├── record-generation.ts    ← glm_record_generation     (Phase D)
│       └── apply-patch.ts          ← glm_apply_patch           (Phase D)
└── tests/
    └── unit/
        ├── config.test.ts
        ├── glm-client.test.ts
        ├── status.test.ts          ← Phase A
        ├── …                       ← per-tool tests added per phase
```

## 3. Phasing

| Phase | Status | Deliverable | Sizing | Tests |
|---|---|---|---|---|
| **A** | ✅ | Scaffolding + `glm_status` tool. stdio MCP server boots, accepts ListTools+CallTool, returns workspace summary | ~2h | unit: glm_status invokes the right HTTP endpoint, parses the response, formats text content |
| **B** | ✅ | Read-only tools: `glm_list_components`, `glm_get_node`, `glm_get_component_spec`. New server route for the composite spec endpoint (`GET /workspaces/:id/components/:glm_id/spec`) | ~3h | unit per tool + integration test for the new server route |
| **C** | ✅ | Verifier tools: `glm_verify`, `glm_run_acceptance_verifier`. New server route `POST /workspaces/:id/acceptance-verify` | ~2h | reuses existing verifier integration tests + new route test |
| **D** | ✅ | Mutating tools: `glm_record_generation`, `glm_apply_patch`. New server route `POST /workspaces/:id/record-generation` reusing existing provenance + audit repos | ~3h | route test + tool tests |
| **E** | ✅ | Slash command templates in `.claude/commands/glm-*.md` (status, verify, generate, refine, list-components) | ~1h | manual smoke; not unit-testable in isolation |
| **F** | ✅ (modified) | Delete server-side LLM call: `src/generation/solo-generate.ts`, `src/server/routes/solo-generate.ts`, related tests. Replace CLI `generate` command with migration message | ~1h | adjust integration tests; CI green |
| **G** | ✅ | Docs: ADR for "MCP-first generation". Update `docs/solo-mode-spec.md` UC-02 + `docs/user-manual.md`. Update README | ~1h | n/a |
| **H** | ✅ | E2E: install MCP server into local Claude Code config, run `/glm-generate` on petshop cart_manager, verify provenance row written | ~2h | manual + smoke test of `record-generation` route |

**Total: ~15h.** Phases A→B→C let smoke-testing of read-only tools start early. D→F finishes the write path and lights up the MCP-as-default story. G+H close out.

**Phase F note.** Per the user's "I want a GLM CLI, so I don't expect to remove anything that is related to it", the CLI `generate` command was **rewritten** to spawn `claude --print` client-side via the new MCP-fork endpoints rather than deleted. The server-side `solo-generate.ts` was stashed (kept as commented-out reference, including the working Puffin spawn recipe) rather than deleted — see ADR-0006 for the rationale and the Phase J follow-up that would revive it under `ANTHROPIC_API_KEY`-mode.

**Phase H validation.** End-to-end run on WSL against the petshop `cart_manager` component: 4 files written (1 SQL migration, cart-manager.ts, cart-routes.ts, cart-manager.test.ts), verifier PASS (exit 0, 1,290,022 ms ≈ 21.5 min on Sonnet 4.6), provenance row recorded with id `5e97f6d5-22f1-4f18-9e32-9d78bddbd08b`. Test state: 177/177 CLI + 699/699 server + 61/61 MCP tests green.

## 4. Wiring into Claude Code

Once published or `bun link`ed, the user adds to their MCP config (`~/.claude/settings.json` or per-project `.claude/settings.json`):

```json
{
  "mcpServers": {
    "glm": {
      "command": "bun",
      "args": ["run", "<absolute-path>/integrations/mcp/src/bin/glm-mcp.ts"]
    }
  }
}
```

Or, after publishing to npm:

```json
{
  "mcpServers": {
    "glm": { "command": "npx", "args": ["-y", "@glm/mcp@latest"] }
  }
}
```

## 5. Out of scope (for this plan)

- Multi-tenant auth (still single-`GLM_SOLO_TOKEN` from `~/.glm/config.json`).
- HTTP transport for MCP (stdio only).
- Restoring server-side LLM generation for CI use. If demanded later, a Phase J could add an `ANTHROPIC_API_KEY`-mode opt-in.
- Migrating `glm vibe` and `glm refine` to slash commands. They work today as client-side CLI commands; leaving them alone for v1.
