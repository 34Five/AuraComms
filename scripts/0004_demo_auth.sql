-- AXI-29: additive. Invite-only sign-in for the demo inbox, until Access or Studio login replaces it.
-- Safe to re-run. The demo_auth_ prefix keeps these apart from other schemas in the shared database.
-- Deleting an invite removes its codes, throttle row and sessions.
CREATE TABLE IF NOT EXISTS demo_auth_invites (
  email TEXT PRIMARY KEY CHECK (email = lower(email)),
  invited_by TEXT NOT NULL,
  invited_at TEXT NOT NULL,
  last_sign_in_at TEXT
);

CREATE TABLE IF NOT EXISTS demo_auth_codes (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL REFERENCES demo_auth_invites(email) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);
CREATE INDEX IF NOT EXISTS demo_auth_codes_email ON demo_auth_codes (email, created_at);

CREATE TABLE IF NOT EXISTS demo_auth_throttle (
  email TEXT PRIMARY KEY REFERENCES demo_auth_invites(email) ON DELETE CASCADE,
  failed_attempts INTEGER NOT NULL,
  locked_until TEXT
);

CREATE TABLE IF NOT EXISTS demo_auth_sessions (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL REFERENCES demo_auth_invites(email) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);
