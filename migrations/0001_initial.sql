-- ----------------------------------------------------------------------------
-- GLM initial schema (Phase 1)
--
-- One DB per organization. Every table is workspace-scoped except `users`
-- (org-global) and `schema_migrations` (DB-global).
--
-- Datetime columns are TEXT in ISO 8601 (YYYY-MM-DDTHH:MM:SS.sssZ). SQLite's
-- comparison operators sort ISO 8601 lexicographically; that is sufficient
-- for our DESC indexes on change_log/audit_events/provenance_events.
--
-- JSON columns are TEXT validated by `json_valid(...)` so we get a hard
-- failure at write time instead of silent corruption.
--
-- Booleans are INTEGER 0/1 with CHECK constraints (SQLite has no BOOLEAN).
-- ----------------------------------------------------------------------------

-- Migration bookkeeping -------------------------------------------------------

CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

-- Org-global ----------------------------------------------------------------

CREATE TABLE users (
  id           TEXT PRIMARY KEY,
  email        TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  role         TEXT NOT NULL CHECK (role IN ('admin', 'editor', 'reviewer', 'viewer')),
  created_at   TEXT NOT NULL
);

CREATE TABLE workspaces (
  id         TEXT PRIMARY KEY,
  slug       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE workspace_members (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users(id)      ON DELETE CASCADE,
  role         TEXT NOT NULL CHECK (role IN ('owner', 'maintainer', 'editor', 'reviewer', 'viewer')),
  joined_at    TEXT NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);

-- Nodes ---------------------------------------------------------------------

CREATE TABLE nodes (
  id                      TEXT PRIMARY KEY,
  workspace_id            TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  glm_id                  TEXT NOT NULL,
  stratum                 TEXT NOT NULL CHECK (stratum IN ('system', 'capability', 'component', 'interaction', 'spec')),
  title                   TEXT NOT NULL,
  description             TEXT NOT NULL DEFAULT '',
  body_json               TEXT NOT NULL CHECK (json_valid(body_json)),
  content_hash            TEXT NOT NULL,
  revision_major          TEXT NOT NULL CHECK (
                            length(revision_major) = 1
                            AND revision_major BETWEEN 'A' AND 'Z'
                            AND revision_major NOT IN ('I', 'O', 'Q', 'S', 'X', 'Z')
                          ),
  revision_iteration      INTEGER NOT NULL CHECK (revision_iteration >= 0),
  revision_status         TEXT NOT NULL CHECK (revision_status IN ('in_work', 'in_review', 'released', 'superseded', 'obsolete')),
  override_kind           TEXT NOT NULL CHECK (override_kind IN ('net_new', 'derives-from', 'refines')),
  derives_from_node_id    TEXT REFERENCES nodes(id) ON DELETE SET NULL,
  system_role             TEXT,
  spec_kind               TEXT,
  authored_by             TEXT NOT NULL,
  authored_at             TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  generator_identity_json TEXT CHECK (generator_identity_json IS NULL OR json_valid(generator_identity_json)),

  -- v1.1.9 discriminator: system_role is required iff stratum='system'
  CHECK (
    (stratum = 'system'     AND system_role IS NOT NULL) OR
    (stratum <> 'system'    AND system_role IS NULL)
  ),
  -- spec_kind is required iff stratum='spec'
  CHECK (
    (stratum = 'spec'     AND spec_kind IS NOT NULL) OR
    (stratum <> 'spec'    AND spec_kind IS NULL)
  ),

  UNIQUE (workspace_id, glm_id),
  UNIQUE (workspace_id, content_hash)
);

CREATE INDEX idx_nodes_workspace_stratum ON nodes (workspace_id, stratum);
CREATE INDEX idx_nodes_derives_from      ON nodes (derives_from_node_id);

-- Supporting tables ---------------------------------------------------------

CREATE TABLE node_parameters (
  node_id        TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  type           TEXT NOT NULL CHECK (type IN ('string', 'integer', 'boolean', 'enum')),
  options_json   TEXT CHECK (options_json IS NULL OR json_valid(options_json)),
  min_value      INTEGER,
  max_value      INTEGER,
  default_json   TEXT NOT NULL CHECK (json_valid(default_json)),
  binding_scope  TEXT NOT NULL CHECK (binding_scope IN ('workspace', 'variant', 'instance')),
  ord            INTEGER NOT NULL,
  PRIMARY KEY (node_id, name)
);

CREATE TABLE node_constraints (
  node_id     TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  ord         INTEGER NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('invariant', 'guard', 'postcondition')),
  expression  TEXT NOT NULL,
  severity    TEXT NOT NULL CHECK (severity IN ('error', 'warning')),
  PRIMARY KEY (node_id, ord)
);

CREATE TABLE node_relationships (
  source_node_id  TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  ord             INTEGER NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('composes-of', 'depends-on', 'derives-from', 'implements', 'generates', 'varies-from')),
  target_glm_id   TEXT NOT NULL,
  attributes_json TEXT CHECK (attributes_json IS NULL OR json_valid(attributes_json)),
  PRIMARY KEY (source_node_id, ord)
);

CREATE INDEX idx_node_relationships_target ON node_relationships (target_glm_id);
CREATE INDEX idx_node_relationships_kind   ON node_relationships (kind);

CREATE TABLE external_deps (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  purl         TEXT NOT NULL,
  role         TEXT NOT NULL,
  license      TEXT,
  notes_json   TEXT CHECK (notes_json IS NULL OR json_valid(notes_json)),
  PRIMARY KEY (workspace_id, purl)
);

CREATE TABLE generated_artifacts (
  id                      TEXT PRIMARY KEY,
  workspace_id            TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_node_id          TEXT NOT NULL REFERENCES nodes(id)      ON DELETE RESTRICT,
  path                    TEXT NOT NULL,
  content_hash            TEXT NOT NULL,
  generation_hash         TEXT NOT NULL,
  generator_identity_json TEXT NOT NULL CHECK (json_valid(generator_identity_json)),
  generated_at            TEXT NOT NULL,
  UNIQUE (workspace_id, path, content_hash)
);

CREATE INDEX idx_generated_artifacts_source ON generated_artifacts (source_node_id);
CREATE INDEX idx_generated_artifacts_gen    ON generated_artifacts (generation_hash);

CREATE TABLE edit_locks (
  node_id      TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  acquired_at  TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL
);

CREATE INDEX idx_edit_locks_heartbeat ON edit_locks (heartbeat_at);

CREATE TABLE change_log (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  node_id             TEXT          REFERENCES nodes(id)      ON DELETE SET NULL,
  user_id             TEXT NOT NULL REFERENCES users(id)      ON DELETE RESTRICT,
  op                  TEXT NOT NULL CHECK (op IN ('create', 'update', 'delete')),
  before_content_hash TEXT,
  after_content_hash  TEXT,
  ts                  TEXT NOT NULL
);

CREATE INDEX idx_change_log_workspace_ts ON change_log (workspace_id, ts DESC);
CREATE INDEX idx_change_log_node         ON change_log (node_id, ts DESC);

CREATE TABLE verification_runs (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  ts                TEXT NOT NULL,
  gate_results_json TEXT NOT NULL CHECK (json_valid(gate_results_json)),
  overall_pass      INTEGER NOT NULL CHECK (overall_pass IN (0, 1))
);

CREATE INDEX idx_verification_runs_workspace_ts ON verification_runs (workspace_id, ts DESC);

CREATE TABLE audit_events (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users(id)      ON DELETE RESTRICT,
  event_type   TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  ts           TEXT NOT NULL
);

CREATE INDEX idx_audit_events_workspace_ts ON audit_events (workspace_id, ts DESC);
CREATE INDEX idx_audit_events_type         ON audit_events (event_type);

-- SCR / SCO -----------------------------------------------------------------

CREATE TABLE scrs (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  class         TEXT NOT NULL CHECK (class IN ('I', 'II')),
  status        TEXT NOT NULL CHECK (status IN ('Draft', 'Submitted', 'Under Review', 'Approved', 'Returned', 'Rejected', 'Implemented', 'Released')),
  proposer      TEXT NOT NULL,
  proposed_at   TEXT NOT NULL,
  problem       TEXT NOT NULL,
  diff_yaml     TEXT NOT NULL CHECK (json_valid(diff_yaml)),
  target_nodes  TEXT NOT NULL CHECK (json_valid(target_nodes)),
  effectivity   TEXT,
  return_reason TEXT,
  impact_json   TEXT CHECK (impact_json IS NULL OR json_valid(impact_json))
);

CREATE INDEX idx_scrs_workspace_status ON scrs (workspace_id, status);

CREATE TABLE scr_approvals (
  scr_id     TEXT NOT NULL REFERENCES scrs(id) ON DELETE CASCADE,
  who        TEXT NOT NULL,
  decision   TEXT NOT NULL CHECK (decision IN ('approve', 'return', 'reject', 'pending')),
  decided_at TEXT,
  PRIMARY KEY (scr_id, who)
);

-- Variants ------------------------------------------------------------------

CREATE TABLE variants (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  label               TEXT NOT NULL,
  instance            TEXT,
  channel             TEXT NOT NULL CHECK (channel IN ('canary', 'stable', 'experimental')),
  pin_policy_default  TEXT NOT NULL CHECK (pin_policy_default IN ('pin-on-release', 'track-latest', 'frozen'))
);

CREATE INDEX idx_variants_workspace ON variants (workspace_id);

CREATE TABLE variant_rollout (
  variant_id    TEXT NOT NULL REFERENCES variants(id) ON DELETE CASCADE,
  node_id       TEXT NOT NULL REFERENCES nodes(id)    ON DELETE CASCADE,
  available_rev TEXT,
  pin_rev       TEXT,
  state         TEXT NOT NULL CHECK (state IN ('Released', 'Available-on-Channel', 'Pinned-by-Variant', 'Generated-for-Instance', 'Deployed-to-dBOM')),
  PRIMARY KEY (variant_id, node_id)
);

-- Drift ---------------------------------------------------------------------

CREATE TABLE drift_records (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  node_id       TEXT NOT NULL REFERENCES nodes(id)      ON DELETE CASCADE,
  file          TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('Synced', 'Hash-Drifted', 'Live-Drifted', 'Suspended')),
  kind          TEXT NOT NULL CHECK (kind IN ('none', 'hash', 'live_state')),
  desired_hash  TEXT,
  observed_hash TEXT,
  policy        TEXT NOT NULL CHECK (policy IN ('auto-heal', 'alert', 'suspend')),
  detail        TEXT,
  detected_at   TEXT NOT NULL
);

CREATE INDEX idx_drift_records_workspace_status ON drift_records (workspace_id, status);
CREATE INDEX idx_drift_records_node             ON drift_records (node_id);

-- Reuse ---------------------------------------------------------------------

CREATE TABLE reuse_candidates (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  subtree             TEXT NOT NULL,
  title               TEXT NOT NULL,
  stage               TEXT NOT NULL CHECK (stage IN ('Variant-Local', 'Candidate-for-Promotion', 'Promoted-to-Library', 'Stewarded-by-Owner')),
  rationale           TEXT NOT NULL DEFAULT '',
  usages              INTEGER NOT NULL DEFAULT 0,
  invariants_held_in  INTEGER NOT NULL DEFAULT 0,
  steward             TEXT
);

CREATE INDEX idx_reuse_candidates_workspace_stage ON reuse_candidates (workspace_id, stage);

-- Provenance ----------------------------------------------------------------

CREATE TABLE provenance_events (
  id                       TEXT PRIMARY KEY,
  workspace_id             TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  occurred_at              TEXT NOT NULL,
  subject_file             TEXT NOT NULL,
  subject_digest           TEXT NOT NULL,
  sekkei_root              TEXT NOT NULL,
  sekkei_rev               TEXT NOT NULL,
  sekkei_lock              TEXT NOT NULL,
  binding_hash             TEXT NOT NULL,
  generator_llm            TEXT NOT NULL,
  generator_prompt_version TEXT NOT NULL,
  tokens_in                INTEGER NOT NULL DEFAULT 0,
  tokens_out               INTEGER NOT NULL DEFAULT 0,
  duration_ms              INTEGER NOT NULL DEFAULT 0,
  cache                    TEXT NOT NULL CHECK (cache IN ('hit', 'miss')),
  signed                   INTEGER NOT NULL CHECK (signed IN (0, 1)),
  note                     TEXT
);

CREATE INDEX idx_provenance_events_workspace_ts ON provenance_events (workspace_id, occurred_at DESC);
CREATE INDEX idx_provenance_events_subject      ON provenance_events (subject_file);

-- Note: schema_migrations row is inserted by the runner (db.ts) after the
-- entire file applies cleanly, so the version is recorded only on success.
