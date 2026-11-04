-- Add the Atlas demo Aura with no address, so its card offers Generate email. Touches no existing row.
-- Adds nothing if the domain is not active, another Aura has the name, or the address is taken.
-- The runbook in the README checks the result, because a skipped insert reports no error.
INSERT INTO auras (id,org_id,name)
SELECT 'aura_demo_atlas','org_demo_001','Atlas'
WHERE EXISTS (SELECT 1 FROM email_domains WHERE org_id='org_demo_001' AND domain_key='34five.studio' AND status='active')
  AND NOT EXISTS (SELECT 1 FROM auras WHERE org_id='org_demo_001' AND lower(name)='atlas')
  AND NOT EXISTS (SELECT 1 FROM email_addresses WHERE address_key='atlas@34five.studio')
ON CONFLICT(id) DO NOTHING;
