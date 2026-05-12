# TodoMVC Sekkei — Verification Report

**Sekkei:** `kizo:web.todomvc @ A.0`
**Date:** 2026-05-10
**Verifier:** `verify_sekkei.py` (TodoMVC-adapted, 6 checks)

## Result: PASS

All six gate checks pass. The sekkei is structurally sound and ready
for Path B (regenerate the system from this sekkei + dependency
closure and validate against the Playwright behavioral tests).

## Inventory

| Stratum     | Count |
|-------------|------:|
| system      |     1 |
| capability  |     2 |
| component   |     8 |
| interaction |     4 |
| spec        |    42 |
| **TOTAL**   | **57** |

YAML files: 14 (1 root + 2 capabilities + 2 component bundles + 1 interactions + 1 deps + 8 spec sets + 1 verify script)

### spec_kind breakdown

| spec_kind     | Count |
|---------------|------:|
| functional    |     8 |
| technical     |     8 |
| acceptance    |     8 |
| prompt        |     8 |
| business_rule |     7 |
| schema        |     3 |

Every Component has the required four (functional, technical, acceptance,
prompt). business_rule is omitted only on the PWA shell (markup with no
behavioral rules of its own). schema is present where there is a real
data shape to pin down: todo_repository (Todo entity), todo_rest_api
(request/response shapes), and todo_pwa_shell (DOM contract).

## Gate-by-gate

### 1. Envelope checks — PASS
Every node has id, stratum, title, revision (major=A, valid status),
provenance (valid override_kind). Every spec node has a recognized
`spec_kind`.

### 2. Stratum hierarchy (§C.1 amendment) — PASS
No composes-of edge crosses a forbidden boundary (System → System|Cap;
Cap → Comp|Int|Spec; Comp → Int|Spec; Int → Spec; Spec is a leaf).

### 3. Closure completeness — PASS
Every `kizo:` target on a composes-of / depends-on relationship resolves
to an authored node. External `pkg:`/`dep:`/`svc:`/`hw:` targets are
treated as the closure boundary (their pins live in
`nodes/dependencies/external_deps.yaml`).

### 4. Brief coverage — PASS
All required nodes present:

- 2 Capabilities — todo_management, web_ui
- 8 Components — todo_repository, todo_filter_engine, todo_rest_api,
  todo_pwa_shell, add_todo_input, todo_list_view, footer_view,
  todo_filter_router
- 4 Interactions — todo_schema, rest_api_contract, edit_mode_fsm,
  url_hash_event_flow

### 5. Spec coverage — PASS
Every Component has spec.functional, spec.technical, spec.acceptance,
and spec.prompt.

### 6. Spec quality — PASS
Every spec.acceptance carries `body.deliverables` (test_file paths,
test cases) and `body.verifier` (executable command).
Every spec.prompt carries `body.context_bundle` (set of node ids),
`body.outputs` (file paths to produce), and `body.verifier`.

## Lessons applied from BaanBaan A.0

- **FSM states read verbatim** — `edit_mode_fsm` (VIEWING / EDITING /
  DELETED) and the implicit transitions in todo_list_view are described
  as the implementation must produce them, not as a "what an edit FSM
  usually looks like" sketch. (Saved as memory:
  `feedback_read_fsm_before_describing.md`.)
- **Honest descriptions** — every Component's `body.boundary` says what
  it does NOT own. Filter engine is marked `runtime: in_process_and_in_browser`
  with the dual-source strategy spelled out (no pretending the same file
  somehow runs everywhere).
- **Per-Component spec files** at `nodes/specs/by_component/*.yaml` —
  one file per Component, all 6 spec_kinds bundled.
- **Acceptance specs as deliverables + invariants + verifier**, not
  just inspection prose. Each cites a concrete test file and the bun:test
  or playwright command that proves it.
- **Prompts as machine-runnable triples** — `context_bundle` (the closure
  the LLM is given), `outputs` (the file paths to produce), `verifier`
  (the same executable command from the acceptance spec).

## Path-B regeneration readiness

A regenerator given this sekkei needs:

1. The sekkei files (this folder).
2. The dependency closure pinned in `nodes/dependencies/external_deps.yaml`
   (bun, hono, ulid, zod, todomvc-app-css, todomvc-common, bun-test, playwright).
3. The 8 prompt templates (one per Component) — they are independent
   and can be issued in this order:
   - Phase 1 (no inter-Component deps): `todo_filter_engine`,
     `todo_repository` (depends on todo_schema only).
   - Phase 2: `todo_rest_api` (depends on the two above).
   - Phase 3: `todo_pwa_shell` (no JS-module deps; just the static shell).
   - Phase 4 (parallel): `add_todo_input`, `todo_list_view`,
     `footer_view`, `todo_filter_router` (each depends only on the
     shell + REST API + filter engine signatures).
4. Per-Component verifier commands run after generation; each is a
   single shell line in the spec.acceptance / spec.prompt body.

## Caveats / known gaps for A.1

- No dBOM at this scale (single host, single SQLite file). Recorded as
  `body.dbom_ref: null` in the root System.
- No sekkei.lock (deferred per project instructions).
- No CI / packaging Component — out of scope for the methodology
  validation.
- The frontend filter engine is documented as a hand-mirror of the
  backend `src/filter.ts`. If a regen run produces non-byte-equivalent
  copies that nonetheless pass the test suite, that is acceptable;
  if A.1 wants to enforce byte-equivalence, add a build-step
  Component to the web_ui Capability.
