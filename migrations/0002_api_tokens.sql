-- ----------------------------------------------------------------------------
-- API tokens for CLI / programmatic access (spec §6.4).
--
-- The raw token is shown to the user exactly once on creation. We store the
-- prefix (for display + lookup) and a hash (for verification). v1 uses
-- SHA-256 of (token || salt); Phase 10 hardening will upgrade to Argon2id.
-- ----------------------------------------------------------------------------

CREATE TABLE api_tokens (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  prefix       TEXT NOT NULL,                -- first 8 chars of the raw token, for UI display
  token_hash   TEXT NOT NULL,                -- sha256(token || salt) in hex
  salt         TEXT NOT NULL,                -- per-token random salt, hex
  name         TEXT NOT NULL,                -- human label, e.g. 'laptop-CLI'
  scopes_json  TEXT NOT NULL CHECK (json_valid(scopes_json)),
  created_at   TEXT NOT NULL,
  last_used_at TEXT,
  expires_at   TEXT,                          -- nullable = never expires
  revoked_at   TEXT                           -- nullable = active
);

CREATE INDEX idx_api_tokens_user ON api_tokens (user_id);
CREATE INDEX idx_api_tokens_prefix ON api_tokens (prefix);
