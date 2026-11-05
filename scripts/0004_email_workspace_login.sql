-- Additive authentication tables. Apply after 0003 and before enabling demo login.
CREATE TABLE IF NOT EXISTS email_workspace_logins (
  org_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  login_key TEXT NOT NULL CHECK (login_key=lower(trim(login_key)) AND length(login_key) BETWEEN 3 AND 254),
  password_salt TEXT NOT NULL CHECK (length(password_salt)=32),
  password_hash TEXT NOT NULL CHECK (length(password_hash)=64),
  password_iterations INTEGER NOT NULL CHECK (password_iterations=100000),
  PRIMARY KEY (org_id,member_id),
  UNIQUE (org_id,login_key),
  FOREIGN KEY (org_id,member_id) REFERENCES email_workspace_access(org_id,member_id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS email_workspace_sessions (
  token_hash TEXT PRIMARY KEY CHECK (length(token_hash)=64),
  org_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at>created_at),
  FOREIGN KEY (org_id,member_id) REFERENCES email_workspace_logins(org_id,member_id)
);
CREATE INDEX IF NOT EXISTS email_workspace_sessions_member ON email_workspace_sessions(org_id,member_id);
CREATE INDEX IF NOT EXISTS email_workspace_sessions_expiry ON email_workspace_sessions(expires_at);
CREATE TABLE IF NOT EXISTS email_workspace_login_limits (
  org_id TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  attempts INTEGER NOT NULL CHECK (attempts>0),
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (org_id,scope_key)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS email_workspace_login_limits_expiry ON email_workspace_login_limits(expires_at);
