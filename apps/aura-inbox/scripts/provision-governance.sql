-- Demo data only. Run after provision-governance.mjs checks ownership and migration state.
-- Reuse the existing Auras and reviewer. Preserve policies after initial configuration.
INSERT INTO auras (id,org_id,name) VALUES ('aura_demo_003','org_demo_001','Olivia') ON CONFLICT(id) DO NOTHING;
INSERT INTO auras (id,org_id,name) VALUES ('aura_demo_004','org_demo_001','Sophia') ON CONFLICT(id) DO NOTHING;

INSERT INTO email_aura_policies (org_id,aura_id,tier,updated_by_member_id)
VALUES ('org_demo_001','aura_demo_001','1','member_demo_001'),('org_demo_001','aura_demo_002','2','member_demo_001'),
       ('org_demo_001','aura_demo_003','3','member_demo_001'),('org_demo_001','aura_demo_004','4','member_demo_001')
ON CONFLICT(org_id,aura_id) DO UPDATE SET tier=excluded.tier,version=email_aura_policies.version+1,
  updated_by_member_id=excluded.updated_by_member_id,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE email_aura_policies.tier IS NULL AND email_aura_policies.version=1;

INSERT INTO email_aura_reviewers (org_id,aura_id,member_id,configured_by_member_id)
VALUES ('org_demo_001','aura_demo_001','member_demo_001','member_demo_001'),('org_demo_001','aura_demo_002','member_demo_001','member_demo_001'),
       ('org_demo_001','aura_demo_003','member_demo_001','member_demo_001'),('org_demo_001','aura_demo_004','member_demo_001','member_demo_001')
ON CONFLICT(org_id,aura_id,member_id) DO NOTHING;

INSERT INTO email_addresses (id,org_id,domain_id,local_part,address,address_key)
SELECT 'address_olivia','org_demo_001',id,'olivia','olivia@34five.studio','olivia@34five.studio'
FROM email_domains WHERE domain_key='34five.studio' AND org_id='org_demo_001' AND status='active' ON CONFLICT(address_key) DO NOTHING;
INSERT INTO email_addresses (id,org_id,domain_id,local_part,address,address_key)
SELECT 'address_sophia','org_demo_001',id,'sophia','sophia@34five.studio','sophia@34five.studio'
FROM email_domains WHERE domain_key='34five.studio' AND org_id='org_demo_001' AND status='active' ON CONFLICT(address_key) DO NOTHING;

INSERT INTO email_address_assignments (id,org_id,address_id,aura_id,assigned_at,reason)
SELECT 'assignment_olivia','org_demo_001',id,'aura_demo_003',strftime('%Y-%m-%dT%H:%M:%fZ','now'),'Four-tier governance demo'
FROM email_addresses a WHERE org_id='org_demo_001' AND address_key='olivia@34five.studio' AND status='active'
AND NOT EXISTS (SELECT 1 FROM email_address_assignments x WHERE x.org_id=a.org_id AND x.address_id=a.id AND x.ended_at IS NULL) ON CONFLICT(id) DO NOTHING;
INSERT INTO email_address_assignments (id,org_id,address_id,aura_id,assigned_at,reason)
SELECT 'assignment_sophia','org_demo_001',id,'aura_demo_004',strftime('%Y-%m-%dT%H:%M:%fZ','now'),'Four-tier governance demo'
FROM email_addresses a WHERE org_id='org_demo_001' AND address_key='sophia@34five.studio' AND status='active'
AND NOT EXISTS (SELECT 1 FROM email_address_assignments x WHERE x.org_id=a.org_id AND x.address_id=a.id AND x.ended_at IS NULL) ON CONFLICT(id) DO NOTHING;
