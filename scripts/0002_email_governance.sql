-- AXI-8: data-preserving upgrade of the exact E07 schema in 0001.
-- Rebuild only reviews to allow audited automatic decisions without a fake human.
-- Apply with the migration runner transaction; do not disable foreign keys.
-- Existing rows, IDs, revisions and human decisions are copied unchanged.
CREATE TABLE email_reviews_e08 (
  id TEXT PRIMARY KEY NOT NULL,
  org_id TEXT NOT NULL,
  aura_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  tier_applied TEXT NOT NULL,
  thread_review_epoch INTEGER NOT NULL DEFAULT 0 CHECK (thread_review_epoch >= 0),
  -- Snapshot the parent thread review_epoch at request time. A reset increments it.
  -- The service must refuse stale approvals; this field does not implement tiers.
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','sent','superseded')),
  decision_source TEXT NOT NULL DEFAULT 'human' CHECK (decision_source IN ('human','automatic')),
  policy_snapshot_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(policy_snapshot_json) AND json_type(policy_snapshot_json) = 'object'),
  approver_member_id TEXT,
  edited_before_send INTEGER NOT NULL DEFAULT 0 CHECK (edited_before_send IN (0,1)),
  reviewed_content_sha256 TEXT, -- Hash of exact body/recipients/attachment revision approved.
  reason TEXT,
  requested_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  decided_at TEXT,
  sent_at TEXT,
  UNIQUE (org_id, aura_id, message_id, revision),
  FOREIGN KEY (org_id, aura_id, message_id) REFERENCES email_messages(org_id, aura_id, id),
  FOREIGN KEY (org_id, approver_member_id) REFERENCES studio_members(org_id, member_id),
  CHECK (status NOT IN ('approved','rejected','sent') OR (decided_at IS NOT NULL AND reviewed_content_sha256 IS NOT NULL
    AND ((decision_source = 'human' AND approver_member_id IS NOT NULL)
      OR (decision_source = 'automatic' AND approver_member_id IS NULL AND status IN ('approved','sent'))))),
  CHECK (status <> 'sent' OR sent_at IS NOT NULL)
);
INSERT INTO email_reviews_e08 (id, org_id, aura_id, message_id, revision, tier_applied, thread_review_epoch, status, approver_member_id, edited_before_send, reviewed_content_sha256, reason, requested_at, decided_at, sent_at)
SELECT id, org_id, aura_id, message_id, revision, tier_applied, thread_review_epoch, status, approver_member_id, edited_before_send, reviewed_content_sha256, reason, requested_at, decided_at, sent_at FROM email_reviews;
DROP TABLE email_reviews;
ALTER TABLE email_reviews_e08 RENAME TO email_reviews;
CREATE UNIQUE INDEX idx_email_reviews_pending ON email_reviews(org_id, aura_id, message_id) WHERE status = 'pending';
CREATE INDEX idx_email_reviews_queue ON email_reviews(org_id, aura_id, status, requested_at DESC, id DESC);
CREATE TRIGGER email_reviews_outbound_insert BEFORE INSERT ON email_reviews
WHEN EXISTS (SELECT 1 FROM email_messages WHERE id = NEW.message_id AND direction <> 'out')
BEGIN SELECT RAISE(ABORT, 'Email reviews require an outbound message'); END;
CREATE TRIGGER email_reviews_outbound_update BEFORE UPDATE ON email_reviews
WHEN EXISTS (SELECT 1 FROM email_messages WHERE id = NEW.message_id AND direction <> 'out')
BEGIN SELECT RAISE(ABORT, 'Email reviews require an outbound message'); END;
