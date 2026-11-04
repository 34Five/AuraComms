-- Invite people to the demo inbox. Touches no existing row, so a rerun changes nothing.
-- Emails must be lower-case. To add someone, add a line to VALUES and rerun this file.
-- Apply scripts/0004_demo_auth.sql first.
INSERT INTO demo_auth_invites (email,invited_by,invited_at)
VALUES ('akash@axiatechnologies.ai','akash@axiatechnologies.ai',strftime('%Y-%m-%dT%H:%M:%fZ','now'))
ON CONFLICT(email) DO NOTHING;
