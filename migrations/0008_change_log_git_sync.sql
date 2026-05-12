-- 0008_change_log_git_sync.sql
--
-- Two schema changes needed to support automated git-sync entries:
--
-- 1. Widen change_log.op CHECK to include 'git-sync'.
-- 2. Allow change_log.user_id to be NULL for system-originated entries
--    (git-sync, startup reconciliation) that have no acting user.
--
-- SQLite doesn't support DROP CONSTRAINT, so we rebuild the table via the
-- canonical "create new, copy, drop, rename" recipe. The runner wraps every
-- migration in db.transaction(), so this file does NOT issue its own
-- BEGIN/COMMIT.

CREATE TABLE change_log_new (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  node_id             TEXT          REFERENCES nodes(id)      ON DELETE SET NULL,
  user_id             TEXT          REFERENCES users(id)      ON DELETE RESTRICT,
  op                  TEXT NOT NULL CHECK (op IN ('create', 'update', 'delete', 'git-sync')),
  before_content_hash TEXT,
  after_content_hash  TEXT,
  ts                  TEXT NOT NULL
);

INSERT INTO change_log_new
  (id, workspace_id, node_id, user_id, op, before_content_hash, after_content_hash, ts)
SELECT
  id, workspace_id, node_id, user_id, op, before_content_hash, after_content_hash, ts
FROM change_log;

DROP TABLE change_log;
ALTER TABLE change_log_new RENAME TO change_log;

CREATE INDEX idx_change_log_workspace_ts ON change_log (workspace_id, ts DESC);
CREATE INDEX idx_change_log_node         ON change_log (node_id, ts DESC);
