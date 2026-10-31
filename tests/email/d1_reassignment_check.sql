-- LOCAL DEMO FIXTURE ONLY. Run once after scripts/email/seed.sql in a fresh local DB.
-- Expected: msg_quote_in remains Sales Aura; msg_d1_new is Support Aura;
-- foreign_key_check returns no rows and quick_check returns ok.
UPDATE email_address_assignments SET ended_at='2026-10-22T10:00:00.000Z' WHERE id='assignment_sales';
INSERT INTO email_address_assignments(id,org_id,address_id,aura_id,assigned_at) VALUES ('assignment_sales_d1_new','e07_demo_org','addr_sales','e07_demo_aura_support','2026-10-22T10:00:00.000Z');
INSERT INTO email_messages(id,org_id,aura_id,thread_id,email_address_id,address_assignment_id,direction,status,from_address,ingest_key,received_at,activity_at) VALUES ('msg_d1_new','e07_demo_org','e07_demo_aura_support','thread_support','addr_sales','assignment_sales_d1_new','in','received','alex@example.invalid','d1-new','2026-10-22T10:01:00.000Z','2026-10-22T10:01:00.000Z');
SELECT id,aura_id,address_assignment_id FROM email_messages WHERE id IN ('msg_quote_in','msg_d1_new') ORDER BY id;
PRAGMA foreign_key_check;
PRAGMA quick_check;
