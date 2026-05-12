# ADR 0003 — Port the 6-gate verifier to TypeScript

**Status:** Accepted
**Date:** 2026-05-11
**Deciders:** Full-stack thread
**Phase:** 9 (Verifier)

## Context

The reference implementation ships a Python verifier (`sekkei/verify_sekkei.py`) that walks the YAML store and reports on six gates plus gate 2.b. The risk table in `docs/implementation_plan.md` §7 left the port-vs-shell-out decision open, recommending shell-out for v1.

In practice the Python script:

- Hard-codes an absolute filesystem path (`/sessions/gifted-epic-cannon/...`)
- Hard-codes a `REQUIRED_NODES` list specific to the food-FSR example
- Reads the YAML store directly, bypassing the SQLite index that the server already keeps in sync

Shelling out from the server would mean (a) reproducing the script's path assumptions for every workspace, (b) adding a Python runtime to the deployment surface, and (c) re-parsing the YAML on every run despite the same data being live in the index.

## Decision

Port the six gates + gate 2.b to TypeScript in `src/verifier/gates.ts` and drive them from `src/verifier/runner.ts` against the SQLite index. The Python script remains as the canonical reference and the source of truth for gate semantics; any future gate change starts there.

## Alternatives considered

- **Shell out to `verify_sekkei.py`** — keeps the Python source canonical, but the script is example-specific, requires a Python interpreter on the box, and re-parses ~hundreds of YAML files on every run. Rejected for production use; preserved as the spec reference.
- **Eager port plus an integration test that runs the Python alongside the TS** — would protect against drift, but the Python script's hard-coded path and required-nodes list make it impractical to run on arbitrary workspaces. Adopting this would mean rewriting the Python first.

## Consequences

- **Positive:** The verifier runs against any workspace in milliseconds, has no Python runtime requirement, and reuses the body-shape validation already in `src/domain/node.ts`.
- **Positive:** The runner can be invoked from three places (REST endpoint, pre-receive hook via `scripts/verify.ts`, future post-merge background job) with a single code path.
- **Positive:** Pure-function gates are trivially unit-testable; each gate ships with at least one pass + one fail test.
- **Negative:** Two implementations of the gate logic exist (Python reference, TS production). Gate-semantic changes must be applied in both. Mitigation: the Python script is example-specific so divergence is mostly cosmetic; production behaviour is defined by `src/verifier/gates.ts`.
- **Negative:** Gate 4 (brief coverage) is workspace-specific and is therefore optional in the port — a workspace must supply a brief explicitly via the REST payload. The Python version hard-codes a brief; ours pushes that responsibility outward.

## Follow-ups

- A future ADR may add a Wasm-loaded Python runtime so the canonical script can run directly inside the Bun process; only worth doing if the gate set grows significantly.
- The audit coverage test in Phase 10 includes `verifier.run` to keep the pipeline visible to operators.
