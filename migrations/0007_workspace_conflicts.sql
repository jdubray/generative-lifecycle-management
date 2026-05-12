-- 0007_workspace_conflicts.sql
--
-- Git Step 2 — Read-Only Sync.
--
-- Records divergence events when `git pull --ff-only` cannot fast-forward
-- because the local clone has diverged from the remote. Each row persists
-- until an operator resolves the conflict (e.g., by force-resetting the
-- local branch or detaching and re-attaching the remote).
--
-- The runner wraps every migration in db.transaction(), so this file must NOT
-- issue its own BEGIN/COMMIT.

CREATE TABLE workspace_conflicts (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  local_commit  TEXT NOT NULL,
  remote_commit TEXT NOT NULL,
  status        TEXT CHECK (status IN ('open', 'resolved')) NOT NULL DEFAULT 'open',
  created_at    TEXT NOT NULL
);

CREATE INDEX idx_ws_conflicts_workspace ON workspace_conflicts(workspace_id, status);
