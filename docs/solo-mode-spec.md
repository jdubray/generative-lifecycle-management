# Solo Mode — Functional and Technical Specification

**Status:** Draft  
**Version:** 0.2  
**Date:** 2026-05-13

---

## 1. Overview

**Solo mode** is a first-class adoption path for GLM in which a single developer authors and regenerates sekkeis without a team or managed Anthropic account. The developer drives the entire lifecycle — vibe design, verification, generation, and provenance — from a terminal using the Claude Code CLI as the authoring and generation agent, with a local GLM server instance as the persistence and verification backend.

### 1.1 Motivation

GLM's default mode is a multi-user web application with server-side LLM routing. Solo mode answers the question: *how does an individual developer use GLM without standing up a team server or sharing an API key?*

From the README:

> Solo CLI integration and Puffin support are in active development to make this path fully self-contained for individuals.

### 1.2 Scope

This specification covers:

- The **authoring flow**: Claude CLI as a vibe-design agent producing sekkei YAML from a system description.
- The **generation flow**: Claude CLI consuming a sekkei's `spec.prompt` context bundle to produce code.
- The **GLM server extensions** needed to support local, single-user operation (auth bypass, CLI-oriented endpoints, provenance to local SQLite or git notes).
- The **protocol** between Claude CLI and the GLM server (HTTP REST over localhost, stream-JSON prompting, MCP tool registration).

Out of scope for v0.1: team collaboration, remote servers, Git-backed workspace sync, sekkei.lock distribution.

### 1.3 Revision history

| Version | Date | Change |
|--------:|------|--------|
| 0.1 | 2026-05-12 | Initial draft. Server-side Claude CLI spawning for all four LLM flows. |
| 0.2 | 2026-05-13 | **MCP-first generation.** UC-02 inverted: the server no longer spawns Claude. Generation is driven client-side, either by the `glm` CLI (spawns `claude --print` in the user's shell) or by Claude Code itself via the `/glm-generate` slash command and the `glm-mcp` stdio MCP server. Server gained three small endpoints (composite spec, acceptance-verify, record-generation). No `ANTHROPIC_API_KEY` is required on server or client — Claude Code's existing OAuth is the credential. Rationale: [`docs/adr/0006-mcp-first-generation.md`](adr/0006-mcp-first-generation.md). Vibe and refine flows had already moved to client-side CLI spawning before this revision; this version's text reflects that. |

---

## 2. Concepts

| Term | Definition |
|------|-----------|
| **Solo mode** | GLM operated by a single developer against a `localhost` server instance, with Claude CLI as the LLM agent. |
| **Vibe design** | Prompting Claude CLI to produce or reverse-engineer a sekkei from a plain-language description or existing codebase. |
| **Generation** | Claude CLI consuming a `spec.prompt` context bundle and producing the listed `outputs` files. |
| **Provenance event** | A record linking a generated artifact to the sekkei node, content hash, generator identity, and timestamp. Stored in local SQLite and optionally in `git notes`. |
| **GLM server** | The Bun + Hono process (`bun run src/server/server.ts`) running at `http://localhost:${PORT}`. |
| **Claude CLI** | The `claude` binary — Claude Code CLI — spawned as a subprocess with `--input-format stream-json --output-format stream-json` for bidirectional JSON streaming, or `--print` for one-shot generation. |

---

## 3. Functional Specification

### 3.1 Use Cases

#### UC-01 Vibe Design (author a new sekkei)

**Actor:** Developer  
**Precondition:** GLM server running (`bun run src/server/server.ts`); `claude` CLI on PATH; target workspace created.  
**Trigger:** Developer runs `glm vibe` or provides a plain-language description.

**Flow:**

1. Developer runs `glm vibe --workspace <id>` (or from Puffin's Solo panel).
2. GLM presents an interactive prompt: *"Describe your system."*
3. Developer enters a free-form description (or points to an existing codebase directory).
4. The CLI fetches the authoring system prompt from the GLM server, constructs the sekkei authoring prompt (see §4.1), and spawns `claude --print` in the user's shell. (Server-side spawning was removed in v0.2 — see ADR-0006.)
5. Claude CLI streams back sekkei YAML conforming to `specification/sekkei.schema.json`.
6. GLM validates the YAML against the schema and runs verifier gates 1–4 (envelope, hierarchy, role consistency, brief coverage).
7. If valid: GLM imports the sekkei into the workspace via `POST /workspaces/:id/import-sekkei`.
8. GLM reports: nodes created, gate results, next suggested action (`glm verify` or `glm generate`).

**Outcome:** A sekkei is persisted in the local GLM database, ready for spec authoring and generation.

---

#### UC-02 Generate Code (consume a sekkei)

**Actor:** Developer
**Precondition:** Sekkei is imported and passes gates 5–6 (spec coverage + spec quality). The workspace's `source_dir` is set (via `glm init --source-dir`, `glm generate --source-dir`, or a `PATCH /workspaces/:id` body).
**Trigger:** Developer runs `glm generate --component <id>` from a terminal, **or** types `/glm-generate <id>` inside Claude Code.

Both entry points drive the same backend endpoints. The LLM call always happens client-side — the GLM server never spawns Claude. See [`docs/adr/0006-mcp-first-generation.md`](adr/0006-mcp-first-generation.md) for the architectural rationale.

**Flow (CLI path — `glm generate`):**

1. CLI optionally `PATCH`es the workspace with `--source-dir` when one is provided on the command line.
2. CLI calls `GET /workspaces/:id/components/:glm_id/spec`. The server returns a composite payload: `{ component, prompt, acceptance, context_bundle, outputs[], hard_constraints, source_dir }` with the context bundle already resolved against the local DB.
3. CLI builds the system prompt + user prompt from the composite payload (the same prompt structure §4.2 describes; constructed in `integrations/cli/src/lib/generate-spec.ts`) and spawns `claude --print --model <model> --system-prompt-file <tmp>` in the user's interactive shell.
4. CLI parses the multi-file response (`=== FILE: <path> ===` delimiters), validates every path against `source_dir` (no absolute paths, no `..` segments, parent dirs created on demand), and writes the files.
5. CLI calls `POST /workspaces/:id/acceptance-verify` with `{ component_id }`. The server runs `spec.acceptance.body.verifier.command` with `cwd = source_dir` and returns `{ exit_code, stdout, stderr, duration_ms }`.
6. On `exit_code === 0`: CLI calls `POST /workspaces/:id/record-generation` with `{ component_id, files: [{ path, sha256, bytes }], verifier_exit_code, duration_ms }`. The server inserts a `provenance_events` row + `audit` entry (`event_type = "mcp.generate"`) and returns the provenance id.

**Flow (Claude Code path — `/glm-generate`):**

Claude Code uses the same backend endpoints, but orchestrates the steps itself through the `glm-mcp` stdio MCP server. The user-facing entry is the slash-command template at `integrations/mcp/commands/glm-generate.md`.

1. User types `/glm-generate <component_id>`. The slash command expands into the orchestration prompt.
2. Claude calls `glm_get_component_spec` — thin MCP wrapper around the same `GET /workspaces/:id/components/:glm_id/spec` endpoint.
3. Claude uses its built-in `Write` tool to produce each file under `source_dir`. No multi-file delimiter parsing — Claude's own tool loop writes the files directly.
4. Claude calls `glm_run_acceptance_verifier` → `POST /workspaces/:id/acceptance-verify`. If the verifier fails, Claude examines the output, edits the relevant files, and re-runs the verifier (zero or more iterations).
5. On verifier `exit_code === 0`, Claude calls `glm_record_generation` → `POST /workspaces/:id/record-generation` with file hashes + verifier exit.

**Outcome:** Output files exist on disk under `source_dir`; the verifier returned 0; `provenance_events` and `audit` rows are written; the developer sees the provenance id (CLI) or Claude's summary (Claude Code).

---

#### UC-03 Verify Sekkei

**Actor:** Developer  
**Trigger:** `glm verify` or after any sekkei edit.

**Flow:**

1. GLM runs all 6 verifier gates against the workspace's current sekkei via `GET /workspaces/:id/verify`.
2. Results are streamed gate-by-gate to stdout.
3. Gate failures print the failing node ID, the violated rule, and a suggested fix.

---

#### UC-04 Reverse-Engineer Existing Codebase

**Actor:** Developer  
**Trigger:** `glm vibe --from-dir <path>` or from Puffin's "Import existing project" flow.

**Flow:**

1. GLM scans `<path>` for source files (respecting `.gitignore`).
2. GLM constructs a reverse-engineer prompt (§4.3) that includes file tree + key file contents.
3. Claude CLI produces a sekkei YAML reflecting the existing structure.
4. GLM validates and imports (same as UC-01 steps 6–8).

---

#### UC-05 Refine a Sekkei Node

**Actor:** Developer  
**Trigger:** `glm refine --node <id>` or Puffin edit with "Ask Claude" action.

**Flow:**

1. GLM fetches the target node body + its ancestors (system → capability → component).
2. Developer provides a refinement instruction in natural language.
3. The CLI fetches the node body + ancestors over HTTP, constructs the refinement prompt, and spawns `claude --print` in the user's shell. (Server-side spawning was removed in v0.2 — see ADR-0006.)
4. Claude CLI returns a JSON-Patch RFC-6902 delta over the node's `body`.
5. GLM applies the delta, updates `revision.iteration`, recomputes `content_hash`.
6. GLM re-runs relevant verifier gates and reports.

---

### 3.2 CLI Commands

The `glm` CLI is the primary Solo mode entrypoint. It wraps HTTP calls to the local GLM server.

```
glm vibe [--workspace <id>] [--from-dir <path>]
    Vibe design: author or reverse-engineer a sekkei interactively.

glm verify [--workspace <id>] [--node <id>]
    Run verifier gates. Without --node, runs all 6 gates on full sekkei.

glm generate --component <id> [--workspace <id>] [--dry-run]
    Generate output files for one Component from its spec.prompt.

glm import-sekkei <file.yaml> [--workspace <id>]
    Import a sekkei YAML file into the workspace.

glm refine --node <id> [--workspace <id>]
    Interactively refine a node's body using Claude CLI.

glm init [--name <name>] [--port <port>]
    Bootstrap a new local workspace and start the GLM server.

glm status [--workspace <id>]
    Show sekkei node counts, verification status, and last generation timestamp.
```

All commands default to `--workspace default` and `--port 3000` (overridable via `GLM_WORKSPACE` and `PORT` env vars).

---

### 3.3 Puffin Integration

Puffin surfaces Solo mode as a **Solo panel** alongside the existing project view:

- **Design tab**: the sekkei node tree; each node has an "Ask Claude" button that triggers UC-05.
- **Generate tab**: per-component generation status (verifier pass/fail, last provenance event).
- **Vibe tab**: a chat-like panel that drives UC-01 / UC-04 with streaming output.

Puffin communicates with the local GLM server over `http://localhost:${PORT}`. No additional IPC is needed — Puffin uses the same GLM REST API as the web UI.

---

## 4. Prompting Protocol

### 4.1 Vibe Design Prompt (UC-01)

Claude CLI is invoked in `--print` mode (one-shot, no tools). The system prompt references the sekkei authoring skill (`docs/sekkei-authoring.md`) and the JSON schema.

**System prompt structure:**

```
You are a sekkei author operating under the GLM methodology.
Your output MUST be valid YAML conforming to the sekkei specification.

<sekkei-authoring.md content>

<sekkei.schema.json content>

HARD CONSTRAINTS:
- Output ONLY YAML. No prose, no markdown fences.
- Every node must have: id, stratum, title, revision, provenance, relationships, body.
- Every Component must have spec nodes for: functional, technical, schema, business_rule, acceptance, prompt.
- Acceptance specs must list deliverables[] with a verifier.command.
- Prompt specs must list context_bundle[] and outputs[].
- IDs must follow the convention: <org>:<project>.<capability>.<component>[.spec.<kind>]
```

**User prompt:**

```
Design a sekkei for the following system.

Namespace prefix: <org>:<project>
Stack: <user-provided>
Description:
<user-provided system description>

Produce a complete sekkei YAML starting with the root System node.
Use multi-document YAML (--- separators) to emit all nodes in one response.
```

---

### 4.2 Generation Prompt (UC-02)

The generation prompt is **built client-side**, not by the server. Two construction sites coexist:

- The `glm` CLI builds it in TypeScript (`integrations/cli/src/lib/generate-spec.ts`) from the composite spec returned by `GET /workspaces/:id/components/:glm_id/spec`, then invokes `claude --print` in `--print` mode (one-shot, no tools) with a `--system-prompt-file`.
- The `/glm-generate` slash command in Claude Code (`integrations/mcp/commands/glm-generate.md`) expands into an orchestration prompt that fetches the same composite spec via `glm_get_component_spec` and uses Claude's built-in `Write` tool to produce files — no subprocess, no `--print`.

Both sites use the structure below. Generation is strictly file-producing; Claude must not invoke `hdsl_*` tools or explore the codebase.

**Prompt structure:**

```
<prompt_template from spec.prompt.body.prompt_template>

Context bundle:
<for each id in context_bundle: serialized node body from DB>

Outputs to produce:
<for each output in spec.prompt.body.outputs:
  - path: <path>
    description: <description>
>

HARD CONSTRAINTS:
<from spec.prompt.body — repeat verbatim>

After writing all files, run:
  <spec.acceptance.body.verifier.command>
and confirm it exits 0.
```

---

### 4.3 Reverse-Engineer Prompt (UC-04)

```
You are reverse-engineering an existing codebase into a sekkei.

<sekkei-authoring.md §10.1–§10.7 conventions>

Codebase structure:
<file tree>

Key files (excerpts):
<up to 20 files, truncated at 200 lines each>

RULES:
- Read FSM states VERBATIM from source (§10.3). Do not invent states.
- Component boundaries must reflect what the code ACTUALLY OWNS (§10.2).
- Emit a complete sekkei with all 6 spec kinds per Component.
- Use override_kind: net_new for all nodes (this is a first-time authoring).

Output ONLY YAML.
```

---

### 4.4 Refinement Prompt (UC-05)

Claude CLI is invoked in one-shot mode. Output is a JSON-Patch array.

```
You are refining one node of a sekkei.

Current node:
<full node YAML>

Ancestor context:
<system body summary>
<capability body summary>

Refinement instruction:
<user-provided>

Output ONLY a JSON array of RFC-6902 JSON-Patch operations targeting `body`.
Do not modify id, stratum, revision, provenance, or relationships.
```

---

## 5. Technical Specification

### 5.1 Claude CLI Subprocess Protocol

Solo mode spawns `claude` as a child process. Two invocation modes are used:

#### 5.1.1 One-Shot (Generation, Vibe Design, Refinement)

```
claude --print --model claude-sonnet-4-6 \
  --system-prompt-file /tmp/glm-system-<hash>.txt \
  < /tmp/glm-user-<hash>.txt
```

- `--print`: single turn, exit after response.
- `--model`: defaults to `claude-sonnet-4-6`; overridable via `GLM_CLAUDE_MODEL` env var.
- Stdin carries the user-turn content.
- Stdout is the raw YAML or JSON-Patch response.
- No MCP servers are attached (no tool use; generation must be pure text output).

#### 5.1.2 Interactive (Vibe panel in Puffin)

```
claude --input-format stream-json --output-format stream-json \
  --model claude-sonnet-4-6 \
  --system-prompt-file /tmp/glm-system-<hash>.txt
```

- Bidirectional streaming JSON on stdin/stdout.
- User messages: `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"..."}]}}`
- Puffin sends messages and streams responses back to the Vibe panel.
- Session resume via `--resume <sessionId>` from the previous `result` message.

#### 5.1.3 Process Lifecycle

- Claude CLI subprocesses are spawned and owned **by the client** (the `glm` CLI for UC-01, UC-02, UC-04, UC-05; Puffin or the Vibe panel for the interactive mode). The GLM server no longer spawns Claude for any use case in v0.2 — see ADR-0006.
- The CLI captures stdout in one shot at process exit. On Windows there is no progress output during the run; a typical 4-file component takes 8–21+ minutes on Sonnet 4.6.
- On parse failure (claude emits prose instead of `=== FILE: <path> ===`), the CLI preserves the raw response in a temp directory printed in the error message so the developer can inspect what the model actually produced.
- For the Claude Code (`/glm-generate`) path there is no subprocess at all — Claude's own tool loop drives generation through `glm-mcp` and its built-in `Write` tool.

---

### 5.2 New GLM Server Endpoints

All new endpoints are under `/api/v1` and require the `solo` authentication mode (see §5.3).

#### `POST /workspaces/:id/vibe`

Trigger a vibe design session.

**Request:**
```json
{
  "mode": "new" | "reverse_engineer",
  "description": "Plain-language system description",
  "namespace_prefix": "acme:web.shop",
  "stack": "Bun + Hono + bun:sqlite",
  "source_dir": "/path/to/existing/codebase"   // mode=reverse_engineer only
}
```

**Response (SSE stream):**
```
data: {"type":"progress","message":"Invoking Claude CLI..."}
data: {"type":"yaml_chunk","content":"id: acme:web.shop\nstratum: system\n..."}
data: {"type":"validation","gates":[{"gate":1,"pass":true},{"gate":2,"pass":true},...]}
data: {"type":"import_result","nodes_created":47,"nodes_failed":0}
data: {"type":"done","sekkei_root_id":"acme:web.shop"}
```

---

#### `GET /workspaces/:id/components/:glm_id/spec`

Composite endpoint returning everything a client needs to drive a generation locally. Replaces the v0.1 server-driven `POST /workspaces/:id/generate`.

**Response:**
```json
{
  "component": { "id": "acme:web.shop.catalog.product_repository", "title": "…" },
  "prompt": { "template": "…", "context_bundle": ["acme:web.shop.catalog.product_repository.spec.schema", "..."], "outputs": [{ "path": "src/repository.ts", "description": "…" }] },
  "acceptance": { "deliverables": ["…"], "verifier": { "command": "bun test src/repository.test.ts" } },
  "context_bundle_resolved": "…canonical YAML, --- separated, ≤ 400 KB…",
  "hard_constraints": "…",
  "source_dir": "/abs/path/to/code"
}
```

The server resolves `context_bundle[]` against the local DB (§5.4) and inlines each referenced node's canonical YAML body. Caps the bundle at 400 KB; if exceeded, omits `spec.schema` and `spec.business_rule` and sets a warning header.

---

#### `POST /workspaces/:id/acceptance-verify`

Runs an acceptance-spec verifier in a workspace's `source_dir`. The server reuses the existing `defaultVerifierRunner` (`src/generation/acceptance-runner.ts`) which spawns `cmd /c` (Windows) or `sh -c` (POSIX).

**Request:**
```json
{ "component_id": "acme:web.shop.catalog.product_repository" }
```

**Response:**
```json
{
  "exit_code": 0,
  "stdout": "…",
  "stderr": "",
  "duration_ms": 42010,
  "command": "bun test src/repository.test.ts"
}
```

---

#### `POST /workspaces/:id/record-generation`

Records a successful (or failed) generation. Idempotent on `(component_id, aggregate_digest)` — re-recording the same artifact set returns the existing provenance id.

**Request:**
```json
{
  "component_id": "acme:web.shop.catalog.product_repository",
  "files": [
    { "path": "src/repository.ts", "sha256": "…", "bytes": 2341 },
    { "path": "test/repository.test.ts", "sha256": "…", "bytes": 567 }
  ],
  "verifier_exit_code": 0,
  "duration_ms": 1290022,
  "model": "claude-sonnet-4-6"
}
```

**Response:**
```json
{
  "provenance_id": "5e97f6d5-22f1-4f18-9e32-9d78bddbd08b",
  "aggregate_digest": "sha256:…",
  "audit_event_id": "…"
}
```

The server computes the aggregate digest from the per-file `sha256` values + the component's `content_hash` so a regeneration with an unchanged spec and unchanged outputs is deterministically identifiable.

---

#### `POST /workspaces/:id/refine`

Refine one node using Claude CLI.

**Request:**
```json
{
  "node_id": "acme:web.shop.catalog.product_repository",
  "instruction": "Add a search-by-title behavior using SQLite FTS5"
}
```

**Response:**
```json
{
  "patch": [
    { "op": "add", "path": "/behaviors/-", "value": { "id": "search", "signature": "..." } }
  ],
  "node_id": "acme:web.shop.catalog.product_repository",
  "new_iteration": 3
}
```

GLM applies the patch, updates `revision.iteration`, recomputes `content_hash`, and revalidates.

---

#### `GET /workspaces/:id/verify`

Run all 6 verifier gates. Existing endpoint; enhanced to stream gate results.

**Response (SSE stream):**
```
data: {"gate":1,"name":"Envelope","pass":true,"failures":[]}
data: {"gate":2,"name":"Stratum hierarchy","pass":true,"failures":[]}
data: {"gate":3,"name":"Closure completeness","pass":false,"failures":[
  {"node_id":"acme:web.shop.catalog.product_repository","target":"pkg:npm/ulid","reason":"not found in depends-on"}
]}
...
data: {"done":true,"pass":false,"gate_count":6,"pass_count":5}
```

---

### 5.3 Authentication in Solo Mode

Solo mode bypasses the full RBAC stack. The GLM server accepts a `GLM_SOLO_TOKEN` env var (a random 32-byte hex string generated at `glm init`). Every request from the CLI or Puffin carries this token in the `Authorization: Bearer <token>` header. The server's auth middleware short-circuits to `{ userId: "solo", role: "owner" }` when the token matches.

Multi-user mode is completely unaffected — solo auth only activates when `GLM_SOLO_TOKEN` is set.

---

### 5.4 Context Bundle Resolution

When building the generation prompt for a Component, the server resolves `spec.prompt.body.context_bundle` as follows:

1. For each entry starting with `<org>:` — fetch the node body from `nodes` table in local SQLite.
2. For each entry starting with `pkg:` — look up the entry in `nodes/dependencies/` and include its `body.implementation_notes` field.
3. Serialize each resolved node to canonical YAML (no comments, keys sorted).
4. Concatenate with `---` separators and inject into the prompt template at `<CONTEXT_BUNDLE>`.

Total context bundle size is capped at **100,000 tokens** (computed via `cl100k_base` tiktoken). If exceeded, omit `spec.schema` and `spec.business_rule` nodes and warn the developer.

---

### 5.5 Provenance Recording

On successful generation (verifier exits 0), GLM records:

**`provenance_events` row:**
```sql
INSERT INTO provenance_events (
  id, node_id, content_hash, generator_identity,
  model, prompt_tokens, completion_tokens, duration_ms,
  artifacts, attested_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
```

**`artifacts`** is a JSON array of `{ path, sha256 }` for each written file.

**`generator_identity`** is `claude-cli/<model>@<cli_version>`.

**Git notes** (optional, enabled via `GLM_SIGN_COMMITS=true`):
```
git notes --ref=glm/provenance add -m '{"event_id":"...","node_id":"...","content_hash":"..."}' HEAD
```

---

### 5.6 Sekkei Import Pipeline

`POST /workspaces/:id/import-sekkei` accepts a multi-document YAML body and processes it as follows:

1. **Parse** all YAML documents (`---` separated) into node objects.
2. **Validate envelope** (gate 1) for each node: reject malformed documents individually, continue on others.
3. **Upsert nodes** via `INSERT OR REPLACE INTO nodes ...` preserving existing `content_hash` if node already exists and `content_hash` matches.
4. **Rebuild relationships** from `relationships[]` arrays: insert into `node_relationships` table.
5. **Run gates 2–4** (stratum hierarchy, role consistency, closure completeness) across the full imported set.
6. **Return** a summary: `{ nodes_created, nodes_updated, nodes_failed, gates: [...] }`.

Idempotent: re-importing the same YAML produces the same result.

---

### 5.7 File Output and Working Directory

Generated files are written relative to the workspace's `source_dir` (set at `glm init` or `--source-dir`). The GLM server holds `source_dir` in the `workspaces` table. Claude CLI receives the absolute path as a system prompt instruction:

```
Working directory: /path/to/project
All output paths in `outputs` are relative to this directory.
Create parent directories as needed. Do NOT create files outside this directory.
```

---

### 5.8 Error Handling

| Condition | Behavior |
|-----------|---------|
| Claude CLI not on PATH | `glm` exits with error: *"claude CLI not found. Install Claude Code: https://claude.ai/code"* |
| GLM server not running | `glm` exits with error: *"GLM server not responding at http://localhost:${PORT}. Run: glm init"* |
| Claude CLI exits non-zero | Server logs stderr; SSE stream emits `{"type":"error","code":"cli_error","stderr":"..."}` |
| Verifier command exits non-zero | Stream emits `{"type":"verifier_failed","stdout":"...","stderr":"...","exit_code":N}`; no provenance event is recorded |
| YAML parse failure | Import rejects the malformed document with line/column reference; valid documents in the same stream proceed |
| Context bundle exceeds token cap | Warning emitted; schema + business_rule nodes are omitted from bundle |
| Gate failure during vibe design | Import proceeds for valid nodes; SSE stream reports gate failure with failing node IDs and fix suggestions |

---

## 6. Non-Functional Requirements

| Property | Requirement |
|----------|------------|
| **Latency** | Vibe design for a 10-Capability system: ≤ 120 s (Claude CLI one-shot, network RTT excluded). |
| **File safety** | Claude CLI writes to a temp staging dir; GLM moves files to `source_dir` only after verifier passes. `--dry-run` skips the move. |
| **Idempotency** | Importing the same sekkei twice is safe. Generating the same component twice overwrites output files and records a new provenance event. |
| **Offline capability** | `glm verify` and `glm import-sekkei` work with no internet access. `glm vibe` and `glm generate` require Claude API reachability (or a locally-routed Anthropic-compatible endpoint via `ANTHROPIC_BASE_URL`). |
| **Model configurability** | `GLM_CLAUDE_MODEL` overrides the default model for all Claude CLI invocations. Supports any model accepted by `claude --model`. |

---

## 7. Open Questions

1. **Vibe design output format**: Should the sekkei be emitted as a single multi-document YAML stream, or split into the canonical file-system layout (`sekkei.yaml` + `nodes/` directory tree)? The file-system layout is more diffable but harder to produce in one LLM turn.

2. **Streaming vs. one-shot for vibe design**: Large sekkeis (50+ nodes) may time out under `--print`. Should the vibe design flow use `--input-format stream-json` with a long-running session and emit nodes incrementally?

3. ~~**Local vs. API key for Solo mode**: Solo mode currently requires an Anthropic API key.~~ **Resolved in v0.2.** Solo mode delegates LLM auth entirely to Claude Code's own OAuth/keychain. The GLM server never holds an `ANTHROPIC_API_KEY`. See [ADR-0006](adr/0006-mcp-first-generation.md). A future Phase J could add an opt-in server-side `ANTHROPIC_API_KEY` mode for headless CI use, but it is not part of v0.2.

4. **Sekkei.lock in Solo mode**: Should `glm generate` automatically update `sekkei.lock` with the new `content_hash` of generated nodes, or leave lock management to the developer?

5. **Puffin as optional**: Is Puffin a required surface for Solo mode, or should Solo mode be fully functional from the terminal alone? The spec above makes Puffin optional (everything goes through the REST API).
