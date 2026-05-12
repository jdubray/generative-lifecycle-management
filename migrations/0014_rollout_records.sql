-- Git Step 8: rollout_records tracks node-by-node rollout progress for each
-- release tag. One row per (variant, node, release_tag) triple; status advances
-- through pending → advanced, or is blocked when a guard check fails.
CREATE TABLE rollout_records (
  id          TEXT PRIMARY KEY,
  variant_id  TEXT NOT NULL REFERENCES variants(id) ON DELETE CASCADE,
  node_id     TEXT NOT NULL REFERENCES nodes(id),
  -- content_hash of the node body at the prior release; null on first release.
  from_rev    TEXT,
  -- content_hash of the node body at this release.
  to_rev      TEXT,
  status      TEXT CHECK (status IN ('pending','advanced','blocked')) NOT NULL DEFAULT 'pending',
  -- Operator-set pin; null means "follow variant pin_policy_default".
  pin_rev     TEXT,
  release_tag TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_rollout_unique ON rollout_records(variant_id, node_id, release_tag);
CREATE INDEX idx_rollout_variant ON rollout_records(variant_id);
CREATE INDEX idx_rollout_node    ON rollout_records(node_id);
CREATE INDEX idx_rollout_tag     ON rollout_records(release_tag);
