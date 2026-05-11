# Path-B Validation — TodoMVC Sekkei → Working Implementation

**Sekkei:** `kizo:web.todomvc @ A.0` at `todo-mvc/sekkei-todomvc/`
**Implementation:** `todo-mvc/src/`
**Date:** 2026-05-10
**Verdict:** **High-fidelity regeneration of the runtime, but tests were not produced.** The sekkei is sound; the regeneration pipeline (or the prompt-driven generator) skipped the test files that every `spec.acceptance` listed as deliverables.

This document is an honest scorecard, not a victory lap.

---

## 1. Inventory check — what the sekkei promised vs what shipped

The sekkei's `spec.prompt.outputs[]` and `spec.acceptance.deliverables[]` together enumerate every file the regeneration was expected to produce. Below: each one, and whether it exists.

| Component               | File                                       | Promised by                      | Present? | Notes |
|-------------------------|--------------------------------------------|----------------------------------|---------:|-------|
| todo_repository         | `src/db.ts`                                | prompt                           | yes      | PRAGMAs at open ✓ |
| todo_repository         | `src/repository.ts`                        | prompt                           | yes      | All 7 methods ✓ |
| todo_repository         | `src/migrations/001_create_todos.sql`      | prompt + acceptance              | yes      | DDL + PRAGMAs |
| todo_repository         | `test/repository.test.ts`                  | prompt + acceptance              | **MISSING** | |
| todo_filter_engine      | `src/filter.ts`                            | prompt                           | yes      | Pure ✓ |
| todo_filter_engine      | `public/js/filter.js`                      | prompt                           | yes      | Mirror ✓ |
| todo_filter_engine      | `test/filter.test.ts`                      | prompt + acceptance              | **MISSING** | |
| todo_rest_api           | `src/server.ts`                            | prompt                           | yes      | Hono v4 ✓ |
| todo_rest_api           | `src/routes/todos.ts`                      | prompt                           | yes      | All 7 endpoints ✓ |
| todo_rest_api           | `src/routes/health.ts`                     | prompt                           | yes      | `/healthz` ✓ |
| todo_rest_api           | `src/routes/schemas.ts`                    | prompt                           | yes      | Zod ✓ |
| todo_rest_api           | `src/routes/static.ts`                     | prompt                           | yes      | + SPA fallback ✓ |
| todo_rest_api           | `test/api.test.ts`                         | prompt + acceptance              | **MISSING** | |
| todo_pwa_shell          | `public/index.html`                        | prompt                           | yes      | All required selectors ✓ |
| todo_pwa_shell          | `public/css/index.css`                     | prompt                           | yes      |  |
| todo_pwa_shell          | `public/css/base.css`                      | prompt                           | yes      | Copied todomvc-app-css |
| todo_pwa_shell          | `public/js/app.js`                         | prompt                           | yes      | Bootstrap + store ✓ |
| todo_pwa_shell          | `test/e2e/shell.spec.ts`                   | prompt + acceptance              | **MISSING** | |
| add_todo_input          | `public/js/add-todo-input.js`              | prompt                           | yes      | IME guard ✓ |
| add_todo_input          | `test/e2e/add-todo.spec.ts`                | prompt + acceptance              | **MISSING** | |
| todo_list_view          | `public/js/todo-list-view.js`              | prompt                           | yes      | + XSS escape ✓ |
| todo_list_view          | `public/js/edit-mode-fsm.js`               | prompt                           | yes      | 3 states ✓ |
| todo_list_view          | `test/e2e/todo-list.spec.ts`               | prompt + acceptance              | **MISSING** | |
| footer_view             | `public/js/footer-view.js`                 | prompt                           | yes      |  |
| footer_view             | `test/e2e/footer.spec.ts`                  | prompt + acceptance              | **MISSING** | |
| todo_filter_router      | `public/js/filter-router.js`               | prompt                           | yes      | replaceState ✓ |
| todo_filter_router      | `test/e2e/filter-router.spec.ts`           | prompt + acceptance              | **MISSING** | |
| (none)                  | `package.json`                             | inferred                         | yes      | Not in any prompt.outputs |
| (none)                  | `tsconfig.json`                            | inferred                         | yes      | Not in any prompt.outputs |
| (none)                  | `bun.lock`                                 | install side effect              | yes      | Not specified |

**Score:** 21 of 21 runtime files present. **0 of 8 test files present.**

---

## 2. Code-vs-spec drift audit (per Component)

Every load-bearing rule and HARD CONSTRAINT in the sekkei was checked against the realized source. The detailed findings follow.

### 2.1 todo_repository — PASS

- All 7 methods (`create`, `list`, `get`, `update`, `remove`, `removeCompleted`, `toggleAll`) present, signatures match.
- BR-REPO-001 (title non-empty after trim) enforced both at SQL CHECK and at `ValidationError` throw.
- BR-REPO-005 (toggleAll no-op when already at target) implemented via `WHERE completed != ?` clause.
- HARD CONSTRAINT: `bun:sqlite` ✓; PRAGMAs at open ✓; timestamps in JS via `new Date().toISOString()` ✓; missing-id is null/false ✓; empty title throws ✓.
- **Drift+**: prepared statements use `ORDER BY created_at ASC, id ASC` (the spec said only `created_at ASC`). The id tiebreaker is harmless and gives deterministic order under fast inserts — an improvement worth lifting into the spec.
- **Drift~**: PRAGMAs are duplicated — once in `db.ts` (lines 12-15) and once at the top of the migration SQL. Redundant but not wrong. Spec should pick one location.

### 2.2 todo_filter_engine — PASS

- `filter`, `countActive`, `countCompleted` all present in both `src/filter.ts` and `public/js/filter.js`.
- HARD CONSTRAINT: pure function ✓; throws TypeError on unknown mode ✓; returns slice() for 'all' (a copy — spec permitted either) ✓.
- The two implementations are byte-equivalent in semantics (validated by reading both).

### 2.3 todo_rest_api — PASS (with one complexity flag)

- All 7 endpoints present, status codes correct.
- HARD CONSTRAINT: Hono v4 ✓; `completed` coerced to boolean (`row.completed === 1`) ✓; PATCH with empty body → 400 ✓; DELETE missing → 404 ✓; 422 on empty-after-trim title ✓; SPA fallback ✓.
- `errorBody` shape matches `spec.schema.ErrorResponse` exactly.
- BR-API-006 (DELETE /completed always 200, even when nothing matched) — implemented.
- **Drift+**: route-ordering is correct: `/api/todos/toggle-all` and `/api/todos/completed` are registered BEFORE `/api/todos/:id`, so the static segments win the match. The spec didn't say this; it's a foot-gun the regenerator avoided.
- **Drift~**: the PATCH route's empty-title detection is more elaborate than necessary — it does both Zod-level `min(1)` enforcement AND a manual `trim().length === 0` re-check after parsing, distinguishing the two via Zod issue codes. The spec asked for one behavior (422 on empty-after-trim) and the code implements it via two independent checks. Works, but could be simplified if `PatchTodoSchema` accepted `min(0)` and the route alone owned the trim-validation.

### 2.4 todo_pwa_shell — PASS (with two unspecified additions)

- All required selectors (h1='todos', input.new-todo[autofocus], section.main, ul.todo-list, footer.footer, footer.info) present.
- `section.main` and `footer.footer` start with `style="display: none"` and are toggled by their respective views — matches the BR-FOOTER-001 / shell-acceptance requirement that they're hidden on empty state.
- ES modules served as-is; no bundler ✓.
- **Unspecified addition**: `<div class="error-banner" hidden>` was added (mentioned in spec.technical as production hygiene but not enumerated in spec.schema.required_selectors). Harmless, useful, but worth lifting into the schema.
- **Unspecified addition**: `<p>Generated from <code>kizo:web.todomvc @ A.0</code></p>` — sekkei self-attribution in footer.info. Cute but not in spec.

### 2.5 add_todo_input — PASS (with one parameter wiring gap)

- All HARD CONSTRAINTS satisfied: trim → empty noop ✓; clear only on 201 ✓; IME guard via `event.isComposing || event.keyCode === 229` ✓; input disabled across round-trip ✓.
- **Drift–**: `spec.functional.behaviors.init` said the init function should "set placeholder = `input_placeholder` System param". The code does NOT set the placeholder — it's hardcoded in `index.html` as `What needs to be done?`. The `input_placeholder` parameter declared on the `web_ui` Capability is not wired through. Functionally correct (default value matches), but the parameter pipeline is broken. Worth a v1.2 spec note: parameter-to-DOM wiring needs an explicit binding mechanism.
- **Unspecified addition**: `input.focus()` after re-enabling. UX win.

### 2.6 todo_list_view (+ edit_mode_fsm) — PASS (with one security gap-fill)

- Edit-mode FSM implements VIEWING / EDITING / DELETED with the four expected transitions: doubleClick, pressEnter (with empty-after-trim → DESTROY branch), blur (commits like Enter), pressEscape (discard).
- All 7 BR-LIST rules enforced.
- HARD CONSTRAINTS: blur commits ✓; empty-after-trim deletes ✓; Escape never PATCHes ✓; toggle-all derives from current state ✓; filtered-out items NOT in DOM ✓ (filter() applied before render).
- **CRITICAL gap-fill that the regenerator caught but the spec missed**: an `escape()` HTML-escape utility (lines 5-12) is applied to titles before innerHTML insertion. The spec's `spec.business_rule` did not include an XSS rule. The regenerator added the right defense; the spec must add `BR-LIST-008: Todo titles MUST be HTML-escaped before DOM insertion.` to v1.2.
- **Drift~**: the FSM exports a `destroyClick` action, but the view handles destroy-button clicks directly via event delegation rather than routing through the FSM. Functionally correct; the FSM-as-spec and FSM-as-impl partially diverge. The acceptance criterion "every transition has at least one Playwright case exercising it" cannot be checked because the tests don't exist.

### 2.7 footer_view — PASS

- Single click listener scoped to `button.clear-completed` — BR-FOOTER-005 enforced.
- Singular vs plural counter logic correct (BR-FOOTER-002).
- `footer.style.display = 'none'` when `todos.length === 0` (BR-FOOTER-001).
- `clear-completed` button rendered conditionally on any-completed (BR-FOOTER-003).
- Filter links: only ONE has class='selected' at any time (BR-FOOTER-004).
- HARD CONSTRAINT: filter `<a>` elements have NO click handlers — they're plain anchors observed by the router via hashchange ✓.

### 2.8 todo_filter_router — PASS (with one improvement worth promoting)

- Three valid hashes mapped correctly; unknown hashes rewritten to `#/`.
- NO HTTP calls ✓.
- Direct navigation to `/#/active` lands in active filter on first paint ✓ (resolve() called once at init, before listener install).
- **Improvement**: code uses `history.replaceState(null, "", "#/")` for unknown-hash rewrite, with `location.hash` as fallback. The spec.technical accepted that `location.hash =` would trigger a follow-up hashchange and double-render; `replaceState` does NOT trigger an event, so the rewrite is single-render. The regenerator's choice is strictly better. Worth promoting into the spec.

---

## 3. Verifier execution

Cannot execute the embedded `spec.acceptance.verifier.command` for any Component because:

1. The regenerator did not produce any test files (8 promised, 0 shipped).
2. `bun` is not installed in this validation sandbox.
3. Playwright would require browser binary downloads (~300 MB) and is not installed.

The runtime can be hand-validated by reading the source files (done above). The acceptance gate the sekkei defined — *"Regenerating from this sekkei must produce a system that passes every spec.acceptance.deliverables[]"* — is **NOT MET** because the deliverables literally do not exist.

If JJ or another generator were to author the test files now, the runtime would (based on the static audit) pass them. But the regeneration as it stands has produced an unverified system.

---

## 4. What this validation reveals about the sekkei (v1.1)

The sekkei is structurally sound. The 6-gate verifier passed. The 8 Components, 4 Interactions, and 42 Specs were enough to drive a high-fidelity regeneration of the runtime. The methodology works.

But four real gaps in the v1.1 specification appeared:

### 4.1 Test files are deliverables that the prompt structure does NOT enforce

The spec.prompt body lists `outputs[]` of the form `{path, description}`. There is no convention separating "runtime files" from "test files." A regenerator that runs out of attention, time, or token budget is free to ship the runtime and skip the tests — exactly what happened here.

**v1.2 proposal**: split `spec.prompt.outputs` into `outputs.runtime[]` and `outputs.tests[]`, with the verifier command refusing to declare success unless every `outputs.tests[].path` exists AND its corresponding `verifier.command` returns 0. Optionally, a separate `spec.prompt` per Component for "runtime" vs "tests" so the regenerator can be invoked twice with separate budgets.

### 4.2 XSS / HTML-escaping rule was missing from view specs

The regenerator caught this independently and added an `escape()` utility. A spec that ships a regenerator could miss it on the second try. Every Component whose runtime is `in_browser` and that writes user-supplied strings to the DOM needs a `BR-XSS` rule.

**v1.2 proposal**: the Component template for `runtime: in_browser` should include a default business_rule `BR-XSS: any user-supplied string written into innerHTML or other parsed-HTML sinks MUST pass through the htmlEscape() helper.` Make it inheritable so every browser Component picks it up.

### 4.3 Parameter wiring is implicit

`add_todo_input` declared `input_placeholder` as a `web_ui` Capability parameter, and the spec.functional said the init function should set `input.placeholder = input_placeholder`. The regenerator ignored this and hardcoded the placeholder in `index.html`. Functionally identical (default values match), but a `web_ui` operator who tries to re-bind `input_placeholder` will get nothing.

The sekkei doesn't say HOW parameters reach the runtime. For the backend it's clear (env vars: `process.env.SERVER_PORT`, `process.env.DATABASE_PATH`, `process.env.CORS_ORIGIN` — visible in `src/server.ts`). For the frontend, there's no convention.

**v1.2 proposal**: every parameter declares a `realization_binding` field — `env_var: SERVER_PORT`, `data_attr: input.new-todo[data-placeholder]`, `js_constant: PLACEHOLDER`, etc. Regenerators wire from there.

### 4.4 Inferred-but-unspecified outputs

`package.json`, `tsconfig.json`, and `bun.lock` shipped without being listed in any `spec.prompt.outputs[]`. The regenerator inferred them from the dependency closure. This is fine for a small system, but for any larger sekkei the inference becomes a cliff: did the regenerator pick the right TypeScript target? The right Bun version pin? The right scripts?

**v1.2 proposal**: a System-stratum Component called something like `build_manifest` whose realization is the `package.json` + lockfile + `tsconfig.json`, with explicit prompt and acceptance. The deps already live in `nodes/dependencies/external_deps.yaml` — wire them through.

---

## 5. What the sekkei got right

The methodology delivered. Of the ~40 hard constraints and business rules across all 8 Components, every load-bearing one is satisfied in code. None of the FSM transitions are wrong. None of the API status codes are wrong. None of the BR rules I checked were violated. The PRAGMAs are at open. The `completed` boolean coercion happens at the boundary. The PATCH-empty-body path returns 400, not 200. The DELETE-missing-id path returns 404, not 204. The toggle-all derivation is right. The Escape-never-PATCHes invariant holds.

That this is achievable from a 57-node design — without the regenerator having to re-derive the design choices — is the methodology's case-in-point. The cost of the second regeneration (against the same sekkei, different generator) will be even lower, because the sekkei *captured the choices that matter*.

The four gaps in §4 are refinements, not rebuttals. They are the kind of feedback that v1.1 → v1.2 is for.

---

## 6. Action items for sekkei v1.2

1. Split `spec.prompt.outputs` into `outputs.runtime[]` and `outputs.tests[]`; require both before claiming success.
2. Add a default `BR-XSS` rule to the Component template for `runtime: in_browser`.
3. Add a `realization_binding` field to every parameter declaration.
4. Add a System-stratum `build_manifest` Component that owns `package.json` + lockfile + `tsconfig.json`.
5. Promote the regenerator's improvements into the spec:
   - Routes ordering: static segments before parameterized ones (REST API technical spec).
   - `history.replaceState` for hash-rewrite (filter-router technical spec).
   - `ORDER BY ... , id ASC` tiebreaker on every list query (repository technical spec).
6. Add a `realization_audit_report.md` deliverable to the System acceptance: the file this is.
7. Consider making the `spec.prompt.verifier.command` a HARD GATE in the regeneration pipeline — if it doesn't return 0, the regeneration is INCOMPLETE, not "shipped without tests."

---

## 7. Bottom line

| Question                                                    | Answer |
|-------------------------------------------------------------|--------|
| Is the runtime correct?                                     | Yes — high fidelity to the sekkei. |
| Did the regenerator follow the HARD CONSTRAINTS?            | Yes — all checked rules satisfied. |
| Did the regenerator add anything the sekkei should adopt?   | Yes — XSS escape, replaceState, route ordering, id tiebreaker. |
| Did the regenerator skip anything load-bearing?             | Yes — all 8 acceptance test files. |
| Could the sekkei alone (re-)produce this same system tomorrow? | Yes for the runtime; only if the prompt structure is revised before tests will reliably ship. |
| Is the sekkei v1.1 itself flawed?                           | No — it caught everything it was designed to catch. The four gaps are v1.2 refinements. |
| What's the most important single change for v1.2?           | Make tests a separate, gated output category in `spec.prompt`. |

The methodology cleared the bar. The next iteration sharpens the tool.
