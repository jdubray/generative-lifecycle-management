---
name: glm
description: >-
  Work with GLM sekkeis — content-addressed, inheritance-aware design DAGs that
  LLM agents regenerate into working software. Use when the user wants to author,
  review, extend, verify, refine, or regenerate a sekkei; talks about strata
  (system → capability → component → interaction → spec), spec leaves, the
  7-gate verifier, or glm_ids; or asks to run any `glm` CLI command or `glm_*`
  MCP tool. Covers the GLM CLI, the MCP server, and sekkei authoring conventions.
---

# GLM — Generative Lifecycle Management

A **sekkei** (設計, "design") is a content-addressed, inheritance-aware DAG of typed
YAML nodes that an LLM agent can regenerate into working software with no extra human
input. The sekkei is the schematic; generated code is a derived build product.

Five strata, top → leaf:

```
system → capability → component → interaction → spec
```

Every Component carries six spec leaves: `functional`, `technical`, `schema`,
`business_rule`, `acceptance`, `prompt`. The `prompt` leaf (context_bundle + outputs +
HARD CONSTRAINTS) is the machine-runnable contract that drives regeneration.

## Surfaces available in this repo

There are three ways to drive a sekkei. Pick by what the user is doing:

| Surface | Where | Use it when |
|---|---|---|
| **MCP tools** (`glm_*`) | `integrations/mcp/` | Driving generation/refinement from inside this Claude Code session (server must be wired into settings) |
| **Slash commands** | `integrations/mcp/commands/` | One-line orchestrations: `/glm-status`, `/glm-list-components`, `/glm-verify`, `/glm-generate <id>`, `/glm-refine <glm_id>`, `/glm-ready`, `/glm-build` |
| **GLM CLI** (`glm`) | `integrations/cli/` | Terminal-driven solo workflows: `glm init`, `glm status`, `glm vibe [--from-dir <path>]`, `glm verify`, `glm generate --component <id>`, `glm refine --node <id>`, `glm import-sekkei <file>` |

Both the MCP server and the CLI talk to a local GLM server over HTTP and read
`~/.glm/config.json` (port, workspace, token) written by `glm init`. If a command fails
with no config, the user likely needs to run `glm init` and start the server
(`bun run src/server/server.ts` from the repo root).

## End-to-end: vibe a sekkei, then code on auto-pilot

The headline workflow (full detail in `docs/glm-cli-process.md`): **vibe the
sekkei interactively until `glm verify` is green, then flip to auto-pilot.** The
verifier is the gate — gates 5 (spec coverage) + 6 (spec quality) green means
every component is a machine-runnable contract. Check the gate with `/glm-ready`;
once it says READY, `/glm-build` generates every component in dependency order
(retry + acceptance-verify + provenance, stop-on-first-failure) until the tree is
green. For unattended runs wrap `/glm-build` in the `/loop` skill.

## Choosing a workflow

- **Author a new sekkei from scratch** → run the authoring procedure below (or
  `glm vibe` for an interactive Claude-driven session). Do NOT invent capabilities,
  components, or FSM states the user hasn't described — boundaries must be honest.
- **Reverse-engineer a sekkei from existing code** → `glm vibe --from-dir <path>`.
- **Regenerate a component's code** → `/glm-generate <component_id>` (or
  `glm generate --component <id>`). This resolves the spec, writes exactly the files in
  `outputs[]` under `source_dir`, runs the acceptance verifier (≤3 retries), and records
  provenance. Never write outside `source_dir`; never skip the verifier.
- **Edit one node's body** → `/glm-refine <glm_id>` (or `glm refine --node <id>`). Build
  minimal RFC-6902 JSON-Patch ops; prefer surgical patches over wholesale replacement.
- **Check health** → `/glm-verify` (or `glm verify`) runs the 7-gate verifier; pure code,
  no LLM.

## Authoring procedure (when authoring/extending by hand)

Read **`docs/sekkei-authoring.md`** — it is the authoritative authoring skill and contains
the full envelope, per-stratum body shapes, all six spec-kind templates, relationship and
constraint syntax, the load-bearing conventions (§10), and the step-by-step checklist
(§13). Always consult it before writing YAML; the summary here is only a map.

Order of work:

1. **Elicit** (sekkei-authoring §1): system pitch, capability groupings, runtime stack,
   fork-or-net-new, and the `<org>:<project>` namespace prefix. All IDs derive from it.
2. **Root System** → `sekkei.yaml` (envelope + system body + `composes-of` to capabilities;
   root needs `acceptance_gate`).
3. **Capabilities** → `nodes/capabilities/` (`user_value` + `boundary` owning/not-owning).
4. **Components** → `nodes/components/` (`boundary`, `runtime`, `realization_file`).
5. **Interactions** → `nodes/interactions/`. **Read FSM states verbatim from the
   realization file (§10.3); never extrapolate from domain concepts.**
6. **Specs** → all six kinds per component in
   `nodes/specs/by_component/<component>_specs.yaml` (multi-doc YAML).
7. **Verify** → run the verifier; fix every gate failure before declaring it authored.
8. **Lock** → update `sekkei.lock`.

## Load-bearing rules (don't violate)

- Every boundary states what it **owns AND does not own** — regenerators can't infer
  ownership from silence.
- Acceptance specs list `deliverables[].path` + a `verifier.command` — never prose.
- Prompt specs must be machine-runnable: non-empty `context_bundle` (System + Capability +
  Component + all five other spec kinds), `outputs`, and HARD CONSTRAINTS.
- Quote YAML strings containing `{`, `}`, `:`, or `?` (§10.7).
- Use placeholder `sha256:0000...` only for new/unverified nodes; released nodes need real
  content hashes.

## The 7 verifier gates

envelope · stratum hierarchy · role consistency · closure completeness · brief coverage ·
spec coverage · spec quality. A gate failure usually means a `/glm-refine` on the offending
spec or component. Don't auto-fix unless the user asks.

## References

- `docs/sekkei-authoring.md` — full authoring spec (the canonical detail)
- `docs/solo-mode-spec.md` — solo-mode design
- `docs/user-manual.md` — user manual
- `integrations/cli/README.md` — CLI commands, config, platform notes
- `integrations/mcp/README.md` — MCP tools, install, slash-command setup
