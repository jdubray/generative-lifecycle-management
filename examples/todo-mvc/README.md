# TodoMVC — `kizo:web.todomvc @ A.0`

The validation case for the GLM methodology. Forward-designed from the canonical TodoMVC reference at https://demo.playwright.dev/todomvc/ with an imagined Bun + Hono + SQLite-WAL backend, then regenerated into a working app to test whether the sekkei alone could drive end-to-end reproduction.

## What this example demonstrates

- The full v1.1 spec shape end-to-end at small scale (57 nodes vs BaanBaan's 457).
- Forward-design (rather than reverse-engineering): the sekkei was authored *before* the code existed, and the code was generated *from* it.
- All 6 spec_kinds per Component (functional + technical + schema + business_rule + acceptance + prompt).
- Acceptance specs as `deliverables[]` + `verifier` (the v1.1 shape, not legacy inspection_assertions).
- Prompt specs as `context_bundle` + `outputs` + `verifier` triples (machine-runnable).
- The first end-to-end Path-B regeneration of a system from its sekkei alone.

## Inventory

| Stratum     | Count |
|-------------|------:|
| root System |     1 |
| Capability  |     2 |
| Component   |     8 |
| Interaction |     4 |
| spec        |    42 |
| **TOTAL**   | **57** |

## Layout

```
todo-mvc/
├── sekkei-todomvc/              ← the sekkei (the design source)
│   ├── sekkei.yaml
│   ├── nodes/
│   ├── verify_sekkei.py
│   ├── VERIFICATION.md
│   └── VERIFICATION_REPORT.txt
├── src/                         ← the regenerated app (Bun + Hono + bun:sqlite)
│   ├── package.json
│   ├── public/                  ← static frontend
│   ├── src/                     ← backend
│   └── tsconfig.json
└── VALIDATION_PATH_B.md         ← the assessment of the Path-B regeneration
```

## How to run the verifier

```bash
cd examples/todo-mvc/sekkei-todomvc
python3 verify_sekkei.py
python3 ../../../specification/validate.py .
```

Both should report PASS / 100% pass rate.

## How to run the app

```bash
cd examples/todo-mvc/src
bun install     # if dependencies aren't already in node_modules/
bun run dev     # serves on http://localhost:3000
```

## What the validation found

See `VALIDATION_PATH_B.md` for the full assessment. The headline: the runtime is high-fidelity to the sekkei (every load-bearing HARD CONSTRAINT and business_rule is satisfied; the regenerator independently added XSS escaping, `history.replaceState`-based hash routing, and a deterministic ORDER BY tiebreaker), but **all 8 promised test files were skipped** by the regeneration pipeline. That gap is captured as the leading v1.2 specification refinement: split `spec.prompt.outputs` into `outputs.runtime[]` and `outputs.tests[]`, and gate completion on both.
