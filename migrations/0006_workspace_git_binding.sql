-- 0006_workspace_git_binding.sql
--
-- Git Step 1 — Workspace Attach.
--
-- Adds six columns that allow a workspace to be bound to a git remote.
-- All columns are nullable so existing workspaces remain in DB-only mode
-- (getSekkeiGit returns null) until an operator explicitly attaches a remote
-- via POST /api/v1/workspaces/:id/git-remote.
--
-- git_remote    — URL the local clone was fetched from (ssh:// or https://).
-- git_ref       — branch/ref to track, e.g. refs/heads/next.
-- git_commit    — SHA of the last imported / synced HEAD; updated on every sync.
-- git_clone_dir — absolute path to the local bare-or-worktree clone,
--                 always data/repos/<workspace-id>/.
-- git_forge     — optional; 'github' or 'gitlab' enables PR/MR automation.
-- git_auto_push — when 1, GLM pushes ECN commits immediately after creating them.
--
-- The runner wraps every migration in db.transaction(), so this file must NOT
-- issue its own BEGIN/COMMIT — nesting would close the outer transaction.

ALTER TABLE workspaces ADD COLUMN git_remote    TEXT;
ALTER TABLE workspaces ADD COLUMN git_ref       TEXT;
ALTER TABLE workspaces ADD COLUMN git_commit    TEXT;
ALTER TABLE workspaces ADD COLUMN git_clone_dir TEXT;
ALTER TABLE workspaces ADD COLUMN git_forge     TEXT CHECK (git_forge IN ('github', 'gitlab'));
ALTER TABLE workspaces ADD COLUMN git_auto_push INTEGER NOT NULL DEFAULT 0;
