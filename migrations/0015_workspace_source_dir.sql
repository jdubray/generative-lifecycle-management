-- Phase 6 (Solo Mode UC-02): per-workspace source directory for `glm generate`.
-- The generation pipeline writes outputs from `spec.prompt.body.outputs[].path`
-- relative to this directory, and runs the acceptance verifier with it as cwd.
-- NULL when the workspace is not yet wired to a local source tree.
ALTER TABLE workspaces ADD COLUMN source_dir TEXT;
