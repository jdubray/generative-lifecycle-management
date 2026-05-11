# Sekkei Specification — v1.1.9 Changelog

**Change:** `system_role` discriminator on System body (PLM "same class, different role" pattern).

## Rationale

Reverse-engineering BaanBaan revealed that the strata model needed to distinguish the root deployable System (cardinality 1, owns the dBOM and the acceptance gate, ships to the operator) from internal structural Sub-Systems (cardinality N, never deploy independently, exist purely for design organization). The original §C.1 amendment introduced System recursion but treated both layers as `stratum: system` with no field-level distinction. Reports collapsed the two into one count.

PLM systems handle this distinction the same way: one class (Item / Part / WTPart) with a type/role discriminator field. Aras has the "Top-Level" boolean; Windchill has the `End-Item Type` enum; Teamcenter uses a configurable Item-Type taxonomy. Splitting into separate classes per layer fragments validation and never quite re-converges; a discriminator gets you role-conditional validation without that cost.

## Change summary

Adds a required field `body.system_role` to every node with `stratum: system`. Enum values:

| Value | Cardinality | Semantics | dbom_ref | acceptance_gate |
|---|---|---|---|---|
| `root` | exactly 1 per graph | the deliverable product family unit; ships to the operator | required (string or explicit null with rationale) | required |
| `subsystem` | N (≥ 0) | structural grouping under a root or another Sub-System | MUST be null (Sub-Systems don't deploy independently) | inherited from root |
| `platform` | reserved | shared-across-products structure whose parameter defaults are inherited by descendants (VW MQB-style) | MAY be set if the platform itself deploys | optional |

## Schema-enforced rules

In `specification/sekkei.schema.json` (Draft 2020-12 `allOf` + `if/then`):

```json
"systemBody": {
  "properties": { "system_role": { "enum": ["root", "subsystem", "platform"] }, ... },
  "allOf": [
    {
      "if":   { "properties": { "system_role": { "const": "root"      } }, "required": ["system_role"] },
      "then": { "required": ["acceptance_gate"] }
    },
    {
      "if":   { "properties": { "system_role": { "const": "subsystem" } }, "required": ["system_role"] },
      "then": { "properties": { "dbom_ref": { "type": "null" } } }
    }
  ]
}
```

## Verifier-enforced rules (gate 2.b)

Both `verify_sekkei.py` scripts (BaanBaan + TodoMVC) gained a new `check_role_consistency` function and a new gate 2.b "Role consistency (§C.1.b)" that flags:

- a System node missing `body.system_role`
- a System with `system_role: root` that IS composed-of by another System (position contradicts declared role)
- a System with `system_role: subsystem` that is NOT composed-of by any other System (orphaned Sub-System)
- a Sub-System with `body.dbom_ref` set to anything other than `null`
- cardinality error if root count ≠ 1 per graph

## Migration

Pure additive change. Existing sekkeis need one line per System node:

```yaml
body:
  system_role: root         # or subsystem | platform
  ...
```

Done in this changeset for:
- `kizo:food.fullservicerestaurant` (root) + 4 Sub-Systems (register, communication, onlineordering, reservations) — all 5 updated.
- `kizo:web.todomvc` (root, only System node).

Backfilled the BaanBaan root with `realization_summary` and `acceptance_gate` (previously had only `realization_notes`).

## Validation status

| Sekkei | Total nodes | Schema pass | Verifier gates |
|---|---:|---:|---|
| `kizo:food.fullservicerestaurant @ A.1` | 457 | 100% | 1, 2, 2.b, 3, 4, 5, 6 all PASS |
| `kizo:web.todomvc @ A.0` | 57  | 100% | (file changes applied; sandbox mount can't read the directory to run the verifier here; the user's local machine can) |

## What this enables for the cosmetic-practice fork

The fork can introduce its own Sub-System layer without ambiguity:

```yaml
# kizo:health.practice.cosmetic — root
body: { system_role: root, dbom_ref: ./dbom.yaml, acceptance_gate: ... }

# kizo:health.practice.cosmetic.surgery — Sub-System for OR/scheduling
body: { system_role: subsystem, dbom_ref: null }

# kizo:health.practice.cosmetic.compliance — Sub-System for HIPAA artifacts
body: { system_role: subsystem, dbom_ref: null }
```

…inheriting most cross-cutting Capabilities (Payment, Inventory, Reporting, Auth, Crypto) from BaanBaan as-is, and replacing only the sector-specific Sub-Systems (Register → Practice Floor, Communication → Clinical Communication, OnlineOrdering → Patient Portal, Reservations → Appointment Booking).
