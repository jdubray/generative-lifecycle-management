-- 0009_scr_git_columns.sql
--
-- Git Step 3: record the ECN commit and feature branch on each SCR.
--
--   git_commit  TEXT — SHA of the ECN commit written on `implement`.
--   git_branch  TEXT — Name of the feature branch (feature/<scr-id>); deleted
--                      from the local clone after merge but preserved here for
--                      audit and forge PR tracking.
--   git_pr_url  TEXT — Forge PR/MR URL when git_forge is set on the workspace.
--
-- All three columns are nullable: they are null until the SCR transitions to
-- Implemented with a git-attached workspace; they stay null for DB-only
-- workspaces.

ALTER TABLE scrs ADD COLUMN git_commit TEXT;
ALTER TABLE scrs ADD COLUMN git_branch TEXT;
ALTER TABLE scrs ADD COLUMN git_pr_url TEXT;
