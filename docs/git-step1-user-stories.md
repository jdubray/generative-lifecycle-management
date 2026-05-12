# Git Step 1 — Workspace Attach: User Stories & Acceptance Criteria

**Parent plan:** [`git-implementation-plan.md §5 Git Step 1`](./git-implementation-plan.md)  
**Schema:** Migration 0002 (`git_remote`, `git_ref`, `git_commit`, `git_clone_dir`, `git_forge`, `git_auto_push`)  
**Status:** Draft · 2026-05-12

---

## Scope

Git Step 1 covers one capability: a workspace can be **attached** to a git remote so that `getSekkeiGit` returns a live client. This is the only gating step — no other git steps can ship until a workspace can be attached. The step is fully reversible (detach returns the workspace to DB-only mode).

This document defines user stories at the interaction level and acceptance criteria in testable form. Implementation belongs to the backend branch (Phase 4 of the main plan).

---

## Actors

| Actor | Description |
|-------|-------------|
| **Admin** | Workspace administrator; the only role that may attach or detach a git remote |
| **Contributor** | Can view git attachment status; cannot change it |
| **GLM System** | The server process; performs the clone, wires `getSekkeiGit` |

---

## User Stories

---

### GS1-01 — Attach a workspace to a git remote

**Title:** Workspace git attachment

**Description:**  
As an **admin**, I want to attach a git remote URL and branch ref to a workspace so that future SCR, variant, and generation operations can be persisted to git.

**Acceptance Criteria:**

- AC-GS1-01-1: `POST /api/v1/workspaces/:id/git-remote` with a valid `{gitRemote, gitRef}` body returns `201 Created` and a response body containing `{gitAttached: true, gitCommit: "<sha>", gitCloneDir: "data/repos/<workspaceId>/"}`.
- AC-GS1-01-2: After a successful attach, `GET /api/v1/workspaces/:id` includes `gitAttached: true` and a non-null `gitCommit` (the HEAD SHA of `gitRef` at clone time).
- AC-GS1-01-3: A bare-repo clone is created at `data/repos/<workspaceId>/`. The clone contains the full object store and has `gitRef` checked out.
- AC-GS1-01-4: The workspace DB row has all four git columns populated: `git_remote`, `git_ref`, `git_commit`, `git_clone_dir`.
- AC-GS1-01-5: Only a user with the `admin` role may call `POST /api/v1/workspaces/:id/git-remote`. A `contributor`, `reviewer`, or `guest` receives `403 Forbidden`.
- AC-GS1-01-6: `getSekkeiGit(workspaceId)` returns a non-null client after the attach completes.

---

### GS1-02 — Validate attach inputs

**Title:** Attach input validation

**Description:**  
As an **admin**, I want GLM to validate the git remote URL and ref before cloning so that I receive a clear error rather than a stuck clone process.

**Acceptance Criteria:**

- AC-GS1-02-1: If `gitRemote` is missing or empty, the request returns `400 Bad Request` with `{"error": "gitRemote is required"}`. No clone is attempted.
- AC-GS1-02-2: If `gitRef` is missing or empty, the request returns `400 Bad Request` with `{"error": "gitRef is required"}`. No clone is attempted.
- AC-GS1-02-3: If `gitRemote` is a syntactically invalid URL (not a valid `file://`, `ssh://`, `https://`, or `git@` form), the request returns `400 Bad Request` before attempting the clone.
- AC-GS1-02-4: If `gitRef` references a branch or tag that does not exist in the remote, GLM attempts the clone, fails, rolls back (removes the partial clone directory), and returns `422 Unprocessable Entity` with `{"error": "ref not found: <gitRef>"}`.
- AC-GS1-02-5: If the remote is unreachable (network error, bad host, auth failure), GLM returns `502 Bad Gateway` with `{"error": "clone failed: <reason>"}` and leaves the workspace in its prior state (no partial clone directory).
- AC-GS1-02-6: If `gitForge` is provided but is not `"github"` or `"gitlab"`, the request returns `400 Bad Request` with `{"error": "gitForge must be 'github' or 'gitlab'"}`.

---

### GS1-03 — Attach with forge declared

**Title:** Workspace attach with forge integration

**Description:**  
As an **admin**, I want to declare a forge provider (`github` or `gitlab`) at attach time so that future SCR implementations automatically open pull requests.

**Acceptance Criteria:**

- AC-GS1-03-1: `POST /api/v1/workspaces/:id/git-remote` accepts an optional `{gitForge: "github"}` or `{gitForge: "gitlab"}` field alongside `gitRemote` and `gitRef`.
- AC-GS1-03-2: On success, `workspace.git_forge` is persisted; `GET /api/v1/workspaces/:id` returns `gitForge: "github"` (or `"gitlab"`).
- AC-GS1-03-3: Attaching without `gitForge` leaves `workspace.git_forge = null`; the workspace operates in direct-commit mode (no PRs opened).
- AC-GS1-03-4: `git_forge` can be updated independently via `PATCH /api/v1/workspaces/:id/git-remote` without re-cloning. The clone directory and `git_commit` are unchanged.

---

### GS1-04 — Configure push policy

**Title:** Push-on-SCR-merge toggle

**Description:**  
As an **admin**, I want to control whether GLM automatically pushes commits to the remote after each SCR merge so that my team can batch pushes rather than triggering a remote event on every change.

**Acceptance Criteria:**

- AC-GS1-04-1: `POST /api/v1/workspaces/:id/git-remote` accepts an optional `{gitAutoPush: true|false}` field. Default is `false`.
- AC-GS1-04-2: `workspace.git_auto_push` is persisted; `GET /api/v1/workspaces/:id` returns `gitAutoPush: true|false`.
- AC-GS1-04-3: `PATCH /api/v1/workspaces/:id/git-remote` accepts `{gitAutoPush: true|false}` and updates the flag without re-cloning.
- AC-GS1-04-4: When `git_auto_push = false`, no `git push` command is executed by the server at any time during Step 1. (Push behavior is verified in Step 3.)

---

### GS1-05 — View git attachment status

**Title:** Git attachment status display

**Description:**  
As a **contributor**, I want to see whether the workspace is attached to git and which remote/branch it tracks so that I understand where approved changes will be committed.

**Acceptance Criteria:**

- AC-GS1-05-1: `GET /api/v1/workspaces/:id` includes a `git` object with the following fields when attached: `{attached: true, remote: "<url>", ref: "<ref>", commit: "<sha>", forge: "<forge>|null", autoPush: false}`.
- AC-GS1-05-2: When the workspace is not attached, the response includes `{git: {attached: false}}` and all other git fields are absent (not null — absent).
- AC-GS1-05-3: All roles (`admin`, `contributor`, `reviewer`, `guest`) may call `GET /api/v1/workspaces/:id` and receive the `git` object.

---

### GS1-06 — Detach a workspace from git

**Title:** Workspace git detach

**Description:**  
As an **admin**, I want to detach a workspace from its git remote so that it returns to DB-only mode without losing any data already in the DB or the local clone.

**Acceptance Criteria:**

- AC-GS1-06-1: `DELETE /api/v1/workspaces/:id/git-remote` returns `204 No Content` on success.
- AC-GS1-06-2: After detach, `workspace.git_remote`, `git_ref`, `git_commit`, `git_clone_dir`, `git_forge`, and `git_auto_push` are all set to `null` / `0` (their migration defaults).
- AC-GS1-06-3: After detach, `GET /api/v1/workspaces/:id` returns `{git: {attached: false}}`.
- AC-GS1-06-4: After detach, `getSekkeiGit(workspaceId)` returns `null`.
- AC-GS1-06-5: The clone directory at `data/repos/<workspaceId>/` **is not deleted** by the detach operation. It remains on disk for manual inspection and recovery.
- AC-GS1-06-6: All sekkei nodes in the DB are intact after detach. No node data is removed.
- AC-GS1-06-7: A workspace with open SCRs (status ≠ `released`) may still be detached. The SCRs remain in the DB in their current state; they simply will not produce git commits until the workspace is re-attached.
- AC-GS1-06-8: Only a user with the `admin` role may call `DELETE /api/v1/workspaces/:id/git-remote`. Others receive `403 Forbidden`.

---

### GS1-07 — Re-attach to a different remote

**Title:** Remote re-binding

**Description:**  
As an **admin**, I want to re-attach a workspace to a different remote (or a different branch of the same remote) so that I can change the upstream target without losing the DB state.

**Acceptance Criteria:**

- AC-GS1-07-1: `POST /api/v1/workspaces/:id/git-remote` on an already-attached workspace returns `409 Conflict` with `{"error": "workspace is already attached; detach first or use PATCH to update ref/forge/autoPush"}`.
- AC-GS1-07-2: `PATCH /api/v1/workspaces/:id/git-remote` with `{gitRemote, gitRef}` re-clones to a **new** clone directory (`data/repos/<workspaceId>-<timestamp>/`), updates all four workspace columns, and then removes the previous clone directory asynchronously.
- AC-GS1-07-3: If the re-clone fails, the workspace columns remain pointing at the previous clone. No partial clone directory is left.
- AC-GS1-07-4: After a successful re-attach, `workspace.git_commit` reflects the HEAD of the new remote + ref at re-clone time.

---

### GS1-08 — Dogfood self-import

**Title:** Self-import workspace auto-attach

**Description:**  
As a **GLM platform developer**, I want the default seed workspace (which imports GLM's own sekkei) to be pre-attached to the local `glm-sekkei` git repository so that every git feature is immediately tested against real data.

**Acceptance Criteria:**

- AC-GS1-08-1: When `scripts/seed.ts` creates the default workspace, it calls `attachRemote` with `gitRemote = "file://<abs-path-to-glm-sekkei>"` and `gitRef = "refs/heads/next"`.
- AC-GS1-08-2: After seeding, the default workspace has a non-null `git_remote` pointing at the local repository.
- AC-GS1-08-3: `getSekkeiGit` returns a live client for the seed workspace immediately after `bun run seed` completes.
- AC-GS1-08-4: If the `glm-sekkei` repository does not exist at the expected path (e.g., running tests in a CI environment without the sibling repo), `scripts/seed.ts` skips the attach step and logs a warning; the workspace is created in DB-only mode without error.

---

### GS1-09 — Clone directory conflict detection

**Title:** Stale clone directory handling

**Description:**  
As the **GLM system**, I want to detect and handle a pre-existing clone directory so that a prior partial attach does not block a new attach.

**Acceptance Criteria:**

- AC-GS1-09-1: Before cloning, `attachRemote` checks whether `data/repos/<workspaceId>/` already exists.
- AC-GS1-09-2: If the directory exists and the workspace is currently detached (all `git_*` columns are null), `attachRemote` removes the stale directory before cloning.
- AC-GS1-09-3: If the directory exists and the workspace is currently attached to a different remote, `attachRemote` returns `409 Conflict` (covered by AC-GS1-07-1) without touching the existing directory.
- AC-GS1-09-4: Directory removal failures (e.g., permission denied) are returned as `500 Internal Server Error` with a message that includes the offending path.

---

### GS1-10 — Audit trail for attach / detach

**Title:** Attach and detach audit events

**Description:**  
As an **admin**, I want every attach and detach action to be recorded in the audit log so that I can see who changed the git binding and when.

**Acceptance Criteria:**

- AC-GS1-10-1: A successful `POST /api/v1/workspaces/:id/git-remote` inserts a row in `audit_events` with `event_type = 'workspace.git_attached'`, `actor_id = <calling user>`, `payload = {gitRemote, gitRef, gitForge, gitAutoPush}`. The `gitRemote` field in the payload must have any PAT credential stripped (e.g., `https://token@github.com/…` → `https://github.com/…`).
- AC-GS1-10-2: A successful `DELETE /api/v1/workspaces/:id/git-remote` inserts a row with `event_type = 'workspace.git_detached'`, `actor_id = <calling user>`, `payload = {previousGitRemote, previousGitRef}` (previous values, not null).
- AC-GS1-10-3: A successful `PATCH /api/v1/workspaces/:id/git-remote` inserts a row with `event_type = 'workspace.git_reattached'` and a payload containing both old and new values.
- AC-GS1-10-4: Failed attach attempts (bad URL, unreachable remote, bad ref) do **not** insert an audit row.

---

## Edge Cases Not Covered by the Stories Above

The following boundary conditions must be handled but do not warrant separate user-facing stories. They are recorded here as constraints on the implementation.

| Condition | Required behavior |
|-----------|------------------|
| `gitRef = "HEAD"` | Resolve `HEAD` to the concrete SHA of the default branch at clone time; store that branch name as `git_ref`, not `"HEAD"`. |
| Remote URL contains credentials (`https://token@…`) | Strip credentials from all stored values and audit log entries; store the clean URL only. Credentials must be provided via the forge PAT mechanism (§8.3 of the git implementation plan), not embedded in the URL. |
| `gitRef` is a tag (not a branch) | Supported: clone checks out the tag. `git_ref = "refs/tags/A.1"`. Subsequent sync (Step 2) will report "already up to date" (tags are immutable); no error. |
| Concurrent attach requests for the same workspace | `withWorkspaceLock` must serialize attach operations. The second request blocks until the first completes, then re-evaluates the pre-condition (workspace already attached → 409). |
| Very large remote (deep history) | Clone with `--depth 1` (shallow) for workspaces where `gitRef` is a branch. Tag checkouts remain full-depth to preserve verifiability. Record `git_shallow = true` on the workspace row so sync logic knows to unshallow before rebasing. |
| `data/repos/` directory does not exist on disk | `attachRemote` creates it before cloning. Failure to create (permissions) → `500` with path in the error message. |

---

## Out of Scope for Step 1

The following capabilities are explicitly **not** part of Git Step 1. They will be specified in later git step documents.

- Pulling new commits from the remote into the DB (Git Step 2).
- Writing ECN commits when an SCR is implemented (Git Step 3).
- SSH key or PAT credential storage for private remotes (Git Step 3 + `src/auth/token-store.ts`).
- Conflict Resolution UI when `git pull --ff-only` fails (Git Step 2).
- Branch protection configuration (Git Step 8).
- Any UI changes to the Workspace Settings view. Step 1 is API-only; UI wiring is a Phase 6/7 concern.
