-- ----------------------------------------------------------------------------
-- Generation attestations (spec §5.9).
--
-- One row per generation event whose Statement was signed. The DSSE envelope
-- and the underlying in-toto Statement are stored verbatim so the audit pane
-- can render them and the export bundle (AC-34) can reproduce them.
-- ----------------------------------------------------------------------------

CREATE TABLE generation_attestations (
  id                  TEXT PRIMARY KEY,
  provenance_event_id TEXT NOT NULL REFERENCES provenance_events(id) ON DELETE CASCADE,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id)        ON DELETE CASCADE,
  statement_json      TEXT NOT NULL CHECK (json_valid(statement_json)),
  dsse_json           TEXT NOT NULL CHECK (json_valid(dsse_json)),
  key_id              TEXT NOT NULL,
  rekor_entry_id      TEXT,
  created_at          TEXT NOT NULL
);

CREATE INDEX idx_generation_attestations_workspace ON generation_attestations (workspace_id, created_at DESC);
CREATE UNIQUE INDEX idx_generation_attestations_event ON generation_attestations (provenance_event_id);
