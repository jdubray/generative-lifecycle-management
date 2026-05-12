-- Git Step 7: record the inputs that drove each generation so the pipeline can
-- perform diff-aware regeneration on subsequent spec changes.
CREATE TABLE generation_inputs (
  attestation_id     TEXT PRIMARY KEY REFERENCES generation_attestations(id) ON DELETE CASCADE,
  -- RESTRICT (SQLite default): node deletion is blocked while generation history
  -- exists. Preserve audit trail; callers must delete generation_inputs rows first.
  spec_node_id       TEXT NOT NULL REFERENCES nodes(id),
  spec_content_hash  TEXT NOT NULL,
  -- Full JSON body of the spec at generation time (enables computeStructuredDiff).
  spec_body_json     TEXT NOT NULL,
  -- sha256 of the prompt text so identical prompts are detectable without
  -- storing large strings twice.
  prompt_hash        TEXT NOT NULL,
  -- Stored when available; may be omitted to save space on large prompts.
  prompt_text        TEXT,
  -- Null on the first generation for a spec node; non-null for re-gens.
  spec_diff_json     TEXT,
  spec_diff_yaml     TEXT,
  artifact_path      TEXT NOT NULL,
  artifact_hash      TEXT NOT NULL,
  -- HEAD SHA of glm-realization/ at the time this artifact was produced.
  -- Used to compute realization drift on the next re-gen.
  realization_commit TEXT,
  produced_at        TEXT NOT NULL
);
CREATE INDEX idx_gen_inputs_spec ON generation_inputs(spec_node_id, produced_at DESC);
