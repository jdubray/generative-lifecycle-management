# Sekkei Schema v1.1 — Validation Report

**Date:** 2026-05-10
**Schema:** `specification/sekkei.schema.json`
**Validator:** `specification/validate.py` (jsonschema Draft 2020-12)

## Hand-crafted canonical examples

One per stratum, plus the two fully-shaped spec_kinds (acceptance + prompt). All six pass.

| # | Example                                                                | Stratum     | Result |
|---|------------------------------------------------------------------------|-------------|--------|
| 1 | `kizo:web.todomvc`                                                     | system      | PASS   |
| 2 | `kizo:web.todomvc.todo_management`                                     | capability  | PASS   |
| 3 | `kizo:web.todomvc.todo_management.todo_repository`                     | component   | PASS   |
| 4 | `kizo:web.todomvc.todo_management.todo_repository.todo_schema`         | interaction | PASS   |
| 5 | `kizo:…todo_repository.spec.acceptance` (deliverables + verifier shape) | spec        | PASS   |
| 6 | `kizo:…todo_repository.spec.prompt` (context_bundle + outputs + verifier) | spec        | PASS   |

## BaanBaan sekkei (`kizo:food.fullservicerestaurant @ A.0`)

| Stratum     | Count |
|-------------|------:|
| system      |     5 |
| capability  |    10 |
| component   |    62 |
| interaction |    48 |
| spec        |    53 |
| **TOTAL**   | **178** |

**Pass rate: 70.2% (125 of 178 nodes pass).**

### What the 53 failures are

Every failing node is a `stratum: spec` node where `spec_kind` is nested
inside `body.spec_kind` (the v1.0 §C.8 form) rather than at the top level
(the v1.1 form). The schema correctly rejects them — this is the
migration gap explicitly enumerated in §11 of the specification document.

```yaml
# v1.0 form (rejected by v1.1 schema):
stratum: spec
body:
  spec_kind: acceptance
  inspection_assertions: [...]

# v1.1 form (accepted):
stratum: spec
spec_kind: acceptance              # <- lifted to top level
body:
  deliverables: [...]              # <- new shape
  verifier: { command, expect }    # <- new shape
  # OR (legacy back-compat):
  inspection_assertions: [...]     # <- legacy shape still accepted
```

### Migration path (deferred)

A simple migration script can lift `spec_kind` to top-level in every
v1.0 node. Not done in this changeset because:

1. The TodoMVC sekkei (the v1.1 reference implementation) was authored
   in v1.1 form from the start and passes 100%.
2. The BaanBaan sekkei is the reverse-engineering EXEMPLAR; preserving
   its v1.0 specs documents what authoring looked like before the
   refinement, which is itself spec content.
3. Migration is mechanical and can be done when BaanBaan A.1 is cut.

## TodoMVC sekkei (`kizo:web.todomvc @ A.0`)

Pre-existing 6-gate verifier in `todo-mvc/sekkei-todomvc/verify_sekkei.py`
reports PASS on all six gates (envelope, hierarchy, closure, brief
coverage, spec coverage, spec quality). The TodoMVC sekkei is the v1.1
reference implementation.

## Conclusion

The v1.1 schema is correctly enforced:

- **Tight on the load-bearing shapes.** `spec.acceptance` MUST have
  `deliverables + verifier`; `spec.prompt` MUST have
  `context_bundle + outputs + verifier`. Both checked via JSON Schema
  `if/then` keyword on `spec_kind`.
- **Loose where the v1.1 spec admits flexibility.** `functional`,
  `technical`, `schema`, `business_rule` bodies are `additionalProperties:
  true` because their shapes are stylistic conventions, not load-bearing
  for regeneration determinism.
- **Backward-compatible on legacy shapes.** Acceptance bodies authored
  in the v1.0 `inspection_assertions[]` form are accepted via the
  `specBodyAcceptanceLegacy` $def.
- **Clear about the migration gap.** The 30% BaanBaan failure rate is
  the spec_kind-location lift, called out in §11 of
  `sekkei_specification.md`.

The schema is ready for use as the `$schema` reference in new sekkei
node files.
