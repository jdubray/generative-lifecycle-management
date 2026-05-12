-- Git Step 6: record realization-repo provenance and drift classification on
-- each drift record so the sweep can be traced back to specific commits.
ALTER TABLE drift_records ADD COLUMN realization_commit TEXT;
ALTER TABLE drift_records ADD COLUMN spec_commit        TEXT;
ALTER TABLE drift_records ADD COLUMN classification     TEXT
    CHECK (classification IN ('format','spec_implied','human_improvement','hot_patch'));
ALTER TABLE drift_records ADD COLUMN auto_resolvable    INTEGER NOT NULL DEFAULT 0;
-- Intended invariant: auto_resolvable = 1 only when classification IS NOT NULL.
-- SQLite's ALTER TABLE cannot add multi-column CHECK constraints; this is
-- enforced at the application layer by DriftRepository.setGitInfo(), which
-- always sets both columns together.
