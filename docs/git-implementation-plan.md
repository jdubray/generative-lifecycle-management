# GLM — Git Integration Implementation Plan

**Companion to:** [`glm-db-git-architecture.md`](./glm-db-git-architecture.md)  
**Companion to:** [`glm-with-git.md`](./glm-with-git.md)  
**Companion to:** [`implementation_plan.md`](./implementation_plan.md) (main app plan; Phase 4 overlaps here)  
**Version:** 1.0  
**Date:** 2026-05-12  
**Status:** Draft

---

## Table of Contents

1. [Overview](#1-overview)
2. [Source-of-Truth Contract](#2-source-of-truth-contract)
3. [File Map](#3-file-map)
4. [Schema Migrations](#4-schema-migrations)
5. [Step-by-Step Activation Plan](#5-step-by-step-activation-plan)
   - [Git Step 1 — Workspace Attach](#git-step-1--workspace-attach)
   - [Git Step 2 — Read-Only Sync](#git-step-2--read-only-sync)
   - [Git Step 3 — SCR-Implement Write Path](#git-step-3--scr-implement-write-path)
   - [Git Step 4 — Variant Publish](#git-step-4--variant-publish)
   - [Git Step 5 — Generation Notes](#git-step-5--generation-notes)
   - [Git Step 6 — Drift Sweep](#git-step-6--drift-sweep)
   - [Git Step 7 — Diff-Aware Regeneration](#git-step-7--diff-aware-regeneration)
   - [Git Step 8 — Effectivity Tags](#git-step-8--effectivity-tags)
6. [Default Branch Structure](#6-default-branch-structure)
7. [Hook Specification](#7-hook-specification)
8. [Forge Integration (GitHub / GitLab)](#8-forge-integration-github--gitlab)
9. [Testing Strategy](#9-testing-strategy)
10. [Risks & Mitigations](#10-risks--mitigations)

---

## 1. Overview

v1 of GLM is DB-only: `getSekkeiGit` in `src/server/app.ts` returns `null`, and the git service code in `src/git/` exists with tests but is dormant. This plan activates git integration in eight independently shippable steps.

**The goal of the git integration is not to replace the DB** — the DB remains the working surface for real-time collaboration, drafts, and indexed queries. The goal is to ensure that every fact that must survive a DB wipe, be auditable by a human, or be shared between machines is persisted in git as a first-class artifact.

After all eight steps are complete:

- Every approved SCR produces a signed ECN commit on `glm-sekkei/`.
- Every variant resolution produces a `sekkei.lock` commit on its variant branch.
- Every generation event produces a DSSE-signed in-toto attestation attached as a git note.
- Drift detection reads authoritative diff data from `glm-realization/`, not from snapshots.
- Releases are immutable signed tags; rollout is a DB state machine that advances against those tags.
- The DB is fully rebuildable from a git ref plus the workflow tables.

### Architecture decisions (already resolved)

All architecture decisions are recorded in `implementation_plan.md §8`. Quick reference:

| # | Topic | Decision |
|---|-------|----------|
| 8.1 | Push policy | Per-workspace flag, default off; user-triggered push |
| 8.2 | Auth | External IdP (SAML/OIDC); roles: admin / contributor / reviewer / guest |
| 8.3 | Conflict resolution | `git pull --ff-only`; divergence → workspace banner + Conflict Resolution UI |
| 8.4 | PR vs direct commit | PR if `git_forge` set; direct to `next` otherwise |
| 8.5 | Realization binding | 1:1, `<sekkei-name>-realization`; per-Component override available |
| 8.6 | Cache durability | `data/cache/` local for v1; S3 backend via `GenerationCache` interface in Phase 2 |
| 8.7 | Self-import dogfood | `git_remote = file://./../glm-sekkei` on the self-import workspace |
| 8.8 | Spec-diff format | Structured `{field, op, old?, new?}[]` primary; YAML unified diff as fallback |

---

## 2. Source-of-Truth Contract

The single rule that resolves all ambiguity:

> **Git owns everything that must survive a DB wipe, be shared between machines, or be audited by a human. The DB owns everything that describes how humans are currently working on the sekkei.**

| Fact class | Owner | Notes |
|-----------|-------|-------|
| Committed sekkei node body + relationships | Git | `nodes/<stratum>/<glm_id>.yaml` |
| `sekkei.lock` (pinned variant closure) | Git | One per `variants/<operator>` branch |
| Releases | Git | Signed annotated tags (`A.0`, `A.1`, …) |
| Variant branches | Git | `variants/<operator>` — long-lived |
| ECN commit messages | Git | Built from SCR by `src/git/ecn-commit.ts` |
| In-toto attestations | Git | `refs/notes/generation` |
| Realization code | Git (other repo) | `glm-realization/`; never committed back |
| Catalog (Standard Parts) | Git (other repo) | `glm-catalog/`; pulled via `git subtree` |
| In-progress drafts, locks, heartbeats | DB | Lost-on-restart is acceptable |
| SCR FSM state | DB | Approved SCR → single ECN commit on merge |
| Real-time collaboration | DB / memory | Ephemeral |
| Where-used index | DB | Materialized; rebuildable from git |
| Drift workflow (assigned-to, decision) | DB | The fact of drift comes from `git diff` |
| Generation cache bytes | Filesystem | `data/cache/`; not in git |
| User accounts, sessions, roles | DB | Out of sekkei scope; never committed |

---

## 3. File Map

All git-related logic is isolated to `src/git/`. Nothing outside this directory may shell out to `git` or read from `data/repos/`.

```
src/git/
  git-client.ts          Typed wrapper: add, commit, tag, push, pull, notes,
                           rev-parse, grep, log, diff, worktree commands.
                           All calls go through withWorkspaceLock().

  yaml-store.ts          Node ↔ YAML file mapping.
                           nodes/<stratum>/<safe-glm-id>.yaml
                           Serialize / deserialize canonical YAML (sorted keys, LF).

  ecn-commit.ts          Builds the conventional ECN commit message from an SCR:
                           ECN: <title>
                           Affected: <glm_id>[, ...]
                           Why: <scr.why>
                           Regen required: yes|no
                           SCR: <scr.id>
                           Signed-off-by: <user> <email>

  sekkei-lock.ts         Serialize / parse sekkei.lock.
                           Format: sorted YAML list of {id, major, content_hash}.

  git-notes.ts           Attach / read in-toto DSSE envelopes at refs/notes/generation.

  hook-installer.ts      Copies pre-commit and pre-receive hooks into a target repo's
                           .git/hooks/. Idempotent.

  sekkei-git-service.ts  Orchestration layer. Holds withWorkspaceLock(), exposes:
                           attachRemote(), syncFromRemote(), commitScrImplementation(),
                           publishVariant(), pushToOrigin().

  forge/
    github.ts            GitHub REST API: create PR, set status check, merge PR.
    gitlab.ts            GitLab REST API: create MR, set pipeline status, merge MR.
    index.ts             Factory: returns the right forge client from workspace.git_forge.

src/generation/
  spec-diff.ts           Computes structured diff + YAML unified diff from two node body
                           objects. Used by the diff-aware regeneration prompt builder.
```

The `src/git/sekkei-git-service.ts` file already exists in v1 with `getSekkeiGit` returning null. Steps 1–8 progressively wire it up.

---

## 4. Schema Migrations

All schema changes are additive (new columns, new table). Each git step that needs a schema change ships its own migration file in `migrations/`.

### Migration 0002 — Workspace attach columns (Git Step 1)

```sql
ALTER TABLE workspaces ADD COLUMN git_remote    TEXT;
ALTER TABLE workspaces ADD COLUMN git_ref       TEXT;     -- e.g. refs/heads/next
ALTER TABLE workspaces ADD COLUMN git_commit    TEXT;     -- last imported / synced SHA
ALTER TABLE workspaces ADD COLUMN git_clone_dir TEXT;     -- data/repos/<workspace-id>/
ALTER TABLE workspaces ADD COLUMN git_forge     TEXT CHECK (git_forge IN ('github','gitlab'));
ALTER TABLE workspaces ADD COLUMN git_auto_push INTEGER NOT NULL DEFAULT 0;
```

### Migration 0003 — SCR git columns (Git Step 3)

```sql
ALTER TABLE scrs ADD COLUMN git_commit  TEXT;   -- ECN commit SHA on implement
ALTER TABLE scrs ADD COLUMN git_branch  TEXT;   -- feature/<scr-id>
ALTER TABLE scrs ADD COLUMN git_pr_url  TEXT;   -- forge PR/MR URL if applicable
```

### Migration 0004 — Variant git columns (Git Step 4)

```sql
ALTER TABLE variants ADD COLUMN git_ref          TEXT;   -- variants/<name>
ALTER TABLE variants ADD COLUMN git_commit       TEXT;
ALTER TABLE variants ADD COLUMN closure_hash     TEXT;   -- sha256 over sorted (id,content_hash)
ALTER TABLE variants ADD COLUMN sekkei_lock_path TEXT;   -- always sekkei.lock
```

### Migration 0005 — Drift and rollout git columns (Git Step 6)

```sql
ALTER TABLE drift_records ADD COLUMN realization_commit TEXT;
ALTER TABLE drift_records ADD COLUMN spec_commit        TEXT;
ALTER TABLE drift_records ADD COLUMN classification     TEXT
    CHECK (classification IN ('format','spec_implied','human_improvement','hot_patch'));
ALTER TABLE drift_records ADD COLUMN auto_resolvable    INTEGER NOT NULL DEFAULT 0;

CREATE TABLE rollout_records (
  id          TEXT PRIMARY KEY,
  variant_id  TEXT NOT NULL REFERENCES variants(id) ON DELETE CASCADE,
  node_id     TEXT NOT NULL REFERENCES nodes(id),
  from_rev    TEXT,
  to_rev      TEXT,
  status      TEXT CHECK (status IN ('pending','advanced','blocked')) NOT NULL DEFAULT 'pending',
  pin_rev     TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX idx_rollout_variant ON rollout_records(variant_id);
CREATE INDEX idx_rollout_node    ON rollout_records(node_id);
```

### Migration 0006 — Attestation git columns (Git Step 5)

```sql
ALTER TABLE generation_attestations ADD COLUMN realization_commit TEXT;
ALTER TABLE generation_attestations ADD COLUMN git_note_ref       TEXT;
```

### Migration 0007 — Generation inputs table (Git Step 7)

```sql
CREATE TABLE generation_inputs (
  attestation_id    TEXT PRIMARY KEY REFERENCES generation_attestations(id) ON DELETE CASCADE,
  spec_node_id      TEXT NOT NULL REFERENCES nodes(id),
  spec_content_hash TEXT NOT NULL,
  prompt_hash       TEXT NOT NULL,
  prompt_text       TEXT,
  spec_diff_json    TEXT,    -- structured diff JSON; null for full-generation runs
  spec_diff_yaml    TEXT,    -- YAML unified diff; null for full-generation runs
  artifact_path     TEXT NOT NULL,
  artifact_hash     TEXT NOT NULL,
  produced_at       TEXT NOT NULL
);
CREATE INDEX idx_gen_inputs_spec ON generation_inputs(spec_node_id, produced_at DESC);
```

---

## 5. Step-by-Step Activation Plan

The eight steps below correspond directly to the migration path in `glm-db-git-architecture.md §7`. Each step is independently shippable; steps 1–2 are fully reversible (workspace detach returns to DB-only). Steps 3 onwards write commits that survive detachment.

---

### Git Step 1 — Workspace Attach

**Goal:** A workspace can be bound to a git remote. GLM clones the remote, records the binding, and `getSekkeiGit` returns a live client.

**Pre-condition:** Migration 0002 applied.

**Deliverables:**

- `src/git/git-client.ts` — minimal implementation: `clone`, `rev-parse HEAD`, `log --oneline -5`.
- `src/git/sekkei-git-service.ts::attachRemote(workspaceId, gitRemote, gitRef)`:
  1. Run `git clone --no-checkout <gitRemote> data/repos/<workspaceId>/`.
  2. `git checkout <gitRef>`.
  3. Record `git_remote`, `git_ref`, `git_commit = HEAD`, `git_clone_dir` on the workspace row.
  4. Wire `getSekkeiGit` to return the new client when `git_remote` is non-null.
- REST endpoint: `POST /api/v1/workspaces/:id/git-remote` — body `{gitRemote, gitRef}`.
- REST endpoint: `DELETE /api/v1/workspaces/:id/git-remote` — detaches (nulls the columns; leaves clone directory in place for safety; a separate cleanup job can remove it).
- Self-import dogfood: `scripts/seed.ts` sets `git_remote = file://${process.cwd()}/../glm-sekkei` on the default workspace (see §8.7 decision).

**Done when:** A workspace row has a non-null `git_remote`; `GET /api/v1/workspaces/:id` returns `{"gitAttached": true, "gitCommit": "<sha>"}`.

**Reversibility:** Detach endpoint nulls all `git_*` columns. The workspace reverts to DB-only mode. Local clone survives for manual inspection.

---

### Git Step 2 — Read-Only Sync

**Goal:** GLM can pull new commits from the remote into the local clone and reconcile the DB against the repo state.

**Pre-condition:** Git Step 1 complete.

**Deliverables:**

- `src/git/git-client.ts` — add: `pull --ff-only`, `log --name-only <from>..<to>`, `show <ref>:<path>`.
- `src/git/sekkei-git-service.ts::syncFromRemote(workspaceId)`:
  1. Run `git pull --ff-only`.
  2. On success: compute the diff between `workspace.git_commit` and the new HEAD.
  3. For each changed YAML file, parse the node and upsert into the DB via `src/repository/node-repository.ts`.
  4. Insert a `change_log` row for each imported node (`op = 'imported', actor = 'git-sync'`).
  5. Update `workspace.git_commit = new HEAD`.
  6. On non-fast-forward failure: insert a `workspace_conflicts` row with `status = 'diverged'`; emit `conflict.detected` on the event bus.
- REST endpoint: `POST /api/v1/workspaces/:id/git-sync` — triggers a pull + reconcile.
- Startup reconciliation: on server start, for each workspace with `git_remote != null`, run a lightweight check: does `workspace.git_commit == git rev-parse HEAD`? If not, queue a sync.
- `workspace_conflicts` table (part of migration 0002):

```sql
CREATE TABLE workspace_conflicts (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  local_commit TEXT NOT NULL,
  remote_commit TEXT NOT NULL,
  status       TEXT CHECK (status IN ('open','resolved')) NOT NULL DEFAULT 'open',
  created_at   TEXT NOT NULL
);
```

**Done when:** A `git push` to the remote followed by `POST /git-sync` updates the DB nodes; `git log` and `change_log` agree on the node revision.

---

### Git Step 3 — SCR-Implement Write Path

**Goal:** When an SCR transitions to `Implemented`, GLM writes an ECN commit on a `feature/<scr-id>` branch. The commit is optionally pushed and optionally promoted via a forge PR.

**Pre-condition:** Git Steps 1–2 complete; Migration 0003 applied.

**Deliverables:**

- `src/git/ecn-commit.ts` — complete implementation of ECN message builder.
- `src/git/yaml-store.ts` — complete implementation: `nodeToYaml(node) → string`, `yamlToNode(str) → Node`, `nodeFilePath(node) → string`.
- `src/git/sekkei-git-service.ts::commitScrImplementation(scrId)`:
  1. Acquire `withWorkspaceLock`.
  2. `git checkout -b feature/<scrId>` from the current integration branch (`workspace.git_ref`).
  3. For each node in `scr.target_nodes`: serialize to canonical YAML; write to `nodes/<stratum>/<glm_id>.yaml`; `git add`.
  4. `git commit -m "<ECN message>" --signoff`.
  5. Update `scrs.git_commit = <sha>`, `scrs.git_branch = feature/<scrId>`.
  6. If `workspace.git_forge` is non-null: call `forge.createPR(...)` and record `scrs.git_pr_url`.
  7. Else if `workspace.git_auto_push`: `git push origin feature/<scrId>`.
  8. Merge feature branch into the integration branch (`git merge --ff-only`); delete the feature branch.
  9. Release `withWorkspaceLock`.
- `src/git/hook-installer.ts` — installs `pre-commit` hook that runs `bun run verify --fast` (schema-only gate; blocks malformed YAML).
- Integration test: spin up a tmp bare repo; run a full SCR cycle (Draft → Implemented); assert:
  - `git log --grep="SCR-<id>"` finds exactly one commit.
  - Commit message contains all required ECN fields.
  - YAML file at `nodes/<stratum>/<glm_id>.yaml` matches the DB row's canonical body.

**Done when:** Full SCR cycle (Draft → Implemented) produces a single ECN commit; `git log --oneline` shows it; DB row has `git_commit` set.

---

### Git Step 4 — Variant Publish

**Goal:** When a user publishes a resolved variant, GLM writes `sekkei.lock` on a `variants/<name>` branch.

**Pre-condition:** Git Steps 1–3 complete; Migration 0004 applied.

**Deliverables:**

- `src/git/sekkei-lock.ts` — complete: `toLock(resolvedNodes) → string` (canonical YAML), `fromLock(str) → ResolvedNode[]`.
- `src/git/sekkei-git-service.ts::publishVariant(variantId)`:
  1. Acquire `withWorkspaceLock`.
  2. `git worktree add ../worktrees/<variantId> -b variants/<name>` (or checkout if the branch exists).
  3. Serialize `sekkei.lock` from `variant.resolved_nodes`.
  4. Write `sekkei.lock` at the worktree root; `git add sekkei.lock`.
  5. `git commit -m "Resolve variant <name> @ <closure_hash>"`.
  6. Update `variants.git_ref`, `variants.git_commit`, `variants.closure_hash`.
  7. `git worktree remove ../worktrees/<variantId>`.
  8. Release lock.
- Integration test: create a variant with three nodes; publish; assert `sekkei.lock` on the variant branch contains exactly those nodes with their content hashes.

**Done when:** `git log variants/<name>` shows the lock commit; `sekkei.lock` is parseable and matches the DB closure.

---

### Git Step 5 — Generation Notes

**Goal:** After a generation artifact lands in `glm-realization/`, GLM attaches the DSSE-signed in-toto attestation to the corresponding sekkei commit as a git note under `refs/notes/generation`.

**Pre-condition:** Git Steps 1–4 complete; Generation Pipeline (main plan Phase 5) complete; Migration 0006 applied.

**Deliverables:**

- `src/git/git-notes.ts` — `attachNote(commit, payloadJson) → void`, `readNote(commit) → string | null`. Uses `git notes --ref refs/notes/generation add -m`.
- Wire `src/generation/pipeline.ts`: after the in-toto attestation is built and the realization commit is known, call `gitNotes.attachNote(scr.git_commit, attestation.envelope)`.
- Update `generation_attestations.git_note_ref = "refs/notes/generation"` and `realization_commit = <sha>` after attach.
- `REGENERATED_FROM` file: alongside each generated artifact in `glm-realization/`, write a small YAML file containing `sekkei_commit`, `sekkei_lock_hash`, and `generated_at`. This is the per-artifact provenance file (see §6.3 of the architecture doc).
- Realization commit trailer: the commit message in `glm-realization/` must include `Generated-From: <sekkei-commit>` as a git trailer.

**Done when:** `git notes --ref refs/notes/generation show <sekkei-commit>` prints the DSSE envelope; the attestation row in the DB has `git_note_ref` and `realization_commit` set.

---

### Git Step 6 — Drift Sweep

**Goal:** Switch the drift detector from comparing against in-memory snapshots to comparing against the live `glm-realization/` repo using `git diff`.

**Pre-condition:** Git Steps 1–5 complete; Migration 0005 applied.

**Deliverables:**

- `src/git/git-client.ts` — add: `diff <sha1> <sha2> -- <path>`, `hash-object <file>`.
- `src/domain/drift.ts` (updated, no API change — only the data source changes):
  - Replace snapshot-hash comparison with: read `node.body.realization_file_hash` from DB; run `git hash-object <realization_path>` in the realization clone; compare.
  - On mismatch, run `git diff` to classify the drift type (`format`, `spec_implied`, `human_improvement`, `hot_patch`).
- `src/git/sekkei-git-service.ts::runDriftSweep(workspaceId)`:
  1. For each Component node with a `realization_repo_path`:
     - Compute `actual_hash` from the realization clone.
     - If `actual_hash != expected_hash`: classify the diff; upsert `drift_records`.
     - Record `spec_commit = workspace.git_commit`, `realization_commit = <realization HEAD>`.
  2. Auto-close any `drift_records` where `actual_hash` now matches (re-synced or regenerated).
- REST endpoint: `POST /api/v1/workspaces/:id/drift-sweep` — on-demand trigger.
- CI cron: add a workflow step that calls the sweep endpoint on a schedule.

**Done when:** A deliberate edit to a file in `glm-realization/` is detected as drift by the sweep; the `drift_records` row has the correct `classification` and both commit hashes populated.

---

### Git Step 7 — Diff-Aware Regeneration

**Goal:** When the spec for a Component changes, the generation pipeline reconstructs the new artifact by showing the LLM the spec delta rather than a blank slate — preserving operator hot-patches where compatible.

**Pre-condition:** Git Steps 1–6 complete; Migration 0007 applied.

**Deliverables:**

- `src/generation/spec-diff.ts`:
  - `computeStructuredDiff(prevBody, nextBody) → SpecDiff[]` where `SpecDiff = { field: string, op: 'added'|'removed'|'changed', old?: unknown, new?: unknown }`.
  - `computeYamlDiff(prevBody, nextBody) → string` — YAML unified diff as human-readable fallback.
- Update `src/generation/pipeline.ts::run(specNodeId, binding, generatorId)`:
  1. Look up the most recent `generation_inputs` row for `specNodeId` whose artifact is still in the realization repo.
  2. If found: compute `spec_diff` between `prev.spec_content_hash` and `current content_hash`.
  3. Read `realization_drift` via `git diff <prev_artifact_hash> HEAD -- <artifact_path>`.
  4. Build a **diff-aware prompt** (see §4.4.2 of the architecture doc).
  5. Cache key gains a fourth component: `sha256(prev_artifact_hash)` — keyed on the transition, not just the destination.
  6. On cache miss: invoke LLM with the diff-aware prompt; on cache hit: reuse.
  7. Write `generation_inputs` row with `spec_diff_json` and `spec_diff_yaml`.
- Integration test: run a generation, mutate one spec field, regenerate — assert the LLM prompt contains the structured diff and the previous artifact hash.

**Done when:** `generation_inputs` rows record structured diffs; a generation after a single field edit produces a prompt that references only the changed field.

---

### Git Step 8 — Effectivity Tags

**Goal:** Releases are immutable signed tags. The rollout state machine tracks node-by-node progress from the prior release to the new one. The pre-receive hook blocks force-pushes and direct commits to `main`.

**Pre-condition:** Git Steps 1–7 complete; `rollout_records` table from Migration 0005 applied.

**Deliverables:**

- `src/git/git-client.ts` — add: `tag -s -a <name> -m <msg>`, `describe --tags`, `log <from>..<to> --name-only`.
- REST endpoint: `POST /api/v1/workspaces/:id/releases` — body `{name: "A.1", message: "..."}`:
  1. Validates `name` matches `/^[A-Z]\.\d+$/`.
  2. Runs `git tag -s -a <name> -m <message>` on the current `next` HEAD.
  3. Optionally pushes the tag if `git_auto_push` is on or user confirms.
  4. For each variant: walks `variant.resolved_nodes`; for each node with a newer revision in the new tag vs. the prior tag, inserts a `rollout_records` row (`status = pending`, `from_rev`, `to_rev`).
- REST endpoint: `POST /api/v1/workspaces/:id/rollout-records/:id/advance` — moves a node through the rollout state machine after guard checks.
- `src/git/hook-installer.ts` — `pre-receive` hook enforced rules (full spec in §7 below).
- Integration test: tag `A.1`; assert `git tag -v A.1` passes; assert `rollout_records` rows created for changed nodes.

**Done when:** `git tag -v A.1` verifies the signature; rollout dashboard in the UI shows pending advances; force-push to `main` is rejected by the hook.

---

## 6. Default Branch Structure

*See also: `implementation_plan.md §9` for the full branch structure specification.*

This section records the concrete git configuration that the `scripts/init-workspace.ts` script applies when a user attaches a new remote.

### 6.1 Branch layout

```
glm-sekkei/
  main                         ← released trunk; signed tagged commits only
  next                         ← integration; all approved ECNs land here
  feature/<scr-id>-<slug>      ← per-SCR; created on Implement, deleted after merge
  variants/<operator>          ← long-lived; holds sekkei.lock per deployment target
  A.0, A.1, B.0, …            ← signed annotated release tags

glm-realization/
  main                         ← stable generated artifacts
  gen/<timestamp>-<component>  ← transient; each generation opens a PR here

glm-catalog/
  main                         ← single protected branch
  v1.0.0, v1.1.0, …           ← semver tags
```

### 6.2 Branch protection config (GitHub / GitLab)

GLM generates a `.github/branch-protection.yml` (or equivalent) at workspace attach time:

- `main`: require signed commits; no direct push; require PR; require status checks; no force-push; no deletion.
- `next`: no force-push; no deletion; status checks optional (configurable).
- `variants/*`: no force-push; no deletion.

### 6.3 Team-of-1 shortcut

When `workspace.git_forge = null`, the feature branch lifecycle is automatic: GLM creates `feature/<scr-id>-<slug>`, commits the ECN, fast-forward merges to `next`, and deletes the feature branch — all in one atomic `withWorkspaceLock` block. No PR is opened.

---

## 7. Hook Specification

GLM installs two hooks via `src/git/hook-installer.ts`. Hooks are committed to `scripts/hooks/` in the repo so they can be reviewed.

### 7.1 `pre-commit` (local; installed in developer clone)

Runs `bun run verify --fast` (schema-only gates):

1. All YAML files under `nodes/` are parseable.
2. Each node file has the required envelope fields (`id`, `stratum`, `title`, `version`, `content_hash`).
3. No node file's `content_hash` field was hand-edited to a value that doesn't match `sha256(canonicalize(body))`.

On failure: print the offending file path and the hash mismatch; abort commit.

### 7.2 `pre-receive` (server; installed in the origin bare repo)

Enforced rules:

| Rule | Applies to | Action on violation |
|------|-----------|-------------------|
| No direct push to `main` | `refs/heads/main` | Reject with `ERR: main is release-only; use next and release tags` |
| No force-push | All branches | Reject with `ERR: force-push not permitted` |
| Release tags must be signed | `refs/tags/A.*` and `refs/tags/[A-Z].*` | Reject unsigned or lightweight tags |
| ECN format on `next` and `main` | Commits on `refs/heads/next`, `refs/heads/main` | Reject if commit message does not start with `ECN:` or a valid merge commit prefix |
| `sekkei.lock` must be present | `refs/heads/variants/*` | Reject if the push would leave the branch without a `sekkei.lock` at root |

---

## 8. Forge Integration (GitHub / GitLab)

When `workspace.git_forge` is set, Git Steps 3 and 4 interact with the forge API.

### 8.1 SCR → PR lifecycle

1. On SCR transition to `Implemented`: `forge.createPR({head: "feature/<scr-id>", base: "next", title: scr.title, body: ecnMessage})`.
2. Store `scrs.git_pr_url`.
3. The PR's CI pipeline runs the verifier. On pass, the PR is mergeable. On fail, the SCR stays at `Implemented` with a `verification_failed` note; it cannot advance to `Released`.
4. On PR merge: `forge` webhook fires `pull_request.closed` → GLM records `scrs.git_commit` from the merge commit SHA and advances SCR to `Released`.

### 8.2 Generation → realization PR lifecycle

1. After an artifact is generated and the `REGENERATED_FROM` file written, GLM opens a PR in `glm-realization/` from `gen/<timestamp>-<component>` → `main`.
2. PR description includes: sekkei node ID, spec content hash, generation timestamp, link to the provenance view.
3. On merge: GLM updates `generation_attestations.realization_commit` and attaches the git note.

### 8.3 Credentials

PAT (Personal Access Token) per workspace, stored encrypted at rest via `src/auth/token-store.ts` using AES-256-GCM with the workspace's derived key. The user provides the PAT once at workspace-attach time; GLM never logs or returns it.

---

## 9. Testing Strategy

Every git step ships with tests in `tests/integration/git/`. The test harness uses a `tmpGitRepo()` fixture that creates a bare origin + a working clone in a temp directory and cleans up after each test.

| Step | Test file | What it asserts |
|------|-----------|----------------|
| Step 1 | `workspace-attach.test.ts` | Clone created; `git_commit` recorded; `getSekkeiGit` returns non-null |
| Step 2 | `read-sync.test.ts` | Push a commit to bare origin; sync; assert DB node updated |
| Step 2 | `conflict-detection.test.ts` | Force-diverge the local clone; sync; assert `workspace_conflicts` row created |
| Step 3 | `scr-commit.test.ts` | Full SCR cycle; assert ECN commit; assert all ECN fields in message |
| Step 3 | `scr-commit.test.ts` | Hand-craft an invalid YAML body; assert pre-commit hook rejects |
| Step 4 | `variant-publish.test.ts` | Publish a 3-node variant; assert `sekkei.lock` on variant branch |
| Step 5 | `generation-notes.test.ts` | Mock generation; attach note; read back note; assert DSSE envelope |
| Step 6 | `drift-sweep.test.ts` | Mutate a file in the realization clone; sweep; assert `drift_records` row with correct classification |
| Step 7 | `spec-diff.test.ts` | Compute structured diff; assert field-level granularity |
| Step 7 | `diff-regen.test.ts` | Run generation twice with a one-field spec change; assert prompt contains structured diff |
| Step 8 | `release-tag.test.ts` | Tag `A.1`; assert signed; assert `rollout_records` rows |
| Step 8 | `pre-receive.test.ts` | Attempt direct push to `main`; assert rejection message |

**Acceptance:** All integration tests must pass on every PR to `next`. The test suite may not use real git remotes (no network); all origins are `file://` paths in the temp directory.

---

## 10. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| `withWorkspaceLock` becomes a bottleneck under heavy SCR throughput | Low | Medium | Steps 3–4 are fast (< 500ms per commit under normal load). Measure in integration tests; add a queue if contention appears. |
| Realization-repo PR rebases break `Generated-From` trailer | Medium | Low | Both the `REGENERATED_FROM` file (per-artifact) and the commit trailer (per-commit) carry the pairing; losing one is recoverable from the other. |
| Pre-receive hook breaks existing operator workflows | Medium | High | Deliver hooks as opt-in at workspace-attach time. Document which rules can be softened (ECN format check is configurable; no-force-push is not). |
| `git pull --ff-only` surfaces conflicts that teams don't know how to resolve | Medium | Medium | Conflict Resolution UI (main plan Phase 7) must ship before Step 2 goes to production teams. |
| Forge API rate limits on high-SCR-volume days | Low | Low | Forge calls are async; failures are surfaced as a workspace warning, not a blocking error. |
| Diff-aware prompt balloons context window when `realization_drift` is large | Low | High | Truncate `realization_drift` at 8k tokens; fall back to full-generation prompt when truncation would lose semantic context. |
| Signed tags require GPG key management | Medium | Medium | Ship with unsigned tags for dev/staging; require signed tags only on `main` in production. Document key rotation procedure in ADR. |
