-- Named parameters; bind org_id from authenticated context, never client input alone.
-- Page 1: omit the cursor predicate. Later pages: use the final row's date + ID.
SELECT t.id, t.subject, t.current_tier, t.tier_state, t.inbox_status, t.last_activity_at
FROM email_threads t
WHERE t.org_id = :org_id AND t.aura_id = :aura_id
  AND t.inbox_status = :inbox_status
  AND t.current_tier = :tier
  AND t.last_activity_at >= :date_from AND t.last_activity_at < :date_to
  AND (t.last_activity_at, t.id) < (:cursor_activity_at, :cursor_id)
  AND EXISTS (
    SELECT 1 FROM email_messages m
    WHERE m.org_id = t.org_id AND m.aura_id = t.aura_id AND m.thread_id = t.id
      AND m.direction = :direction AND m.status = :message_status
  )
ORDER BY t.last_activity_at DESC, t.id DESC
LIMIT :page_size;

-- Pending review queue. Authorization must also check the member's Aura access.
SELECT r.id, r.message_id, r.tier_applied, r.revision, r.requested_at
FROM email_reviews r
WHERE r.org_id = :org_id AND r.aura_id = :aura_id AND r.status = 'pending'
ORDER BY r.requested_at DESC, r.id DESC
LIMIT :page_size;

-- Thread header lookup: run for In-Reply-To first, then References right to left.
SELECT id, thread_id
FROM email_messages
WHERE org_id = :org_id AND aura_id = :aura_id AND rfc_message_id = :rfc_message_id;
