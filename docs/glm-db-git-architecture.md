# GLM ↔ Git ↔ DB — Functional & Technical Specification

**Status:** Draft for review · **Companion doc:** [glm-with-git.md](./glm-with-git.md)

`glm-with-git.md` lays out the *conceptual* mapping from PLM processes to git primitives. This document is the *architectural* counterpart: which store owns which fact, how data flows between them, and what each of the seven PLM-derived processes looks like end-to-end when both stores are involved.

Today (v1) GLM runs DB-only — `getSekkeiGit` defaults to `() => null` in `src/server/app.ts:46` and the git module under `src/git/` is wired but dormant. This spec defines the **target** state and the **migration path**.

---

## 1. Goals and non-goals

### Goals
- A clear, single-sentence rule for "who owns this fact?" — DB or Git.
- Per-process flow specs for the seven processes (change management, variant resolution, drift, where-used, provenance, effectivity & rollout, reuse).
- A specification for **diff-aware regeneration** so that a 1-spec edit doesn't force a full subtree re-generation.
- A migration path from v1's DB-only reality.

### Non-goals
- The realization repository's branching strategy (covered by team conventions; we only specify GLM's contract with it).
- Replacing the seven processes with a CRDT or external workflow engine.
- Choosing a specific git hosting provider — design assumes plain git remotes; GitHub/GitLab are usable but not required.

---

## 2. Source-of-truth model

> **Rule:** Git is the source of truth for everything *persisted across sessions and reviewable as text*. The DB is the working store for *interactive state, indices, and not-yet-committed drafts*. Every fact that affects another user, another machine, or a future audit must round-trip through git.

This single rule resolves the ambiguity the user surfaced. Specifically:

| Fact class                                    | Owner | Notes                                                                                              |
|-----------------------------------------------|-------|----------------------------------------------------------------------------------------------------|
| Committed sekkei node body + relationships    | Git   | YAML files under `glm-sekkei/nodes/...`. DB rehydrates from git on import or fast-forward sync.   |
| `sekkei.lock` (pinned closure)                | Git   | One per variant branch.                                                                            |
| Releases (tags `A.0`, `A.1`, …)               | Git   | Signed annotated tags, immutable on origin.                                                        |
| Variants                                      | Git   | Long-lived branches `variants/<operator>`.                                                         |
| ECN commit messages (Affected/Why/Regen)      | Git   | Built from the SCR by `src/git/ecn-commit.ts`.                                                     |
| In-toto attestations on generated artifacts   | Git   | Git notes under `refs/notes/generation`.                                                           |
| Realization code                              | Git (other repo) | `glm-realization/`, never committed back into the sekkei repo.                          |
| Catalog (shared components)                   | Git (other repo) | `glm-catalog/`, pulled in via `git subtree`.                                            |
| In-progress edits (drafts, locks, heartbeats) | DB    | Lost-on-restart is acceptable.                                                                     |
| SCR FSM state (Draft → Submitted → …)         | DB    | Persisted; the *final* approved SCR produces a single ECN commit on merge.                         |
| Real-time collaboration (presence, WS events) | DB / memory | Ephemeral, not committed.                                                                     |
| Where-used pre-built index                    | DB    | Materialized view over committed sekkei graph; rebuildable from git.                               |
| Drift records (open / resolved)               | DB    | The *facts* (a path drifted) come from git diff; the *workflow* (assigned to, decision, rationale) is DB. |
| Generation cache                              | Both  | DB stores metadata + cache-key. Bytes live in a content-addressed object store (LFS, S3, or fs).   |
| User accounts, sessions, API tokens, roles    | DB    | Not part of the sekkei; never committed.                                                           |
| Audit log                                     | DB    | Every DB mutation is logged. Git's commit history is a *parallel* audit log for committed state.   |

A reader should be able to look at any GLM screen and answer in one sentence: "if I git-push this workspace right now, what does git see?" The answer is the union of all rows marked *Git* in the table above; the rest stays in the DB.

### The DB's three jobs

1. **Stage-and-review buffer.** Edits land in the DB first. They're visible to other users in real-time, but they're not in git until an SCR is approved and merged.
2. **Index.** Composes-of / depends-on / where-used / impact queries run in milliseconds against a SQLite graph that would take seconds to recompute from YAML.
3. **Workflow state.** SCR FSM, lock heartbeats, rollout per-variant progress, drift triage assignments — all things that *describe how humans are working* on the sekkei rather than the sekkei itself.

### Hydration

The DB is always a derived view of one git ref + a pending-changes overlay:

```
DB workspace state = (git ref @ <commit>)
                   ⊕ (uncommitted SCRs in Draft/Submitted/Under Review/Approved)
                   ⊕ (workflow state: locks, drift records, rollout, …)
```

`POST /api/v1/workspaces/import` already implements the first term. The second and third are present today but only the first will need a new "sync from git" code path when we wire git up.

---

## 3. Per-process responsibility matrix

| Process                          | Trigger                          | DB role                                                                 | Git role                                                                 | Boundary                                                            |
|----------------------------------|----------------------------------|-------------------------------------------------------------------------|--------------------------------------------------------------------------|---------------------------------------------------------------------|
| **Change Management** (SCR)      | User edits a spec or vibe-changes | Stages edits as node drafts; FSM tracks Draft → Submitted → Approved   | Approved SCR → single ECN commit on `feature/<scr-id>`; PR into `next`   | DB write is reversible; git commit is permanent.                    |
| **Variant Resolution**           | New operator / parameter change   | Computes the resolved closure; UI walks composes-of + derives-from     | The result is written as `sekkei.lock` on the variant branch             | DB does the math; git stores the answer.                            |
| **Drift Reconciliation**         | CI job or manual sweep            | Stores one `drift_record` row per drifting file with workflow state    | The *truth* about drift comes from `git diff` between sekkei and realization | DB tracks the inbox; git answers "is it still drifted?"             |
| **Where-Used**                   | User clicks "where used" on a node | Pre-built index over composes-of/depends-on/derives-from; sub-100ms response | Authoritative answer comes from `git grep` + walking branches' `sekkei.lock` | DB is the fast path; git is the long-term audit.                    |
| **Provenance & Audit**           | Each generation, each mutation    | Writes `provenance_events` + `generation_attestations` rows on every action | Attestation envelopes for *committed* generations get attached as git notes | DB has every event; git has the cryptographically-anchored subset.  |
| **Effectivity & Rollout**        | Release cut, variant promote      | Per-variant rollout state per node (current rev, target rev, gate status) | Releases are signed tags; variants pull releases via merge/rebase        | DB orchestrates the rollout; git tags are the immutable facts.      |
| **Reuse**                        | Reuse candidate found / promoted  | Workflow state (candidate → vetted → promoted; assigned steward)       | Promoted components move to `glm-catalog/`, consumed via `git subtree`   | DB drives the promotion process; git carries the result.            |

---

## 4. End-to-end flows

### 4.1 Importing a sekkei (current behavior, plus git source)

Today: `POST /workspaces/import` accepts inline YAML docs. Target: also accept a git remote URL + ref.

```
Client                  GLM API                       DB                    Git (local clone)
  |--POST /workspaces/import {gitUrl, ref}---->|                                  |
  |                       |--clone --bare gitUrl-->                              |
  |                       |<--commit info, tree-----------------------|         |
  |                       |--walk YAML docs------------->|                       |
  |                       |--insert nodes+rels---------->|                       |
  |                       |--record source.commit = abc123--->|                  |
  |<--201, {workspaceId, summary, sourceCommit}|         |                       |
```

The workspace gets two new columns: `git_remote` (URL) and `git_commit` (last imported SHA). All subsequent git-side reads (where-used by grep, sekkei.lock writes, attestations) use the workspace's local clone at `data/repos/<workspace-id>/`.

### 4.2 Direct spec edit (DB-first, eventually-git)

This is the "I clicked into a spec and changed a field" flow. There are two committable units involved:

- **The DB write** — instant, real-time, reversible, visible to all collaborators.
- **The git commit** — happens once, when an SCR wrapping this edit is approved.

```
User edits spec in browser
   │
   ▼
PUT /api/v1/workspaces/:id/nodes/:glmId
   │  (requires the user to hold the lock)
   ▼
DB:  nodes row UPDATE
     change_log row INSERT (op=update, before_hash, after_hash)
     audit_events row INSERT
     EventBus.publish(node.changed)  ──── WS ────►  other browsers refresh
   │
   ▼
The edit is in the DB but NOT in git.

  ───────────────────────────────────────
  Later, the user submits this edit as part of a Sekkei Change Request:

User clicks "Submit SCR" with title/why/affected
   │
   ▼
POST /api/v1/workspaces/:id/scrs  {title, why, affected: [glmId, …]}
   │
   ▼
DB:  scrs row INSERT (status=submitted)
     audit + event
   │
   ▼
(SCR is reviewed via DB workflow; transitions Draft→Submitted→Under Review→Approved)
   │
   ▼
On "Implement" event:
   │
   ▼
src/git/sekkei-git-service.ts::commitScrImplementation()
   │
   ▼
Git: for each affected node, write canonical YAML to nodes/<stratum>/<safeId>.yaml
     git add <files>
     git commit -m "<ECN message from SCR>" --signoff
     return commit info
   │
   ▼
DB:  scrs row UPDATE status=implemented, git_commit=<sha>
     audit row INSERT (event=scr.committed, payload=<sha>)
     provenance_events row INSERT
```

**Key property:** the *git commit* is built from the **DB state at approval time**, not from the diff history. We don't replay individual edits to git — multiple edits to the same node between submission and approval collapse into one final commit. This matches PLM ECN practice: the commit is the *outcome*, not the journal.

The change_log table still has every intermediate edit; that's the DB's audit trail. Git only sees the approved end state.

### 4.3 Vibe-driven change

The vibe loop is the same DB-first pattern, with an LLM intermediary that produces a *proposed change set* the user reviews before any DB write.

```
User types a prompt in vibe mode
   │
   ▼
POST /api/v1/vibe/intent  {message}
   │
   ▼
src/agent/intent.ts — classify the intent
   ├── canned script match  →  scripted change plan
   └── llm-fallback         →  POST /api/v1/vibe/llm-fallback
                              │
                              ▼
                              Construct a context bundle:
                                · current node bodies for the subtree the user named
                                · their relationships
                                · acceptance criteria
                              LLM returns a change plan:
                                · proposed node creations
                                · proposed node modifications (diff)
                                · proposed deletions
   │
   ▼
GLM renders the plan as a reviewable diff in the right pane
   │
   ▼
User: Accept / Reject / Modify
   │
   ▼  (on Accept)
The plan is applied as a single SCR with:
   · scr.summary  = the user's original prompt
   · scr.target_nodes = every glmId in the plan
   · scr.proposed_changes_json = the LLM's diff
   │
   ▼
From here, the flow is identical to §4.2 — the SCR goes through review and produces one ECN commit on merge.
```

The key invariant: **vibe never writes nodes directly**. It always produces an SCR. That gives reviewers an audit trail with the prompt that authored it, makes the change reversible at the SCR layer, and ensures the same approval-then-git-commit path runs.

### 4.4 Code regeneration with diff-aware prompts

Today's pipeline (`src/generation/pipeline.ts`) regenerates an artifact by:
1. Bundling the current node body + parameters as the prompt context
2. Calling the LLM
3. Caching on `(closure_hash, binding_hash, generator_identity)`

It treats every regeneration as a clean-room generation. That's correct but wasteful — and worse, it loses the operator's hot-patches in `glm-realization/` when those patches don't conflict with the spec change.

**Diff-aware regeneration** changes step 2: instead of "generate code for this spec", the prompt becomes "update the existing code to reflect this spec delta, preserving local modifications where compatible".

#### 4.4.1 Inputs

- **`previous_spec`** — the node body at the prior content_hash (read from the git history, OR from the DB's `change_log` if not yet committed).
- **`current_spec`** — the node body at the new content_hash.
- **`spec_diff`** — a structured diff: which body fields changed, with old/new values.
- **`previous_artifact`** — the previously-generated code (read from `glm-realization/` at the realization commit that pairs with `previous_spec`).
- **`realization_drift`** — `git diff` between the generated `previous_artifact` and what's actually in `glm-realization/` right now (i.e., human edits that landed after the last generation).

#### 4.4.2 Prompt shape

```
You previously generated <previous_artifact> from this spec:
  <previous_spec>

The spec has been updated. Here is the diff:
  <spec_diff>

The current realization has these human modifications since your last generation:
  <realization_drift>

Generate the new code by applying the spec_diff and preserving the realization_drift
where it doesn't conflict. If a conflict exists, prefer the spec_diff and call it out
in your response.
```

#### 4.4.3 Cache key

The cache key gains a fourth component: `previous_artifact_hash`. So the cache is keyed on the **transition** (prev → next), not just the destination state. This means:

- Identical spec change applied twice from the same start → cache hit.
- Same destination state, different start → cache miss (correct: the diff prompt differs).
- Same destination state, no prior artifact → cache miss → falls back to full-generation prompt.

#### 4.4.4 Acceptance

After generation, the embedded `spec.acceptance.verifier.command` runs against the produced artifact. On pass, an in-toto attestation is built and attached. On fail, the generation is marked *incomplete* and the SCR cannot advance to Implemented.

#### 4.4.5 Where DB and git meet

- **DB writes**: one `generation_attestations` row per artifact, one `provenance_events` row.
- **Git writes** (after SCR merge): the realization commit lands in `glm-realization/`; the DSSE envelope is attached to the matching sekkei commit as `refs/notes/generation`.
- **Cache bytes**: stored content-addressed in `data/cache/<sha256-prefix>/<sha256>.bin`, not git.

### 4.5 Variant resolution

```
User creates a variant in GLM
   │
   ▼
POST /api/v1/workspaces/:id/variants {name, parameterBindings: {…}}
   │
   ▼
DB:  variants row INSERT (root_id, status=resolving)
     resolver walks composes-of + derives-from from root_id
     for each visited node, picks the override based on:
       · parameter_binding
       · variant.varies-from edges
       · operator-specific overrides on the variant branch
     resolved_nodes rows INSERT (one per node in the closure)
     variants row UPDATE status=resolved, closure_hash=<sha256>
   │
   ▼
Git side (deferred):
   │
   ▼
On user action "publish variant":
   git checkout -b variants/<name>
   write sekkei.lock from resolved_nodes rows
   git add sekkei.lock
   git commit -m "Resolve variant <name> @ <closure_hash>"
   git push (if configured)
   │
   ▼
DB:  variants row UPDATE git_ref=variants/<name>, git_commit=<sha>
```

The DB owns the resolver — it's an O(n) graph walk with parameter substitution that benefits enormously from indexed lookups. Git owns the *answer* — a single `sekkei.lock` file that captures the closure deterministically and can be read by any tool that doesn't have the DB available (CI, downstream regen, an auditor).

### 4.6 Drift detection and reconciliation

Drift is the asymmetric relationship between sekkei (intent) and realization (reality). The git diff is the source of truth; the DB is the inbox.

```
Drift sweep (CI or manual)
   │
   ▼
For each Component node with realization_file:
   read sekkei expected_hash = node.body.realization_file_hash
   read actual_hash = sha256(realization_repo/<path>)
   if expected_hash != actual_hash:
     │
     ▼
     classify the diff:
       · whitespace/format only          → auto-resolvable (regen reformats)
       · spec-implied refactor pending   → regenerate to align
       · human improvement post-spec     → backport into sekkei
       · operator hot-patch              → leave for manual triage
     │
     ▼
     DB: drift_records row UPSERT (node_id, expected_hash, actual_hash, class, status=open)
         provenance_events row INSERT
         EventBus.publish(drift.detected)
   │
   ▼
User views Drift dashboard
   │
   ▼
For each open drift:
   · "Backport" → opens a vibe session preloaded with realization diff → produces SCR
   · "Regenerate" → queues a generation job → on success, drift closes automatically
   · "Accept hot-patch as spec" → records realization_file_hash := actual_hash via SCR
   · "Revert" → writes a realization-repo PR that reverts to the spec-implied state
```

The drift_records table is the workflow. The classification logic is a heuristic — it doesn't need to be perfect because every record is also reviewable by a human. The git diff is rerun on every sweep so a record stays open only as long as the underlying divergence persists; a re-sync closes it automatically.

### 4.7 Where-used

```
User clicks "where used" on a node
   │
   ▼
GET /api/v1/workspaces/:id/nodes/:glmId/where-used
   │
   ▼
DB walks the indexed graph:
   · all nodes with composes-of  →  target_glm_id = <glmId>
   · all nodes with depends-on   →  target_glm_id = <glmId>
   · all nodes with derives-from →  derives_from_node_id = <node.id>
   · all SCRs with target_nodes ∋ <glmId>
   · all variants whose resolved_nodes pin this <glmId>
   · all drift_records on this <glmId>
   │
   ▼
Returns a structured response. UI renders five tabs (Composes-of, Depends-on, Derives-from, SCRs, Variants).
```

This is exclusively a DB query — git can answer it via `git grep` and walking branches, but at sub-second latency for a 200-node sekkei the DB index wins by two orders of magnitude. The git path remains the *audit* answer for offline forensics; the DB is the *interactive* answer.

### 4.8 Effectivity & rollout

Releases are git tags. Rollout is a per-variant state machine in the DB that tracks each node's progression from the prior release to the new one.

```
Release authoring (GLM operator):
   tag the next ref → A.1 (signed annotated tag)
   the release tag is the immutable fact

For each variant:
   DB walks variant.resolved_nodes
   for each node that has a newer revision in A.1:
     rollout_records row INSERT (variant_id, node_id, from_rev=A.0, to_rev=A.1, status=pending)

Operator views Rollout dashboard
   selects a node, clicks "advance"
   │
   ▼
   guard checks:
     · all upstream SCRs implemented?
     · drift on this node = none?
     · acceptance verifier passes against current realization?
   │
   ▼
   variant.resolved_nodes UPDATE rev := A.1
   sekkei.lock rewrite (git commit on variant branch)
   rollout_records UPDATE status=advanced
   │
   ▼
   Generation pipeline triggers if the realization needs updating.
```

The `pin-policy` per node lets an operator hold a specific node at an older revision (e.g., legacy hardware constraint). That pin lives in `rollout_records` and is honored when computing the next variant resolution.

### 4.9 Reuse

```
Reuse candidate finder (CI or manual)
   │
   ▼
Walks every node in every workspace; finds nodes whose body.content_hash
matches another node's body.content_hash (or whose semantic similarity > threshold).
   │
   ▼
DB:  reuse_candidates rows INSERT
     status=found
   │
   ▼
Steward triage:
   · "Promote to catalog" — moves the canonical version of this Component
     into glm-catalog/<id>/A.<n>/ on a feature branch, opens a PR.
     On merge, GLM rewrites the consuming nodes to use the catalog entry
     via git subtree pull and updates references_catalog_path on the node.
   · "Reject" — closes the candidate; never offer this pairing again.
   · "Defer" — keeps it open without prioritizing.
```

The DB drives the workflow. Git carries the result — the catalog repo is the durable shared component library.

---

## 5. Workspace ↔ git-repo binding

Each workspace is bound to **one** sekkei git repo + **one** branch.

```sql
ALTER TABLE workspaces ADD COLUMN git_remote   TEXT;     -- e.g., git@github.com:kizo/glm-sekkei.git
ALTER TABLE workspaces ADD COLUMN git_ref      TEXT;     -- e.g., refs/heads/next
ALTER TABLE workspaces ADD COLUMN git_commit   TEXT;     -- last imported sha
ALTER TABLE workspaces ADD COLUMN git_clone_dir TEXT;    -- local clone path
```

If `git_remote` is null, the workspace is **detached** (current v1 behavior) — DB-only, exportable but no live git binding. When the user attaches a remote, GLM clones it, imports, and from then on every SCR merge writes a commit and (optionally) pushes.

The `data/repos/<workspace-id>/` clone is a regular working tree. GLM holds an exclusive lock for the duration of any `git add/commit/push` to keep concurrent SCR merges from interleaving. The `withWorkspaceLock` promise chain already in `src/git/sekkei-git-service.ts:50` handles this.

---

## 6. Schemas

### 6.1 New columns on existing tables

```sql
-- workspaces (already discussed)
git_remote     TEXT,
git_ref        TEXT,
git_commit     TEXT,
git_clone_dir  TEXT

-- scrs
git_commit         TEXT,        -- the ECN commit SHA on implement
git_branch         TEXT,        -- feature/<scr-id>, before merge
git_pr_url         TEXT,        -- if a forge integration is configured

-- variants
git_ref            TEXT,        -- variants/<name>
git_commit         TEXT,
closure_hash       TEXT,        -- sha256 over the sorted (id, content_hash) tuples
sekkei_lock_path   TEXT,        -- always sekkei.lock at variant branch root

-- drift_records
realization_commit       TEXT,  -- commit in glm-realization/ used for the diff
spec_commit              TEXT,  -- commit in glm-sekkei/ used as the expected side
classification           TEXT CHECK (classification IN
                                ('format', 'spec_implied', 'human_improvement', 'hot_patch')),
auto_resolvable          INTEGER NOT NULL DEFAULT 0,

-- rollout_records (extends variants)
node_id                  TEXT NOT NULL REFERENCES nodes(id),
from_rev                 TEXT,
to_rev                   TEXT,
status                   TEXT CHECK (status IN ('pending','advanced','blocked')),
pin_rev                  TEXT,        -- explicit hold

-- generation_attestations
realization_commit       TEXT,  -- nullable; set after the realization PR merges
git_note_ref             TEXT,  -- refs/notes/generation, set after the note is attached
```

### 6.2 New table: `generation_inputs`

The diff-aware regeneration needs to know what the *previous* artifact was. Today's cache stores outputs keyed by inputs; we also need to store inputs keyed by their resulting artifact so we can reconstruct the prev → next diff.

```sql
CREATE TABLE generation_inputs (
  attestation_id     TEXT PRIMARY KEY REFERENCES generation_attestations(id) ON DELETE CASCADE,
  spec_node_id       TEXT NOT NULL REFERENCES nodes(id),
  spec_content_hash  TEXT NOT NULL,           -- node body hash at generation time
  prompt_hash        TEXT NOT NULL,           -- sha256 of the full prompt text
  prompt_text        TEXT,                    -- nullable (large prompts may be stored elsewhere)
  artifact_path      TEXT NOT NULL,           -- realization-repo-relative
  artifact_hash      TEXT NOT NULL,           -- sha256 of the produced bytes
  produced_at        TEXT NOT NULL
);
CREATE INDEX idx_gen_inputs_spec ON generation_inputs(spec_node_id, produced_at DESC);
```

Lookups: "give me the most recent generation of `<spec_node_id>` whose artifact is still in the realization repo" → indexed scan in DB, no git involvement.

### 6.3 Two paths for the realization commit pointer

When a generated artifact lands in `glm-realization/`, the pairing back to the sekkei needs to survive realization-repo PR rebases. Two strategies:

**Option A — `REGENERATED_FROM` file (current plan).** A small text file committed alongside each artifact, naming the sekkei commit + sekkei.lock hash. Cheap, human-readable, but fragile to manual edits.

**Option B — git trailer in the realization commit message.** A line like `Generated-From: <sekkei-commit>` appended to the realization commit. Survives squash-merges if the trailer is preserved; requires the realization PR template to keep it.

The doc proposes **both**: file for per-artifact provenance (lets us recover the pairing for a single file), trailer for the per-commit pairing (lets a `git log` reviewer see at a glance which sekkei commit a realization commit corresponds to).

---

## 7. The migration path

v1 today: `getSekkeiGit = () => null`. Everything runs in DB. The git service code exists, has tests, and is idle.

A safe activation sequence:

1. **Workspace attach.** Add columns to `workspaces`, add a "Attach git remote" UI on the workspace settings page. Wire `getSekkeiGit` to return a real client when `git_remote` is non-null.
2. **Read-only sync.** Pull commits from the remote into `data/repos/<workspace-id>/`. The DB's `change_log` records "imported" events on each pull. No write path yet.
3. **SCR-implement write path.** When an SCR transitions to `Implemented`, call `commitScrImplementation()` — this commit goes to a feature branch in the local clone. Push is optional (gated by a workspace flag).
4. **Variant publish.** When a user clicks "Publish variant", write `sekkei.lock` on the variant branch.
5. **Generation notes.** Wire the pipeline to attach git notes after the realization commit lands.
6. **Drift sweep.** Switch the drift detector from "compare against a snapshot path" to "compare against the realization repo at HEAD".
7. **Diff-aware regeneration.** Land the `generation_inputs` table; rewrite the prompt builder to consult prior generations.
8. **Effectivity tags.** Wire release tags + the pre-receive hook.

Steps 1-2 are reversible — at any point a user can detach the workspace and return to DB-only mode. Steps 3+ create commits that survive detachment; once a workspace has shipped an ECN to git, "detach" means "keep the local DB, lose the live-sync wire", not "delete".

Each step is independently shippable. Step 1 alone makes the feature usable for offline-aware operators. Step 3 unlocks the "real PLM" promise of the project.

---

## 8. Architecture decisions (resolved 2026-05-12)

All eight questions below were decided and recorded in `docs/implementation_plan.md §8`. Summaries:

1. **Push policy.** Per-workspace flag, default **off**. Push triggered by explicit user action ("Push to origin") or optional CI cron. See §8.1.
2. **Auth to remote.** External IdP (SAML/OIDC) in v1; GLM does not own credentials. Four roles: `admin`, `contributor`, `reviewer`, `guest`. See §8.2.
3. **Conflict resolution on pull.** Fast-forward only (`git pull --ff-only`). Divergence surfaces as a workspace banner + Conflict Resolution UI. No auto-merge of sekkei nodes. See §8.3.
4. **PR vs direct commit.** PR if `workspace.git_forge` is set (`"github"` | `"gitlab"`); direct commit to `next` otherwise. See §8.4.
5. **Realization repo binding.** 1:1, named `<sekkei-name>-realization`. Per-Component `realization_repo` field is the multi-repo escape hatch. See §8.5.
6. **Cache durability.** Local filesystem (`data/cache/`) for v1. S3-compatible backend via `GenerationCache` interface is Phase 2. See §8.6.
7. **Self-import.** When attach-git ships, self-import workspace gets `git_remote = file://./../glm-sekkei`. Dogfood case. See §8.7.
8. **Spec-diff format.** Structured diff `{ field, op, old?, new? }[]` as primary LLM input; YAML unified diff as fallback/display. See §8.8.

---

## 9. Quick reference: the one-paragraph summary

> The DB is the working surface: real-time edits, drafts, indexed queries, workflow state, and not-yet-committed change requests. Git is the historical surface: approved changes become ECN commits, variants become branches, releases become signed tags, generations get DSSE attestations attached as git notes. Every fact that another user, another machine, or a future auditor needs to see has to round-trip through git. The DB is rebuildable from a git ref + the workflow tables; if the DB is wiped, the sekkei survives.

That's the design. The review's job is to nail down the eight items in §8 and to flag any process where the DB↔Git boundary feels wrong.
