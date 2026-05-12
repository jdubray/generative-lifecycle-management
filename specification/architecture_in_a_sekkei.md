# Where does architecture live in a sekkei?

A short answer to a question that has come up: where does the *architecture* of a system go in the sekkei model? We have `spec.functional` (what does it do) and `spec.technical` (how is it built). Which one IS the architecture? Both? Neither?

The honest answer: **architecture is not a single spec_kind. It is distributed across the entire sekkei structure.** That is intentional. The sekkei IS the architecture document — but it's hierarchical and content-addressed instead of a free-form prose deck. This document explains the distribution using the TodoMVC sekkei as the worked example.

---

## 1. The seven places architectural decisions actually live

| Architectural concern              | Where it's expressed in the sekkei                                        |
|------------------------------------|---------------------------------------------------------------------------|
| **Structural** (what are the parts) | The strata themselves: `system → capability → component → interaction → spec`. Plus the `composes-of` relationships between them. |
| **Deployment / process**           | `Component.body.runtime` enum: `in_process` / `sidecar` / `external_service` / `in_browser` / `in_process_and_in_browser`. Plus the `System.body.dbom_ref` (when present) — the dBOM IS the deployment architecture. |
| **Dependency**                     | `depends-on` relationships, both internal (`kizo:...`) and external (`pkg:...`/`dep:...`/`svc:...`/`hw:...`). |
| **Responsibility / boundary**      | `Component.body.boundary` — "owns X; does NOT own Y." The single most important honest-architecture field. |
| **Interface / contract**           | `Interaction` nodes with `contract_kind: fsm | event_flow | integration_adapter | schema_binding` and their `contract_definition` bodies. These are the wires between Components. |
| **Configuration**                  | `parameters[]` declarations with `binding_scope` (which stratum they bind at) and their `schema`/`default`/`enum` choices. |
| **Implementation architecture**    | `spec.technical` body of each Component: framework choice, module layout, storage engine, library pins, error taxonomy, validation strategy. |
| **Data architecture**              | `spec.schema` body of each Component (the entity/request/response shapes), plus the schema_binding Interactions (DDL + PRAGMAs + indexes). |
| **Cross-cutting invariants**       | `spec.business_rule` body of each Component, plus the top-level `constraints[]` on System/Capability/Component nodes. |

`spec.functional` is the contract-with-the-caller (what the thing does); `spec.technical` is the implementation guidance (how it's built); but neither of them is "the architecture." The architecture is the *structure plus the contracts plus the boundaries plus the dependencies plus the deployment runtimes plus the implementation choices*. It's distributed because it's authored at the stratum where the decision actually applies.

---

## 2. The TodoMVC sekkei, walked through architecturally

The TodoMVC sekkei is small enough to enumerate. Let me walk every architectural decision it captures and point at the file/line that captures it.

### 2.1 Structural architecture — the top three strata

The `composes-of` graph IS the structural architecture diagram:

```
kizo:web.todomvc                            (root System)
├── kizo:web.todomvc.todo_management        (Capability — backend)
│   ├── todo_repository                     (Component — CRUD + SQLite)
│   ├── todo_filter_engine                  (Component — pure function, dual-tier)
│   └── todo_rest_api                       (Component — Hono routes)
└── kizo:web.todomvc.web_ui                 (Capability — frontend)
    ├── todo_pwa_shell                      (Component — HTML/CSS bundle)
    ├── add_todo_input                      (Component — input + Enter handler)
    ├── todo_list_view                      (Component — list rendering + edit FSM)
    ├── footer_view                         (Component — counter + filters)
    └── todo_filter_router                  (Component — URL hash routing)
```

Three architectural choices visible in this picture alone:

- **Backend/frontend split** (two Capabilities). The REST API is the boundary.
- **Five-Component frontend decomposition**. Could have been one big Component. Wasn't. The split is by *editable concern*: the shell owns markup; each view owns its DOM region; the router owns URL state.
- **`todo_filter_engine` placed at the backend Capability** but flagged `runtime: in_process_and_in_browser`. That's the architectural declaration that the filter is dual-tier shared logic — the same source file feeds both `src/filter.ts` and `public/js/filter.js`.

None of those decisions are written in a prose paragraph titled "Architecture." They are written in the structure of the tree.

### 2.2 Deployment / process architecture — the runtime enum

Every Component declares one of five `runtime` values. For TodoMVC:

| Component             | runtime                          | What that says                                    |
|-----------------------|----------------------------------|---------------------------------------------------|
| `todo_repository`     | `in_process`                     | Runs in the Bun server                            |
| `todo_filter_engine`  | `in_process_and_in_browser`      | Same source, two execution contexts               |
| `todo_rest_api`       | `in_process`                     | Runs in the Bun server                            |
| `todo_pwa_shell`      | `in_browser`                     | Served as static files, executes in the client    |
| `add_todo_input`      | `in_browser`                     | ditto                                             |
| `todo_list_view`      | `in_browser`                     | ditto                                             |
| `footer_view`         | `in_browser`                     | ditto                                             |
| `todo_filter_router`  | `in_browser`                     | ditto                                             |

This is the deployment architecture. A regenerator can compute from this alone: "one Bun process serves three TypeScript modules and a `public/` directory of ES modules." No separate deployment diagram is needed because the runtime tags ARE the diagram.

For BaanBaan, the runtime tags get richer (`sidecar` for the Counter Companion bridge running on the iPad, `external_service` for Finix/Clover), and the System's `dbom_ref` points at the dBOM that pins the Raspberry Pi 5 + PAX A920 Pro + Star TSP100III hardware target. TodoMVC's `dbom_ref: null` says "no separate deployment manifest at this scale" — also an architectural choice.

### 2.3 Dependency architecture — the depends-on graph

External dependencies are first-class `depends-on` relationships, never assumed:

```yaml
# kizo:web.todomvc (root System) — depends-on:
- pkg:generic/bun@1.1                      # role: runtime
- pkg:npm/hono@4                            # role: http_framework

# kizo:web.todomvc.todo_management.todo_repository — depends-on:
- pkg:npm/ulid                              # role: id_generation
- pkg:generic/bun@1.1                      # role: runtime (transitive)

# kizo:web.todomvc.todo_management.todo_rest_api — depends-on:
- pkg:npm/hono@4
- pkg:npm/zod                               # role: request validation
```

This is the dependency architecture, complete with role attributions. No prose "we chose Hono because…" — the choice is the pin; the rationale (if needed) is in the `spec.technical` body of the Component that uses it.

### 2.4 Boundary architecture — the single most-violated field

`Component.body.boundary` is the field that PLM would call the "responsibility statement." Each Component MUST state both what it owns AND what it does NOT own. From TodoMVC:

```yaml
# todo_repository.body.boundary:
Owns the todos table DDL and the per-operation SQL. Does NOT own:
REST routing (todo_rest_api), filter semantics (todo_filter_engine),
or the SQLite connection (Bun runtime singleton).
```

```yaml
# todo_list_view.body.boundary:
Owns the list DOM, per-item event handlers, and the edit-mode FSM
instance per list item. Does NOT own the data (fetched from
todo_rest_api) or the filter applied to the list (passed in by
todo_filter_router).
```

The "does NOT own" half is load-bearing. It is the boundary, declared from both sides. When you read these statements end-to-end, you have read the architectural responsibility graph. The boundary statements MUST be honest — if a Component sneaks in logic that belongs elsewhere, the spec is wrong, not the code.

### 2.5 Interface architecture — the Interaction stratum

Interactions are the contracts BETWEEN Components. They're explicit, addressable, version-controlled, and `contract_kind`-tagged so a tool can understand them. TodoMVC has four:

| Interaction id (under kizo:web.todomvc...)     | contract_kind         | What it pins                                                      |
|------------------------------------------------|-----------------------|-------------------------------------------------------------------|
| `todo_management.todo_repository.todo_schema`  | `schema_binding`      | DDL: `id TEXT PK, title TEXT NOT NULL CHECK length>0, completed INTEGER 0|1, created_at, updated_at`; PRAGMAs (WAL, foreign_keys, NORMAL) |
| `todo_management.todo_rest_api.rest_api_contract` | `integration_adapter` | 7 endpoints with status-code taxonomy: GET/POST/PATCH/DELETE shapes |
| `web_ui.todo_list_view.edit_mode_fsm`          | `fsm`                 | 3 states (VIEWING, EDITING, DELETED); 4 transitions (double-click, Enter, blur, Escape); behavior on empty-after-trim |
| `web_ui.todo_filter_router.url_hash_event_flow` | `event_flow`          | hashchange listener mapped to `{all, active, completed}`; fallback rewrite for unknown hashes |

This is what architecture diagrams in traditional practice would draw as boxes-and-arrows. In the sekkei it's authored as YAML so the regenerator can read it. The FSM contract has named states and transitions — those names must match the realization verbatim (the "read FSM from source" rule). That's not stylistic; that's because regeneration must be able to reproduce the contract.

### 2.6 Configuration architecture — parameters and their binding scope

The System-level parameters define the architectural configuration surface:

```yaml
# kizo:web.todomvc — System parameters
parameters:
  - { name: server_port,        binding_scope: system, default: 3000 }
  - { name: database_path,      binding_scope: system, default: ./data/todomvc.db }
  - { name: hono_logger_enabled, binding_scope: system, default: true }
  - { name: cors_origin,        binding_scope: system, default: "*" }
```

```yaml
# kizo:web.todomvc.web_ui — Capability parameters
parameters:
  - { name: input_placeholder,        binding_scope: capability, default: "What needs to be done?" }
  - { name: hash_routes,              binding_scope: capability, default: [#/, #/active, #/completed] }
  - { name: counter_singular_label,   binding_scope: capability, default: "item left" }
```

The `binding_scope` field is architectural: it says where this parameter is BOUND, not where it's CONSUMED. A `binding_scope: system` parameter is visible to every descendant; a `binding_scope: capability` parameter is scoped to that Capability's subtree. A fork that wants to vary the input placeholder for a French TodoMVC binds `input_placeholder: "Que faut-il faire?"` at the `web_ui` Capability — not at the root, because that's not where the choice belongs.

### 2.7 Implementation architecture — the `spec.technical` leaves

This is where the lower-level architectural choices live, per Component. For `todo_repository` in TodoMVC:

```yaml
body:
  implementation:
    runtime: bun
    storage: bun:sqlite (WAL mode)
    connection: |
      Singleton Database instance opened at startup with `database_path`
      System parameter. PRAGMAs at open time:
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        PRAGMA foreign_keys = ON;
        PRAGMA busy_timeout = 5000;
    prepared_statements: |
      All operations use prepared statements (db.prepare(...).get/all/run)
      cached on the repository instance for hot-path latency.
    id_generation: |
      ULID via the `ulid` package by default. Lexicographically sortable.
    timestamps: |
      ISO-8601 UTC produced by `new Date().toISOString()` at the application
      layer (not datetime('now') in SQL — that returns local-server time
      and lacks milliseconds).
    serialization: |
      Bun:sqlite serializes writes per-connection. No additional locking
      needed for this single-process demo.
    error_taxonomy:
      - "title length 0 → SQLite CHECK constraint failure → ValidationError"
      - "id collision → UNIQUE constraint failure → ConflictError"
      - "missing id on get/update/delete → returns null/false (NOT error)"
  module_layout: |
    src/db.ts        — opens the connection, applies PRAGMAs, exports `db`
    src/repository.ts — exports class TodoRepository(db) with the methods above
```

Every architectural-level decision is named: prepared statements (not ad-hoc strings); ULID (not UUID v7 or sequential); application-layer timestamps (not SQL `datetime('now')`); per-connection write serialization (not external locking). The HARD CONSTRAINTS list at the bottom of the same Component's `spec.prompt` echoes these as non-negotiable for regeneration.

For the REST API:

```yaml
body:
  framework: Hono v4
  middleware:
    - "cors({ origin: cors_origin })"
    - "logger() if request_logging is true"
    - "JSON body parser is built-in to Hono via c.req.json()"
  validation: |
    Request bodies are validated with zod schemas defined in src/routes/schemas.ts.
  error_translation:
    ValidationError: 422
    ConflictError:   409
    NotFound:        404
    JSON parse:      400
    ZodError:        400
    unhandled:       500 + log
  static_serving: |
    `/` and `/css/...`, `/js/...` are served from ./public via Hono's serveStatic.
    Falls back to index.html for any non-API non-asset path so hash-based
    client routing works.
```

Hono v4 (not Express), zod (not joi), an explicit error-translation table, SPA fallback strategy — all architectural choices, all in the `technical` body where they belong, none of them written as a separate "architecture document."

### 2.8 Data architecture — `spec.schema`

The entity shapes:

```yaml
# todo_repository.spec.schema.body.data_shapes
Todo:
  type: object
  required: [id, title, completed, created_at, updated_at]
  properties:
    id:         { type: string }
    title:      { type: string, minLength: 1 }
    completed:  { type: boolean }
    created_at: { type: string, format: date-time }
    updated_at: { type: string, format: date-time }
  additionalProperties: false
```

The wire shapes (request/response):

```yaml
# todo_rest_api.spec.schema.body.shapes
CreateTodoRequest:    { ..., required: [title] }
PatchTodoRequest:     { anyOf: [required: [title], required: [completed]] }
ToggleAllRequest:     { ..., required: [completed] }
TodoResponse:         { $ref: ...todo_repository.spec.schema#/data_shapes/Todo }
ErrorResponse:        { error: enum[invalid_request, not_found, ...], message, issues? }
```

And the cross-tier coercion rule lives next to it:

```yaml
serialization_to_sqlite: |
  completed is stored as INTEGER (0 or 1) in SQLite and converted to
  boolean at the repository boundary.
```

That single statement IS a data architecture decision — at the boundary, we coerce. Without it, the API would leak `0`/`1` to clients, which is a real bug avoided by an architectural decision pinned in one place.

### 2.9 Cross-cutting invariants — `spec.business_rule`

These are the architectural rules that span Components. For TodoMVC:

```
# todo_repository:
BR-REPO-001: title MUST be non-empty after trim — CHECK + ValidationError
BR-REPO-002: id never changes after create
BR-REPO-003: updated_at MUST advance on every UPDATE
BR-REPO-005: toggleAll is no-op when already at target (WHERE completed != ?)

# todo_rest_api:
BR-API-001: filter validation lives in the API layer; repository assumes valid
BR-API-002: PATCH MUST NOT accept empty body (neither title nor completed)
BR-API-003: DELETE on missing id is 404, NOT 204
BR-API-004: completed MUST be coerced to boolean before JSON (never 0/1)
BR-API-006: DELETE /completed is idempotent, always 200 (even if 0 rows)

# todo_list_view:
BR-LIST-002: Enter while EDITING with empty-after-trim MUST DELETE the todo
BR-LIST-003: Escape MUST discard, no PATCH issued
BR-LIST-004: blur MUST behave like Enter (commit, not cancel)
BR-LIST-006: filtered-out items MUST NOT be in the DOM (no display:none hack)
BR-LIST-007: only one item in EDITING at a time
```

These are architectural invariants — they cross Component boundaries (the API trusts the repository's validation; the repository trusts the schema's CHECK), they have names so they're quotable, and they have enforcement notes so the regenerator knows WHERE to enforce. None of these would survive a free-form "Architecture.md" document; they'd evaporate into prose.

---

## 3. So what should a reader do when they want "the architecture"?

Read the sekkei top-down:

1. Start at `sekkei.yaml` — the System body's `realization_summary` is the one-paragraph elevator pitch ("Single Bun process. Hono router. bun:sqlite (WAL)…").
2. Walk every `composes-of` edge — that's the structural tree.
3. For each Component, read `body.boundary` (responsibility), `body.runtime` (deployment), and `depends-on` (libraries used).
4. For each Interaction, read `contract_kind` + `contract_definition` (the interfaces between Components).
5. Open each Component's `spec.technical` for implementation choices.
6. Open each Component's `spec.schema` for data shapes.
7. Scan `spec.business_rule` files for cross-cutting invariants.

That sequence reproduces what a traditional architecture document would have told you, except every piece is content-addressable, version-controlled, and the regenerator can act on it directly. The trade-off is: there is no single "architecture deck." You build the picture by walking the tree.

If a stakeholder absolutely needs a one-pager, the System's `realization_summary` + the `composes-of` tree + the table of Component runtimes is enough for 80% of conversations. The remaining 20% (the "but how does X really work") points the reader at the specific Component's `spec.technical`, which is more precise than any narrative could be.

---

## 4. What this implies for the sekkei methodology

Three corollaries fall out of the distributed-architecture pattern:

- **`spec.functional` is the WHAT, `spec.technical` is the HOW, but neither is "the architecture."** Architecture is what happens at the strata above — Component, Interaction, Capability, System — plus the runtime/dependency/boundary fields and the parameter binding scopes.
- **The architectural "diagram" is generated, not authored.** A 30-line script over the sekkei produces the boxes-and-arrows view: nodes = Components colored by `runtime`, edges = `composes-of`/`depends-on`, contracts = Interactions on the edges. We haven't built this view yet, but the data is all there. (Future work: `make architecture-svg`.)
- **An "Architecture Decision Record" (ADR) maps cleanly onto a single commit on `spec.technical` or `spec.business_rule`.** The commit message records the decision; the body of the spec records the choice; the `provenance.authored_by` records who; the `provenance.authored_at` records when. No separate `docs/adr/0042-use-hono-v4.md` is needed — the ADR is the diff plus the surrounding spec.

The model is opinionated about this. Architecture is not a document; it's the structure. The sekkei IS the document, and the structure of the sekkei IS the architecture.
