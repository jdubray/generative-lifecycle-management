# GLM — Functional & Technical Specification

**Product:** Puffin GLM (Generative Lifecycle Management)  
**Version:** 1.0  
**Derived from:** `mockup/` prototype  
**Date:** 2026-05-11  
**Status:** Draft

---

## Table of Contents

1. [Product Overview](#1-product-overview)  
2. [Domain Glossary](#2-domain-glossary)  
3. [Data Model](#3-data-model)  
4. [Application Shell](#4-application-shell)  
5. [View Specifications](#5-view-specifications)  
   - 5.1 [Dashboard (00)](#51-dashboard-00)  
   - 5.2 [Sekkei Browser (01)](#52-sekkei-browser-01)  
   - 5.3 [Change Management (02)](#53-change-management-02)  
   - 5.4 [Variant Resolution (03)](#54-variant-resolution-03)  
   - 5.5 [Where-Used (04)](#55-where-used-04)  
   - 5.6 [Effectivity & Rollout (05)](#56-effectivity--rollout-05)  
   - 5.7 [Drift Reconciliation (06)](#57-drift-reconciliation-06)  
   - 5.8 [Reuse & Inheritance (07)](#58-reuse--inheritance-07)  
   - 5.9 [Provenance & Audit (08)](#59-provenance--audit-08)  
   - 5.10 [Vibe Mode (✦)](#510-vibe-mode-)  
6. [Cross-Cutting Concerns](#6-cross-cutting-concerns)  
7. [API Surface](#7-api-surface)  
8. [Non-Functional Requirements](#8-non-functional-requirements)  
9. [Git Integration](#9-git-integration)

---

## 1. Product Overview

GLM is a multi-user web application for authoring, reviewing, and regenerating **sekkeis** — formal, content-addressed bill-of-materials designs from which LLM agents can rebuild working software. It wraps seven structured lifecycle processes around the sekkei graph: Change Management, Variant Resolution, Where-Used, Effectivity & Rollout, Drift Reconciliation, Reuse & Inheritance, and Provenance & Audit.

### 1.1 Primary User Roles

| Role | Responsibilities |
|------|-----------------|
| **Author** | Creates and edits sekkei nodes; proposes SCRs; triggers regeneration |
| **Reviewer** | Approves or returns SCRs; stewards promoted library subtrees |
| **Platform Lead** | Approves Class I (contract) SCRs; manages variant channels; owns effectivity gates |
| **Operator** | Monitors drift sweeps; executes auto-heal / waiver policies; manages deploy windows |
| **Auditor** | Read-only access to provenance log and audit events; exports DSSE bundles |

### 1.2 Scope Boundaries (v1)

- Single organization per installation; no cross-org sharing.
- Concurrency: 1–50 simultaneous editors per sekkei.
- LLM inference is delegated to an external provider; GLM orchestrates only.
- Conflict resolution: soft-lock + last-writer-wins at node-body grain.
- No general-purpose CRDT/OT collaboration engine.

---

## 2. Domain Glossary

| Term | Definition |
|------|-----------|
| **Sekkei** | A directed acyclic graph of nodes organized across five strata that constitutes the complete bill-of-materials for an LLM-generated software system. |
| **Node** | A versioned, content-addressed unit of design information at a specific stratum. Each node carries an envelope (id, stratum, revision, status), a body (stratum-specific YAML shape), optional parameters and constraints, and relationships to other nodes. |
| **Stratum** | One of five levels in the sekkei hierarchy: `system`, `capability`, `component`, `interaction`, `spec`. |
| **GLM ID** | Globally unique identifier for a node, structured as `glm:<domain>.<system>[.<subtree>...]`. Example: `glm:web.todomvc.todo_management.todo_filter_engine`. |
| **Revision** | A `MAJOR.ITERATION` label (e.g., `A.0`, `A.1`) following ANSI Y14.35 conventions (skip I/O/Q/S/X/Z for MAJOR letters). |
| **Content hash** | SHA-256 of the node's canonical body YAML. Enforced unique within a workspace at the application layer. |
| **Override kind** | How a node relates to its ancestor: `net_new` (original), `derives-from` (inherits + overrides), `refines` (adds constraints without changing contract). |
| **SCR** | Sekkei Change Request — a formal proposal to mutate one or more nodes. |
| **SCO** | Sekkei Change Order — the authorized execution of an approved SCR. |
| **Class I change** | A contract-breaking SCR: adds/removes states, changes interface shape, mutates enum options. Requires platform-lead approval. |
| **Class II change** | An internal SCR: implementation detail with no contract impact. Requires solo-dev or team approval. |
| **Variant** | A resolved instance of a sekkei root with a specific parameter binding. Identified by `variant.id`, `instance` (dBOM address), and `channel`. |
| **sekkei.lock** | Content-addressed lock file that pins every node in a variant closure by `(glm_id, revision, content_hash)`. Equivalent of a package lockfile for generated artifacts. |
| **Generation hash** | `hash(design_hash, binding_hash, generator_identity)` — the cache key that determines whether regeneration can be skipped. |
| **Drift** | Divergence between the desired state (sekkei content-hash) and the observed state (deployed artifact hash). Two kinds: **hash drift** (sekkei advanced; artifact stale) and **live-state drift** (artifact was hand-edited outside the sekkei). |
| **dBOM** | Deployed Bill of Materials — the runtime artifact manifest produced after a full generation and deployment cycle. |
| **in-toto Statement** | A signed supply-chain attestation (DSSE envelope) emitted per generation event. Predicate type: `https://puffin.dev/glm/v1/generation`. |
| **ECN** | Engineering Change Notification — the GLM term for a git commit that carries a sekkei change. One ECN = one commit; the subject names the affected node GLM IDs; the body carries `Affected:`, `Why:`, and `Regen required:` blocks. |
| **glm-sekkei** | The canonical sekkei git repository. Contains `sekkei.yaml`, `nodes/`, `specification/`, `sekkei.lock`, `verify_sekkei.py`, and `Makefile`. This is the source-of-truth design store; the web application's SQLite database is a queryable index derived from it. |
| **glm-realization** | The generated-code git repository. Contains the artifacts produced by the generation pipeline. Carries a `REGENERATED_FROM` file linking back to the originating sekkei commit and lock hash. Never merged back into the sekkei repo. |
| **glm-catalog** | Community-shared Components repository. Consumed by sekkei repos via `git subtree`. Provides the "Standard Parts" library; components graduate here from `Promoted-to-Library` status. |
| **effectivity.yaml** | Optional file at the system root that attaches fine-grained effectivity rules (serial-number range, date-effective) to specific nodes beyond what channel/pin-policy covers. |
| **REGENERATED_FROM** | Plain-text file in the realization repo recording the sekkei commit hash and sekkei.lock content hash that produced the current artifact set. The inverse of the `generates` relationship. |

---

## 3. Data Model

### 3.1 Node

```
nodes
  id                    TEXT  PK  (surrogate UUID)
  workspace_id          TEXT  FK → workspaces
  glm_id               TEXT  UNIQUE per workspace
  stratum               TEXT  CHECK IN ('system','capability','component','interaction','spec')
  title                 TEXT
  description           TEXT
  body_json             JSON  (stratum-specific shape — see §3.2)
  content_hash          TEXT  UNIQUE per workspace (sha256: prefixed)
  revision_major        TEXT  (single letter, Y14.35 — no I/O/Q/S/X/Z)
  revision_iteration    INT
  revision_status       TEXT  CHECK IN ('in_work','in_review','released','superseded','obsolete')
  override_kind         TEXT  CHECK IN ('net_new','derives-from','refines')
  derives_from_node_id  TEXT  FK → nodes (nullable)
  system_role           TEXT  nullable, only for stratum=system
  spec_kind             TEXT  nullable, only for stratum=spec
  authored_by           TEXT
  authored_at           DATETIME
  updated_at            DATETIME
  generator_identity_json JSON nullable
```

**Computed label:** `rev_label = revision_major || "." || revision_iteration` (e.g. `A.0`)

### 3.2 Body Shapes per Stratum

**system**
```yaml
system_role: <string>        # e.g. "browser-resident SPA"
dbom_ref: <string | null>
runtime: <string | null>
```

**capability**
```yaml
user_value: <multiline string>
```

**component**
```yaml
boundary: <multiline string>
runtime: <string>
```

**interaction** — four contract kinds:
- `fsm`: `states: [...]`, `transitions: ["event: from→to", ...]`
- `integration_adapter`: `endpoints: [...]`
- `schema_binding`: `contract: <yaml>`
- `event_flow`: `listener: <string>`

**spec**
```yaml
spec_kind: code_recipe | test_suite | migration | ...
content: <multiline prompt>
inspection_assertions:          # optional
  - id: <string>
    kind: <string>
    expression: <string>
context_bundle: [glm_id, ...]  # nodes whose bodies are injected into the prompt
outputs: [file_path, ...]
verifier: <string>
```

### 3.3 Supporting Tables

```
node_parameters
  node_id         FK → nodes
  name            TEXT
  type            TEXT   (string | integer | boolean | enum)
  options         JSON   nullable (for enum)
  min / max       INT    nullable (for integer)
  default_json    JSON
  binding_scope   TEXT   (workspace | variant | instance)
  ord             INT

node_constraints
  node_id         FK → nodes
  kind            TEXT   (invariant | guard | postcondition)
  expression      TEXT   (CEL predicate)
  severity        TEXT   (error | warning)
  ord             INT

node_relationships
  source_node_id  FK → nodes  ON DELETE CASCADE
  kind            TEXT   CHECK IN ('composes-of','depends-on','derives-from','implements','generates','varies-from')
  target_glm_id  TEXT
  attributes_json JSON   nullable
  ord             INT

external_deps
  workspace_id    FK → workspaces
  purl            TEXT   (Package URL)
  role            TEXT
  license         TEXT
  notes_json      JSON

generated_artifacts
  id              UUID PK
  workspace_id    FK → workspaces
  source_node_id  FK → nodes
  path            TEXT   (relative file path)
  content_hash    TEXT
  generation_hash TEXT
  generator_identity_json JSON
  generated_at    DATETIME

edit_locks
  node_id PK      FK → nodes
  user_id         FK → users
  acquired_at     DATETIME
  heartbeat_at    DATETIME

change_log
  id              INT PK AUTOINCREMENT
  workspace_id    FK
  node_id         FK
  user_id         FK
  op              TEXT   (create | update | delete)
  before_content_hash TEXT nullable
  after_content_hash  TEXT
  ts              DATETIME

verification_runs
  id              UUID PK
  workspace_id    FK
  ts              DATETIME
  gate_results_json JSON
  overall_pass    BOOLEAN

audit_events
  id              UUID PK
  workspace_id    FK
  user_id         FK
  event_type      TEXT
  payload_json    JSON
  ts              DATETIME
```

### 3.4 SCR / SCO Model

```
scrs
  id              TEXT PK  (e.g. "SCR-2089")
  workspace_id    FK
  title           TEXT
  class           TEXT  CHECK IN ('I','II')
  status          TEXT  CHECK IN ('Draft','Submitted','Under Review','Approved',
                                  'Returned','Rejected','Implemented','Released')
  proposer        TEXT  (user email)
  proposed_at     DATETIME
  problem         TEXT
  diff_yaml       JSON  (array of {line, kind} diff lines)
  target_nodes    JSON  (array of glm_ids)
  effectivity     TEXT
  return_reason   TEXT nullable
  impact_json     JSON  ({variants_affected, tokens_est, cache_miss_count})

scr_approvals
  scr_id          FK → scrs
  who             TEXT
  decision        TEXT  CHECK IN ('approve','return','reject','pending')
  when            DATETIME nullable
```

### 3.5 Variant Model

```
variants
  id              TEXT PK   (e.g. "glm:web.todomvc.team")
  workspace_id    FK
  label           TEXT
  instance        TEXT       (dBOM address)
  channel         TEXT       (canary | stable | experimental)
  pin_policy_default TEXT   (pin-on-release | track-latest | frozen)

variant_rollout
  variant_id      FK → variants
  node_id         FK → nodes
  available_rev   TEXT
  pin_rev         TEXT
  state           TEXT  CHECK IN ('Released','Available-on-Channel','Pinned-by-Variant',
                                  'Generated-for-Instance','Deployed-to-dBOM')
```

### 3.6 Drift Records

```
drift_records
  id              UUID PK
  workspace_id    FK
  node_id         FK → nodes
  file            TEXT       (relative path of the artifact file)
  status          TEXT  CHECK IN ('Synced','Hash-Drifted','Live-Drifted','Suspended')
  kind            TEXT  CHECK IN ('none','hash','live_state')
  desired_hash    TEXT
  observed_hash   TEXT
  policy          TEXT  CHECK IN ('auto-heal','alert','suspend')
  detail          TEXT
  detected_at     DATETIME
```

### 3.7 Reuse Records

```
reuse_candidates
  id              TEXT PK
  workspace_id    FK
  subtree         TEXT  (glm_id of the root of the subtree)
  title           TEXT
  stage           TEXT  CHECK IN ('Variant-Local','Candidate-for-Promotion',
                                  'Promoted-to-Library','Stewarded-by-Owner')
  rationale       TEXT
  usages          INT
  invariants_held_in INT
  steward         TEXT nullable
```

### 3.8 Provenance Events

```
provenance_events
  id              TEXT PK   (e.g. "prov-001")
  workspace_id    FK
  when            DATETIME
  subject_file    TEXT
  subject_digest  TEXT  (sha256: prefixed)
  sekkei_root     TEXT  (glm_id)
  sekkei_rev      TEXT
  sekkei_lock     TEXT  (hash)
  binding_hash    TEXT
  generator_llm   TEXT
  generator_prompt_version TEXT
  tokens_in       INT
  tokens_out      INT
  duration_ms     INT
  cache           TEXT  CHECK IN ('hit','miss')
  signed          BOOLEAN
  note            TEXT nullable
```

### 3.9 Repository Layout & Git-Backed Storage

The web application's SQLite database is a **queryable index** derived from the canonical git-backed YAML store. Git is the source of truth for all sekkei content; SQLite provides the real-time query and collaboration surface for the UI.

#### Three-Repo Layout

```
glm-sekkei/                  # canonical design store — source of truth
  sekkei.yaml                # root System node
  nodes/                     # one YAML file per node (stratum subdirectory)
  specification/             # formal sekkei schema + validator
  sekkei.lock                # pinned (glm_id, major, content_hash) closure
  verify_sekkei.py           # 6-gate verifier
  Makefile                   # where-used, drift-report, regenerate targets
  effectivity.yaml           # optional fine-grained effectivity rules

glm-realization/             # derived generated code; never merged back
  src/
  test/
  REGENERATED_FROM           # sekkei_commit + sekkei_lock_hash
  in_toto.attestation.json

glm-catalog/                 # community-shared components (Standard Parts)
  <component>/               # pulled into sekkei repos via git subtree
```

#### SQLite ↔ Git Sync

| Direction | Trigger | Mechanism |
|-----------|---------|-----------|
| git → SQLite | Push to `glm-sekkei` | Post-receive hook + CI job walks `nodes/`, upserts into SQLite |
| SQLite → git | User saves a node in the web UI | Server writes the canonical YAML to `nodes/`, stages, and commits with an ECN-formatted message |
| Conflict resolution | Concurrent UI edits vs. git push | Soft-lock on the node prevents the conflict; web UI holds the lock while the commit is in flight |

#### sekkei.lock YAML Format

```yaml
# sekkei.lock — pinned by Variant Resolution; do not edit by hand
root_id: glm:<domain>.<system>
parameter_binding:
  <param_name>: <value>
  # … one entry per bound parameter
nodes:
  - id: glm:<domain>.<system>[.<subtree>]
    major: A
    content_hash: sha256:<hex>
  # … one entry per node in the resolved closure
generator_identity:
  llm: claude-sonnet-4-6
  prompt_version: sha256:<hex>
  tool_chain: sha256:<hex>
```

---

## 4. Application Shell

### 4.1 Layout

The application uses a three-zone layout:

```
┌─────────────────── topbar (fixed, 48px) ────────────────────┐
│  Brand · workspace · revision · status · lock hashes · user  │
├──────────┬──────────────────────────────────────────────────┤
│   rail   │                  main / viewport                  │
│  (200px) │                                                   │
│          │                                                   │
└──────────┴───────────────────────────────────────────────────┘
```

### 4.2 Topbar

Displays:
- Brand mark + product name (`Puffin GLM`) and tagline (`generative lifecycle management`)
- Active workspace identifier (`glm:web.todomvc`) and current revision (`@ A.0`)
- `StatusPill` for the sekkei revision status
- `sekkei.lock` with its content hash (truncated SHA-256)
- Generation cache stats: hits / misses
- Authenticated user email

### 4.3 Navigation Rail

The rail is organized in three labeled groups:

| Group | Items |
|-------|-------|
| Overview | ✦ Vibe Mode, 00 Dashboard |
| Design | 01 Sekkei Browser |
| Lifecycle Processes | 02 Change Management, 03 Variant Resolution, 04 Where-Used, 05 Effectivity & Rollout, 06 Drift Reconciliation, 07 Reuse & Inheritance, 08 Provenance & Audit |

Each nav item shows:
- Numeric label (or `✦` for Vibe Mode)
- Display name
- Badge (count) when there are active items (SCRs, variants, drift records, provenance events)

Below the lifecycle items, a **Variants** section lists all active variants with their `label`, `instance`, and `channel`.

### 4.4 Cross-View State

Two pieces of state are shared across views via a `window.__glm` interface (to be replaced with proper React context or a state management store in the production build):

| State | Purpose |
|-------|---------|
| `selectedNodeId` | GLM ID of the currently focused node; persists across Sekkei ↔ Where-Used navigation |
| `whereUsedTarget` | GLM ID passed from Sekkei Browser when the user clicks "Where used →" |
| `goto(tabId)` | Navigation shortcut used by deep links in other views |

### 4.5 Shared UI Components

| Component | Description |
|-----------|-------------|
| `StatusPill` | Colored pill for node revision status: `in_work`, `in_review`, `released`, `superseded`, `obsolete` |
| `StratumTag` | Small tag showing the one-letter stratum abbreviation (S/C/O/I/P) |
| `ClassBadge` | Class I (amber) / Class II (neutral) SCR classification pill |
| `Hash` | Renders a `sha256:…` hash as a truncated 10-character monospace span with full value in tooltip |
| `Section` | Collapsible card section with title and optional right-aligned content |
| `KV` | Definition-list key–value grid |
| `DiffBlock` | Syntax-colored diff renderer: `add` (green), `del` (red), `hunk` (neutral header), context (plain) |
| `YamlBlock` | Monospace preformatted block for YAML / JSON content |
| `Empty` | Centered placeholder for empty panes |

---

## 5. View Specifications

### 5.1 Dashboard (00)

**Purpose:** System-wide pulse. Aggregates the current state of the sekkei graph, open SCRs, drift, variants, generation costs, and recent activity.

#### Layout

Full-width scrollable content with three rows of cards:

1. **Top row (3 equal columns):** Sekkei graph, Change requests, Drift
2. **Middle row (2 columns):** Variants table, Generation cost sparkline
3. **Bottom row (full width):** Recent activity table

#### Sekkei Graph Card

- Big number: total node count
- Stacked bar chart showing node distribution across all five strata (color-coded)
- Legend with absolute counts per stratum
- Footer: override count, root system count

#### Change Requests Card

- Big number: active SCRs (Submitted + Under Review + Approved)
- Stacked bar chart across all six SCR states: Draft, In Review, Approved, Implemented, Released, Returned/Rejected
- Legend with color and count per state

#### Drift Card

- Big number: drifted nodes (Hash-Drifted + Live-Drifted)
- Horizontal bar per drift status: Synced, Hash drift, Live-state drift, Suspended
- Each bar shows count and percentage
- Footer: timestamp of last drift sweep

#### Variants Card

Table with columns: Variant, Channel, Status (healthy / N pending), Pinned nodes

#### Generation Cost Card (30d)

- Big number: total token consumption
- SVG sparkline (30 data points)
- Footer: cache hit ratio, estimated tokens saved by cache

#### Recent Activity Table

Columns: When (ISO datetime), Event (tag label), Subject, Actor  
Clickable row "see all provenance →" navigates to view 08.

#### Actions

- **Search across sekkei:** global full-text search (scope TBD, Phase 2)
- **Propose change:** opens New SCR flow in view 02

---

### 5.2 Sekkei Browser (01)

**Purpose:** Navigate and inspect the full sekkei DAG. The primary authoring surface for node content.

#### Layout

Two-pane split (420px left / remaining right):
- **Left pane:** filterable tree
- **Right pane:** selected node detail

#### Tree (Left Pane)

- Toolbar: search input, "Expand all", "Collapse all" buttons
- Tree renders the `composes-of` hierarchy from root nodes downward
- Each tree row shows:
  - Collapse/expand caret (or dot for leaf nodes)
  - Stratum label (`StratumTag`)
  - Node title and leaf segment of the GLM ID
  - Revision label (e.g. `A.0`)
  - `StatusPill`
- Depth is visualized by left-padding: `8px + depth × 16px`
- Clicking a row selects the node and updates the right pane
- Filter: narrows by glm_id or title substring; ancestor nodes of matches are kept visible

#### Node Detail (Right Pane)

Sections rendered top to bottom:

1. **Header** — stratum tag, status pill, revision label, override kind; title (h2); GLM ID; description; action buttons ("Propose change", "Where used →")

2. **Envelope** — KV grid: `id`, `stratum`, `revision`, `status`, `override_kind`, `derives_from` (clickable link to parent), `content_hash`, `authored_by`

3. **Parameters** *(if present)* — table: Name, Type (with enum options or integer range), Default, Scope

4. **Constraints** *(if present)* — inline list of `{kind, severity, expression}` rows, with severity color-coded (error = red, warning = amber)

5. **Body** — `YamlBlock` rendering the stratum-specific body YAML (see §3.2 for each shape)

6. **Realization files** *(if present)* — list of file paths with content hashes

7. **Relationships** — all relationship edges from and to this node:
   - `composes-of (parent)` — upward link
   - `composes-of (child)` — downward links (clickable)
   - Inbound relationship kinds (`depends-on ←`, `varies-from ←`, etc.)
   - `depends-on` external deps with PURL, role, digest

8. **Generation cache** — KV: design hash, closure hash, generation hash, cache status (hit/miss + last timestamp)

#### Acceptance Criteria

- AC-01: Selecting a node from a deep subtree scrolls the right pane to the top.
- AC-02: Clicking "Where used →" from a node detail sets `whereUsedTarget` and navigates to view 04.
- AC-03: Filter clears on "Expand all" click.
- AC-04: A node with `derives_from` shows a clickable link that selects the ancestor node.
- AC-05: Content hash is rendered as a truncated Hash component; full value is available on hover.

---

### 5.3 Change Management (02)

**Purpose:** Author, submit, review, approve, and track SCRs (Sekkei Change Requests) through their full workflow lifecycle.

#### Layout

Full-height view header + two-pane split (420px left list / right detail).

#### SCR List (Left Pane)

- Toolbar: Class filter toggle (All / Class I / Class II), Status dropdown (all states), count display
- Table columns: ID, Title (+ proposer and date), Class (`ClassBadge`), Status (`ScrStatus`)
- Click row to open detail in right pane

#### SCR Detail (Right Pane)

1. **Header** — SCR id, `ClassBadge`, `ScrStatus`; title; proposer + proposed_at; context-aware action buttons:
   - `Draft` → "Submit" button
   - `Under Review` → "Return", "Reject", "Approve" buttons
   - `Approved` → "Implement →" button

2. **Workflow** — horizontal step indicator across the six live states: Draft, Submitted, Under Review, Approved, Implemented, Released. Completed steps are highlighted; current step is active.

3. **Problem statement** — free text; if `Returned`, shows a callout with the return reason.

4. **Target nodes** — list of `StratumTag + title (clickable → Sekkei Browser) + rev + StatusPill`

5. **Proposed delta** — `DiffBlock` rendering the YAML diff

6. **Impact closure** — four statistics: Variants affected, Est. tokens to regenerate, Generation cache misses, Effectivity date. Footer explanation of how cost is estimated.

7. **Approvals** — table: Reviewer, Decision (approve/return/reject/pending), When

8. **Provenance** — KV: scr id, created, class, audit attestation hash

#### SCR State Machine

```
Draft ──→ Submitted ──→ Under Review ──→ Approved ──→ Implemented ──→ Released
                                   └──→ Returned ──→ (back to Draft)
                                   └──→ Rejected (terminal)
```

- Class I: requires `platform-review` approval
- Class II: requires team/solo-dev approval

#### Git Mapping

Each approved SCO that mutates one or more nodes produces an **ECN commit** in `glm-sekkei/`. The commit message follows the conventional format:

```
ECN: <brief description of the change>

Affected:
  - glm:<node_id_1>
  - glm:<node_id_2>

Why:
  <problem statement from the SCR>

Regen required:
  - <realization_file_path>  (re-emit; <reason>)

SCR: <scr_id>
Signed-off-by: <user_email>
```

- One commit = one ECN. Splitting an SCO across multiple commits is an anti-pattern.
- The `Affected:` block is enforced by the pre-receive hook on origin: any push touching `nodes/` that lacks an `Affected:` line is rejected.
- Class I changes additionally require a signed commit (`git commit -S`) because they alter the public contract surface.
- The SCR id is embedded in the commit body so `git log --grep="SCR-2089"` surfaces the full change history for a request.

#### Acceptance Criteria

- AC-06: "New SCR" button opens a blank SCR form pre-populated with `target_nodes = [selectedNodeId]` when navigated from Sekkei Browser.
- AC-07: Transitioning a Draft SCR to Submitted emits an `audit_event` of type `scr.submit`.
- AC-08: Approving an SCR increments the SCR's approval record and updates status to `Approved`.
- AC-09: The impact closure token estimate is recomputed when target_nodes changes.
- AC-10: Clicking a target node title navigates to Sekkei Browser with that node selected.

---

### 5.4 Variant Resolution (03)

**Purpose:** Given a sekkei root and a parameter binding, validate the single candidate variant against declared constraints, resolve external dependencies, compute content-addressed cache keys, and emit `sekkei.lock`.

#### Layout

Full-height view header + two-pane split (420px left input / right result).

#### Input Panel (Left)

1. **Sekkei root** — dropdown listing all root nodes (nodes with no parent); shows `derives_from` lineage if present.

2. **Parameter binding** — auto-collected from all nodes in the closure. For each parameter:
   - Label: `name` (mono), scope and type info
   - Control: `<select>` for enum, `<select>` for boolean, `<input>` for others
   - Hint: default value

3. **Target environment** — KV: generator identity, prompt version hash, tool chain hash, env digest hash

#### Resolution Pipeline

The "Resolve variant" action runs the following six-step pipeline (simulated async, ~380ms):

| Step | Description | Pass criteria |
|------|-------------|---------------|
| 1. Closure walk | Traverse `composes-of` + `derives-from` from root to leaves | Always passes |
| 2. Parameter binding | Verify all parameters have a value (default or provided) | No unbound parameters |
| 3. Constraint validation | Evaluate each node's CEL constraints against the binding | All `error`-severity constraints pass |
| 4. External dependency closure | Collect all `depends-on` external deps; verify all have content digests | Always passes |
| 5. Cache key computation | Compute `closure_hash`, `binding_hash`, `design_hash`, `generation_hash` | Always passes |
| 6. sekkei.lock emission | Pin each node by `(glm_id, revision, content_hash)` | Always passes |

#### Result Panel (Right)

Shown after successful "Resolve variant":

- Callout: overall pass/fail with summary counts
- Pipeline section: each step with OK/FAIL pill and detail text
- Constraint evaluation table: Kind, Severity, Expression, Result
- External dependency pins table: PURL, Role, Digest
- Cache keys KV: closure hash, binding hash, design hash, generator, generation hash
- `sekkei.lock` YAML block with copy button

#### Hash Definitions

```
closure_hash    = sha256(root_glm_id || sorted(node.content_hash for each node in closure))
binding_hash    = sha256(JSON.stringify(binding))
design_hash     = closure_hash
generation_hash = sha256(design_hash || binding_hash || generator_identity_string)
```

#### Git Mapping

A **variant is a long-lived git branch** off the parent sekkei. The branch name encodes the operator/instance: `variants/<operator>` (e.g., `variants/hanuman-kirkland`). The resolved `sekkei.lock` YAML is committed on that branch, pinning the entire closure.

| Operation | Git action |
|-----------|-----------|
| Create a new variant | `git checkout -b variants/<operator> main` |
| Commit the resolved lock | Commit `sekkei.lock` with message `variant: resolve <operator>` |
| Pull upstream improvements | `git rebase main` on the variant branch, then re-resolve |
| Pin a specific release | Tag `variants/<operator>/A.1` — immutable on origin |

The branch should **only** differ from `main` in `sekkei.lock` and small node overrides (e.g., a `derives-from` component). Accumulating feature changes on a variant branch is an anti-pattern; those belong on `feature/*` branches.

#### Acceptance Criteria

- AC-11: Changing any parameter in the binding resets the result panel.
- AC-12: A constraint failure with `severity=error` causes overall resolution to fail.
- AC-13: `sekkei.lock` YAML includes `for_sekkei`, pinned node list with `id`, `revision`, `content_hash`.
- AC-14: Cache key section always shows all five hash values regardless of pass/fail status.

---

### 5.5 Where-Used (04)

**Purpose:** Given a node, find all direct and transitive consumers across all relationship kinds, and estimate per-variant regeneration impact.

#### Layout

Full-height view header + two-pane split (340px left picker / right analysis).

#### Node Picker (Left)

- Search input filtering all nodes by id or title
- Flat list of all nodes with stratum tag, title, leaf id, revision
- Clicking sets the target node

#### Analysis (Right)

1. **Target summary** — stratum tag, status, revision, title, GLM ID

2. **Direct dependents** — all nodes that reference the target via any relationship kind (including `composes-of` parent). Columns: relationship kind tag, stratum tag, node title (clickable), revision, status.

3. **Transitive consumers** — breadth-first traversal from direct dependents upward. Rendered depth-indented (12px + depth×16px). Clicking a node navigates to it in the Where-Used picker.

4. **Variant impact table** — per variant: Override mode (as_is / with_override / shadowed), Generations affected (file count), Cache miss probability (percentage + mini bar), Token cost estimate.

5. **Open SCRs touching this node** — SCRs whose `target_nodes` includes the target or its ancestors. Columns: SCR id, Class badge, Title, Status.

#### Impact Estimation Model

```
mode          = "with_override"  if variant has an override on this node or its parent
              = "as_is"          if node is in the rollout but not overridden
              = "shadowed"       if node is not in the rollout at all

files         = node.files.length  (or 1 if no realization files)
cache_miss    = 0.0  if shadowed
              = 0.7  if channel == experimental
              = 0.35 otherwise

tokens        = files × 1800 × (1 - 0.4 × (1 - cache_miss))
```

#### Git Mapping

Three complementary tools cover the where-used question against the git store:

| Tool | Use case | Command |
|------|----------|---------|
| `git grep` | Find every node YAML that references a given GLM ID | `git grep "glm:<node_id>"` |
| `git log -L` | Track the history of a specific field (e.g., when did `dbom_ref` change?) | `git log -L:dbom_ref:sekkei.yaml` |
| `make where-used` | Graph-walk: find all variant branches whose `sekkei.lock` includes the node at any revision | `make where-used ID=glm:<node_id>` |

The `make where-used` target is ~30 lines of Python over `git for-each-ref` + a YAML walk of `sekkei.lock` across all `variants/*` branches. The web UI's **Where-Used** view is the interactive equivalent of this Makefile target, operating against the SQLite index.

The **Export CSV** button in the UI emits the same data as `make where-used` in spreadsheet form.

#### Acceptance Criteria

- AC-15: "Where used →" action in Sekkei Browser pre-selects the correct target node.
- AC-16: `composes-of (parent)` is always listed first among direct dependents.
- AC-17: Open SCRs section is empty (with message) if no SCRs target the node or its ancestors.
- AC-18: Export CSV button downloads a UTF-8 CSV of the transitive set with columns: glm_id, stratum, title, relationship_path, variant, tokens_est.

---

### 5.6 Effectivity & Rollout (05)

**Purpose:** Control when a released sekkei revision reaches each consuming variant instance. Four orthogonal gates: date, variant predicate, channel, pin-policy.

#### Layout

Full-height view header + toolbar + scrollable content.

#### Toolbar

- Variant selector dropdown (label + instance)
- Channel pill (read-only)
- Default pin-policy pill (read-only)
- dBOM instance label

#### Summary Stats

- Nodes pinned, Advanceable, Released but not yet pinned, Last rollout timestamp

#### Rollout State per Node Table

Columns: Node (stratum + clickable title), Available rev, Pin policy (editable dropdown), Pinned rev, Rollout state (mini step indicator + state name), Advance button (shown when `available ≠ pinned`).

**Rollout state machine per node:**
```
Released → Available-on-Channel → Pinned-by-Variant → Generated-for-Instance → Deployed-to-dBOM
```

Each transition triggers the generation pipeline for that node under the variant's binding.

#### Effectivity Rules Section

Displays the four gate predicates:
- `date`: `activate_at <= now()`
- `variant`: `predicate(variant.parameters)` (e.g. `multi_user == true`)
- `channel`: `channel == "<current_channel>"`
- `pin-policy`: value of `pin_policy_default` (overridable per node)

#### Pin Policies

| Policy | Behavior |
|--------|----------|
| `pin-on-release` | Node is pinned to the revision that was current at channel promotion time |
| `track-latest` | Node always advances to the latest available revision on the channel |
| `frozen` | Node never advances; operator must manually unlock |

#### Recent Rollout Events Table

Columns: When, Node, Transition, Actor

#### Actions

- **Pause channel:** halts all advances on this variant's channel
- **Promote canary → stable:** batch-advances all pinned nodes from canary to stable channel

#### Git Mapping

Major releases follow **ASME Y14.35** letter sequencing via signed annotated git tags. Iteration suffixes are lightweight tags.

| Release type | Git operation | Example |
|---|---|---|
| Major release | `git tag -s -a A.0 -m "<message>"` | `A.0`, `B.0` |
| Iteration | `git tag A.1` | `A.1`, `A.2` |
| Variant pin | `git tag variants/<operator>/A.1` | `variants/hanuman-kirkland/A.1` |

**Immutability** is enforced by a pre-receive hook that refuses any push that rewrites an existing release tag:

```bash
# Excerpt from .git/hooks/pre-receive on origin
while read old new ref; do
  case "$ref" in
    refs/tags/[A-HJ-NPRTUV-WY]*)
      [ "$old" != "0000000000000000000000000000000000000000" ] && {
        echo "Refusing to rewrite released tag $ref"; exit 1; }
      ;;
  esac
done
```

Fine-grained effectivity rules beyond channel/pin-policy are expressed in `effectivity.yaml` at the system root:

```yaml
effectivity:
  - rule: date_effective
    nodes: [glm:<domain>.<system>.<node>]
    not_before: 2026-07-01
  - rule: serial_number_range
    nodes: [glm:<domain>.<system>.<node>]
    from: appliance#001
    to:   appliance#999
```

The "Promote canary → stable" action in the UI corresponds to a `git merge --ff-only` of the canary tag's commit into the `main` branch.

#### Acceptance Criteria

- AC-19: Per-node pin policy override persists across variant-selector changes.
- AC-20: "Advance →" is disabled when `pinned_rev == available_rev`.
- AC-21: Advancing a node emits a `rollout.advance` audit event with old and new state.
- AC-22: Switching variants resets the pin policy overrides to empty.

---

### 5.7 Drift Reconciliation (06)

**Purpose:** Detect and reconcile divergence between the desired state (sekkei content-hash) and the observed state (deployed artifact hash).

#### Drift Kinds

| Kind | Cause | Detection |
|------|-------|-----------|
| `hash` | Sekkei node was advanced; deployed artifact still references the old generation-hash | Drift sweep compares `desired_hash` against the `generation_hash` embedded in the deployed artifact manifest |
| `live_state` | Deployed artifact file was hand-edited outside the sekkei | Drift sweep computes SHA-256 of the current file content and compares to `generation_hash` |

#### Layout

Full-height view header + filter toolbar + two-pane split.

#### Filter Toolbar

Status segmented control: All, Synced, Hash drift, Live-state drift, Suspended. Count badges per status. Timestamp of last sweep. Sweep interval (every 5 minutes default).

#### Drift List (Left Pane)

Table: Node title + GLM ID, File path (relative), `DriftPill` status, Policy tag.

#### Drift Detail (Right Pane)

1. **Summary** — drift pill, drift kind tag, detection timestamp, node title, GLM ID → file path

2. **Reconciliation triplet** — KV: desired hash (sekkei), observed hash (runtime), reported status, drift kind, policy

3. **Detail** — human-readable description of the divergence

4. **Resolution** *(hash drift)* — "Regenerate & deploy" button, "Schedule next window" button. Explanation: the generation pipeline will re-run for this node, produce a new artifact hash, and the deployer will swap the file.

5. **Resolution** *(live-state drift)* — four action buttons based on the node's configured policy:
   - **Auto-heal (overwrite):** regenerates from sekkei, discards the hand-edit
   - **Capture as net-new SCR:** promotes the hand-edit into the sekkei as a Class II SCR
   - **Issue deviation/waiver:** suspends reconciliation for a stated period (audited)
   - **Suspend reconciliation:** marks the drift record as `Suspended` indefinitely

6. **Sweep history (last 7 days)** — table of daily sweep results: When, Status, Desired hash, Observed hash

#### Drift Policies

| Policy | Behavior on live-state drift detection |
|--------|----------------------------------------|
| `auto-heal` | Immediately overwrites the artifact file; emits audit event |
| `alert` | Creates a drift record in `Live-Drifted` status; notifies owner; does not overwrite |
| `suspend` | Marks the record `Suspended`; no further sweeps until explicitly re-enabled |

#### Git Mapping

The two-repo layout makes drift detection mechanical. Every component node's `realization_file` field carries a path into `glm-realization/`. The drift sweep iterates the sekkei, reads each referenced file, and compares content hashes.

```bash
# In glm-realization/, driven by a Makefile target
make drift-report SEKKEI_REF=A.1
# Output per referenced file:
#   src/routes/todos.ts   sekkei expects sha256:1bf2…  realization is sha256:1bf2…  OK
#   src/routes/todos.ts   sekkei expects sha256:9c4d…  realization is sha256:7e11…  DRIFT
```

Resolution paths in git:

| Drift kind | Resolution | Git action |
|------------|-----------|------------|
| Hash drift | Regenerate the artifact from the current sekkei | CI job keyed on the new `content_hash`; updates `glm-realization/` + `REGENERATED_FROM` |
| Live-state drift: promote | Capture the hand-edit as an SCR | Author commits the hand-edit to a `feature/*` branch; SCR links to the commit |
| Live-state drift: heal | Overwrite with freshly regenerated artifact | `make regenerate SEKKEI_COMMIT=<hash>` in `glm-realization/` |
| Live-state drift: waiver | Suspend reconciliation | Add an entry to `effectivity.yaml` with `rule: drift_waiver` and an expiry date |

The web UI's **Drift Reconciliation** view surfaces the same information as `make drift-report` with interactive resolution buttons.

#### Acceptance Criteria

- AC-23: "Run full sweep" triggers a background job that updates all drift records.
- AC-24: "Reconcile all auto-heal" applies `auto-heal` to all nodes with policy=auto-heal that are currently drifted.
- AC-25: Capturing a live-state edit as an SCR pre-fills the SCR with `class=II`, the diff extracted from the hand-edit, and the affected node in `target_nodes`.
- AC-26: Issuing a waiver requires a duration input (days) and emits an audit event.
- AC-27: The reconciliation triplet always shows all three hashes even when two are equal (Synced).

---

### 5.8 Reuse & Inheritance (07)

**Purpose:** Promote sekkei subtrees from variant-local to community-shared via a formal lifecycle. Discovery is structural (Where-Used) rather than catalog-based.

#### Promotion Stages

```
Variant-Local
    → Candidate-for-Promotion   (confirmed second adopter)
        → Promoted-to-Library   (Class I SCR approved; steward assigned)
            → Stewarded-by-Owner (ongoing maintenance SLA active)
```

#### Layout

Two-pane split (420px left list / right detail).

#### Candidate List (Left Pane)

Table: Subtree (node title + GLM ID), Stage (`ReuseStagePill`), Usages count.

#### Candidate Detail (Right Pane)

1. **Header** — stage pill, stratum tag, status pill, title, subtree GLM ID

2. **Promotion lifecycle** — horizontal step indicator across four stages

3. **Rationale** — free text explaining why this subtree is a reuse candidate

4. **Where-used signal** — three statistics: Live usages, Variants holding invariants, Promotion threshold (`≥ 2 deployed + ≥ 1 steward`)

5. **Steward** — KV: owner email, on-call address, maintenance SLA. If no steward: callout with "Accept stewardship" button.

6. **Action** — stage-contextual:
   - `Variant-Local` → "Mark as candidate" (requires second adopter confirmation)
   - `Candidate-for-Promotion` → "Open promotion SCR (Class I)" or "Reject candidate"
   - `Promoted-to-Library` → Informational message; consumers inherit via `derives-from`

7. **Inheritance proof** — `YamlBlock` showing `library_id`, `revision`, `content_hash`, adopter list, regeneration proof (byte-identical artifacts across adopters)

#### Promotion Rules

- A subtree may be nominated as a candidate by any Author once it appears in two or more variants.
- Promotion to Library requires: (a) a Class I SCR (contract surface change) approved by a platform lead, and (b) a named steward who accepts the maintenance SLA.
- Once promoted, all adopting variants reference the library node via `derives-from` rather than holding a local copy.
- The inheritance proof must demonstrate byte-identical artifact output under the same binding across all adopters.

#### Git Mapping

Two git patterns correspond to the two reuse stages:

**Inherit-as-is** (Variant-Local → Candidate): normal branch inheritance. The variant branch's `sekkei.lock` references the parent node by `(glm_id, content_hash)`. No copy is made. Upstream improvements flow into the variant via `git rebase main`.

**Community catalog** (Promoted-to-Library): the component moves to `glm-catalog/` and consuming sekkeis pull it via `git subtree`:

```bash
# Add a catalog component to a consuming sekkei
git subtree add \
  --prefix=nodes/components/_catalog/filter_engine \
  git@github.com:glm/glm-catalog.git \
  filter_engine/A.1 \
  --squash

# Pull a catalog update
git subtree pull \
  --prefix=nodes/components/_catalog/filter_engine \
  git@github.com:glm/glm-catalog.git \
  filter_engine/A.2 \
  --squash
```

`git subtree` is preferred over `git submodule` because: the catalog history is flattened (not visible in `git log` for the consumer), pinning is a simple commit, and `git clone` works without additional init steps.

A `varies-from` edge in the sekkei corresponds to an **Alternate/Substitute** selection: when two catalog components are interchangeable (e.g., different payment processors), the variant's `sekkei.lock` pins the chosen one; the `varies-from` relationship documents the alternative.

#### Acceptance Criteria

- AC-28: "Find candidates" button triggers a Where-Used analysis across all nodes and surfaces those appearing in ≥ 2 variants as `Variant-Local` candidates.
- AC-29: "Open promotion SCR (Class I)" pre-populates the SCR with the subtree root as target node.
- AC-30: A candidate may not advance past `Candidate-for-Promotion` without a named steward.
- AC-31: The inheritance proof timestamp is updated on each regeneration event affecting an adopter.

---

### 5.9 Provenance & Audit (08)

**Purpose:** Maintain an immutable, signed per-generation attestation trail. One DSSE-wrapped in-toto Statement is emitted per generation event; the predicate records the complete sekkei context, parameter binding, generator identity, and cache result.

#### Layout

Full-height view header + stats toolbar + two-pane split.

#### Stats Toolbar

Four stats: Generation events (30d), Cache hits / misses, Tokens consumed (30d), Signature coverage.  
Cache filter segmented control: All / Cache miss / Cache hit.

#### Event List (Left Pane)

Table: Event ID + timestamp, Artifact file path, Cache status pill, Token count (tokens_in → tokens_out).

#### Event Detail (Right Pane)

1. **Header** — event id, cache status pill, DSSE signed pill; artifact file path; timestamp; subject digest hash

2. **Note** — optional callout (e.g. "cache hit — no LLM call was made")

3. **Sekkei** — KV: root GLM ID (clickable → Sekkei Browser), revision, lock digest

4. **Binding** — KV: parameter hash

5. **Generator** — KV: LLM identifier, prompt version hash, tool chain hash, duration ms, token counts, cache status

6. **in-toto Statement** — `YamlBlock` with the full JSON predicate body (copy button)

7. **DSSE envelope** — KV: payload type, signing key hash, Fulcio cert hash, transparency log entry URL (Rekor)

#### in-toto Statement Schema

```json
{
  "_type": "https://in-toto.io/Statement/v1",
  "subject": [{
    "name": "<artifact_file_path>",
    "digest": { "sha256": "<hex>" }
  }],
  "predicateType": "https://puffin.dev/glm/v1/generation",
  "predicate": {
    "sekkei": {
      "root_id":      "<glm_id>",
      "revision":     "<rev_label>",
      "lock_digest":  "<sha256>"
    },
    "binding":    { "parameter_hash": "<sha256>" },
    "generator": {
      "llm":            "<model_id@version>",
      "prompt_version": "<hash>",
      "tool_chain":     "<hash>"
    },
    "metrics": {
      "tokens_in":   <int>,
      "tokens_out":  <int>,
      "duration_ms": <int>,
      "cache":       "hit" | "miss"
    }
  }
}
```

#### Git Mapping

In-toto attestations are stored as **git notes** on the originating sekkei commit, under the `refs/notes/generation` namespace. This makes the provenance chain tamper-evident without polluting the commit history.

```bash
# Attach an attestation to the sekkei commit that triggered generation
git notes --ref=refs/notes/generation add \
  -m "$(jq -c . in_toto.attestation.json)" \
  <sekkei-commit>

# Read the attestation for a specific commit
git notes --ref=refs/notes/generation show <sekkei-commit>

# Audit trail: "what produced the artifact on appliance#003?"
# 1. Read REGENERATED_FROM in the realization repo
cat REGENERATED_FROM
# sekkei_commit: e7a9...
# sekkei_lock_hash: sha256:6c1f...

# 2. Pull the generation note
git notes --ref=refs/notes/generation show e7a9...

# 3. Replay the generation if needed
make regenerate SEKKEI_COMMIT=e7a9... LOCK_HASH=sha256:6c1f...
```

Notes are co-signed with commit signing (`git config notes.rewriteRef refs/notes/generation`) so the chain is tamper-evident. The web UI's **Export DSSE bundle** button packages these notes into the `application/vnd.in-toto+json` format for external verification.

The sekkei IS the supply chain manifest (SBOM). The realization artifacts are the side-effect of applying the manifest through the generation pipeline.

#### Acceptance Criteria

- AC-32: Every generation event (cache miss) produces exactly one `provenance_events` record and one signed Statement.
- AC-33: Cache hit events also produce a `provenance_events` record but with `tokens_in = tokens_out = 0` and `cache = hit`; no LLM call is made.
- AC-34: "Export DSSE bundle" downloads a newline-delimited JSON file of all DSSE envelopes for the filtered set.
- AC-35: "Verify signatures" triggers server-side re-verification of all Fulcio certs in the current view and returns a pass/fail report.
- AC-36: Transparency log entry links use the format `rekor.sigstore.dev/index/<entry_id>`.

---

### 5.10 Vibe Mode (✦)

**Purpose:** Conversational interface to the GLM agent. The user describes intent in plain language; the agent interprets it against the live sekkei graph, proposes a lifecycle plan, asks for approval at every formal gate, and executes the seven processes — without ever bypassing approval gates.

#### Layout

Two-pane horizontal split:
- **Left (60%):** Chat transcript
- **Right (40%):** Process Console (streaming log)

#### Chat Transcript

Messages alternate between:
- **User bubble** (right-aligned, filled background)
- **Agent bubble** (left-aligned, with `✦` avatar, lighter background)

Agent messages may contain one of the following rich card types:

| Card type | Description |
|-----------|-------------|
| `agent_text` | Plain prose response |
| `plan` | Ordered list of lifecycle steps, each with a process tag, description, and status pill |
| `clarifier` | Decision-required card with a question and labeled option buttons (A/B/C) |
| `scr_draft` | SCR preview with id, class, target nodes, diff block, and impact stats |
| `drift_card` | Live-state drift summary with node, file, and detail text |
| `choice` | Fat option buttons with title and subtitle (e.g. promote / heal / waiver for drift) |
| `gate` | Approval gate card: label, optional detail, action buttons (primary / default / ghost variants) |
| `resolution_card` | Variant resolution result: target, OK/FAIL status, design hash, generation hash, pins, misses |
| `result` | Success card with title, bullet list, and optional "Open in view →" link |

#### Process Console (Right Pane)

- Fixed header: "Process Console" label + event count
- Scrollable event log: each line shows `HH:MM:SS`, level dot (`info` / `ok` / `warn`), and message text
- Streaming: when the agent runs a multi-step operation, console lines appear one at a time (~180ms intervals)
- Busy cursor: animated typing indicator (three bouncing dots) in the chat; blinking `▍` cursor in the console

#### Intent Matching

The agent attempts to match user input to one of three scripted scenarios:

| Pattern | Scenario |
|---------|----------|
| `/archive|delete/` | Scenario: Class I structural change (add archive state to todos) |
| `/multi.?user|team|postgres/` | Scenario: Variant re-resolution (glm:web.todomvc.team) |
| `/drift|hand.?edit|reconcil/` | Scenario: Drift reconciliation (live-state drift on todo_rest_api) |
| *(no match)* | Fallback: LLM free-form response via `claude.complete()` |

#### Formal Gate Invariants

The agent must respect the following invariants regardless of user instruction:
1. Class I SCRs always route to `platform-review` for approval; the agent cannot self-approve.
2. `auto-heal` on live-state drift is only executed if the node's configured policy is `auto-heal`; otherwise the agent presents the choice to the user.
3. Deviation/waiver always produces an audited record.
4. The agent may draft, propose, and submit — but never transition `Under Review → Approved` unilaterally.

#### Suggestion Chips

Displayed when the transcript contains only the initial welcome message:
1. "Add a way to archive todos instead of deleting them" (hint: Class I SCR)
2. "Spin up a team variant with multi-user + Postgres" (hint: Variant resolution)
3. "Reconcile the live-state drift on todo_rest_api" (hint: Drift reconciliation)
4. "Promote the filter engine subtree to a shared library" (hint: Reuse promotion)

#### Input Area

- `<textarea>` with single-row default; `Shift+Enter` for newlines, `Enter` to submit
- Submit button disabled when input is empty or agent is working
- Footer disclaimer: "Vibe Mode never bypasses approval gates."

#### Acceptance Criteria

- AC-37: Each scripted scenario produces the correct sequence of agent messages and console log events.
- AC-38: Approval gate card actions are disabled (greyed out) once a response has been submitted.
- AC-39: The "Open … →" link in a `result` card navigates to the correct view via `goto()`.
- AC-40: The LLM fallback gracefully degrades when the model is unreachable (displays a canned error message; does not crash).
- AC-41: Suggestion chips disappear once the first user message is sent.

---

## 6. Cross-Cutting Concerns

### 6.1 Content Addressing

- Every node write computes `sha256(canonical_body_yaml)` and stores it as `content_hash`.
- `content_hash` is verified on read; a mismatch raises an application-level exception.
- `content_hash` is used as the primary cache key component for generation; the full cache key is `generation_hash = sha256(design_hash || binding_hash || generator_identity)`.
- No external object store; the hash is enforced entirely at the application layer.

### 6.2 Edit Locking

- When a user opens a node for edit, the server issues a lock token (stored in `edit_locks`).
- Lock heartbeat interval: 30 seconds. If no heartbeat arrives within 30 seconds, the lock expires and is released.
- Concurrent edits on different nodes proceed independently.
- Concurrent edits on the same node: only the lock holder may write; others see the node as locked and receive a "locked by X" indicator.
- Lock acquisition and release are broadcast over the workspace WebSocket.

### 6.3 Real-Time Collaboration

- Single WebSocket per workspace at `/ws/:workspace_id`.
- Event types carried on the socket:
  - `node.changed` — content hash, author, timestamp
  - `node.locked` / `node.unlocked` — user identity, node id
  - `scr.created` / `scr.status_changed`
  - `drift.detected` / `drift.resolved`
  - `generation.started` / `generation.progress` / `generation.complete`
- Clients replay missed events from `change_log(workspace_id, ts DESC)` on reconnect.

### 6.4 Authentication

- Browser sessions: signed HTTP-only cookies (SameSite=Strict).
- CLI regeneration: per-user API tokens passed as Bearer in the Authorization header.
- User roles: `admin`, `author`, `reviewer`, `operator`, `auditor` (see §1.1).

### 6.5 PWA / Offline

- Service worker provides offline read of cached sekkei data.
- Writes while offline are queued in IndexedDB and flushed on reconnect.
- Conflict resolution on reconnect: last-writer-wins at node-body grain, mediated by the soft-lock protocol.

### 6.6 Sekkei Verifier

- The 6-gate verifier runs on demand and as a background job after each merge of an `in_review` revision.
- Results written to `verification_runs`.
- Gate 2b (from Sekkei spec v1.1.9): validates `system_role` discriminator on `system`-stratum nodes.

---

## 7. API Surface

### 7.1 REST Endpoints

All routes under `/api/v1/`.

#### Nodes

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/workspaces/:id/nodes` | List nodes (filter by stratum, status) |
| `GET` | `/workspaces/:id/nodes/:glm_id` | Get node detail |
| `POST` | `/workspaces/:id/nodes` | Create node |
| `PUT` | `/workspaces/:id/nodes/:glm_id` | Update node body |
| `DELETE` | `/workspaces/:id/nodes/:glm_id` | Soft-delete (sets status = obsolete) |
| `GET` | `/workspaces/:id/nodes/:glm_id/where-used` | Transitive where-used traversal |
| `POST` | `/workspaces/:id/nodes/:glm_id/lock` | Acquire edit lock |
| `DELETE` | `/workspaces/:id/nodes/:glm_id/lock` | Release edit lock |
| `PUT` | `/workspaces/:id/nodes/:glm_id/lock/heartbeat` | Extend lock TTL |

#### SCRs

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/workspaces/:id/scrs` | List SCRs (filter by class, status) |
| `POST` | `/workspaces/:id/scrs` | Create SCR |
| `GET` | `/workspaces/:id/scrs/:scr_id` | Get SCR detail |
| `PUT` | `/workspaces/:id/scrs/:scr_id/status` | Transition status (submit/approve/return/reject/implement/release) |
| `POST` | `/workspaces/:id/scrs/:scr_id/approvals` | Add approval decision |

#### Variants

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/workspaces/:id/variants` | List variants |
| `POST` | `/workspaces/:id/variants/:variant_id/resolve` | Run variant resolution pipeline |
| `GET` | `/workspaces/:id/variants/:variant_id/rollout` | Get rollout state |
| `PUT` | `/workspaces/:id/variants/:variant_id/rollout/:node_id/advance` | Advance a node to next rollout state |

#### Drift

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/workspaces/:id/drift` | List drift records |
| `POST` | `/workspaces/:id/drift/sweep` | Trigger a full drift sweep |
| `PUT` | `/workspaces/:id/drift/:record_id/resolve` | Apply resolution action (heal / scr / waiver / suspend) |

#### Generation

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/workspaces/:id/generate` | Queue a generation job for a node + variant binding |
| `GET` | `/workspaces/:id/artifacts` | List generated artifacts |

#### Provenance

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/workspaces/:id/provenance` | List provenance events |
| `GET` | `/workspaces/:id/provenance/:event_id` | Get event detail + Statement |
| `POST` | `/workspaces/:id/provenance/export` | Export DSSE bundle |
| `POST` | `/workspaces/:id/provenance/verify` | Trigger signature verification |

### 7.2 WebSocket

- `GET /ws/:workspace_id` — Upgrade to WebSocket; requires valid session cookie or Bearer token.
- All messages are JSON-framed with `{ type, payload, ts }`.

### 7.3 Static Assets

- `GET /public/*` — Serves the PWA bundle.
- `GET /public/sw.js` — Service worker.

---

## 8. Non-Functional Requirements

### 8.1 Performance

| Metric | Target |
|--------|--------|
| Sekkei tree initial load (100 nodes) | < 200 ms |
| Node detail panel render after click | < 50 ms (local state) |
| Variant resolution pipeline (30 nodes) | < 500 ms |
| Drift sweep (100 nodes) | < 2 s |
| WebSocket message delivery (p95) | < 100 ms within org network |

### 8.2 Scalability

- Design for 1–50 concurrent editors per workspace.
- Total nodes per workspace: up to a few hundred (single-digit GB SQLite, WAL mode).
- Generation jobs are queued; the pipeline does not block the HTTP serving thread.

### 8.3 Security

- All state-changing endpoints require authentication.
- Class I SCR approval requires the `platform-lead` role; the server enforces this regardless of client state.
- `content_hash` re-verification on read prevents silent corruption.
- DSSE signatures are verified server-side on export and on demand.
- Edit lock tokens are scoped to user + node + workspace; no cross-workspace lock escalation.

### 8.4 Observability

- Every SCR transition, drift action, lock acquisition, generation event, and approval emits an `audit_events` record.
- The `change_log` table provides a complete append-only history of node mutations.
- Generation cost metrics (tokens in/out, duration, cache hit/miss) are recorded per event in `provenance_events`.

### 8.5 Browser Compatibility

- Evergreen browsers: Chromium (≥ 120), Firefox (≥ 120), Safari (≥ 17).
- PWA installable; offline read via service worker.
- No IE or legacy Edge support.

---

## 9. Git Integration

Git is the **version-control and distribution layer** for the sekkei. Each of the seven GLM processes maps directly to one or more git primitives. The web application's SQLite database is a derived, queryable index of the `glm-sekkei` repository; git is the authoritative store.

### 9.1 Why Git Fits

PLM systems invented engineering change orders, effectivity tables, where-used queries, drift detection, and signed provenance before software needed them. Git already provides most of these primitives under different names. A sekkei is a hierarchical, content-addressed graph of YAML files; git is a content-addressed, branch-aware version-control system. Three things git does NOT provide for free — and that GLM adds on top:

1. **Closure pinning** — handled by `sekkei.lock` (analogous to `flake.lock`)
2. **Artifact-to-design linking** — handled by git notes (`refs/notes/generation`) + in-toto attestations
3. **Effectivity rules** — handled by signed annotated tags + branch policy + `effectivity.yaml`

### 9.2 Repository Layout

```
glm-sekkei/                  # source-of-truth design store
  sekkei.yaml                # root System node
  nodes/                     # one YAML file per node
    system/
    capabilities/
    components/
    interactions/
    specs/
    _catalog/                # git subtree: community components from glm-catalog
  specification/             # formal sekkei schema + verifier
  sekkei.lock                # pinned variant closure (see §3.9)
  verify_sekkei.py           # 6-gate verifier
  effectivity.yaml           # fine-grained effectivity rules (optional)
  Makefile                   # where-used, drift-report, regenerate targets

glm-realization/             # derived generated code — NEVER merged back
  src/
  test/
  REGENERATED_FROM           # sekkei_commit + sekkei_lock_hash
  in_toto.attestation.json

glm-catalog/                 # community-shared Standard Parts
  <component_name>/
    A.1/
    A.2/
```

> **Anti-pattern:** Do not merge generated code back into the sekkei repo. The realization is derived; committing it pollutes the design history. The realization carries `REGENERATED_FROM` as the sole back-reference.

> **Anti-pattern:** Do not put the dBOM in the sekkei repo. The dBOM is per-deployment, mutable, and may be secret-bearing. It lives in its own repo (`glm-dbom/`), keyed by the sekkei commit it realizes.

### 9.3 Process → Git Primitive Mapping

| GLM Process | Git Primitive | Convention |
|---|---|---|
| Change Management | commit + commit message | One commit = one ECN; `Affected:`/`Why:`/`Regen required:` blocks in body |
| Variant Resolution | long-lived branch + `sekkei.lock` | `variants/<operator>` branch; lock committed on that branch |
| Where-Used | `git grep` / `git log -L` / `make where-used` | Scans `composes-of`, `depends-on`, `derives-from` edges across all `variants/*` branches |
| Effectivity & Rollout | signed annotated tags + pre-receive hook | `A.0`, `A.1`, `B.0`; tags immutable on origin; `effectivity.yaml` for fine-grained rules |
| Drift Reconciliation | `git diff` between sekkei and realization repo | `make drift-report SEKKEI_REF=A.1` compares `realization_file` hashes |
| Reuse & Inheritance | branch inheritance + `git subtree` | Catalog components pulled as `git subtree --squash`; `varies-from` = Alternate selection |
| Provenance & Audit | git notes + signed commits | `refs/notes/generation` per sekkei commit; `REGENERATED_FROM` in realization |
| Generation Pipeline | CI workflow + content-addressed cache | Triggered by push; cache keyed on `(content_hash, binding_hash, generator_identity)` |

### 9.4 Branch and Tag Conventions

| Ref pattern | Purpose |
|---|---|
| `main` | Released sekkei trunk; fast-forward only from `next` |
| `next` | Integration branch for the next major release; requires full verifier pass |
| `feature/<id>-<short>` | Single ECN in progress; merged into `next` via PR |
| `variants/<operator>` | Long-lived per-operator branch; rebased on `main` for upstream improvements |
| `forks/<sector>.<subsector>` | Sector fork (e.g., `forks/health.practice.cosmetic`) |
| `A.0`, `A.1`, `B.0`, … | Major + iteration signed annotated tags; **immutable** |
| `variants/<operator>/A.1` | Operator variant pinned to a specific major; immutable on origin |

**Typical PR shape:** `feature/*` → `next` → tag `A.<n+1>` → `main` (fast-forward).

### 9.5 ECN Commit Convention

```
ECN: <imperative description of the change>

Affected:
  - glm:<node_id_1>
  - glm:<node_id_2>

Why:
  <free text — the business or technical reason>

Regen required:
  - <realization_file_path>  (re-emit; <brief reason>)

SCR: SCR-<number>
Signed-off-by: <user_email>
```

Rules:
- One commit = one ECN. Never split an ECN across commits or bundle unrelated ECNs.
- Do not squash commits that span an SCR's spec→regen→test→tag chain. `git bisect` must work on behavioral regressions.
- Class I SCRs require `git commit -S` (signed commit).
- The pre-receive hook on `origin` rejects any commit touching `nodes/` that lacks an `Affected:` block.

### 9.6 Generation Pipeline (CI)

For each component whose `content_hash` changed since the last release tag:

1. **Cache probe**: query generation cache keyed on `(content_hash, parameter_binding_hash, generator_identity)`. On hit: fetch artifact, skip to step 4.
2. **Cache miss**: dispatch the component's `spec.prompt` to the LLM with the `context_bundle`. Write output files to `glm-realization/`.
3. **Run verifier**: execute `spec.acceptance.verifier.command`. Non-zero exit = generation INCOMPLETE; open an issue with the sekkei author, do not merge.
4. **Emit attestation**: produce in-toto Statement, attach to the sekkei commit via `git notes --ref=refs/notes/generation`.
5. **Update realization**: commit `REGENERATED_FROM` (sekkei commit + lock hash) in `glm-realization/`.

The cache is keyed by `sha256(content_hash || binding_hash || generator_identity)`. Any content-addressed store works: S3 bucket, local content-addressed directory, or a Nix-style hash-locked output path.

### 9.7 Hooks

#### Pre-commit (local, advisory)

```bash
#!/bin/sh
# .git/hooks/pre-commit in glm-sekkei/
set -e
python3 verify_sekkei.py
python3 specification/validate.py . --show 5
# Refuse null bytes in staged YAML
git diff --cached --name-only -z | xargs -0 grep -l $'\x00' 2>/dev/null && {
  echo "Null bytes detected in staged YAML"; exit 1; }
```

#### Pre-receive (origin, mandatory)

Enforces three invariants on every push:
1. **Released tags are immutable**: refuses any push that rewrites an existing `A.*` or `B.*` tag.
2. **ECN block required**: any commit touching `nodes/` must carry an `Affected:` line in the body.
3. **Verifier must pass**: reruns `verify_sekkei.py` server-side to catch bypassed local hooks.

### 9.8 Anti-Patterns

| Anti-pattern | Consequence | Correct alternative |
|---|---|---|
| Merging generated code into the sekkei branch | Pollutes design history; confuses `git log` analysis | Keep realization in `glm-realization/`; link via `REGENERATED_FROM` |
| Squashing commits that span an ECN | Breaks `git bisect` on behavioral regressions | Preserve spec→regen→test→tag as separate commits |
| Editing a released tag | Loses immutability invariant | Cut a new iteration tag (`A.1 → A.2`) for any post-release fix |
| Putting the dBOM in the sekkei repo | dBOM is per-deployment and may be secret-bearing | Use a separate `glm-dbom/` repo keyed by sekkei commit |
| Committing `sekkei.lock` without matching node revisions | Downstream `make regenerate` fails with unresolvable content hash | Always commit lock and node changes in the same ECN commit |
| Using `git submodule` for the catalog | Awkward pinning; consumers must know the URL; history appears separate | Use `git subtree --squash` |
| Accumulating feature changes on a variant branch | Variant drifts from `main`; changes become hard to upstream | Feature changes belong on `feature/*` branches; variants hold only lock + small overrides |

### 9.9 CLI Cheat Sheet

```bash
# Verify the sekkei locally (6 gates + gate 2.b)
python3 verify_sekkei.py
python3 specification/validate.py .

# Find all variants that pin a specific node
make where-used ID=glm:<domain>.<system>.<node>

# Pull upstream improvements into an operator variant
git checkout variants/hanuman-kirkland
git rebase main
python3 verify_sekkei.py    # re-evaluate parameter validity post-rebase
make regenerate              # if any composed-of content_hash changed

# Cut a release
git checkout next
python3 verify_sekkei.py && python3 specification/validate.py .
git tag -s -a A.1 -m "GLM A.1 — <summary>"
git checkout main && git merge --ff-only next
git push --tags

# Drift report against current realization
( cd glm-realization && make drift-report SEKKEI_REF=A.1 )

# Audit: what produced artifact on a given appliance?
cat glm-realization/REGENERATED_FROM
git notes --ref=refs/notes/generation show <sekkei_commit>
```
