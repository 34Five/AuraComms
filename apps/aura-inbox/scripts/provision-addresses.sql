-- Add receiving addresses to the existing demo Auras. Preserve all seed identities and history.
-- Verify domain control and routing readiness before marking this domain active.
-- Run through Wrangler after the preflight in provision-addresses.mjs.
INSERT INTO email_domains
  (id,org_id,domain,domain_key,kind,status,cloudflare_zone_id,verified_at,activated_at)
VALUES ('domain_34five_inbox_test','org_demo_001','34five.studio','34five.studio','custom','active',
  '1c60311626bbfe94b6fe3496d15de727',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'))
ON CONFLICT(domain_key) DO NOTHING;

INSERT INTO email_addresses (id,org_id,domain_id,local_part,address,address_key)
SELECT 'address_lyra','org_demo_001',id,'lyra','lyra@34five.studio','lyra@34five.studio'
FROM email_domains WHERE domain_key='34five.studio' AND org_id='org_demo_001' AND status='active'
ON CONFLICT(address_key) DO NOTHING;
INSERT INTO email_addresses (id,org_id,domain_id,local_part,address,address_key)
SELECT 'address_nova','org_demo_001',id,'nova','nova@34five.studio','nova@34five.studio'
FROM email_domains WHERE domain_key='34five.studio' AND org_id='org_demo_001' AND status='active'
ON CONFLICT(address_key) DO NOTHING;

INSERT INTO email_address_assignments (id,org_id,address_id,aura_id,assigned_at,reason)
SELECT 'assignment_lyra','org_demo_001',a.id,'aura_demo_001',strftime('%Y-%m-%dT%H:%M:%fZ','now'),
  'Real incoming email for the read-only Aura inbox test'
FROM email_addresses a JOIN auras u ON u.org_id=a.org_id AND u.id='aura_demo_001'
WHERE a.org_id='org_demo_001' AND a.address_key='lyra@34five.studio' AND a.status='active'
  AND NOT EXISTS (SELECT 1 FROM email_address_assignments x WHERE x.org_id=a.org_id AND x.address_id=a.id AND x.ended_at IS NULL)
ON CONFLICT(id) DO NOTHING;
INSERT INTO email_address_assignments (id,org_id,address_id,aura_id,assigned_at,reason)
SELECT 'assignment_nova','org_demo_001',a.id,'aura_demo_002',strftime('%Y-%m-%dT%H:%M:%fZ','now'),
  'Real incoming email for the read-only Aura inbox test'
FROM email_addresses a JOIN auras u ON u.org_id=a.org_id AND u.id='aura_demo_002'
WHERE a.org_id='org_demo_001' AND a.address_key='nova@34five.studio' AND a.status='active'
  AND NOT EXISTS (SELECT 1 FROM email_address_assignments x WHERE x.org_id=a.org_id AND x.address_id=a.id AND x.ended_at IS NULL)
ON CONFLICT(id) DO NOTHING;
