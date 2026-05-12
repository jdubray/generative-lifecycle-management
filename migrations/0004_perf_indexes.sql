-- ----------------------------------------------------------------------------
-- Phase 10 performance indexes.
-- Added during the §8.1 profiling pass. Each index has a documented caller.
-- ----------------------------------------------------------------------------

-- SCR list (Change Management): we filter by (workspace, status) very often.
CREATE INDEX IF NOT EXISTS idx_scrs_workspace_proposed_at ON scrs (workspace_id, proposed_at DESC);

-- Node detail's Where-Used pre-pass uses the derives-from chain.
CREATE INDEX IF NOT EXISTS idx_nodes_workspace_glm_id ON nodes (workspace_id, glm_id);

-- Provenance per-subject lookups feed AC-32..36 detail pages.
CREATE INDEX IF NOT EXISTS idx_provenance_events_subject_ts
  ON provenance_events (workspace_id, subject_file, occurred_at DESC);

-- Edit-lock heartbeat sweeps (expired lock cleanup).
CREATE INDEX IF NOT EXISTS idx_edit_locks_user ON edit_locks (user_id);

-- Audit feed by user (Phase 6 dashboard filter).
CREATE INDEX IF NOT EXISTS idx_audit_events_user_ts ON audit_events (user_id, ts DESC);
