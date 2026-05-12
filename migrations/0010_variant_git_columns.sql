-- 0010_variant_git_columns.sql
--
-- Git Step 4: record the variant branch and sekkei.lock commit on each variant.
--
--   git_ref          TEXT — Long-form branch ref (variants/<label>).
--   git_commit       TEXT — SHA of the lock commit written on publish.
--   closure_hash     TEXT — sha256 of the serialized sekkei.lock bytes;
--                           surfaced in the UI as "sekkei.lock #<short>".
--   sekkei_lock_path TEXT — Always 'sekkei.lock'; stored for forward compatibility
--                           in case per-variant subdirs are introduced in a later step.
--
-- All columns are nullable: null until the variant is first published to a
-- git-attached workspace. DB-only workspaces never populate these.

ALTER TABLE variants ADD COLUMN git_ref          TEXT;
ALTER TABLE variants ADD COLUMN git_commit       TEXT;
ALTER TABLE variants ADD COLUMN closure_hash     TEXT;
ALTER TABLE variants ADD COLUMN sekkei_lock_path TEXT;
