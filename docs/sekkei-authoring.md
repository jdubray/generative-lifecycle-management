# Skill: Sekkei Authoring

> **Invoke this skill** when the user wants to author, review, or extend a sekkei — the canonical design artifact of Generative Lifecycle Management (GLM). Follow every section in order unless the user is targeting a specific node type.

---

## 0. What You Are Building

A **sekkei** (設計, "design") is a content-addressed, inheritance-aware DAG of typed YAML nodes that an LLM agent can regenerate into working software with no additional human input. It is the *schematic*, not the *netlist*: generated code is a derived build product.

Five strata compose the hierarchy (top → leaf):

```
system → capability → component → interaction → spec
```

Sub-Systems (recursive Systems) sit under a root System for structural grouping.

Every node shares a **common envelope** (id, stratum, title, revision, provenance, parameters, constraints, relationships, body). The `body` shape is stratum-specific and spec-kind-specific.

---

## 1. Elicitation — Before Writing a Single Node

Ask the user the following before producing any YAML:

1. **What is the system?** One-paragraph elevator pitch — what it does, who uses it, how it runs.
2. **What are the major feature groupings?** (These become Capabilities.)
3. **What runtime stack?** Language, framework, DB, process model.
4. **Is this a fork of an existing sekkei?** If yes, ask for the parent's root `id` and `content_hash`.
5. **What is the namespace prefix?** Format: `<org>:<project>` (e.g., `kizo:dev.glm`, `acme:web.shop`). All node IDs derive from this prefix.

Do **not** invent Capabilities, Components, or Interactions that the user has not described or that cannot be derived from the runtime realization. §10.2: boundaries must be honest.

---

## 2. ID Convention

```
<org>:<project>[.<subsystem>].<capability>[.<component>[.<interaction>]]
# spec leaf:
<org>:<project>.<capability>.<component>.spec.<spec_kind>
```

Examples:
```
kizo:dev.glm                                              # root System
kizo:dev.glm.authoring                                    # Capability
kizo:dev.glm.authoring.node_editor                        # Component
kizo:dev.glm.authoring.node_editor.edit_mode_fsm          # Interaction
kizo:dev.glm.authoring.node_editor.spec.functional        # Spec leaf
```

---

## 3. File Layout

```
sekkei.yaml                           # Root System node
nodes/
  systems/                            # Sub-Systems (optional)
  capabilities/                       # One file per Capability
  components/                         # One file per Component (or bundled multi-doc)
  interactions/                       # FSMs, contracts (multi-doc bundles OK)
  specs/
    by_component/                     # One *_specs.yaml per Component
sekkei.lock                           # Pinned (id, major, content_hash) — generated
verify_sekkei.py                      # 6-gate verifier
```

---

## 4. Common Envelope (Required on Every Node)

```yaml
id: <namespace>.<path>
stratum: system | capability | component | interaction | spec
title: <Short human label>
description: |
  <What this node IS and IS NOT responsible for. Be honest about boundaries.>

revision:
  major: A              # ASME Y14.35: A..Z excluding I, O, Q, S, X, Z
  iteration: 0          # Reset to 0 on release; increments on in-work edits
  status: in_work       # in_work | in_review | released | superseded | obsolete

provenance:
  derives_from:
    id: <parent-id>          # null if net_new
    content_hash: "sha256:0000000000000000000000000000000000000000000000000000000000000000"
  override_kind: net_new    # as_is | with_override | extend | net_new
  authored_by: <tool-or-agent-id>
  authored_at: <ISO-8601>
  generator_identity: null  # Only set when produced by an LLM generator

parameters: []            # See §7
constraints: []           # See §8
relationships: []         # See §9
body: {}                  # See §5 per stratum
```

**content_hash** is computed at evaluation time over canonical YAML + recursive hashes of composed/dependent nodes. Use the placeholder `sha256:0000...` for new (unverified) nodes.

---

## 5. Body Shapes by Stratum

### 5.1 System

```yaml
body:
  system_role: root          # root | subsystem
  dbom_ref: null             # Path to deployment manifest; null for subsystems
  realization_summary: |
    <One paragraph: process model, framework, DB, concurrency profile,
     key modules. Be concrete — what files exist, what singletons run.>
  acceptance_gate: |         # Required for root only
    Regenerating this sekkei must produce a system that:
      1. <Boots and serves the main surface>
      2. <Passes verifier gate 5 + 6 across all Components>
      3. <Domain-specific acceptance criterion>
```

Rules:
- Exactly **one** root System per sekkei.
- Root Systems must have `acceptance_gate`.
- Sub-Systems must have `system_role: subsystem` and `dbom_ref: null`.

### 5.2 Capability

```yaml
body:
  user_value: |
    <What an end-user or operator gains from this grouping. One paragraph.>
  boundary: |
    Owns: <list of responsibilities>.
    Does NOT own: <explicit exclusions with the Capability that does own them>.
```

### 5.3 Component

```yaml
body:
  boundary: |
    Owns: <...>
    Does NOT own: <...>
  runtime: in_process         # in_process | sidecar | external_service | in_browser | in_process_and_in_browser
  realization_file: src/path/to/module.ts   # or realization_files: [...]
  realization_notes: |
    <Optional: PLANNED status, special wiring, caveats.>
```

### 5.4 Interaction

```yaml
body:
  contract_kind: fsm          # fsm | event_flow | integration_adapter | schema_binding
  contract_definition:        # Shape depends on contract_kind

    # --- FSM shape ---
    pc: status                # Property-control field name
    pc0: idle                 # Initial state
    states:
      - { id: idle,     terminal: false, transitions: [START] }
      - { id: running,  terminal: false, transitions: [DONE, ERROR] }
      - { id: done,     terminal: true,  transitions: [] }
    actions:
      START: [running]
      DONE:  [done]
    naps:
      placement: "Wired in component.naps POST-INIT"
      principal_naps:
        - { state: idle, fires: START, when: instance_creation }
    reactors:
      - { name: persist_on_transition, on: every_transition, target: <table> }
    invariants:
      - "<CEL expression or prose invariant>"

  realization_file: src/path/to/module.ts
```

**§10.3 — CRITICAL:** Read FSM states **verbatim** from the realization file. Never extrapolate from domain concepts. States you cannot find in the source code must not appear in the sekkei.

---

## 6. Spec Leaves (Six Kinds)

Every Component must have all six spec kinds. Author them in `nodes/specs/by_component/<component>_specs.yaml` as a multi-document YAML file (`---` separators).

### 6.1 functional

```yaml
---
id: <component-id>.spec.functional
stratum: spec
spec_kind: functional
# ... envelope ...
body:
  behaviors:
    - id: create
      signature: "create(input: CreateInput): Entity"
      description: <What it does>
      preconditions:  ["<condition>"]
      postconditions: ["<condition>"]
  # OR for HTTP APIs:
  endpoints:
    - method: POST
      path: /api/v1/nodes
      request_body: { schema_ref: CreateNodeRequest }
      responses:
        201: { schema_ref: Node }
        409: { description: Soft-lock conflict }
```

### 6.2 technical

```yaml
---
id: <component-id>.spec.technical
stratum: spec
spec_kind: technical
# ... envelope ...
body:
  implementation:
    runtime: bun
    framework: hono
    storage: "bun:sqlite (WAL mode)"
    key_decisions:
      - "<Decision and rationale>"
    error_taxonomy:
      - "<Input condition> → <exception class>"
  module_layout: |
    <File → export summary>
```

### 6.3 schema

```yaml
---
id: <component-id>.spec.schema
stratum: spec
spec_kind: schema
# ... envelope ...
body:
  data_shapes:
    EntityName:
      type: object
      properties:
        id:         { type: string }
        created_at: { type: string, format: date-time }
      required: [id, created_at]
      additionalProperties: false
  serialization_notes: |
    <Booleans as INTEGER, timestamps as ISO-8601, etc.>
```

### 6.4 business_rule

```yaml
---
id: <component-id>.spec.business_rule
stratum: spec
spec_kind: business_rule
# ... envelope ...
body:
  rules:
    - id: BR-<COMPONENT>-001
      rule: "<Invariant in plain English>"
      enforcement: "<Where/how it is enforced>"
```

### 6.5 acceptance — §10.4 Deliverables-first

```yaml
---
id: <component-id>.spec.acceptance
stratum: spec
spec_kind: acceptance
# ... envelope ...
body:
  deliverables:
    - kind: test_file
      path: test/<component>.test.ts
      framework: bun:test
      cases:
        - "<Test case description>"
    - kind: migration_file
      path: src/migrations/<NNN>_<name>.sql
      content_reference: <schema-spec-id>
    - kind: fsm_acceptance
      reference: <interaction-id>
      assertion: "every transition has ≥1 test case"
  runtime_invariants:
    - "<Invariant that must hold after any successful operation>"
  verifier:
    command: "bun test test/<component>.test.ts"
    expect: "all tests pass; exit code 0"
```

### 6.6 prompt — §10.5 Machine-runnable

```yaml
---
id: <component-id>.spec.prompt
stratum: spec
spec_kind: prompt
# ... envelope ...
body:
  context_bundle:
    - <system-id>
    - <capability-id>
    - <component-id>
    - <component-id>.spec.functional
    - <component-id>.spec.technical
    - <component-id>.spec.schema
    - <component-id>.spec.business_rule
    - <component-id>.spec.acceptance
    - "pkg:generic/bun@1.1"
    - "pkg:npm/<dependency>"
  outputs:
    - { path: src/<file>.ts, description: "<What this file exports and does>" }
    - { path: test/<file>.test.ts, description: "<What it tests>" }
  prompt_template: |
    You are generating the <component role> of <system name>.
    Read the bundled context files in order.
    Implement every behavior declared in spec.functional with
    spec.technical guidance and spec.business_rule constraints.
    Produce the exact files listed in `outputs`.
    Run the verifier and ensure it passes before returning.

    HARD CONSTRAINTS:
    - <Non-negotiable technology choice>
    - <Non-negotiable coding invariant>
  verifier:
    command: "<executable command>"
    expect: "all tests pass; exit code 0"
```

---

## 7. Parameters

```yaml
parameters:
  - name: PORT
    schema: { type: integer, minimum: 1024, maximum: 65535 }
    default: 3000
    binding_scope: system      # system | capability | component | interaction | spec
```

`binding_scope` is the stratum where the parameter is declared; it is visible to all descendants. A **variant** is a complete assignment of all parameters from root to leaf.

---

## 8. Constraints (CEL)

```yaml
constraints:
  - kind: requires             # requires | excludes | invariant | acceptance
    expression: "param.PORT > 1024"
    severity: error            # error | warning
```

---

## 9. Relationships (Six Typed)

```yaml
relationships:
  - { kind: composes-of,  target: <child-id>,          attributes: { find_number: "1.0" } }
  - { kind: depends-on,   target: "pkg:npm/hono@4",    attributes: { role: http_framework } }
  - { kind: derives-from, target: <parent-id>,         attributes: {} }
  - { kind: implements,   target: <spec-id>,           attributes: {} }
  - { kind: generates,    target: src/path/file.ts,    attributes: { generation_hash: "sha256:..." } }
  - { kind: varies-from,  target: <sibling-id>,        attributes: { variant_type: alternate } }
```

Use `pkg:` PURLs for external dependencies (`pkg:npm/hono@4`, `pkg:generic/bun@1.1`).
Use `dep:`, `svc:`, or `hw:` PURLs for non-npm dependencies.

---

## 10. Authoring Conventions (Load-Bearing)

| § | Rule | Why It Matters |
|---|------|---------------|
| §10.1 | Name Components by **what they do**, not location | Brief names survive fork/rename |
| §10.2 | Every boundary states what it **owns AND does not own** | Regenerator must know which component owns what |
| §10.3 | Read FSM states **verbatim** from source | Regenerator replicates code exactly; invented states diverge |
| §10.4 | Acceptance specs list **files to produce + verifier command** | Prose inspection fails silently; deliverables are checkable |
| §10.5 | Prompt specs are **machine-runnable without human input** | context_bundle + outputs + HARD CONSTRAINTS is the full contract |
| §10.6 | Substantive specs (>3 leaves) go in `nodes/specs/by_component/` | Diffable, browsable, avoids sekkei.yaml bloat |
| §10.7 | Strings containing `{`, `}`, `:`, `?` **must be quoted** | YAML flow context silently mangles unquoted special chars |

---

## 11. Verification Gates (Run After Authoring)

A sekkei is **authored** when all 6 gates pass (via `verify_sekkei.py`):

| # | Gate | What It Checks |
|---|------|----------------|
| 1 | **Envelope** | id, stratum, title, revision (major ∈ Y14.35 set, status ∈ enum), provenance, spec_kind |
| 2 | **Stratum hierarchy** | Every `composes-of` respects the parent→child table (system→capability, capability→component, component→interaction, interaction→spec) |
| 2b | **Role consistency** | Exactly 1 root; root not composed-of; subsystem composed-of; root has acceptance_gate; subsystem has dbom_ref=null |
| 3 | **Closure completeness** | Every `kizo:` target in composes-of/depends-on resolves to an authored node or known PURLscheme |
| 4 | **Brief coverage** | All required named nodes present (project-specific list) |
| 5 | **Spec coverage** | Every Component has functional, technical, acceptance, and prompt specs |
| 6 | **Spec quality** | acceptance has deliverables+verifier; prompt has context_bundle+outputs+verifier |

---

## 12. Inheritance Operations

When forking an existing sekkei, each inherited node declares its `provenance.override_kind`:

| Operation | Semantics |
|-----------|-----------|
| `as_is` | References parent by (id, content_hash). No local changes. |
| `with_override` | JSON-Patch RFC-6902 delta. Effective node = merge(parent.body, delta). |
| `extend` | Adds new child nodes under an inherited parent. No changes to inherited body. |
| `net_new` | Wholly new node with no ancestor. The locus of differentiation. |

**80% rule:** Forks inherit ~80% of the parent as-is; ~20% are override/extend/net_new.

---

## 13. Step-by-Step Authoring Checklist

Work through each step; tick off when complete before advancing.

- [ ] **1. Elicitation** — Run §1 questions; record namespace prefix, stack, Capabilities list
- [ ] **2. Root System** — Author `sekkei.yaml` with envelope + system body + all `composes-of` relationships
- [ ] **3. Capabilities** — One file per Capability in `nodes/capabilities/`; include `user_value` + `boundary`; add `composes-of` for each Component
- [ ] **4. Components** — One file per Component in `nodes/components/`; fill `boundary`, `runtime`, `realization_file`; add `composes-of` for each Interaction
- [ ] **5. Interactions** — Author FSMs and contracts in `nodes/interactions/`; read states verbatim from source (§10.3)
- [ ] **6. Specs** — For each Component, author all 6 spec kinds in `nodes/specs/by_component/<component>_specs.yaml`
- [ ] **7. External deps** — Enumerate `depends-on` relationships with PURL targets in `nodes/` (or inline on the owning node)
- [ ] **8. Parameters & constraints** — Declare on the lowest-common-ancestor stratum; add CEL constraints
- [ ] **9. Verify** — Run `python verify_sekkei.py` (or `bun run verify`); fix all gate failures before declaring the sekkei authored
- [ ] **10. Lock** — Generate or update `sekkei.lock` with pinned (id, major, content_hash) per node

---

## 14. Common Mistakes to Avoid

- **Inventing FSM states not in the source code.** Check the realization file first.
- **Writing acceptance specs as prose.** They must list `deliverables[].path` and `verifier.command`.
- **Omitting the "Does NOT own" clause** from boundary descriptions. Regenerators cannot infer ownership from silence.
- **Using plain `sha256:0000...` on released nodes.** Released nodes need real content hashes.
- **Putting both `realization_file` and `realization_files`.** Use one or the other.
- **Nesting component specs inline in `sekkei.yaml`.** Put substantive specs in `nodes/specs/by_component/`.
- **Leaving `spec_kind` off spec leaves.** Gate 1 fails without it.
- **Empty `context_bundle` in prompt specs.** Must include System + Capability + Component + all 5 other spec kinds.
