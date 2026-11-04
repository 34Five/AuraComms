-- Add the Merlin demo Aura and its receiving address. Touches no row outside Merlin's own.
-- Run through Wrangler after the preflight in provision-merlin.mjs.
INSERT INTO auras (id,org_id,name) VALUES ('aura_demo_merlin','org_demo_001','Merlin')
ON CONFLICT(id) DO NOTHING;

INSERT INTO email_addresses (id,org_id,domain_id,local_part,address,address_key)
SELECT 'address_merlin','org_demo_001',id,'merlin','merlin@34five.studio','merlin@34five.studio'
FROM email_domains WHERE domain_key='34five.studio' AND org_id='org_demo_001' AND status='active'
ON CONFLICT(address_key) DO NOTHING;

INSERT INTO email_address_assignments (id,org_id,address_id,aura_id,assigned_at,reason)
SELECT 'assignment_merlin','org_demo_001',a.id,'aura_demo_merlin',strftime('%Y-%m-%dT%H:%M:%fZ','now'),
  'Thursday demo Aura on the aura-inbox-demo Worker'
FROM email_addresses a JOIN auras u ON u.org_id=a.org_id AND u.id='aura_demo_merlin'
WHERE a.org_id='org_demo_001' AND a.address_key='merlin@34five.studio' AND a.status='active'
  AND NOT EXISTS (SELECT 1 FROM email_address_assignments x WHERE x.org_id=a.org_id AND x.address_id=a.id AND x.ended_at IS NULL)
ON CONFLICT(id) DO NOTHING;

-- Retire the earlier merlin-test address if an earlier run added it. Its row and any history stay.
UPDATE email_address_assignments SET ended_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE id='assignment_merlin_test' AND org_id='org_demo_001' AND ended_at IS NULL;
UPDATE email_addresses SET status='disabled',disabled_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE id='address_merlin_test' AND org_id='org_demo_001' AND status='active';
