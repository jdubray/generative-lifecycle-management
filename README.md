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
├── docs/                    Functional + technical spec, implementation plan, ADRs
├── src/                     GLM workbench — Bun + Hono server (TypeScript)
│   ├── server/                     Hono app + routes + middleware
│   ├── repository/                 bun:sqlite repositories (WAL, FK on)
│   ├── domain/                     Pure logic: SCR FSM, variant resolver, CEL, …
│   ├── generation/                 LLM pipeline + DSSE attestations
│   ├── git/                        YAML store + ECN commits + sekkei.lock + hooks
│   ├── verifier/                   6-gate verifier (+ 2.b system_role)
│   ├── agent/                      Vibe Mode scenarios + intent classifier
│   └── auth/                       Signed-cookie sessions + API tokens
├── public/                  PWA frontend — vanilla ES modules, no bundler
├── migrations/              Numbered SQLite migrations (applied at boot)
├── scripts/                 verify / backup / restore / migrate / seed / loadtest
├── tests/                   bun:test unit + integration (279 cases)
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

## Run the GLM workbench

The workbench is a Bun + Hono server on top of a single SQLite file, with a
no-bundler PWA at `public/`. Prereqs: **Bun ≥ 1.1** and **git ≥ 2.40**.

### Install

```sh
bun install                       # installs hono + yaml + biome + bun-types
cp .env.example .env              # then edit: SESSION_SECRET, GLM_DB_PATH, …
```

A 32-byte session secret:

```sh
bun -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

### Start the dev server

```sh
bun run dev                       # http://localhost:3000, --watch enabled
```

First request applies any pending migrations to `GLM_DB_PATH` (defaults to
`./data/glm.db`). The PWA shell is at `/`; the dev login is at `/login` —
type any email to start an `editor`-role session. REST surface lives under
`/api/v1/...`; OpenAPI-shaped contract is in `docs/glm_functional_technical_spec.md` §7.

### First-time seed

The PWA needs at least one workspace to drop you into. After your first
`/login`, run the seeder once — it creates a `demo` workspace and adds every
existing user as `owner`:

```sh
bun run seed                      # idempotent; safe to re-run
# Options:
#   bun run seed -- --slug=foo --name="Foo Workspace"
#   bun run seed -- --user=alice@example.com
```

Then reload `http://localhost:3000` — the Dashboard renders against the new
workspace.

### Bootstrap an existing sekkei (import)

GLM's primary onboarding path is to import an existing on-disk sekkei into a
workspace. The bundled `./sekkei/` directory is the GLM's own reverse-engineered
sekkei (`kizo:dev.glm @ A.1` — 1 system, 16 capabilities, 66 components, 6
interactions). To bootstrap it as a `glm-self` workspace owned by you:

```sh
bun run scripts/import-sekkei.ts \
  --path=./sekkei \
  --workspace-slug=glm-self \
  --workspace-name="GLM (self)" \
  --owner=you@example.com
```

Idempotent: a re-run against an unchanged tree is a no-op. After an edit to
any `*.yaml` under `./sekkei/`, re-running updates only nodes whose
canonical body hash changed. Pass `--dry-run` to walk + parse + report
without persisting anything.

Open `http://localhost:3000/?workspace=glm-self` to land in the imported
workspace.

### Tests, lint, typecheck

```sh
bun test                          # 311 cases across unit + integration (~4 s)
bun run lint                      # biome
bunx tsc --noEmit                 # strict TS
```

### Useful scripts

```sh
bun run scripts/import-sekkei.ts --path=./sekkei --workspace-slug=glm-self \
  --workspace-name="GLM (self)" --owner=you@example.com
bun run scripts/verify.ts --workspace=<slug>     # run the 6-gate verifier
bun run scripts/backup.ts --db=./data/glm.db --out=./backups/glm.db
bun run scripts/restore.ts --backup=./backups/glm.db --db=./data/glm.db
bun run scripts/loadtest.ts --workspace=ws-1 \
  --node=glm:component.web --editors=50 --duration=30
```

### Production

A single-binary build + systemd / Docker recipe, plus the
backup / restore / verify / hook-installer playbook, lives in
[`docs/deploying.md`](docs/deploying.md). Architecture decisions are in
[`docs/adr/`](docs/adr/).

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

`todo-mvc/sekkei-todomvc/` is a sekkei reverse-engineered by Claude from the
live [TodoMVC reference app](https://feature-hub.io/todomvc/), with the
instruction to imagine a Bun + Hono + bun:sqlite (WAL) REST backend for it.
The resulting sekkei was then imported into GLM. 57 nodes total:

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

The companion essay (the GLM essay, [§C "Formal structure of a sekkei"](https://www.linkedin.com/pulse/formal-structure-sekkei-jean-jacques-d--2pbzc/)) expands
on the seven GLM processes (Change Management, Variant Resolution, Where-Used,
Effectivity, Drift Reconciliation, Reuse, Provenance) and the two-dimensional
cache that make this economical at scale.

---

## Vibe designing

GLM shifts the focus from writing code to design thinking — moving from
sketching to blueprinting. There are two adoption paths:

**Solo.** "Vibe design" your project: prompt Claude (or your preferred LLM) to
reverse-engineer or author a sekkei from an existing app or a plain-language
description. The AI writes the sekkei; you import it into GLM and let the
generator produce the code. The TodoMVC example in this repo was built exactly
this way — Claude reverse-engineered the frontend from
[feature-hub.io/todomvc](https://feature-hub.io/todomvc/) and imagined the
backend, producing a 57-node sekkei that was then imported and regenerated into
a working implementation.

**Team.** Bring structure to the review process: teammates author and iterate on
well-organized design specs, trust the code generation, and use GLM's
lifecycle tools (change management, variant resolution, provenance) to keep the
design authoritative as the system evolves.

> **Solo mode (no API key required).** The `glm` CLI in `integrations/cli/` and
> the `glm-mcp` MCP server in `integrations/mcp/` let an individual developer
> drive vibe design, generation, and refinement entirely through their existing
> Claude Code session — no `ANTHROPIC_API_KEY` on the server or the client. From
> a terminal: `glm vibe`, `glm generate`, `glm refine`. From inside Claude Code:
> the `/glm-*` slash commands. The server stays a pure data + verifier + provenance
> layer. Rationale and trade-offs:
> [`docs/adr/0006-mcp-first-generation.md`](docs/adr/0006-mcp-first-generation.md).
> [Puffin](https://github.com/kizo-core/puffin) integration surfaces the same
> flow inside its Solo panel.

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
