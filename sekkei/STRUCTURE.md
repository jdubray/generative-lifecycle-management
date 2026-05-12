# GLM Sekkei — proposed structure

**Sekkei id:** `kizo:dev.glm @ A.0`
**Location:** `./sekkei/` (top-level of the repo)
**Status:** structural draft; full per-Component spec sets to follow.

This is the GLM authoring this sekkei *about itself*. The strata below name what the GLM application IS, decomposed per the §C model. The sub-strata totals are conservative — small enough to author by hand at A.0, big enough to drive a real Path-B regeneration.

## Root System

```
kizo:dev.glm                                   (system_role: root)
  realization_summary: |
    Multi-user web app for authoring, reviewing, and regenerating sekkeis.
    Bun + Hono server, bun:sqlite (WAL) per workspace, vanilla-JS PWA client,
    server-sent events for collaboration broadcast. Single-tenant per
    organization; 1–50 simultaneous editors per sekkei. Sekkei size profile:
    100–500 nodes. LLM regeneration via external provider API; the app
    orchestrates, does not host inference.
  acceptance_gate: |
    Regenerating from this sekkei must produce a system that:
      1. Authors and validates a sekkei against specification/sekkei.schema.json
      2. Performs the seven GLM processes (Change Mgmt, Variant Resolution,
         Where-Used, Effectivity, Drift, Reuse, Provenance + Generation Pipeline)
      3. Successfully regenerates the BaanBaan + TodoMVC example sekkeis
         end-to-end, with all 7 verifier gates passing
      4. Runs as a single Bun process on a developer laptop with no external
         services beyond the LLM provider
```

## Sub-Systems

Two Sub-Systems naturally fall out (per §C.1):

```
kizo:dev.glm.workbench     (system_role: subsystem)
  — the multi-user authoring surface; PWA client + collaboration server

kizo:dev.glm.engine        (system_role: subsystem)
  — the headless regeneration engine; LLM dispatch + cache + verifier runner
```

The split lets the engine run independently (CI, server-side) without the workbench, while the workbench can run standalone for offline review against a frozen sekkei.

## Capabilities

Eight Capabilities — five cross-cutting at root, three under Sub-Systems.

### Under root (cross-cutting)

```
kizo:dev.glm.identity            — auth, sessions, org/user model, RBAC
kizo:dev.glm.persistence         — SQLite + WAL, content-hash store, sekkei.lock
kizo:dev.glm.audit               — provenance log, in-toto attestations, git-notes bridge
kizo:dev.glm.observability       — request log, error reporting, health probes
kizo:dev.glm.distribution        — release packaging, version pinning, plugin surface
```

### Under workbench

```
kizo:dev.glm.workbench.authoring        — node editor, schema-aware forms, validation feedback
kizo:dev.glm.workbench.collaboration    — soft-lock, presence, SSE broadcast, offline draft queue
kizo:dev.glm.workbench.review           — tree view, diff view, where-used, navigation
```

### Under engine

```
kizo:dev.glm.engine.generation          — LLM dispatch, prompt assembly, retry policy
kizo:dev.glm.engine.cache               — two-dimensional cache (design + generation hashes)
kizo:dev.glm.engine.verification        — runs spec.acceptance.verifier commands; drift report
```

## Components per Capability (rough count)

Numbers are A.0 estimates; some may split/merge during authoring.

| Capability                                | Components | Notable members |
|-------------------------------------------|-----------:|---|
| identity                                  | 4 | session_store, oauth_provider, rbac_engine, audit_login |
| persistence                               | 5 | sekkei_repository, content_hash_store, sekkei_lock_writer, ddl_manager, backup_engine |
| audit                                     | 3 | provenance_log, in_toto_emitter, git_notes_bridge |
| observability                             | 3 | request_logger, error_reporter, health_endpoint |
| distribution                              | 3 | release_packager, version_pin, plugin_loader |
| workbench.authoring                       | 6 | node_editor, schema_forms, validation_inspector, parameter_binder, fsm_visualizer, inheritance_resolver |
| workbench.collaboration                   | 4 | soft_lock_manager, presence_broker, sse_broadcaster, offline_draft_queue |
| workbench.review                          | 5 | sekkei_tree_view, diff_view, where_used_panel, history_navigator, search_box |
| engine.generation                         | 4 | llm_dispatcher, prompt_assembler, context_bundle_resolver, retry_policy |
| engine.cache                              | 3 | design_cache, generation_cache, content_addresser |
| engine.verification                       | 3 | spec_acceptance_runner, drift_reporter, gate_orchestrator |
| **TOTAL**                                 | **43** | |

## Interactions (rough count)

| Capability                          | Interactions | Notable |
|-------------------------------------|-------------:|---|
| persistence                         | 3 | sqlite_wal_schema, content_hash_algorithm, sekkei_lock_format |
| workbench.collaboration             | 2 | soft_lock_protocol, sse_event_flow |
| workbench.authoring                 | 2 | node_form_contract, parameter_binding_event_flow |
| engine.generation                   | 3 | llm_provider_adapter, prompt_envelope_schema, regeneration_workflow_fsm |
| engine.cache                        | 1 | cache_key_algorithm |
| engine.verification                 | 2 | gate_orchestration_fsm, drift_report_format |
| audit                               | 2 | in_toto_attestation_schema, git_notes_protocol |
| identity                            | 1 | session_token_format |
| **TOTAL**                           | **16** | |

## Brief-named Components (must be present per gate 4)

The Components whose names carry the design's identity — what `inventory_decrement` and `payment_state_machine` were to BaanBaan:

1. **`sekkei_repository`** — the persistence of a sekkei graph with content-hash integrity.
2. **`llm_dispatcher`** — the workflow that turns a `spec.prompt` into a generated artifact.
3. **`design_cache`** — the content-addressed cache of design closures.
4. **`generation_cache`** — the content-addressed cache of generated artifacts.
5. **`soft_lock_manager`** — the per-node lock protocol that makes 1–50 simultaneous editors work.
6. **`spec_acceptance_runner`** — the verifier dispatcher that closes the loop on `spec.acceptance.verifier.command`.

These will get fully-authored v1.1 spec sets at A.0; the other 37 Components will have skeleton Component nodes and selectively-populated specs.

## Provisional totals

| Stratum     | A.0 plan |
|-------------|---------:|
| root System |   1 |
| Sub-System  |   2 |
| Capability  |  11 |
| Component   |  43 |
| Interaction |  16 |
| spec (full) |  ~36 (6 brief-named × 6 kinds) |
| spec (skeleton) | ~74 (37 other Components × 2 kinds each) |
| **TOTAL**   | ~183 nodes |

This is in the small-half of the BaanBaan size band (457 nodes), large enough to exercise the methodology, small enough to author in a few focused passes.

## What this captures by *not* being more specific

A few intentional silences in the A.0 sketch:

- **No frontend framework choice yet.** The Capability is `workbench.authoring`, the Components are named by their *purpose* (node_editor, schema_forms, …). Whether the implementation is React, Lit, vanilla web components, or htmx is a `spec.technical` choice on each Component, not a structural one. A fork that wants a different stack can override at the Component level without touching the Capability tree.
- **No CRDT vs OT vs last-writer-wins decision at the Capability level.** The project assumption (CLAUDE.md) is "soft-lock + last-writer-wins at the node-body grain." That's a property of `soft_lock_manager` Component's `spec.business_rule`, NOT a Capability-level commitment. The fork that does want a CRDT-grade collaboration substrate replaces this Component.
- **No specific LLM provider.** `llm_dispatcher` Component's `spec.technical` will declare an adapter interface; a `pkg:` depends-on pins the default provider; a fork can swap.
- **No HTTP framework choice for the server.** Same pattern: Component-level decision, not structural.

This is the §C.2 locality rule in action: structural commitments are minimal at the upper strata so forks have room to vary at the leaves.
