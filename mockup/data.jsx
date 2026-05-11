/* ----------------------------------------------------------------------------
   Puffin GLM — seeded design corpus
   Models kizo:web.todomvc @ A.0 plus a fork kizo:web.todomvc.team @ A.0 to
   demonstrate variant inheritance. Hashes are stable-fake so the cache view
   reads correctly.
---------------------------------------------------------------------------- */

/* ---------- Hash utility (stable fake content addressing) ---------- */
function djb2(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16).padStart(8, "0");
}
function hash(...parts) {
  return "sha256:" + djb2(parts.join("|")) + djb2(parts.join("·")) + djb2(parts.join("~")) + djb2(parts.join(""));
}
function shortHash(h) { return h.replace(/^sha256:/, "").slice(0, 10); }

/* ---------- Strata ---------- */
const STRATA = ["system", "capability", "component", "interaction", "spec"];
const STRATUM_LABEL = {
  system: "SYS", capability: "CAP", component: "CMP", interaction: "INT", spec: "SPC"
};
const SPEC_KINDS = ["functional", "technical", "schema", "business_rule", "acceptance", "prompt"];

/* ---------- Nodes — TodoMVC sekkei ---------- */
// Each: { id, stratum, title, description, parent, revision, status, override_kind,
//   derives_from, params, constraints, body, files, depends_on }
const NODES_RAW = [
  // ------------- root system -------------
  {
    id: "kizo:web.todomvc",
    stratum: "system",
    title: "Kizō Web — TodoMVC",
    description: "Canonical TodoMVC implementation with a Bun + Hono + SQLite-WAL backend. Single-user.",
    parent: null,
    revision: { major: "A", iteration: 0, status: "in_review" },
    override_kind: "net_new",
    body: { system_role: "root", dbom_ref: null, runtime: "bun_process" },
    params: [
      { name: "server_port", type: "integer", default: 3000, min: 1024, max: 65535, scope: "system" },
      { name: "database_path", type: "string", default: "./data/todomvc.db", scope: "system" },
      { name: "cors_origin", type: "string", default: "*", scope: "system" },
      { name: "hono_logger_enabled", type: "boolean", default: true, scope: "system" }
    ],
    constraints: [
      { kind: "invariant", expression: "single_user == true", severity: "error" },
      { kind: "invariant", expression: "persistence == sqlite_wal", severity: "error" }
    ],
    depends_on: [
      { purl: "pkg:generic/bun@1.1", role: "runtime", digest: "sha256:bun-1.1.x" },
      { purl: "pkg:npm/hono@4.6.3", role: "http_framework", digest: "sha256:hono-4.6.3" },
      { purl: "pkg:npm/zod@3.23.8", role: "validation", digest: "sha256:zod-3.23.8" }
    ]
  },
  // ------------- capabilities -------------
  {
    id: "kizo:web.todomvc.todo_management",
    stratum: "capability",
    title: "Todo Management",
    description: "Backend ownership of the todo data model and operations against it.",
    parent: "kizo:web.todomvc",
    revision: { major: "A", iteration: 0, status: "in_review" },
    override_kind: "net_new",
    body: { user_value: "Todos persist across refreshes and devices; filtering is server-driven." },
    params: [
      { name: "max_title_length", type: "integer", default: 200, min: 1, max: 1000, scope: "capability" },
      { name: "trim_input", type: "boolean", default: true, scope: "capability" },
      { name: "reject_empty_after_trim", type: "boolean", default: true, scope: "capability" }
    ],
    constraints: [
      { kind: "invariant", expression: "todo.title.length > 0 AFTER trim", severity: "error" },
      { kind: "invariant", expression: "filter_value in ['all','active','completed']", severity: "error" }
    ]
  },
  {
    id: "kizo:web.todomvc.web_ui",
    stratum: "capability",
    title: "Web UI",
    description: "Vanilla-JS frontend served from /public. Hash-based filter routing.",
    parent: "kizo:web.todomvc",
    revision: { major: "A", iteration: 0, status: "in_review" },
    override_kind: "net_new",
    body: { user_value: "TodoMVC reference behavior at /." },
    params: [
      { name: "show_remaining_count", type: "boolean", default: true, scope: "capability" }
    ]
  },
  // ------------- components -------------
  {
    id: "kizo:web.todomvc.todo_management.todo_repository",
    stratum: "component",
    title: "Todo Repository",
    description: "Owns the todos table and CRUD operations. bun:sqlite WAL mode.",
    parent: "kizo:web.todomvc.todo_management",
    revision: { major: "A", iteration: 2, status: "in_work" },
    override_kind: "net_new",
    body: { boundary: "Owns SQL. Does NOT own routing or filter semantics.", runtime: "in_process" },
    files: ["src/repository.ts", "src/db.ts"],
    params: [
      { name: "id_format", type: "enum", default: "ulid", options: ["ulid", "uuid_v7", "sequential"], scope: "component" }
    ]
  },
  {
    id: "kizo:web.todomvc.todo_management.todo_filter_engine",
    stratum: "component",
    title: "Todo Filter Engine",
    description: "Pure function that filters a todo set by status. Used server-side and client-side.",
    parent: "kizo:web.todomvc.todo_management",
    revision: { major: "A", iteration: 0, status: "released" },
    override_kind: "net_new",
    body: { boundary: "Pure. Stateless. No I/O.", runtime: "in_process_and_in_browser" },
    files: ["src/filter.ts", "public/js/filter.js"],
    params: [
      { name: "default_filter", type: "enum", default: "all", options: ["all", "active", "completed"], scope: "component" }
    ]
  },
  {
    id: "kizo:web.todomvc.todo_management.todo_rest_api",
    stratum: "component",
    title: "Todo REST API",
    description: "Hono router exposing seven endpoints + CORS + JSON validation.",
    parent: "kizo:web.todomvc.todo_management",
    revision: { major: "A", iteration: 1, status: "in_review" },
    override_kind: "net_new",
    body: { boundary: "HTTP routes, validation, status codes.", runtime: "in_process" },
    files: ["src/server.ts", "src/routes/todos.ts"],
    depends_on: [
      { purl: "pkg:npm/hono@4.6.3", role: "http_framework" }
    ]
  },
  {
    id: "kizo:web.todomvc.web_ui.todo_list_view",
    stratum: "component",
    title: "Todo List View",
    description: "Renders todos, drives double-click-to-edit and per-item actions.",
    parent: "kizo:web.todomvc.web_ui",
    revision: { major: "A", iteration: 0, status: "in_review" },
    override_kind: "net_new",
    body: { boundary: "DOM rendering for the list section.", runtime: "in_browser" },
    files: ["public/js/list-view.js"]
  },
  {
    id: "kizo:web.todomvc.web_ui.todo_filter_router",
    stratum: "component",
    title: "Filter Router",
    description: "Hash-router translating #/active|completed into UI state.",
    parent: "kizo:web.todomvc.web_ui",
    revision: { major: "A", iteration: 0, status: "released" },
    override_kind: "net_new",
    body: { boundary: "hashchange listener, history.replaceState fallback.", runtime: "in_browser" },
    files: ["public/js/filter-router.js"]
  },
  {
    id: "kizo:web.todomvc.web_ui.footer_view",
    stratum: "component",
    title: "Footer View",
    description: "Bottom strip: items-left counter, filter links, clear-completed.",
    parent: "kizo:web.todomvc.web_ui",
    revision: { major: "A", iteration: 0, status: "released" },
    override_kind: "net_new",
    body: { boundary: "DOM rendering for the footer.", runtime: "in_browser" },
    files: ["public/js/footer-view.js"]
  },
  // ------------- interactions -------------
  {
    id: "kizo:web.todomvc.todo_management.todo_repository.todo_schema",
    stratum: "interaction",
    title: "Todo Schema",
    description: "DDL for the single todos table. Sort by created_at ASC.",
    parent: "kizo:web.todomvc.todo_management.todo_repository",
    revision: { major: "A", iteration: 0, status: "released" },
    override_kind: "net_new",
    body: {
      contract_kind: "schema_binding",
      contract: "table todos: id TEXT PK, title TEXT NOT NULL, completed INTEGER NOT NULL DEFAULT 0, created_at TEXT, updated_at TEXT"
    },
    constraints: [
      { kind: "invariant", expression: "pragma.journal_mode == 'wal'", severity: "error" },
      { kind: "invariant", expression: "pragma.foreign_keys == 1", severity: "error" }
    ],
    files: ["src/db.ts"]
  },
  {
    id: "kizo:web.todomvc.todo_management.todo_rest_api.rest_api_contract",
    stratum: "interaction",
    title: "REST API Contract",
    description: "Wire contract for the seven endpoints the Web UI consumes.",
    parent: "kizo:web.todomvc.todo_management.todo_rest_api",
    revision: { major: "A", iteration: 1, status: "in_review" },
    override_kind: "net_new",
    body: {
      contract_kind: "integration_adapter",
      endpoints: [
        "GET    /api/todos[?filter=…]",
        "POST   /api/todos          { title }",
        "PATCH  /api/todos/:id      { title?, completed? }",
        "DELETE /api/todos/:id",
        "POST   /api/todos/toggle-all { completed }",
        "DELETE /api/todos/completed",
        "GET    /healthz"
      ]
    },
    files: ["src/routes/todos.ts"]
  },
  {
    id: "kizo:web.todomvc.web_ui.todo_list_view.edit_mode_fsm",
    stratum: "interaction",
    title: "Edit Mode FSM",
    description: "Per-item small FSM driving double-click-to-edit.",
    parent: "kizo:web.todomvc.web_ui.todo_list_view",
    revision: { major: "A", iteration: 0, status: "in_review" },
    override_kind: "net_new",
    body: {
      contract_kind: "fsm",
      states: ["VIEWING", "EDITING", "DELETED"],
      transitions: [
        "VIEWING --DOUBLE_CLICK--> EDITING",
        "EDITING --ENTER--> VIEWING | DELETED  (guard: trim length)",
        "EDITING --ESC--> VIEWING  (rollback)",
        "VIEWING --DELETE_BTN--> DELETED"
      ]
    },
    files: ["public/js/edit-mode-fsm.js"]
  },
  {
    id: "kizo:web.todomvc.web_ui.todo_filter_router.url_hash_event_flow",
    stratum: "interaction",
    title: "URL Hash Event Flow",
    description: "hashchange-driven filter routing. #/ #/active #/completed.",
    parent: "kizo:web.todomvc.web_ui.todo_filter_router",
    revision: { major: "A", iteration: 0, status: "released" },
    override_kind: "net_new",
    body: { contract_kind: "event_flow", listener: "window.addEventListener('hashchange', …)" },
    files: ["public/js/filter-router.js"]
  },
  // ------------- specs (selected representative leaves) -------------
  {
    id: "kizo:web.todomvc.todo_management.todo_rest_api.spec.post_todos_acceptance",
    stratum: "spec",
    title: "POST /api/todos — Acceptance",
    description: "Acceptance criteria for create endpoint. Empty title returns 422.",
    parent: "kizo:web.todomvc.todo_management.todo_rest_api",
    revision: { major: "A", iteration: 1, status: "in_review" },
    override_kind: "net_new",
    body: {
      spec_kind: "acceptance",
      content: "GIVEN body { title: '   ' }\nWHEN POST /api/todos\nTHEN 422 { error: 'empty_title' }\n\nGIVEN body { title: 'Buy milk' }\nWHEN POST /api/todos\nTHEN 201 Todo with id (ULID) and completed=false",
      assertions: [
        { id: "post.empty_title_422", kind: "unit_test", expression: "status == 422 AND body.error == 'empty_title'" },
        { id: "post.valid_creates", kind: "unit_test", expression: "status == 201 AND body.id matches ULID AND body.completed == false" }
      ]
    }
  },
  {
    id: "kizo:web.todomvc.todo_management.todo_repository.spec.create_prompt",
    stratum: "spec",
    title: "Generation Prompt — Repository",
    description: "Machine-runnable prompt for the LLM generator.",
    parent: "kizo:web.todomvc.todo_management.todo_repository",
    revision: { major: "A", iteration: 0, status: "released" },
    override_kind: "net_new",
    body: {
      spec_kind: "prompt",
      content: "Write src/repository.ts that exposes: list(filter?), get(id), create({title}), update(id, patch), remove(id), toggleAll(completed), clearCompleted(). Use bun:sqlite, ULID ids, strict types.",
      context_bundle: ["todo_schema@A.0", "rest_api_contract@A.1"],
      outputs: ["src/repository.ts"],
      verifier: "bun test test/repository.test.ts"
    }
  },
  {
    id: "kizo:web.todomvc.web_ui.todo_list_view.spec.edit_mode_acceptance",
    stratum: "spec",
    title: "Edit Mode — Acceptance",
    description: "Behavioral assertions for the double-click edit FSM.",
    parent: "kizo:web.todomvc.web_ui.todo_list_view",
    revision: { major: "A", iteration: 0, status: "in_review" },
    override_kind: "net_new",
    body: {
      spec_kind: "acceptance",
      content: "Double-click label → input replaces it, focused, caret at end.\nEscape → discard, restore prior text, no API call.\nEnter on empty (after trim) → DELETE /api/todos/:id.",
      assertions: [
        { id: "edit.escape_no_api", kind: "property", expression: "ESC during EDITING never calls /api" },
        { id: "edit.empty_routes_delete", kind: "property", expression: "ENTER with trim()=='' issues DELETE" }
      ]
    }
  },
  {
    id: "kizo:web.todomvc.todo_management.todo_filter_engine.spec.filter_invariants",
    stratum: "spec",
    title: "Filter Engine — Invariants",
    description: "Pure function invariants.",
    parent: "kizo:web.todomvc.todo_management.todo_filter_engine",
    revision: { major: "A", iteration: 0, status: "released" },
    override_kind: "net_new",
    body: {
      spec_kind: "business_rule",
      content: "filter('all', T) === T (identity).\nfilter('active', T).every(¬completed).\nfilter('completed', T).every(completed)."
    }
  }
];

/* ---------- Compute revisions, hashes, paths ---------- */
const NODES = NODES_RAW.map(n => {
  const rev = `${n.revision.major}.${n.revision.iteration}`;
  const h = hash(n.id, rev, JSON.stringify(n.body || {}), JSON.stringify(n.params || []), JSON.stringify(n.constraints || []));
  return {
    ...n,
    rev_label: rev,
    content_hash: h,
    short_hash: shortHash(h),
    children: [],
    depth: 0
  };
});
const BY_ID = Object.fromEntries(NODES.map(n => [n.id, n]));
NODES.forEach(n => { if (n.parent && BY_ID[n.parent]) BY_ID[n.parent].children.push(n.id); });
function computeDepth(id, d = 0) {
  const n = BY_ID[id]; if (!n) return;
  n.depth = d; n.children.forEach(c => computeDepth(c, d + 1));
}
NODES.filter(n => !n.parent).forEach(r => computeDepth(r.id));

/* ---------- Variant fork: kizo:web.todomvc.team — adds multi-user assignment ---------- */
const FORK_NODES = [
  {
    id: "kizo:web.todomvc.team",
    stratum: "system",
    title: "Kizō Web — TodoMVC Team",
    description: "Multi-user fork. Inherits the canonical TodoMVC sekkei as-is, with parameter overrides plus a net-new Assignment component.",
    parent: null,
    revision: { major: "A", iteration: 0, status: "in_work" },
    override_kind: "with_override",
    derives_from: { id: "kizo:web.todomvc", rev: "A.0" },
    body: { system_role: "root", dbom_ref: null, runtime: "bun_process" },
    params: [
      { name: "server_port", type: "integer", default: 3100, scope: "system" },
      { name: "multi_user", type: "boolean", default: true, scope: "system" }
    ]
  }
];
FORK_NODES.forEach(n => {
  const rev = `${n.revision.major}.${n.revision.iteration}`;
  const h = hash(n.id, rev, JSON.stringify(n.body || {}));
  Object.assign(n, { rev_label: rev, content_hash: h, short_hash: shortHash(h), children: [], depth: 0 });
  NODES.push(n);
  BY_ID[n.id] = n;
});

/* ---------- Sekkei tree projection ---------- */
function rootNodes() { return NODES.filter(n => !n.parent); }
function childrenOf(id) { return (BY_ID[id]?.children || []).map(cid => BY_ID[cid]); }

/* ---------- SCRs (Change Management) ---------- */
const SCRS = [
  {
    id: "SCR-2026-014",
    title: "Allow soft-delete of completed todos (deleted_at column)",
    class: "I",
    status: "Under Review",
    proposer: "noemi.kiraly",
    proposed_at: "2026-05-08T11:18:00Z",
    target_nodes: [
      "kizo:web.todomvc.todo_management.todo_repository.todo_schema",
      "kizo:web.todomvc.todo_management.todo_repository",
      "kizo:web.todomvc.todo_management.todo_rest_api.rest_api_contract"
    ],
    problem: "Clear-completed is destructive. Users have asked for a soft-delete with 30-day retention so accidental clear can be undone.",
    impact: { variants_affected: 2, tokens_est: 18400, cache_miss_count: 7 },
    effectivity: "channel=canary; date>=2026-05-15",
    diff_yaml: [
      { kind: "hunk",  text: "@@ todo_schema.body.contract @@" },
      { kind: "ctx",   text: "    table: todos" },
      { kind: "ctx",   text: "    cols:" },
      { kind: "ctx",   text: "      - \"id TEXT PRIMARY KEY\"" },
      { kind: "ctx",   text: "      - \"title TEXT NOT NULL\"" },
      { kind: "ctx",   text: "      - \"completed INTEGER NOT NULL DEFAULT 0\"" },
      { kind: "add",   text: "      - \"deleted_at TEXT NULL\"           # net-new soft-delete column" },
      { kind: "ctx",   text: "    indexes:" },
      { kind: "del",   text: "      - \"CREATE INDEX idx_todos_completed ON todos(completed)\"" },
      { kind: "add",   text: "      - \"CREATE INDEX idx_todos_completed ON todos(completed) WHERE deleted_at IS NULL\"" },
      { kind: "hunk",  text: "@@ rest_api_contract.body.endpoints @@" },
      { kind: "del",   text: "    - \"DELETE /api/todos/completed       (hard delete)\"" },
      { kind: "add",   text: "    - \"DELETE /api/todos/completed       (soft: sets deleted_at)\"" },
      { kind: "add",   text: "    - \"POST   /api/todos/completed/restore  { window_days=30 }\"" }
    ],
    approvals: [
      { who: "todo_management owner", when: null, decision: "pending" },
      { who: "web_ui owner",         when: "2026-05-08T17:02Z", decision: "approve" }
    ]
  },
  {
    id: "SCR-2026-013",
    title: "Tighten max_title_length to 140 (Twitter-style)",
    class: "II",
    status: "Approved",
    proposer: "han.junseo",
    proposed_at: "2026-05-06T08:42:00Z",
    target_nodes: ["kizo:web.todomvc.todo_management"],
    problem: "Field is currently 200; long titles wrap awkwardly. Tighten to 140.",
    impact: { variants_affected: 2, tokens_est: 1200, cache_miss_count: 2 },
    effectivity: "channel=stable; immediate",
    diff_yaml: [
      { kind: "hunk", text: "@@ todo_management.parameters[max_title_length] @@" },
      { kind: "del",  text: "    default: 200" },
      { kind: "add",  text: "    default: 140" }
    ],
    approvals: [
      { who: "todo_management owner", when: "2026-05-06T09:30Z", decision: "approve" }
    ]
  },
  {
    id: "SCR-2026-012",
    title: "Add Assignment component to Team fork",
    class: "I",
    status: "Implemented",
    proposer: "ren.takagi",
    proposed_at: "2026-04-29T15:11:00Z",
    target_nodes: ["kizo:web.todomvc.team"],
    problem: "Team variant needs per-todo assignee. Extend the inherited todo_management capability.",
    impact: { variants_affected: 1, tokens_est: 9100, cache_miss_count: 4 },
    effectivity: "variant=team; channel=experimental",
    diff_yaml: [
      { kind: "hunk", text: "@@ extend kizo:web.todomvc.team.todo_management @@" },
      { kind: "add",  text: "  net_new component: kizo:web.todomvc.team.todo_management.assignment" },
      { kind: "add",  text: "    title: Assignment" },
      { kind: "add",  text: "    body.boundary: \"Maps todo_id → user_id, single assignee.\"" },
      { kind: "add",  text: "    files: [src/assignment.ts]" }
    ],
    approvals: [
      { who: "todo_management owner", when: "2026-04-30T10:00Z", decision: "approve" },
      { who: "CCB chair",             when: "2026-04-30T10:14Z", decision: "approve" }
    ]
  },
  {
    id: "SCR-2026-011",
    title: "Disable Hono request logging by default",
    class: "II",
    status: "Released",
    proposer: "han.junseo",
    proposed_at: "2026-04-22T14:00:00Z",
    target_nodes: ["kizo:web.todomvc"],
    problem: "Demo deployments spam stdout. Change default to false; users opt in.",
    impact: { variants_affected: 2, tokens_est: 320, cache_miss_count: 1 },
    effectivity: "stable; immediate",
    diff_yaml: [
      { kind: "hunk", text: "@@ kizo:web.todomvc.parameters[hono_logger_enabled] @@" },
      { kind: "del",  text: "    default: true" },
      { kind: "add",  text: "    default: false" }
    ],
    approvals: [
      { who: "system owner", when: "2026-04-22T15:10Z", decision: "approve" }
    ]
  },
  {
    id: "SCR-2026-010",
    title: "Add toggle-all idempotency key header",
    class: "I",
    status: "Returned",
    proposer: "ada.lopes",
    proposed_at: "2026-04-19T09:00:00Z",
    target_nodes: ["kizo:web.todomvc.todo_management.todo_rest_api.rest_api_contract"],
    problem: "Bulk toggle has been observed firing twice on flaky networks.",
    impact: { variants_affected: 2, tokens_est: 2400, cache_miss_count: 2 },
    effectivity: "tbd",
    return_reason: "Single-user demo; idempotency is overkill at this scale. Reopen if reused in Team variant.",
    diff_yaml: [
      { kind: "hunk", text: "@@ rest_api_contract.headers @@" },
      { kind: "add",  text: "    - Idempotency-Key: string (required on POST /todos/toggle-all)" }
    ],
    approvals: [
      { who: "todo_management owner", when: "2026-04-19T11:20Z", decision: "return" }
    ]
  },
  {
    id: "SCR-2026-009",
    title: "Switch ULID → UUID v7 for new ids",
    class: "I",
    status: "Draft",
    proposer: "noemi.kiraly",
    proposed_at: "2026-05-09T22:00:00Z",
    target_nodes: ["kizo:web.todomvc.todo_management.todo_repository"],
    problem: "Standardize on UUID v7 across all Puffin demos so codegen prompts can share id format.",
    impact: { variants_affected: 2, tokens_est: 800, cache_miss_count: 2 },
    effectivity: "stable; next minor",
    diff_yaml: [
      { kind: "hunk", text: "@@ todo_repository.parameters[id_format] @@" },
      { kind: "del",  text: "    default: ulid" },
      { kind: "add",  text: "    default: uuid_v7" }
    ],
    approvals: []
  }
];

/* ---------- Where-Used edges (precomputed) ---------- */
const RELATIONSHIPS = [
  // implements
  { kind: "implements", source: "kizo:web.todomvc.todo_management.todo_repository", target: "kizo:web.todomvc.todo_management.todo_repository.todo_schema" },
  { kind: "implements", source: "kizo:web.todomvc.todo_management.todo_rest_api",   target: "kizo:web.todomvc.todo_management.todo_rest_api.rest_api_contract" },
  // depends-on (internal)
  { kind: "depends-on", source: "kizo:web.todomvc.todo_management.todo_rest_api", target: "kizo:web.todomvc.todo_management.todo_repository" },
  { kind: "depends-on", source: "kizo:web.todomvc.todo_management.todo_rest_api", target: "kizo:web.todomvc.todo_management.todo_filter_engine" },
  { kind: "depends-on", source: "kizo:web.todomvc.web_ui.todo_list_view",         target: "kizo:web.todomvc.todo_management.todo_rest_api" },
  { kind: "depends-on", source: "kizo:web.todomvc.web_ui.footer_view",            target: "kizo:web.todomvc.todo_management.todo_filter_engine" },
  { kind: "depends-on", source: "kizo:web.todomvc.web_ui.todo_filter_router",     target: "kizo:web.todomvc.web_ui.footer_view" },
  // derives-from (the fork)
  { kind: "derives-from", source: "kizo:web.todomvc.team", target: "kizo:web.todomvc",
    override_kind: "with_override" },
];

function whoUses(nodeId) {
  const direct = RELATIONSHIPS.filter(r => r.target === nodeId);
  return direct.map(r => ({ ...r, source_node: BY_ID[r.source] }));
}
function whoDependsTransitive(nodeId) {
  const out = [];
  const seen = new Set();
  function walk(id, depth) {
    if (seen.has(id)) return;
    seen.add(id);
    whoUses(id).forEach(r => {
      out.push({ ...r, depth });
      walk(r.source, depth + 1);
    });
  }
  walk(nodeId, 0);
  return out;
}

/* ---------- Drift records ---------- */
const DRIFT = [
  {
    node_id: "kizo:web.todomvc.todo_management.todo_repository",
    file: "src/repository.ts",
    desired_hash: "sha256:" + djb2("repository.ts@desired") + djb2("desired-2"),
    observed_hash: "sha256:" + djb2("repository.ts@observed") + djb2("obs-2"),
    kind: "live_state",
    status: "Live-Drifted",
    detected_at: "2026-05-10T03:22:00Z",
    detail: "Hand-edit to repository.ts at line 88: someone added `ORDER BY updated_at DESC` to list() outside the sekkei.",
    policy: "alert"
  },
  {
    node_id: "kizo:web.todomvc.todo_management.todo_rest_api",
    file: "src/routes/todos.ts",
    desired_hash: "sha256:" + djb2("routes.ts@desired") + djb2("d3"),
    observed_hash: "sha256:" + djb2("routes.ts@desired") + djb2("d3"),
    kind: "hash",
    status: "Hash-Drifted",
    detected_at: "2026-05-09T19:08:00Z",
    detail: "rest_api_contract@A.1 advanced to in_review but the deployed instance still has the A.0 generation.",
    policy: "auto_heal"
  },
  {
    node_id: "kizo:web.todomvc.web_ui.footer_view",
    file: "public/js/footer-view.js",
    desired_hash: "sha256:" + djb2("footer.js@matched"),
    observed_hash: "sha256:" + djb2("footer.js@matched"),
    kind: "none",
    status: "Synced",
    detected_at: "2026-05-10T08:00:00Z",
    detail: "OK.",
    policy: "auto_heal"
  },
  {
    node_id: "kizo:web.todomvc.web_ui.todo_list_view",
    file: "public/js/list-view.js",
    desired_hash: "sha256:" + djb2("list-view.js@d"),
    observed_hash: "sha256:" + djb2("list-view.js@o"),
    kind: "live_state",
    status: "Suspended",
    detected_at: "2026-05-07T14:00:00Z",
    detail: "Reconciliation suspended by operator; hand-edit under review for promotion.",
    policy: "suspend"
  },
  {
    node_id: "kizo:web.todomvc.todo_management.todo_filter_engine",
    file: "src/filter.ts",
    desired_hash: "sha256:" + djb2("filter.ts@d"),
    observed_hash: "sha256:" + djb2("filter.ts@d"),
    kind: "none",
    status: "Synced",
    detected_at: "2026-05-10T08:00:00Z",
    detail: "OK.",
    policy: "auto_heal"
  },
  {
    node_id: "kizo:web.todomvc.todo_management.todo_repository.todo_schema",
    file: "src/db.ts",
    desired_hash: "sha256:" + djb2("db.ts@d"),
    observed_hash: "sha256:" + djb2("db.ts@d"),
    kind: "none",
    status: "Synced",
    detected_at: "2026-05-10T08:00:00Z",
    detail: "OK.",
    policy: "auto_heal"
  }
];

/* ---------- Provenance events ---------- */
const PROVENANCE = [
  {
    id: "prov-2026-051",
    when: "2026-05-10T07:11:42Z",
    subject_file: "src/repository.ts",
    subject_digest: "sha256:" + djb2("repository.ts@A.2"),
    sekkei: { root: "kizo:web.todomvc", rev: "A.0", lock: "sha256:" + djb2("sekkei.lock@A.0") },
    generator: { llm: "claude-sonnet-4.5@2026-04", prompt_version: "sha256:" + djb2("prompt-v3") },
    binding_hash: "sha256:" + djb2("binding-001"),
    duration_ms: 4280,
    tokens_in: 6420, tokens_out: 2140,
    cache: "miss",
    signed: true
  },
  {
    id: "prov-2026-050",
    when: "2026-05-10T07:11:38Z",
    subject_file: "src/db.ts",
    subject_digest: "sha256:" + djb2("db.ts@A.0"),
    sekkei: { root: "kizo:web.todomvc", rev: "A.0", lock: "sha256:" + djb2("sekkei.lock@A.0") },
    generator: { llm: "claude-sonnet-4.5@2026-04", prompt_version: "sha256:" + djb2("prompt-v3") },
    binding_hash: "sha256:" + djb2("binding-001"),
    duration_ms: 1820,
    tokens_in: 2110, tokens_out: 940,
    cache: "hit",
    signed: true
  },
  {
    id: "prov-2026-049",
    when: "2026-05-10T07:10:51Z",
    subject_file: "public/js/edit-mode-fsm.js",
    subject_digest: "sha256:" + djb2("edit-mode-fsm.js@A.0"),
    sekkei: { root: "kizo:web.todomvc", rev: "A.0", lock: "sha256:" + djb2("sekkei.lock@A.0") },
    generator: { llm: "claude-sonnet-4.5@2026-04", prompt_version: "sha256:" + djb2("prompt-v3") },
    binding_hash: "sha256:" + djb2("binding-001"),
    duration_ms: 2210,
    tokens_in: 3010, tokens_out: 1640,
    cache: "miss",
    signed: true
  },
  {
    id: "prov-2026-048",
    when: "2026-05-09T19:08:14Z",
    subject_file: "src/routes/todos.ts",
    subject_digest: "sha256:" + djb2("routes.ts@A.1-superseded"),
    sekkei: { root: "kizo:web.todomvc", rev: "A.0", lock: "sha256:" + djb2("sekkei.lock@A.0") },
    generator: { llm: "claude-sonnet-4.5@2026-04", prompt_version: "sha256:" + djb2("prompt-v3") },
    binding_hash: "sha256:" + djb2("binding-001"),
    duration_ms: 3490,
    tokens_in: 4810, tokens_out: 1980,
    cache: "miss",
    signed: true,
    note: "Superseded by SCR-2026-014 once approved."
  },
  {
    id: "prov-2026-047",
    when: "2026-05-04T13:44:02Z",
    subject_file: "src/assignment.ts",
    subject_digest: "sha256:" + djb2("assignment.ts@A.0"),
    sekkei: { root: "kizo:web.todomvc.team", rev: "A.0", lock: "sha256:" + djb2("sekkei.lock@team-A.0") },
    generator: { llm: "claude-sonnet-4.5@2026-04", prompt_version: "sha256:" + djb2("prompt-v3") },
    binding_hash: "sha256:" + djb2("binding-002"),
    duration_ms: 5320,
    tokens_in: 7910, tokens_out: 3220,
    cache: "miss",
    signed: true
  }
];

/* ---------- Reuse promotion candidates ---------- */
const REUSE = [
  {
    id: "promote-001",
    subtree: "kizo:web.todomvc.todo_management.todo_filter_engine",
    title: "Promote: Todo Filter Engine → kizo:web.shared.filter_engine",
    stage: "Candidate-for-Promotion",
    rationale: "Pure stateless filter. Used in 2 variants. Both have identical assertions. Strong promotion candidate.",
    usages: 2,
    invariants_held_in: 2,
    steward: null
  },
  {
    id: "promote-002",
    subtree: "kizo:web.todomvc.web_ui.todo_filter_router",
    title: "Promote: URL Hash Filter Router → kizo:web.shared.hash_router",
    stage: "Candidate-for-Promotion",
    rationale: "Hash-router is generic; not specific to todos. Reusable across single-page demos.",
    usages: 2,
    invariants_held_in: 2,
    steward: null
  },
  {
    id: "promote-003",
    subtree: "kizo:web.todomvc.team.todo_management.assignment",
    title: "Promote: Assignment → kizo:web.shared.assignment",
    stage: "Variant-Local",
    rationale: "Only in the Team fork. Released in 1 instance. Needs second adopter before promotion.",
    usages: 1,
    invariants_held_in: 1,
    steward: null
  },
  {
    id: "promote-004",
    subtree: "kizo:web.todomvc.todo_management.todo_repository.todo_schema",
    title: "Promote: SQLite-WAL Todo Schema → kizo:db.sqlite_wal.schema_pattern",
    stage: "Promoted-to-Library",
    rationale: "Pattern (PRAGMA WAL, defaults, indexes) extracted to shared library; concrete columns remain variant-local.",
    usages: 2,
    invariants_held_in: 2,
    steward: "platform-data@kizo.dev"
  }
];

/* ---------- Effectivity / rollout per variant ---------- */
const VARIANTS = [
  {
    id: "kizo:web.todomvc",
    label: "TodoMVC — stable",
    instance: "demo-prod-01",
    channel: "stable",
    pin_policy_default: "pin-on-release",
    rollout: [
      { node: "kizo:web.todomvc.todo_management.todo_repository",        state: "Generated-for-Instance", pin: "A.1", available: "A.2 (canary)" },
      { node: "kizo:web.todomvc.todo_management.todo_rest_api",          state: "Generated-for-Instance", pin: "A.0", available: "A.1 (in_review)" },
      { node: "kizo:web.todomvc.todo_management.todo_filter_engine",     state: "Deployed-to-dBOM",       pin: "A.0", available: "A.0" },
      { node: "kizo:web.todomvc.web_ui.todo_list_view",                  state: "Pinned-by-Variant",      pin: "A.0", available: "A.0" },
      { node: "kizo:web.todomvc.web_ui.todo_filter_router",              state: "Deployed-to-dBOM",       pin: "A.0", available: "A.0" }
    ]
  },
  {
    id: "kizo:web.todomvc.team",
    label: "TodoMVC Team — experimental",
    instance: "team-canary-02",
    channel: "experimental",
    pin_policy_default: "track-latest",
    rollout: [
      { node: "kizo:web.todomvc.todo_management.todo_repository",        state: "Pinned-by-Variant",      pin: "A.2", available: "A.2" },
      { node: "kizo:web.todomvc.todo_management.todo_rest_api",          state: "Pinned-by-Variant",      pin: "A.1", available: "A.1" },
      { node: "kizo:web.todomvc.todo_management.todo_filter_engine",     state: "Generated-for-Instance", pin: "A.0", available: "A.0" }
    ]
  }
];

/* ---------- Export to window ---------- */
Object.assign(window, {
  STRATA, STRATUM_LABEL, SPEC_KINDS,
  NODES, BY_ID, FORK_NODES,
  rootNodes, childrenOf,
  SCRS, RELATIONSHIPS, whoUses, whoDependsTransitive,
  DRIFT, PROVENANCE, REUSE, VARIANTS,
  shortHash, djb2, hash
});
