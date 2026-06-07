# GLM-driven Claude Code: vibe the sekkei, then code on auto-pilot

A two-phase development process that uses GLM as the source of truth for a
codebase built by Claude Code. You **vibe** a sekkei into shape interactively,
and once the verifier says it is complete, you flip to **auto-pilot**: Claude
generates every component's code, runs each component's acceptance verifier, and
records provenance — hands-off — until the whole tree is green.

> Surfaces used here: the `glm` CLI (`integrations/cli/`), the `glm_*` MCP tools
> (`integrations/mcp/`), and the slash commands `/glm-status`,
> `/glm-list-components`, `/glm-verify`, `/glm-refine`, `/glm-generate`,
> plus the two orchestration commands this process adds: `/glm-ready` and
> `/glm-build`. The conversational `/glm` skill is the co-author in Phase 1.

---

## The core idea — the verifier IS the gate

The process hinges on one thing: **`glm verify` going green is the seam between
"still speccing" and "ready to code."** You do not guess when you are ready to
code — the 7-gate verifier tells you. In particular:

- **Gate 5 (spec coverage)** — every component has `functional`, `technical`,
  `acceptance`, and `prompt` spec leaves.
- **Gate 6 (spec quality)** — every `acceptance` lists `deliverables[]` + a
  `verifier.command`; every `prompt` has a non-empty `context_bundle`, explicit
  `outputs[]`, and HARD CONSTRAINTS.

Gate 6 is what makes a component **machine-runnable without a human** — exactly
what auto-pilot needs. So the process is: **vibe loosely → tighten until verify
is green → flip to auto-pilot.**

```
  PHASE 1: VIBE -> SPEC                  GATE              PHASE 2: AUTO-PILOT
  (high-touch, you + Claude)         (verify green)        (low-touch, Claude alone)
  +-------------------------+      ++==============++      +----------------------+
  | describe -> vibe        |      || Definition   ||      | topo-order components |
  |   -> verify             | ---> || of Ready to  || ---> | generate each, retry  |
  |   loop: refine, verify  |      || Code (DoRC)  ||      | acceptance-verify     |
  |  shape the sekkei       |      ++==============++      | record provenance     |
  +-------------------------+              |              +----------+-----------+
            ^                              |                         |
            +------- drift / bounce <------+------ hard failure -----+
```

---

## Phase 0 — Setup (once per project)

```bash
glm init --name myproj                 # writes ~/.glm/config.json + a solo token
# (the GLM server is already always-on on :3300 via the "GLM Server" task)
glm init --source-dir /abs/path/to/code  # where generated code lands (sandboxed)
```

`source_dir` is a hard sandbox: `generate` only ever writes **under** it and
never outside. That is the blast-radius guarantee that makes auto-pilot safe.

## Phase 1 — Vibe to a sekkei (high-touch loop)

A tight loop, not one shot:

1. **Seed it.**
   `glm vibe --slug myproj --namespace acme:myproj --description "<elevator pitch + capabilities + stack>"`
   (or `--description-file`). Authors the System -> Capability -> Component
   skeleton. Brownfield variant: add `--from-dir <path>` to reverse-engineer the
   sekkei from existing code first.
2. **See where you stand.** `/glm-verify` (or `glm verify --verbose`). Early on
   it fails gate 5 hard — expected. (Reference: the `glm-self` workspace has 66
   components and 0 specs, so it reports 66 gate-5 failures.)
3. **Refine toward green.** For each gap, `/glm-refine <glm_id>` with an
   instruction: fill boundaries, FSM states (read **verbatim** from any
   reference code — never invent states), and the six spec leaves per component.
   Re-verify. Repeat.
4. The `/glm` skill is your co-author — it knows the envelope, per-stratum body
   shapes, and the load-bearing rules (honest boundaries, deliverables-not-prose
   acceptance, machine-runnable prompts). Full detail in
   [`sekkei-authoring.md`](./sekkei-authoring.md).

## The Gate — "Definition of Ready to Code" (DoRC)

Do not flip to auto-pilot until **all** of these hold. Run `/glm-ready` to check
them in one shot:

- [ ] `glm verify` exits **0** (all gates pass) — non-negotiable.
- [ ] Gate 5 green: every component has `functional, technical, acceptance, prompt`.
- [ ] Gate 6 green: every `acceptance.verifier.command` is real and runnable;
      every `prompt` has a non-empty `context_bundle`, explicit `outputs[]`, and
      HARD CONSTRAINTS.
- [ ] `source_dir` is set on the workspace.
- [ ] Each component's `outputs[]` paths are disjoint (no two components claim
      the same file).
- [ ] External deps (`pkg:` PURLs) are declared so every `context_bundle`
      resolves.

When all true, the sekkei is a complete, executable contract — and **you give
the explicit "go."**

## Phase 2 — Auto-pilot build loop (low-touch)

Because `glm generate` is **one component at a time**, auto-pilot is an
orchestrated loop (this is what `/glm-build` automates):

1. **Enumerate** — `glm_list_components`.
2. **Order** — topologically sort by each component's `depends-on` edges and its
   `prompt.context_bundle` references, so a component is generated only after the
   components it imports. Leaf/utility components first; routes/entrypoints last.
3. **For each component, in order:** resolve spec -> write exactly `outputs[]`
   under `source_dir` -> run its `acceptance.verifier.command` -> on non-zero,
   fix and retry (<=3) -> on pass, `record_generation` (provenance + audit).
4. **Failure policy: stop-on-first-failure.** If a component still fails after 3
   retries, **halt** (downstream depends on it), surface the stderr, and bounce
   to Phase 1 — usually a `/glm-refine` on that component's `technical` or
   `acceptance` spec — then resume.
5. **Final acceptance:** after all components, re-run `glm verify` and the System
   root's `acceptance_gate` (boots + full test suite green). That is "build
   complete."

Auto-pilot stays honest because every step is checkable: the per-component
verifier is the inner gate, provenance is the audit trail, and `source_dir` is
the sandbox. For fully unattended runs, wrap `/glm-build` in the `/loop` skill so
it resumes until the whole tree is green.

## Phase 3 — Iteration & drift (steady state)

Once code exists, changes flow **spec-first**: edit the node (`/glm-refine`) ->
re-verify -> re-generate just the affected subtree. The drift detector flags when
hand-edited code diverges from its spec so you can reconcile (regenerate, or fold
the change back into the sekkei). The sekkei stays the source of truth; code
stays a derived build product.

---

## Command quick-reference

| Step | Command |
|------|---------|
| One-time setup | `glm init`, `glm init --source-dir <abs>` |
| Seed sekkei | `glm vibe --slug <s> --namespace <ns> --description "<...>"` |
| Reverse-engineer | `glm vibe --from-dir <path> ...` |
| Inspect | `/glm-status`, `/glm-list-components` |
| Check gates | `/glm-verify` |
| Fix a node | `/glm-refine <glm_id>` |
| **Readiness gate** | **`/glm-ready`** |
| **Auto-pilot build** | **`/glm-build`** |
| Generate one component | `/glm-generate <component_id>` |

## Design notes

- **Why a hard gate?** Auto-pilot is only safe when each component is a complete
  contract. Gate 6 guarantees `context_bundle + outputs + HARD CONSTRAINTS` — the
  full input for generation — so Claude needs no human mid-build.
- **Why topological order?** A component's tests import sibling modules; generate
  a dependency before its dependents or the acceptance verifier fails for missing
  imports. Order by `depends-on` + `context_bundle` references.
- **Why stop-on-failure (default)?** A failed component blocks everything
  downstream, so collecting further failures wastes work and muddies the report.
  `/glm-build` halts, points at the blocker, and resumes after a refine.
