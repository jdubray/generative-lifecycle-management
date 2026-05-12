-- 0005_widen_parameter_enums.sql
--
-- Align node_parameters with the v1.1 spec (specification/sekkei.schema.json).
--
-- TWO divergences this migration closes:
--
-- 1. binding_scope
--    Spec v1.1: enum [system, capability, component, interaction, spec]
--      — names the STRATUM at which the parameter is declared, which
--        determines its visibility scope (descendants inherit by default;
--        a child may shadow).
--    0001 (this DB so far): enum [workspace, variant, instance]
--      — names the LIFECYCLE PHASE at which the value is bound.
--    These are different axes. The spec's is the source-of-truth identifier;
--    the lifecycle-phase concept is preserved through the resolved
--    parameter_binding in sekkei.lock, not on the declaration itself.
--
-- 2. type
--    Spec v1.1: `parameter.schema` is a full JSON Schema fragment, so
--    valid `type` values include string, integer, boolean, number, array,
--    object, null (and the enum keyword decorates any of them).
--    0001: enum [string, integer, boolean, enum]. Too narrow.
--
-- SQLite doesn't support DROP CONSTRAINT, so we rebuild the table via the
-- canonical "create new, copy, drop, rename" recipe. The runner wraps every
-- migration in db.transaction(), so this file does NOT issue its own
-- BEGIN/COMMIT — nesting one would close the outer tx prematurely.

CREATE TABLE node_parameters_new (
  node_id        TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  type           TEXT NOT NULL CHECK (
    type IN ('string', 'integer', 'boolean', 'number', 'array', 'object', 'null', 'enum')
  ),
  options_json   TEXT CHECK (options_json IS NULL OR json_valid(options_json)),
  min_value      INTEGER,
  max_value      INTEGER,
  default_json   TEXT NOT NULL CHECK (json_valid(default_json)),
  binding_scope  TEXT NOT NULL CHECK (
    binding_scope IN ('system', 'capability', 'component', 'interaction', 'spec',
                      'workspace', 'variant', 'instance')
  ),
  ord            INTEGER NOT NULL,
  PRIMARY KEY (node_id, name)
);

-- Carry forward existing rows. Pre-migration values are all in
-- {workspace, variant, instance} and {string, integer, boolean, enum},
-- which are still accepted by the new CHECKs, so this is lossless.
INSERT INTO node_parameters_new
  (node_id, name, type, options_json, min_value, max_value, default_json, binding_scope, ord)
SELECT
  node_id, name, type, options_json, min_value, max_value, default_json, binding_scope, ord
FROM node_parameters;

DROP TABLE node_parameters;
ALTER TABLE node_parameters_new RENAME TO node_parameters;

-- Re-create the index that 0004_perf_indexes.sql added on node_id (if any).
-- 0004 created idx_node_parameters_node_id; SQLite drops indexes with the
-- old table, so we have to re-create them.
CREATE INDEX IF NOT EXISTS idx_node_parameters_node_id ON node_parameters(node_id);
