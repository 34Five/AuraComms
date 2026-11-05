-- Additive D1 migration. Existing studio membership and email history stay intact.
CREATE TABLE IF NOT EXISTS email_workspace_access (
  org_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 100),
  email TEXT,
  role TEXT NOT NULL CHECK (role IN ('admin','manager','reviewer')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  bootstrap_revoked INTEGER NOT NULL DEFAULT 0 CHECK (bootstrap_revoked IN (0,1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (org_id,member_id),
  FOREIGN KEY (org_id,member_id) REFERENCES studio_members(org_id,member_id)
) WITHOUT ROWID;
CREATE UNIQUE INDEX IF NOT EXISTS email_workspace_access_email
  ON email_workspace_access(org_id,lower(email)) WHERE email IS NOT NULL;
CREATE TABLE IF NOT EXISTS email_workspace_credentials (
  token_hash TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (org_id,member_id) REFERENCES email_workspace_access(org_id,member_id)
);
CREATE INDEX IF NOT EXISTS email_workspace_credentials_member ON email_workspace_credentials(org_id,member_id);
CREATE TABLE IF NOT EXISTS email_workspace_access_events (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  actor_member_id TEXT NOT NULL,
  target_member_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('created','updated','credential_reset')),
  details_json TEXT NOT NULL CHECK (json_valid(details_json)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS email_workspace_access_events_org ON email_workspace_access_events(org_id,created_at DESC,id DESC);
