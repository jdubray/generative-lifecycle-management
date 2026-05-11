# Generative Lifecycle Management

> Mature engineering disciplines — naval, aerospace, automotive, electronic — have
> relied on formal designs managed through lifecycle processes for decades. Software
> has not. UML, MDA, and MDSE all tried; in each case "designs stayed aspirational,
> code stayed authoritative." Coding agents change that calculus: if a design is
> machine-runnable, the design *is* the artifact under management and the code is a
> derived build product.
>
> — [Jean-Jacques Dubray, *Every mature engineering discipline…*](https://www.linkedin.com/posts/jdubray_every-mature-engineering-discipline-be-it-ugcPost-7459065106908307457-AM_n)

This repository is the working specification and reference implementation of
**Generative Lifecycle Management (GLM)** — a Product Lifecycle Management (PLM)
discipline for software-as-design. The unit of design is the **sekkei** (設計):
a directed acyclic graph of typed, content-addressed nodes that an LLM agent can
regenerate into working software.

---

## What's in this repo

```
.
├── specification/           Sekkei v1.1 specification — the design language itself
│   ├── sekkei_specification.md     Narrative spec (~520 lines)
│   ├── sekkei.schema.json          Normative JSON Schema (Draft 2020-12)
│   ├── sekkei_schema.yaml          Informative YAML mirror
│   ├── validate.py                 Schema validator (schema gate only)
│   └── VALIDATION_REPORT.md
│
├── mockup/                  Interactive UX prototype of the GLM workbench
│                            (deployed to GitHub Pages — see mockup/README.md)
│
└── todo-mvc/                Forward-designed validation case
    ├── sekkei-todomvc/      kizo:web.todomvc @ A.0 — 57-node sekkei
    │   ├── sekkei.yaml             Root System node
    │   ├── nodes/                  Capabilities, Components, Interactions, Specs
    │   ├── verify_sekkei.py        6-gate verifier (envelope → spec quality)
    │   └── VERIFICATION_REPORT.txt
    └── src/                 Working TodoMVC, generated from the sekkei
```

A larger reverse-engineered sekkei — `kizo:food.fullservicerestaurant @ A.0`
(~170 nodes, distilled from a real POS) — is referenced by the specification but
not committed here.

---

## What is a sekkei?

A sekkei is a five-stratum DAG:

| Stratum       | Holds                                  | PLM analog                                |
|---------------|----------------------------------------|-------------------------------------------|
| `system`      | sub-systems, capabilities              | End-Item / Configured Engineering Item    |
| `capability`  | components, interactions, specs        | Major sub-assembly                        |
| `component`   | interactions, specs                    | Assembly                                  |
| `interaction` | specs                                  | Sub-assembly / interface (FSMs, schemas)  |
| `spec`        | (leaf — six `spec_kind` variants)      | Drawing / part specification              |

Each node carries an envelope (`id`, `stratum`, `title`, `revision`, `provenance`)
plus typed `parameters`, `constraints`, and `relationships` (`composes-of`,
`depends-on`, `derives-from`, `implements`, `generates`, `varies-from`).

Spec leaves come in six kinds: `functional`, `technical`, `schema`,
`business_rule`, `acceptance`, and `prompt`. The last two are the
machine-runnable contract:

- **acceptance** declares the deliverables, runtime invariants, and a single
  shell `verifier.command` that must exit 0 on success.
- **prompt** is a `(context_bundle, outputs, prompt_template, verifier)` triple
  sufficient to drive an LLM regenerator with no further human input.

Forks of a sekkei inherit nodes via one of four explicit operations (`as_is`,
`with_override`, `extend`, `net_new`) — the locality rule guarantees that
overrides are visible at the leaf they apply to.

See **`specification/sekkei_specification.md`** for the full v1.1 narrative.

---

## The TodoMVC validation case

`todo-mvc/sekkei-todomvc/` is a forward-designed sekkei for a canonical TodoMVC
clone backed by a Bun + Hono + bun:sqlite (WAL) REST API. 57 nodes total:

- 1 System, 2 Capabilities (`todo_management`, `web_ui`)
- 8 Components (repository, filter engine, REST API, PWA shell, add-todo input,
  list view, footer, filter router)
- 4 Interactions (todo schema, REST contract, edit-mode FSM, URL hash event flow)
- 42 Specs across the six `spec_kind` variants

`todo-mvc/src/` is the working implementation regenerated from that sekkei.

### Run the demo

```sh
cd todo-mvc/src
bun install
bun run dev          # serves on http://localhost:3000 (or set SERVER_PORT=3030)
```

The REST surface (per `kizo:web.todomvc.todo_management.todo_rest_api.rest_api_contract`):

```
GET    /api/todos[?filter=all|active|completed]
POST   /api/todos                  { title }
PATCH  /api/todos/:id              { title?, completed? }
DELETE /api/todos/:id
POST   /api/todos/toggle-all       { completed: boolean }
DELETE /api/todos/completed
GET    /healthz
```

The frontend at `/` is canonical TodoMVC markup served from `public/`.

### Verify the sekkei

Two independent gates:

```sh
# Schema gate — validates every YAML node against sekkei.schema.json
python specification/validate.py todo-mvc/sekkei-todomvc

# Full 6-gate verifier — envelope, stratum hierarchy, closure, brief
# coverage, spec coverage, spec quality
python todo-mvc/sekkei-todomvc/verify_sekkei.py
```

The sekkei ships passing both.

---

## Why this matters

The bet is that **regenerable design** beats hand-written code on three axes
that have always defeated MDSE-style approaches:

1. **The design stays authoritative.** When the generator can reproduce a working
   system from the sekkei, the code is no longer the source of truth — it is a
   build product, like the netlist a board layout tool emits from a schematic.
2. **Variants are first-class.** A fork is a child sekkei that inherits ~80% of
   its parent `as_is`, with the rest as `with_override` / `extend` / `net_new`.
   Variant resolution is a sekkei-level operation, not a feature-flag tangle.
3. **Provenance is reified.** Every node carries `derives_from`, `override_kind`,
   and a `content_hash`; every generated artifact carries a `generates`
   relationship back to the node that produced it. Change management becomes a
   PLM concern, not an archaeology project.

The companion essay (the GLM essay, §C "Formal structure of a sekkei") expands
on the seven GLM processes (Change Management, Variant Resolution, Where-Used,
Effectivity, Drift Reconciliation, Reuse, Provenance) and the two-dimensional
cache that make this economical at scale.

---

### Run the test suites

Two layers cover the eight Components' `spec.acceptance` deliverables:

```sh
cd todo-mvc/src

# Unit tests — 35 cases across filter / repository / REST API
bun run test                        # ~140ms; isolated :memory: SQLite

# End-to-end tests — 39 cases across the five UI Components
bunx playwright install chromium    # one-time browser download
bun run test:e2e                    # ~14s; boots Bun against a test DB
```

---

## Status

- **Sekkei specification:** v1.1, validated against two sekkeis
  (`kizo:web.todomvc @ A.0` and `kizo:food.fullservicerestaurant @ A.0`).
- **TodoMVC sekkei:** A.0, in review.
- **TodoMVC implementation:** generated and running locally. Passes the 35
  bun:test unit cases (filter / repository / REST API) and all 39 Playwright
  e2e cases enumerated across the eight Components' acceptance specs.

Open items for v1.2+ (multi-parent inheritance, dBOM schema, `sekkei.lock`
format, find_number conventions) are listed at the end of the specification.
