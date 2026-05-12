# The Parameter Model — two axes, currently conflated

A real divergence surfaced when the TodoMVC sekkei was imported into the running GLM for the first time. The sekkei used `binding_scope: capability` and `schema.type: array`; the importer warned on both and coerced them. This document explains what was happening, what the resolution is for now, and what should change in v1.2 of the spec.

---

## 1. What `binding_scope` actually names

The v1.1 spec (`sekkei.schema.json` and `sekkei_specification.md §5`) declares:

```yaml
parameters:
  - name: input_placeholder
    schema: { type: string }
    default: "What needs to be done?"
    binding_scope: capability      # the STRATUM where the parameter is declared
```

`binding_scope` here names **the stratum at which the parameter is declared**. It controls *visibility* — descendants of that stratum see the parameter; siblings and ancestors don't. A `binding_scope: system` parameter is visible everywhere; a `binding_scope: component` parameter is local to that Component subtree. This is the §5 "parameter propagation" rule.

Enum: `system | capability | component | interaction | spec`.

## 2. What the realization actually stored

The GLM database schema (`migrations/0001_initial.sql:105`) declared a different enum for the same column:

```sql
binding_scope TEXT NOT NULL CHECK (binding_scope IN ('workspace', 'variant', 'instance'))
```

This names **the lifecycle phase at which the parameter's value gets bound**. `workspace` = bound at install / authoring time; `variant` = bound at variant resolution time (operator-specific); `instance` = bound at deployment time. This is *timing*, not *visibility*.

The two enums name different axes. The importer at `src/import/adapter.ts` was trying to bridge them with a translation map that knew only one cross-walk (`system → workspace`) and warned about every other spec value. When the TodoMVC sekkei arrived with `capability`, `component`, every parameter warned.

## 3. The two axes belong together

| Axis                | Question it answers                                                      | Spec enum                                              | Realization enum (pre-fix)             |
|---------------------|--------------------------------------------------------------------------|--------------------------------------------------------|----------------------------------------|
| **Visibility scope** | At which stratum is this parameter *declared*? Who can see it?           | `system | capability | component | interaction | spec` | (not modeled)                          |
| **Binding lifecycle** | At which phase is the value *resolved*? Who provides it?                 | (not modeled)                                          | `workspace | variant | instance`       |

Both axes are useful. Visibility constrains who reads; binding constrains who writes. Conflating them under one field name was the mistake — on both sides.

## 4. Concrete consequence: the same parameter wants both

Take `input_placeholder` from the TodoMVC sekkei:

- **Visibility:** declared at the `web_ui` Capability stratum. The `add_todo_input` Component (a descendant) reads it; the backend Capability (a sibling) shouldn't.
- **Binding:** bound at the workspace level — the operator picks the locale at install time; it doesn't vary per variant or per deployment.

A parameter like `server_port`:

- **Visibility:** declared at the root System stratum. Visible everywhere.
- **Binding:** also workspace-bound — chosen once per install.

A parameter like `payment_processor_dine_in` in BaanBaan:

- **Visibility:** declared at the root System stratum. Visible everywhere.
- **Binding:** bound at the *variant* level — different sectors choose different processors.

A parameter like `hardware_class`:

- **Visibility:** System stratum.
- **Binding:** *instance* — every appliance picks its own at deployment time.

The realization needs to know BOTH for each parameter. The spec, today, only models the visibility axis.

## 5. The current state (after the v1.1.9 + fix-of-the-day patches)

Migration `0005_widen_parameter_enums.sql` widened the DB CHECK constraint to accept BOTH vocabularies:

```sql
CHECK (binding_scope IN (
  'system', 'capability', 'component', 'interaction', 'spec',     -- v1.1 spec values
  'workspace', 'variant', 'instance'                                -- pre-v1.1 realization values
))
```

The importer (`src/import/adapter.ts`) now passes any value from either set through unchanged. `TypeScript` (`src/types.ts`) declares the union of both for `ParameterBindingScope`. Imports of v1.1-shaped sekkeis succeed; older rows already in the DB stay valid.

**This is a compromise, not a destination.** It papers over the conflation by accepting both axes' values into one field, which means a reader of the DB row can't tell which axis the author intended.

## 6. The same week's smaller divergence: parameter `type`

The DB also restricted the parameter's `type` to `(string, integer, boolean, enum)`. The v1.1 spec treats `parameter.schema` as a full JSON Schema fragment, so `array`, `object`, `number`, and `null` are all valid. The TodoMVC sekkei's `hash_routes` parameter (`type: array`) was being coerced to `string` and warning loudly.

Migration `0005` widened the CHECK to:

```sql
CHECK (type IN ('string', 'integer', 'boolean', 'number', 'array', 'object', 'null', 'enum'))
```

This one is a clean fix — the spec was always the source of truth here; the realization just had too narrow an enum.

## 7. Proposed v1.2 resolution: split into two fields

The compromise above lets imports succeed. The right long-term answer is to model both axes explicitly:

```yaml
parameters:
  - name: input_placeholder
    schema: { type: string }
    default: "What needs to be done?"
    declared_at: capability       # visibility — the stratum of declaration
    bound_at:    workspace        # timing — the lifecycle phase of binding
```

Defaults that mirror the current behavior:

| Field          | Default                                | Spec validation                                                        |
|----------------|----------------------------------------|------------------------------------------------------------------------|
| `declared_at`  | Inferred from the host node's stratum  | enum `system | capability | component | interaction | spec`            |
| `bound_at`     | `workspace`                             | enum `workspace | variant | instance`                                  |

Reading legacy sekkeis: if only `binding_scope` is present, the value is interpreted as `declared_at` when it matches the stratum enum, otherwise as `bound_at`. The unambiguous cases all migrate cleanly; the ambiguous case (a value of `workspace` on a v1.1 sekkei from before this split) becomes `bound_at: workspace` with `declared_at` inferred.

This change is additive at the schema level; the JSON Schema gains the two fields and deprecates `binding_scope` with a `description` note.

## 8. Why this matters beyond cosmetics

The two axes have different downstream consumers:

- **Visibility (`declared_at`)** is consumed by the Authoring Capability — it controls which parameters appear in the schema-aware editor for which node, and what shadowing UI to render. It's also consumed by the Inheritance Resolver — descendants inherit visible parameters from ancestors.
- **Binding (`bound_at`)** is consumed by the Variant Resolution Capability — it controls which parameters get values from a variant's `parameter_binding` (in `sekkei.lock`) vs. from the workspace's settings vs. from per-instance deployment configuration.

A parameter that's `declared_at: system / bound_at: variant` is global in visibility but per-sector in value. A parameter `declared_at: capability / bound_at: workspace` is local in visibility and global in value. These four corners are real product behaviors, not edge cases — `server_port` is one corner, `input_placeholder` is another, `payment_processor_dine_in` is a third.

Pushing both axes onto one field forces the implementation to choose which one to enforce, and risks mis-routing the parameter's UI and resolution behavior.

## 9. Action items

For v1.2 of the spec:

1. Add `declared_at` and `bound_at` fields to the `parameter` $def in `sekkei.schema.json`.
2. Deprecate `binding_scope` with a `description` note pointing readers at the two new fields and a one-line migration rule.
3. Update `sekkei_specification.md §5` to discuss both axes explicitly.
4. Update `validate.py` to read the new fields and fall back to `binding_scope` for legacy sekkeis.

For the realization, alongside the v1.2 spec change:

1. Add a migration `0006_split_binding_axes.sql` that introduces two columns (`declared_at`, `bound_at`) and back-fills from the existing `binding_scope`.
2. Update `src/import/adapter.ts` to read both new fields and fall back to `binding_scope` as before.
3. Update `src/types.ts` to expose the two-axis shape, deprecate `ParameterBindingScope` in favor of `ParameterDeclaredAt` + `ParameterBoundAt`.
4. Update the Authoring Capability's forms and the Variant Resolution Capability's pipeline to consume the correct axis.

## 10. Until v1.2 ships

Both vocabularies work on this codebase. The importer accepts either; the DB accepts either; the validator accepts either. New sekkeis SHOULD use the v1.1 spec vocabulary (`system | capability | component | interaction | spec`) — that aligns with the documented spec and with future v1.2 migration. Existing sekkeis don't need to migrate.
