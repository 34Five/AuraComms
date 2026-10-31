"""Contract checks using SQLite with foreign-key enforcement enabled."""
from pathlib import Path
import sqlite3
import unittest

ROOT = Path(__file__).resolve().parents[2]
ORG = 'e07_demo_org'
AURA = 'e07_demo_aura_sales'

class SchemaTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(':memory:')
        self.db.row_factory = sqlite3.Row
        self.db.execute('PRAGMA foreign_keys=ON')
        for name in ('tests/email/fixtures/studio_parents_2026_10_22.sql','scripts/0001_email_model.sql','scripts/email/seed.sql'):
            self.db.executescript((ROOT/name).read_text())

    def tearDown(self):
        self.db.close()

    def clone(self, table, source_id, **overrides):
        row = dict(self.db.execute('SELECT * FROM '+table+' WHERE id=?',(source_id,)).fetchone())
        row.update(overrides)
        self.db.execute('INSERT INTO '+table+' ('+','.join(row)+') VALUES ('+','.join('?' for _ in row)+')',tuple(row.values()))

    def reject(self, fn):
        with self.assertRaises(sqlite3.IntegrityError):
            fn()

    def test_seed_and_integrity(self):
        self.assertEqual(self.db.execute('PRAGMA integrity_check').fetchone()[0],'ok')
        self.assertEqual(self.db.execute('PRAGMA foreign_key_check').fetchall(),[])
        self.assertEqual(self.db.execute('SELECT count(DISTINCT org_id), count(*) FROM auras').fetchone()[:],(1,2))
        self.assertEqual(self.db.execute('SELECT count(*) FROM email_messages').fetchone()[0],6)

    def test_cross_org_aura_rejected(self):
        self.reject(lambda:self.clone('email_threads','thread_quote',id='bad-thread',org_id='other-org',first_message_id=None))

    def test_cross_aura_address_rejected(self):
        self.reject(lambda:self.clone('email_messages','msg_quote_draft',id='bad-message',email_address_id='addr_support',send_idempotency_key='new-send'))

    def test_cross_aura_thread_rejected(self):
        self.reject(lambda:self.clone('email_messages','msg_quote_draft',id='bad-message',thread_id='thread_support',send_idempotency_key='new-send'))

    def test_first_message_must_belong_to_thread(self):
        self.reject(lambda:self.db.execute("UPDATE email_threads SET first_message_id='msg_failure' WHERE id='thread_quote'"))

    def test_message_scope_immutable(self):
        self.reject(lambda:self.db.execute("UPDATE email_messages SET thread_id='thread_failure' WHERE id='msg_quote_draft'"))

    def test_ingest_dedup(self):
        self.reject(lambda:self.clone('email_messages','msg_quote_in',id='duplicate-ingest'))

    def test_send_dedup(self):
        self.reject(lambda:self.clone('email_messages','msg_quote_draft',id='duplicate-send'))

    def test_missing_and_duplicate_rfc_ids_allowed(self):
        self.clone('email_messages','msg_quote_in',id='other-delivery',ingest_key='other-ingest')
        self.assertIsNone(self.db.execute("SELECT rfc_message_id FROM email_messages WHERE id='msg_quote_draft'").fetchone()[0])

    def test_inline_body_budget_and_byte_count(self):
        self.reject(lambda:self.db.execute("UPDATE email_messages SET body_text=?, body_size_bytes=? WHERE id='msg_quote_in'",('x'*65537,65537)))
        self.reject(lambda:self.db.execute("UPDATE email_messages SET body_text='é', body_size_bytes=1 WHERE id='msg_quote_in'"))
        self.db.execute("UPDATE email_messages SET body_text='é', body_size_bytes=2 WHERE id='msg_quote_in'")

    def test_r2_body_requires_reference_and_no_inline_body(self):
        self.reject(lambda:self.db.execute("UPDATE email_messages SET body_r2_key=NULL WHERE id='msg_large'"))
        self.reject(lambda:self.db.execute("UPDATE email_messages SET body_text='duplicate body' WHERE id='msg_large'"))

    def test_review_pending_uniqueness(self):
        self.reject(lambda:self.clone('email_reviews','review_quote',id='duplicate-pending',revision=2))

    def test_review_member_tenant(self):
        self.db.execute("INSERT INTO studio_members(org_id,member_id,role) VALUES ('other-org','other-member','admin')")
        self.reject(lambda:self.db.execute("UPDATE email_reviews SET status='approved',approver_member_id='other-member',decided_at='2026-10-22T09:00:00.000Z',reviewed_content_sha256=? WHERE id='review_quote'",('a'*64,)))

    def test_review_inbound_rejected(self):
        self.reject(lambda:self.clone('email_reviews','review_quote',id='bad-review',message_id='msg_quote_in'))

    def test_review_decision_requires_actor_time_and_content(self):
        self.reject(lambda:self.db.execute("UPDATE email_reviews SET status='approved' WHERE id='review_quote'"))

    def test_event_recipient_belongs_to_same_message(self):
        self.reject(lambda:self.clone('email_events','evt_bounced',id='bad-event',dedup_key='new-event',recipient_id='recipient_msg_quote_draft'))

    def test_event_replay_dedup(self):
        self.reject(lambda:self.clone('email_events','evt_bounced',id='replayed-event'))

    def test_event_raw_payload_valid_and_bounded(self):
        self.reject(lambda:self.db.execute("UPDATE email_events SET raw_payload_json='invalid' WHERE id='evt_bounced'"))
        self.reject(lambda:self.db.execute("UPDATE email_events SET raw_payload_json=? WHERE id='evt_bounced'",('"'+'x'*65536+'"',)))

    def test_delivery_failure_does_not_rewrite_send_history(self):
        self.assertEqual(self.db.execute("SELECT status FROM email_messages WHERE id='msg_failure'").fetchone()[0],'sent')
        self.assertEqual(self.db.execute("SELECT delivery_status FROM email_message_recipients WHERE id='recipient_msg_failure'").fetchone()[0],'bounced')

    def test_contact_tenant_isolation(self):
        self.reject(lambda:self.clone('email_contacts','contact_alex',id='duplicate-contact'))
        self.clone('email_contacts','contact_alex',id='other-contact',org_id='other-org')
        self.reject(lambda:self.db.execute("UPDATE email_messages SET sender_contact_id='other-contact' WHERE id='msg_quote_in'"))

    def test_address_release_keeps_unique_reservation(self):
        self.db.execute("UPDATE email_addresses SET status='released',disabled_at='2026-10-22T09:00:00.000Z',released_at='2026-10-22T09:01:00.000Z' WHERE id='addr_sales'")
        self.reject(lambda:self.clone('email_addresses','addr_sales',id='reused-address'))

    def test_inbox_query_and_index(self):
        sql=(ROOT/'scripts/email/inbox.sql').read_text().split('LIMIT :page_size;')[0]+'LIMIT :page_size;'
        params=dict(org_id=ORG,aura_id=AURA,inbox_status='open',tier='demo_review_required',date_from='2026-10-01T00:00:00.000Z',date_to='2026-11-01T00:00:00.000Z',cursor_activity_at='2026-11-01T00:00:00.000Z',cursor_id='z',direction='in',message_status='received',page_size=20)
        rows=self.db.execute(sql,params).fetchall()
        self.assertEqual([r['id'] for r in rows],['thread_quote'])
        plan=' '.join(r[3] for r in self.db.execute('EXPLAIN QUERY PLAN '+sql,params))
        self.assertIn('idx_email_threads_',plan)
        self.assertIn('idx_email_messages_',plan)

