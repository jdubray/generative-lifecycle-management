-- Git Step 5: record the realization-repo commit and the git-notes ref on
-- each generation attestation so the note can be found and re-verified.
ALTER TABLE generation_attestations ADD COLUMN realization_commit TEXT;
ALTER TABLE generation_attestations ADD COLUMN git_note_ref       TEXT;
