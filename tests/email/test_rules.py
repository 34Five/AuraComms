"""AXI-8 tier and state-machine contracts against the actual E07 schema/seed."""
from datetime import datetime, timezone
import importlib.util
import json
from pathlib import Path
import sqlite3
import unittest
import test_schema as base

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('email_rules', ROOT / 'scripts/email_rules.py')
rules = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rules)
ORG = 'e07_demo_org'
AURA = 'e07_demo_aura_sales'
MEMBER = 'e07_demo_reviewer'


class RulesTests(unittest.TestCase):
    clone = base.SchemaTests.clone
    tearDown = base.SchemaTests.tearDown

    def setUp(self):
        base.SchemaTests.setUp(self)
        self.original_reviews = [tuple(r) for r in self.db.execute('SELECT * FROM email_reviews ORDER BY id')]
        self.db.executescript((ROOT / 'scripts/0002_email_governance.sql').read_text())
        self.time = datetime(2026, 10, 22, 10, tzinfo=timezone.utc)
        self.engine = rules.RulesEngine(self.db, lambda: self.time)
        self.policy(1)
        self.db.commit()

    def policy(self, tier, **settings):
        self.db.execute('''UPDATE email_aura_policies SET tier=?,rules_json=?,version=version+1
            WHERE org_id=? AND aura_id=?''', (str(tier), json.dumps(settings), ORG, AURA))

    def draft(self, name='draft', thread='thread_quote'):
        self.clone('email_messages', 'msg_quote_draft', id=name, thread_id=thread,
                   send_idempotency_key='send-' + name, activity_at=self.engine.now(), created_at=self.engine.now())
        self.clone('email_message_recipients', 'recipient_msg_quote_draft', id='to-' + name, message_id=name)
        return name

    def evaluate(self, message):
        return self.engine.evaluate(ORG, AURA, message)

    def approve(self, result):
        return self.engine.decide(ORG, AURA, result['review_id'], MEMBER, 'approved')

    def send(self, result):
        return self.engine.mock_send(ORG, AURA, result['review_id'])

    def test_upgrade_preserves_all_existing_review_fields_and_foreign_keys(self):
        columns = [r[1] for r in self.db.execute('PRAGMA table_info(email_reviews)')
                   if r[1] not in ('decision_source', 'policy_snapshot_json')]
        actual = [tuple(r) for r in self.db.execute('SELECT ' + ','.join(columns) + ' FROM email_reviews ORDER BY id')]
        self.assertEqual(actual, self.original_reviews)
        self.assertEqual(self.db.execute('PRAGMA foreign_key_check').fetchall(), [])
        self.assertEqual(self.db.execute('PRAGMA integrity_check').fetchone()[0], 'ok')

    def test_tier_1_every_message_requires_human(self):
        for name in ('first', 'second'):
            result = self.evaluate(self.draft(name))
            self.assertEqual(result['decision'], 'hold for review')
            self.approve(result)
            self.send(result)

    def test_tier_2_first_then_later_automatic(self):
        self.policy(2)
        result = self.evaluate(self.draft())
        self.assertEqual(result['reason'], 'tier_2_first_outbound')
        self.approve(result)
        # Approval alone must not unlock a second draft.
        second = self.evaluate(self.draft('second'))
        self.assertEqual(second['decision'], 'hold for review')
        self.send(result)
        third = self.evaluate(self.draft('third'))
        self.assertEqual(third['decision'], 'send now')
        self.send(third)
        row = self.engine.review(ORG, AURA, third['review_id'])
        self.assertEqual((row['decision_source'], row['approver_member_id'], row['status']), ('automatic', None, 'sent'))

    def test_tier_2_new_outbound_thread_also_requires_review(self):
        self.policy(2)
        self.clone('email_threads', 'thread_quote', id='new-thread', first_message_id=None)
        self.assertEqual(self.evaluate(self.draft(thread='new-thread'))['decision'], 'hold for review')

    def test_tier_3_first_reply_then_later_automatic(self):
        self.policy(3)
        result = self.evaluate(self.draft())
        self.assertEqual(result['reason'], 'tier_3_first_inbound_reply')
        self.approve(result)
        self.send(result)
        self.assertEqual(self.evaluate(self.draft('second'))['decision'], 'send now')

    def test_tier_3_aura_initiated_mail_then_inbound_requires_first_reply_approval(self):
        self.policy(3)
        self.clone('email_threads', 'thread_quote', id='new-thread', first_message_id=None)
        result = self.evaluate(self.draft(thread='new-thread'))
        self.assertEqual(result['decision'], 'send now')
        self.send(result)
        self.time = datetime(2026, 10, 22, 11, tzinfo=timezone.utc)
        self.clone('email_messages', 'msg_quote_in', id='new-in', thread_id='new-thread', ingest_key='new-in',
                   activity_at=self.engine.now(), received_at=self.engine.now())
        self.assertEqual(self.evaluate(self.draft('reply', 'new-thread'))['decision'], 'hold for review')

    def test_tier_4_copies_and_automatic_review(self):
        self.policy(4, cc=['human@example.invalid'], bcc=['audit@example.invalid'])
        result = self.evaluate(self.draft())
        self.assertEqual(result['decision'], 'send now')
        self.assertEqual(self.evaluate('draft')['review_id'], result['review_id'])
        rows = self.db.execute("SELECT kind,address FROM email_message_recipients WHERE message_id='draft' AND kind<>'to' ORDER BY kind").fetchall()
        self.assertEqual([tuple(r) for r in rows], [('bcc', 'audit@example.invalid'), ('cc', 'human@example.invalid')])
        self.send(result)

    def start_proactive_tier_3(self):
        self.policy(3)
        self.clone('email_threads', 'thread_quote', id='proactive-thread', first_message_id=None)
        return self.evaluate(self.draft(thread='proactive-thread'))

    def receive_proactive_inbound(self, name='first-inbound'):
        self.clone('email_messages', 'msg_quote_in', id=name, thread_id='proactive-thread', ingest_key=name,
                   activity_at=self.engine.now(), received_at=self.engine.now())

    def test_tier_3_inbound_before_dispatch_invalidates_automatic_approval(self):
        result = self.start_proactive_tier_3()
        self.assertEqual(result['decision'], 'send now')
        self.time = datetime(2026, 10, 22, 11, tzinfo=timezone.utc)
        self.receive_proactive_inbound()
        with self.assertRaisesRegex(rules.GovernanceError, 'Stale'):
            self.send(result)
        self.assertEqual(self.db.execute("SELECT status,sent_at FROM email_messages WHERE id='draft'").fetchone()[:],
                         ('draft', None))
        self.assertEqual(self.evaluate(self.draft('first-reply', 'proactive-thread'))['decision'], 'hold for review')
        refreshed = self.evaluate('draft')
        self.assertEqual(refreshed['decision'], 'hold for review')
        self.assertNotEqual(refreshed['review_id'], result['review_id'])
        self.assertEqual(self.engine.review(ORG, AURA, result['review_id'])['status'], 'superseded')
        self.approve(refreshed)
        self.send(refreshed)
        self.assertEqual(self.evaluate(self.draft('later-reply', 'proactive-thread'))['decision'], 'send now')

    def test_tier_3_reevaluation_after_inbound_does_not_reuse_cached_automatic_review(self):
        result = self.start_proactive_tier_3()
        self.receive_proactive_inbound()
        refreshed = self.evaluate('draft')
        self.assertEqual(refreshed['status'], 'pending')
        self.assertNotEqual(refreshed['review_id'], result['review_id'])
        with self.assertRaises(rules.GovernanceError):
            self.send(result)

    def test_tier_3_same_timestamp_proactive_send_does_not_unlock_first_reply(self):
        result = self.start_proactive_tier_3()
        self.send(result)
        self.receive_proactive_inbound()
        # Proactive send, inbound, review and reply all share the same millisecond.
        sent_at = self.db.execute("SELECT sent_at FROM email_messages WHERE id='draft'").fetchone()[0]
        self.assertEqual(sent_at, self.engine.now())
        reply = self.evaluate(self.draft('first-reply', 'proactive-thread'))
        self.assertEqual(reply['decision'], 'hold for review')
        self.approve(reply)
        self.send(reply)
        self.assertEqual(self.evaluate(self.draft('later-reply', 'proactive-thread'))['decision'], 'send now')

    def test_tier_3_later_inbound_keeps_reviewed_thread_unlocked(self):
        self.start_proactive_tier_3()
        self.receive_proactive_inbound()
        reply = self.evaluate(self.draft('first-reply', 'proactive-thread'))
        self.approve(reply)
        self.send(reply)
        later = self.evaluate(self.draft('later-reply', 'proactive-thread'))
        self.time = datetime(2026, 10, 22, 11, tzinfo=timezone.utc)
        self.receive_proactive_inbound('second-inbound')
        self.assertEqual(self.evaluate('later-reply')['review_id'], later['review_id'])
        self.send(later)

    def test_send_advances_activity_and_preserves_actual_assignment_history(self):
        self.policy(4)
        result = self.evaluate(self.draft('delayed'))
        self.time = datetime(2026, 10, 22, 10, 30, tzinfo=timezone.utc)
        self.draft('newer-draft')
        self.time = datetime(2026, 10, 22, 11, tzinfo=timezone.utc)
        self.send(result)
        row = self.db.execute("SELECT activity_at,sent_at FROM email_messages WHERE id='delayed'").fetchone()
        self.assertEqual(tuple(row), (self.engine.now(), self.engine.now()))
        latest = self.db.execute("SELECT id FROM email_messages WHERE thread_id='thread_quote' ORDER BY activity_at DESC LIMIT 1").fetchone()[0]
        self.assertEqual(latest, 'delayed')
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE email_address_assignments SET ended_at='2026-10-22T10:30:00.000Z' WHERE id='assignment_sales'")

    def test_invalid_copy_addresses_never_modify_recipients_or_create_reviews(self):
        self.draft()
        invalid = ['<alice@example.invalid>', 'audit@example.invalid,', 'audit@example.invalid;',
                   'a\x00@example.invalid', 'a\x7f@example.invalid', 'a\x01@example.invalid',
                   'Name<a@example.invalid>', 'a@example.invalid\n', 'a..b@example.invalid',
                   '.a@example.invalid', 'a.@example.invalid', 'a@-example.invalid',
                   'a@example..invalid', 'a@example.invalid>', 'a@[127.0.0.1]',
                   'a' * 65 + '@example.invalid', 'a@' + 'b' * 64 + '.invalid']
        for kind in ('cc', 'bcc'):
            for address in invalid:
                with self.subTest(kind=kind, address=repr(address)):
                    # A valid cc entry must not be partially inserted if bcc is bad.
                    settings = {'cc': ['valid@example.invalid'], kind: [address]}
                    self.policy(4, **settings)
                    with self.assertRaises(rules.GovernanceError):
                        self.evaluate('draft')
                    self.assertEqual(self.db.execute("SELECT COUNT(*) FROM email_message_recipients WHERE message_id='draft' AND kind<>'to'").fetchone()[0], 0)
                    self.assertEqual(self.db.execute("SELECT COUNT(*) FROM email_reviews WHERE message_id='draft'").fetchone()[0], 0)

    def test_copy_addresses_allow_normal_dot_atom_mailboxes(self):
        self.policy(4, cc=["o'connor+sales@example.invalid", 'first.last@sub-domain.example.invalid'])
        result = self.evaluate(self.draft())
        self.assertEqual(result['decision'], 'send now')
        self.send(result)

    def test_daily_limit_reserves_approvals_and_releases_next_day(self):
        # Existing sales seed contains one sent message on this UTC day.
        self.policy(4, daily_limit=2)
        first = self.evaluate(self.draft())
        second = self.evaluate(self.draft('second'))
        self.assertEqual(first['decision'], 'send now')
        self.assertEqual(second['reason'], 'daily_limit')
        with self.assertRaises(rules.GovernanceError):
            self.approve(second)
        self.send(first)
        self.time = datetime(2026, 10, 23, 10, tzinfo=timezone.utc)
        self.approve(second)
        self.send(second)

    def test_daily_limit_rechecked_before_dispatch(self):
        self.policy(4, daily_limit=2)
        first = self.evaluate(self.draft())
        self.clone('email_messages', 'msg_failure', id='external-send', send_idempotency_key='external-send')
        with self.assertRaisesRegex(rules.GovernanceError, 'limit'):
            self.send(first)

    def test_rejected_cannot_send_or_be_approved_without_revision(self):
        result = self.evaluate(self.draft())
        self.engine.decide(ORG, AURA, result['review_id'], MEMBER, 'rejected')
        self.assertEqual(self.evaluate('draft')['status'], 'rejected')
        with self.assertRaises(rules.GovernanceError):
            self.send(result)
        with self.assertRaises(rules.GovernanceError):
            self.approve(result)

    def test_pending_cannot_send_and_humans_cannot_mark_sent(self):
        result = self.evaluate(self.draft())
        with self.assertRaises(rules.GovernanceError):
            self.send(result)
        with self.assertRaises(rules.GovernanceError):
            self.engine.decide(ORG, AURA, result['review_id'], MEMBER, 'sent')

    def test_unassigned_or_revoked_reviewer_denied(self):
        result = self.evaluate(self.draft())
        self.db.execute("INSERT INTO studio_members(org_id,member_id,role) VALUES (?,'outsider','admin')", (ORG,))
        for member in ('outsider', 'missing'):
            with self.assertRaises(rules.GovernanceError):
                self.engine.decide(ORG, AURA, result['review_id'], member, 'approved')
        self.approve(result)
        self.db.execute('UPDATE email_aura_reviewers SET revoked_at=? WHERE member_id=?', (self.engine.now(), MEMBER))
        with self.assertRaises(rules.GovernanceError):
            self.send(result)

    def test_cross_scope_and_inbound_denied(self):
        for org, aura, message in [('other', AURA, 'msg_quote_draft'),
                                   (ORG, 'e07_demo_aura_support', 'msg_quote_draft'),
                                   (ORG, AURA, 'msg_quote_in')]:
            with self.assertRaises(rules.GovernanceError):
                self.engine.evaluate(org, aura, message)

    def test_content_edit_requires_new_revision(self):
        result = self.evaluate(self.draft())
        self.approve(result)
        self.db.execute("UPDATE email_messages SET subject='Changed' WHERE id='draft'")
        with self.assertRaisesRegex(rules.GovernanceError, 'Stale'):
            self.send(result)
        revised = self.evaluate('draft')
        self.assertEqual(revised['status'], 'pending')
        self.assertEqual(self.engine.review(ORG, AURA, result['review_id'])['status'], 'superseded')
        self.assertEqual(self.engine.review(ORG, AURA, revised['review_id'])['edited_before_send'], 1)

    def test_recipient_and_attachment_edits_invalidate_hash(self):
        for edit in ("UPDATE email_message_recipients SET address='changed@example.invalid' WHERE message_id='draft'",
                     "INSERT INTO email_attachments(id,org_id,aura_id,message_id,ordinal,content_type,size_bytes,r2_key) VALUES ('new', 'e07_demo_org','e07_demo_aura_sales','draft',0,'text/plain',1,'immutable-key')"):
            with self.subTest(edit=edit):
                self.db.execute('SAVEPOINT test_edit')
                self.policy(4)
                result = self.evaluate(self.draft())
                self.db.execute(edit)
                with self.assertRaisesRegex(rules.GovernanceError, 'Stale'):
                    self.send(result)
                self.db.execute('ROLLBACK TO test_edit')
                self.db.execute('RELEASE test_edit')

    def test_policy_change_invalidates_approval(self):
        self.policy(4)
        result = self.evaluate(self.draft())
        self.policy(1)
        with self.assertRaisesRegex(rules.GovernanceError, 'Stale'):
            self.send(result)
        self.assertEqual(self.evaluate('draft')['status'], 'pending')

    def test_reset_supersedes_pending_and_approved_and_relocks_tier_2_and_3(self):
        for tier in (2, 3):
            with self.subTest(tier=tier):
                self.policy(tier)
                result = self.evaluate(self.draft('first-' + str(tier)))
                self.approve(result)
                self.send(result)
                pending_send = self.evaluate(self.draft('next-' + str(tier)))
                self.assertEqual(pending_send['decision'], 'send now')
                self.engine.reset_thread(ORG, AURA, 'thread_quote', MEMBER)
                with self.assertRaises(rules.GovernanceError):
                    self.send(pending_send)
                self.assertEqual(self.evaluate('next-' + str(tier))['decision'], 'hold for review')

    def test_disabled_route_and_closed_assignment_block_send(self):
        self.policy(4)
        result = self.evaluate(self.draft())
        self.db.execute("UPDATE email_addresses SET status='disabled',disabled_at=? WHERE id='addr_sales'", (self.engine.now(),))
        with self.assertRaises(rules.GovernanceError):
            self.send(result)
        self.db.execute("UPDATE email_addresses SET status='active',disabled_at=NULL WHERE id='addr_sales'")
        self.db.execute("UPDATE email_address_assignments SET ended_at='2026-10-22T10:01:00.000Z' WHERE id='assignment_sales'")
        with self.assertRaises(rules.GovernanceError):
            self.send(result)

    def test_replay_does_not_duplicate_reviews_or_sends(self):
        self.policy(4)
        result = self.evaluate(self.draft())
        self.assertEqual(self.evaluate('draft'), result)
        self.send(result)
        self.assertEqual(self.send(result)['decision'], 'already sent')
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM email_reviews WHERE message_id='draft'").fetchone()[0], 1)

    def test_invalid_policy_fails_closed_and_rolls_back(self):
        self.draft()
        for tier, settings in [(0, {}), (4, {'unknown': True}), (4, {'daily_limit': True}),
                               (4, {'cc': ['invalid\r\n@example.invalid']})]:
            self.policy(tier, **settings)
            with self.assertRaises(rules.GovernanceError):
                self.evaluate('draft')
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM email_reviews WHERE message_id='draft'").fetchone()[0], 0)

    def test_upgrade_still_rejects_fake_human_or_automatic_rejection(self):
        self.policy(4)
        result = self.evaluate(self.draft())
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE email_reviews SET decision_source='human' WHERE id=?", (result['review_id'],))
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE email_reviews SET status='rejected' WHERE id=?", (result['review_id'],))
