# GLM User Manual

**Version:** 1.0 · **Date:** 2026-05-12

---

## Table of Contents

1. [Core Concepts](#1-core-concepts)
2. [The Git Branch Scheme](#2-the-git-branch-scheme)
3. [Starting a Project from Scratch](#3-starting-a-project-from-scratch)
4. [Importing an Existing Codebase](#4-importing-an-existing-codebase)
5. [Creating a Change Request](#5-creating-a-change-request)
6. [Creating a Variant](#6-creating-a-variant)
7. [Reference: Roles and Permissions](#7-reference-roles-and-permissions)

---

## 1. Core Concepts

### What is a sekkei?

A **sekkei** (設計, Japanese for "design") is a formal, content-addressed specification of a software system, stored as a tree of YAML files. It is the single source of truth from which GLM's LLM agents can regenerate working code, detect drift, and track change.

Every sekkei node belongs to one of five strata, and System nodes carry an additional `system_role` field that distinguishes the root from nested sub-systems:

| Stratum | `system_role` | What it describes |
|---------|--------------|------------------|
| **System** | `root` | The top-level bounded context — the whole product |
| **System** | `subsystem` | A major architectural partition within the root (e.g., a workbench vs. a headless engine) |
| **Capability** | — | A user-facing feature or significant cross-cutting concern |
| **Component** | — | A deployable unit: a service, library, or CLI |
| **Interaction** | — | How two Components communicate — an API contract or event schema |
| **Spec** | — | A leaf specification — the prompt that drives code generation |

`system_role` is required on every System node and rejected on all others. The DB enforces this with a CHECK constraint.

A typical tree looks like:

```
System (root)              ← the whole product
  ├─ System (subsystem)    ← major partition A (e.g., user-facing workbench)
  │    └─ Capability       ← feature within the subsystem
  │         └─ Component   ← deployable unit
  │              └─ Spec   ← generation prompt
  └─ System (subsystem)    ← major partition B (e.g., headless engine)
       └─ Capability
            └─ Component
                 └─ Interaction   ← API contract between Components
                 └─ Spec
```

Sub-systems are connected to their root via `composes-of` relationships. Capabilities can sit directly under the root (cross-cutting concerns like identity or observability) or under a specific sub-system. There is no fixed depth limit — a large product might have three or four layers of nested Systems before reaching Capabilities.

### The two stores

GLM uses two complementary stores:

| Store | What it holds | Notes |
|-------|--------------|-------|
| **Database** | Your current working state — drafts, edit locks, SCR workflow, rollout progress | Lost if wiped; rebuilt from git |
| **Git** | Every approved change, every release, every generated artifact's provenance | Survives everything; the audit record |

The rule is simple: **anything another user, machine, or auditor must see goes through git. Everything you are still working on lives in the DB.**

### What is an SCR?

A **Sekkei Change Request** (SCR) is the unit of change in GLM. No node body is committed to git until an SCR that covers it is approved. This is the equivalent of an Engineering Change Notice (ECN) in hardware PLM: one SCR → one commit → one review.

### What is a variant?

A **variant** is a named deployment target — for example, `eu-prod`, `staging`, or `acme-customer`. Each variant resolves the sekkei tree against a set of parameter bindings and records the result in a `sekkei.lock` file on a dedicated git branch. Variants let you maintain one canonical design while shipping different configurations to different environments.

---

## 2. The Git Branch Scheme

GLM organizes its git repositories into three separate repos, each with a defined branch topology.

### 2.1 The three repos

```
glm-sekkei/        ← the design: your sekkei YAML tree
glm-realization/   ← the generated code: one artifact per Spec node
glm-catalog/       ← shared components promoted for reuse across projects
```

GLM manages `glm-sekkei/` directly. `glm-realization/` is written by the generation pipeline via pull requests. `glm-catalog/` is managed by a steward when a component is promoted for reuse.

### 2.2 Branches in glm-sekkei

```
glm-sekkei/
  main                       ← released trunk; tagged commits only; no direct push
  next                       ← integration branch; all approved SCRs land here
  feature/<scr-id>-<slug>    ← short-lived; auto-created when an SCR is implemented
  variants/<name>            ← long-lived; holds sekkei.lock for each deployment target

Release tags (on main):
  A.0, A.1, A.2, …          ← signed annotated tags; one per release cycle
  B.0, B.1, …               ← letter increments on major milestones
```

**How changes flow:**

```
  Your edits (DB)
       │
       ▼ SCR submitted → reviewed → approved
  feature/<scr-id>  (ECN commit, auto-created)
       │
       ▼ fast-forward merge (automatic)
      next
       │
       ▼ release cut (operator action: POST /releases)
  signed tag A.n → merged to main
```

**Rules enforced by the pre-receive hook:**

| Rule | Branch/Tag | Effect |
|------|-----------|--------|
| No direct push to `main` | `refs/heads/main` | Rejected — use release tags |
| No force-push | All branches | Rejected |
| Commit message must start with `ECN:` or `Merge ` | `next`, `main` | Rejected |
| `sekkei.lock` must be present at root | `variants/*` | Rejected without the lock file |
| Release tags must be annotated | `[A-Z].*` tags | Lightweight tags rejected |
| Release tags must be GPG-signed | `[A-Z].*` tags (when `GLM_REQUIRE_SIGNED_TAGS=1`) | Unsigned tags rejected in production |
| Every commit touching `nodes/` must carry an `Affected:` block | All branches | Rejected without the block |

### 2.3 Branches in glm-realization

```
glm-realization/
  main                              ← stable generated artifacts; protected
  gen/<timestamp>-<component>       ← transient; opened by the generation pipeline as a PR
```

Each code generation run opens a PR from `gen/<timestamp>-<component>` → `main`. The PR description links back to the sekkei commit and node ID. On merge, GLM records the realization commit SHA against the generation attestation.

### 2.4 Branches in glm-catalog

```
glm-catalog/
  main                   ← single protected branch
  v1.0.0, v1.1.0, …     ← semantic version tags for each promoted component set
```

---

## 3. Starting a Project from Scratch

### Step 1 — Create the git repos

Create three empty repositories on your git host (GitHub, GitLab, or any bare server):

```
<org>/glm-sekkei
<org>/glm-realization
<org>/glm-catalog      (optional — only needed when you promote reusable components)
```

Initialize `glm-sekkei` with the branch structure:

```bash
git clone <org>/glm-sekkei && cd glm-sekkei
git checkout -b main && git push -u origin main
git checkout -b next  && git push -u origin next
```

Set branch protection on `main`: no direct push, require signed commits, require status checks.

### Step 2 — Create a workspace in GLM

Open GLM and click **New workspace**. Fill in:

| Field | Value |
|-------|-------|
| Name | Your project name |
| Slug | URL-friendly identifier (e.g., `acme-billing`) |
| Git remote | `git@github.com:<org>/glm-sekkei.git` |
| Tracking branch | `refs/heads/next` |

GLM clones the remote into `data/repos/<workspace-id>/`, checks out `next`, and records the HEAD SHA. The workspace dashboard shows **Git: attached**.

### Step 3 — Build the sekkei tree

Start at the root System node. The tree should reflect your system's decomposition:

1. **Root System** → click **Add node** → choose stratum **System** → set `system_role` to `root` → fill in title, description, and boundary definition.

2. **Sub-systems** (optional) → if your product has major architectural partitions (e.g., a user-facing workbench and a headless engine, or a mobile client and a backend platform), add a System node per partition with `system_role: subsystem`. Connect each to the root with a `composes-of` relationship. Skip this step for small projects; go directly to Capabilities.

3. **Capabilities** → for each major user-facing feature or cross-cutting concern (auth, billing, observability), add a Capability node. Attach cross-cutting Capabilities to the root with `composes-of`; attach product-area Capabilities to the appropriate sub-system.

4. **Components** → for each deployable unit (service, library, CLI), add a Component node under the relevant Capability.

5. **Interactions** → for each API or event contract between Components, add an Interaction node.

6. **Specs** → for each Component (or sub-feature), add a Spec node with a `spec.prompt` field that the generation pipeline will use.

All of this is live in the DB. None of it is in git yet — that happens when you submit your first SCR.

### Step 4 — Submit the initial SCR

Once your initial tree is drafted, submit a **Sekkei Change Request** to commit it to git:

1. Click **New SCR** on the workspace dashboard.
2. Title: `Initial sekkei structure` (or similar).
3. Select all nodes you created.
4. Fill in **Why** (the motivation for this design).
5. Submit → review → approve.

On approval GLM creates `feature/<scr-id>-initial-sekkei`, writes every node as a YAML file under `nodes/<stratum>/`, commits with an `ECN:` message, fast-forward merges to `next`, and deletes the feature branch. The workspace's **git_commit** advances to the new HEAD.

### Step 5 — Generate your first artifact

Navigate to a Spec node, click **Regenerate**. GLM:

1. Bundles the spec's prompt + the node's body as the LLM context.
2. Calls the configured LLM.
3. Opens a PR in `glm-realization/` from `gen/<timestamp>-<component>` → `main`.
4. Attaches a DSSE-signed in-toto attestation to the sekkei commit as a git note.

Review and merge the PR in your git host. GLM then records the realization commit SHA.

### Step 6 — Cut the first release

When `next` is ready to ship:

1. Click **New release** on the Effectivity dashboard (or POST `api/v1/workspaces/:id/releases`).
2. Enter the release name — `A.0` for your first release.
3. Enter a release message describing what is included.

GLM creates a signed annotated tag `A.0` on the current `next` HEAD and seeds `rollout_records` for every variant node, letting you track node-by-node advancement to the new release.

---

## 4. Importing an Existing Codebase

### 4.1 Generate a sekkei from the codebase

Before importing into GLM you need a sekkei — a structured YAML description of the system. Two paths:

#### Path A — Manual authoring (recommended for small codebases)

Walk the codebase yourself:
- Write one **System** node (`system_role: root`) for the overall bounded context.
- If the codebase has major partitions (e.g., frontend and backend, or multiple independently deployable services), write a **System** node (`system_role: subsystem`) for each and connect them to the root with `composes-of`.
- Map each top-level user feature or cross-cutting concern (auth, billing, observability) to a **Capability** node under the appropriate System.
- Map each deployed service or library to a **Component** node under its Capability.
- Map each significant API endpoint group or event contract to an **Interaction** node.
- For each Component, write a **Spec** node whose `spec.prompt` field captures what the component does and what constraints it must satisfy.

Save each node as a YAML file in the structure:

```
nodes/
  systems/
    <safe-glm-id>.yaml
  capabilities/
    <safe-glm-id>.yaml
  components/
    <safe-glm-id>.yaml
  interactions/
    <safe-glm-id>.yaml
  specs/
    <safe-glm-id>.yaml
```

Each file must have the envelope fields: `id`, `stratum`, `title`, `version`, `content_hash`. The `content_hash` is `sha256(canonicalize(body))` where the body is the non-envelope fields sorted by key. GLM will reject any file whose stored `content_hash` doesn't match the computed one.

#### Path B — Assisted extraction (via vibe mode)

Open GLM, create a workspace (no git remote yet), and use **Vibe mode**:

1. Click **Vibe** → type a prompt like:
   > "I have a REST API written in TypeScript. It has these services: auth, billing, catalog. Auth owns the session store. Billing calls Stripe. Catalog is read-only. Create a sekkei for this."

2. GLM returns a proposed node tree as a reviewable diff.
3. Accept, modify, or reject the proposal.
4. The accepted plan is automatically wrapped in an SCR, which you approve to commit it to git.

Repeat for deeper layers — vibe at the Capability level to expand into Components, then at the Component level to draft Spec prompts from existing README files or inline code snippets.

### 4.2 Import the sekkei into GLM

Once your YAML files exist (either authored manually or exported from a prior sekkei tool), push them to your `glm-sekkei` repo on `next`:

```bash
git clone <org>/glm-sekkei && cd glm-sekkei
git checkout next
mkdir -p nodes/systems nodes/capabilities nodes/components nodes/interactions nodes/specs
# Copy your YAML files into the appropriate subdirectory.
git add nodes/
git commit -m "ECN: Import initial sekkei from <project>"
git push origin next
```

Then in GLM:

1. Create (or open) the workspace and attach it to the remote (see §3, Step 2).
2. Click **Sync** (or POST `api/v1/workspaces/:id/git-sync`).

GLM pulls from `next`, walks every changed YAML file, upserts nodes into the DB, and writes a `change_log` row for each (`op=git-sync`). The workspace dashboard shows the nodes and their relationships.

**If the workspace already existed (re-import):** GLM reconciles the imported YAML against the existing DB rows. Nodes whose `content_hash` has changed are updated; new nodes are inserted; nodes in the DB but absent from the YAML are left in place (deletion requires an explicit SCR).

---

## 5. Creating a Change Request

### 5.1 Path A — Direct sekkei edit

Use this path when you know exactly what needs to change.

1. **Acquire the edit lock.** Navigate to the node you want to edit. Click the pencil icon. GLM acquires a 30-second heartbeat lock; you will see a "Editing" badge. Other users see a "Locked by [you]" indicator and cannot edit this node until you release or the lock expires.

2. **Edit the body.** Modify any fields in the node editor. The change is saved to the DB immediately; other users see your draft in real time (their view shows the updated content but notes it is a draft).

3. **Open an SCR.** Click **Submit as SCR** (or navigate to **Change Management → New SCR**):
   - **Title:** One-line summary of the change.
   - **Why:** The problem this change addresses.
   - **Affected nodes:** GLM pre-selects the node you edited; add others if needed.
   - Submit.

4. **Review workflow.** The SCR moves through:
   ```
   Draft → Submitted → Under Review → Approved → Implementing → Implemented → Released
   ```
   - **Submitted:** Visible to all reviewers.
   - **Under Review:** A reviewer has been assigned.
   - **Approved:** The change is accepted; the next step writes it to git.
   - **Implementing:** GLM is building the ECN commit (automatic).
   - **Implemented:** The ECN commit exists on the feature branch; the feature branch has been merged to `next`.
   - **Released:** The SCR's commit is included in a release tag.

5. **What GLM writes to git.** On the **Approved → Implementing** transition:
   - Creates `feature/<scr-id>-<slug>` from the current `next` HEAD.
   - Writes each affected node as `nodes/<stratum>/<safe-glm-id>.yaml` with a freshly computed `content_hash`.
   - Commits with the ECN message:
     ```
     ECN: <title>

     Affected: <glm_id>[, ...]
     Why: <why>
     Regen required: yes|no
     SCR: <scr-id>
     Signed-off-by: <your-name> <email>
     ```
   - Fast-forward merges the feature branch to `next`.
   - Deletes the feature branch.

### 5.2 Path B — Vibe-driven change

Use this path when you want the LLM to propose the change based on a natural-language description.

1. Click **Vibe** in the top navigation bar.

2. Type a prompt describing the desired outcome:
   > "The billing component needs to support multi-currency. Update the Billing Interaction to add a `currency_code` field on every transaction request and response."

3. GLM classifies your intent and either applies a canned script or calls the LLM. The LLM receives the current node bodies for the affected subtree plus their relationships.

4. The LLM returns a **change plan** — a list of proposed creations, modifications, and deletions shown as a diff in the right panel.

5. **Review each change.** You can:
   - **Accept all** — applies the entire plan.
   - **Accept individually** — check or uncheck each proposed change.
   - **Modify** — edit a proposed node body before accepting.
   - **Reject** — discard the plan entirely.

6. When you accept, GLM wraps the change plan in an SCR:
   - `scr.summary` = your original prompt.
   - `scr.target_nodes` = every glmId in the accepted plan.
   - `scr.proposed_changes_json` = the LLM's diff.

7. From here the workflow is identical to Path A (§5.1, step 4 onwards). Vibe never writes nodes directly — it always produces a reviewable SCR.

### 5.3 Completing the process — up to code generation

Once the SCR reaches **Implemented** (the ECN commit is on `next`):

1. **Trigger regeneration.** Navigate to the Spec node whose component needs updated code. Click **Regenerate**. If the spec changed, GLM uses a diff-aware prompt: it shows the LLM the prior spec, the new spec, the spec delta, and any human modifications that landed in `glm-realization/` since the last generation — so the LLM can update the code surgically rather than regenerating from scratch.

2. **Review the PR.** The generation pipeline opens a PR in `glm-realization/` from `gen/<timestamp>-<component>` → `main`. The PR description includes:
   - The sekkei node ID and spec content hash.
   - The structured spec diff (which fields changed).
   - A link to the provenance view in GLM.

3. **Acceptance check.** If the node has a `spec.acceptance.verifier.command`, the pipeline runs it against the generated artifact. The PR's CI status reflects the result. The SCR cannot advance to **Released** until the acceptance check passes.

4. **Merge the PR.** Once the CI check passes and the generated code looks correct, merge the PR in your git host. GLM records the realization commit SHA against the generation attestation and attaches the DSSE-signed in-toto envelope as a git note on the sekkei commit.

5. **Cut a release.** When `next` is ready to ship, create a release tag (see §3, Step 6). The SCR status advances to **Released** when its commit is reachable from the new tag.

---

## 6. Creating a Variant

A variant is a named deployment target that resolves the sekkei tree against a specific set of parameter bindings. Examples: `eu-prod` (GDPR-compliant, EU data residency), `staging` (test credentials, reduced resource limits), `acme-customer` (white-labeled build with customer-specific integrations).

### 6.1 Initiate the variant

1. Navigate to **Variants** in the sidebar.
2. Click **New variant**.
3. Fill in:
   - **Label:** e.g., `eu-prod`.
   - **Channel:** `stable`, `beta`, or `nightly`.
   - **Pin policy:** `pin-on-release` (nodes advance only when an operator explicitly approves) or `auto-advance` (nodes follow the release automatically).
   - **Parameter bindings:** key-value pairs that override parameters in the sekkei. For example, `data_region = eu-west-1`.

4. Click **Resolve.** GLM walks the `composes-of` and `derives-from` graph from the System node, substitutes your parameter bindings at each node, and produces a resolved closure — the full set of node IDs and their content hashes that this variant pins.

5. Click **Publish variant.** GLM:
   - Creates the branch `variants/<label>` in `glm-sekkei/` (or checks it out if it exists).
   - Writes `sekkei.lock` at the branch root — a sorted YAML list of `{id, major, content_hash}` tuples, one per resolved node.
   - Commits: `Resolve variant eu-prod @ <closure-hash-prefix>`.
   - Records `git_ref = refs/heads/variants/eu-prod` and `git_commit` on the variant row.

The `variants/<label>` branch is **long-lived**. Every subsequent publish creates a new commit on it.

### 6.2 Propagate changes from the variant to the parent (innovations)

When your variant team discovers something worth contributing back — a new algorithm, a corrected constraint, a better default — the path is:

1. **Backport via vibe.** Open the node whose improvement you want to upstream. Click **Vibe** → describe the change:
   > "The eu-prod variant uses a more efficient pagination algorithm for the catalog listing. Update the Catalog Component spec to make this the default."

2. GLM proposes an SCR against the parent `next` branch (not the variant branch). Review and approve as normal.

3. Once the SCR is implemented and on `next`, re-publish the variant (`variants/eu-prod`). GLM re-resolves the closure against the updated sekkei; `sekkei.lock` gains a new commit referencing the improved node.

**Why the variant branch is not the contribution mechanism:** the `variants/<name>` branch holds only `sekkei.lock`, not node bodies. Node bodies always live under `nodes/` on `next`/`main`. Improvements flow back by opening an SCR on `next` — the same path as any other change.

### 6.3 Propagate parent enhancements and bug fixes to the variant

When `next` advances (new ECNs, bug fixes), your variant can adopt those changes node by node via the **Rollout** dashboard.

#### The rollout state machine

When a release tag is cut (e.g., `A.1`), GLM seeds one `rollout_records` row for each node that changed between `A.0` and `A.1` for every enrolled variant:

```
pending → advanced   (operator explicitly approves after guard checks)
pending → blocked    (operator halts this node at the prior revision)
```

#### Step-by-step rollout

1. Go to **Effectivity** → select your variant → select the release tag.

2. For each **pending** node:
   - Review the diff between `from_rev` (the node's state in `A.0`) and `to_rev` (its state in `A.1`).
   - Verify the guard checks: upstream SCRs implemented? Drift on this node = none? Acceptance test passing?
   - Click **Advance** to move the node to `A.1`, or **Block** to pin it at `A.0`.

3. When a node is advanced:
   - `rollout_records.status` → `advanced`.
   - GLM re-resolves the variant closure for this node.
   - A new `sekkei.lock` commit is written on `variants/<label>`.
   - If the node has a Spec, GLM queues regeneration (using the diff-aware path where possible).

4. Blocked nodes stay at their prior revision. A **pin_rev** is recorded on the rollout record. The operator can unblock later by advancing again.

#### Handling a bug fix that must go out immediately

If a critical fix lands on `next` before the next planned release:

1. Cut an out-of-band release tag (e.g., `A.2` immediately after `A.1`).
2. Rollout dashboard shows the fix as a pending advance.
3. Advance only the affected node(s); leave everything else at `A.1`.

The immutable release tag is the safety net: you can always roll back by re-publishing the variant against the prior tag's sekkei.lock snapshot.

### 6.4 Managing branches effectively

#### One sekkei branch per team cadence

| Branch | Purpose | Who pushes |
|--------|---------|-----------|
| `next` | Integration; staging ground for the next release | GLM (auto, via SCR implement) |
| `main` | Released state; tag target | GLM (auto, via release cut) |
| `variants/<name>` | Pinned closure per deployment target | GLM (auto, via variant publish) |
| `feature/<scr-id>-<slug>` | Short-lived; deleted after merge | GLM (auto, via SCR implement) |

No human should push directly to `next` or `main`. The pre-receive hook enforces this.

#### When variant branches diverge

If a variant branch falls significantly behind `next` (many releases unadvanced), do a **bulk advance**:

1. Open the Rollout dashboard for the variant.
2. Select all pending nodes across all unadvanced releases.
3. Click **Advance all** — GLM advances each node and produces a single consolidated `sekkei.lock` commit on the variant branch.

Use **Block** judiciously — a blocked node at an old revision accumulates technical debt every time the parent node is updated on `next`.

#### Branch hygiene rules of thumb

- **One SCR → one feature branch → one ECN commit.** Never batch unrelated changes into a single SCR.
- **Release tags are immutable.** Never delete a release tag. If a release is bad, cut a new one.
- **Variant branches accumulate history.** Each variant publish appends a commit; `git log variants/eu-prod` is the rollout audit log for that deployment target.
- **Feature branches are disposable.** GLM deletes them automatically after the merge. If one lingers (e.g., a crashed implementation), delete it manually and re-implement the SCR.
- **Never rebase `next` or `main`.** If history needs cleaning, use `git revert` and open an SCR for the revert commit.

---

## 7. Reference: Roles and Permissions

| Role | Can do |
|------|--------|
| **admin** | All operations; attach/detach git remote; manage users |
| **contributor** | Create and edit nodes; submit SCRs; trigger regeneration; publish variants |
| **reviewer** | Review and approve/reject SCRs; view all |
| **guest** | Read-only access to the sekkei tree and dashboard |

Roles are per-workspace. A user can be a contributor in one workspace and a guest in another.

---

*For internal implementation details — migration steps, hook specification, forge integration — see `docs/git-implementation-plan.md` and `docs/glm-db-git-architecture.md`.*
