-- Resolve CURRENT routing. Bind a canonical lowercase address_key.
-- For delayed events use their original delivery/assignment context, not this query.
SELECT a.id AS address_id, a.org_id, a.domain_id, a.address,
       x.id AS address_assignment_id, x.aura_id, x.assigned_at
FROM email_addresses a
JOIN email_domains d ON d.org_id = a.org_id AND d.id = a.domain_id
JOIN email_address_assignments x ON x.org_id = a.org_id AND x.address_id = a.id
WHERE a.address_key = :address_key
  AND a.status = 'active' AND d.status = 'active' AND x.ended_at IS NULL;
