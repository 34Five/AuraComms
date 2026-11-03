"""AXI-8 local SQLite reference engine. No network or real email dispatch.

Callers supply authenticated org/Aura/member identities, never request-body claims.
Each operation uses a savepoint: it is atomic and leaves commit ownership to callers.
"""
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import json
import sqlite3
from uuid import uuid4


class GovernanceError(ValueError):
    pass


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False)


class RulesEngine:
    def __init__(self, db, clock=None):
        self.db = db
        self.db.row_factory = sqlite3.Row
        if not db.execute('PRAGMA foreign_keys').fetchone()[0]:
            raise GovernanceError('Foreign keys must be enabled')
        self.clock = clock or (lambda: datetime.now(timezone.utc))

    def now(self):
        return self.clock().astimezone(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')

    @contextmanager
    def atomic(self):
        self.db.execute('SAVEPOINT governance')
        try:
            yield
        except Exception:
            self.db.execute('ROLLBACK TO governance')
            raise
        finally:
            self.db.execute('RELEASE governance')

    def one(self, sql, args=()):
        row = self.db.execute(sql, args).fetchone()
        if row is None:
            raise GovernanceError('Record not found in requested tenant/Aura scope')
        return dict(row)

    def message(self, org, aura, message):
        row = self.one('SELECT * FROM email_messages WHERE org_id=? AND aura_id=? AND id=?', (org, aura, message))
        if row['direction'] != 'out':
            raise GovernanceError('Only outbound messages can be reviewed')
        return row

    def thread(self, msg):
        return self.one('SELECT * FROM email_threads WHERE org_id=? AND aura_id=? AND id=?',
                        (msg['org_id'], msg['aura_id'], msg['thread_id']))

    def reviewer(self, org, aura, member):
        self.one('''SELECT r.member_id FROM email_aura_reviewers r
            JOIN studio_members m ON m.org_id=r.org_id AND m.member_id=r.member_id
            WHERE r.org_id=? AND r.aura_id=? AND r.member_id=? AND r.revoked_at IS NULL''', (org, aura, member))

    def policy(self, org, aura):
        row = self.one('SELECT * FROM email_aura_policies WHERE org_id=? AND aura_id=?', (org, aura))
        if row['tier'] not in ('1', '2', '3', '4'):
            raise GovernanceError('Configure tier as 1, 2, 3 or 4 before evaluation')
        rules = json.loads(row['rules_json'])
        if set(rules) - {'cc', 'bcc', 'daily_limit'}:
            raise GovernanceError('Unsupported guardrail; refusing to ignore it')
        for kind in ('cc', 'bcc'):
            addresses = rules.get(kind, [])
            if not isinstance(addresses, list) or any(
                not isinstance(a, str) or a.count('@') != 1 or any(c.isspace() for c in a)
                or not all(a.split('@')) for a in addresses
            ):
                raise GovernanceError('cc/bcc must be lists of bare email addresses')
        limit = rules.get('daily_limit')
        if limit is not None and (type(limit) is not int or limit < 1):
            raise GovernanceError('daily_limit must be a positive integer or null')
        return {'tier': row['tier'], 'version': row['version'], 'rules': rules}

    def fingerprint(self, msg):
        # Delivery metadata is excluded; anything the recipient sees is included.
        fields = ('from_address', 'from_name', 'envelope_from', 'envelope_to', 'subject',
                  'reply_to_json', 'body_storage', 'body_text', 'body_html', 'body_r2_key',
                  'body_size_bytes', 'in_reply_to', 'references_json', 'rfc_message_id')
        scope = (msg['org_id'], msg['aura_id'], msg['id'])
        recipients = [dict(r) for r in self.db.execute('''SELECT kind,ordinal,address,address_key,display_name
            FROM email_message_recipients WHERE org_id=? AND aura_id=? AND message_id=? ORDER BY kind,ordinal''', scope)]
        attachments = [dict(r) for r in self.db.execute('''SELECT ordinal,filename,content_type,size_bytes,r2_key,content_id,disposition
            FROM email_attachments WHERE org_id=? AND aura_id=? AND message_id=? ORDER BY ordinal''', scope)]
        return hashlib.sha256(canonical({'message': {k: msg[k] for k in fields},
                                       'recipients': recipients, 'attachments': attachments}).encode()).hexdigest()

    def add_copies(self, msg, policy):
        if policy['tier'] != '4':
            return
        scope = (msg['org_id'], msg['aura_id'], msg['id'])
        for kind in ('cc', 'bcc'):
            for address in policy['rules'].get(kind, []):
                if self.db.execute('''SELECT 1 FROM email_message_recipients
                    WHERE org_id=? AND aura_id=? AND message_id=? AND kind=? AND address_key=?''',
                                   (*scope, kind, address.lower())).fetchone():
                    continue
                ordinal = self.db.execute('''SELECT COALESCE(MAX(ordinal),-1)+1 FROM email_message_recipients
                    WHERE org_id=? AND aura_id=? AND message_id=? AND kind=?''', (*scope, kind)).fetchone()[0]
                self.db.execute('''INSERT INTO email_message_recipients
                    (id,org_id,aura_id,message_id,kind,ordinal,address,address_key) VALUES (?,?,?,?,?,?,?,?)''',
                                (uuid4().hex, *scope, kind, ordinal, address, address.lower()))

    def limit_reached(self, msg, policy, now):
        limit = policy['rules'].get('daily_limit')
        if limit is None:
            return False
        # Count sent mail plus today's unsent approvals (reserved slots), once/message.
        count = self.db.execute('''SELECT COUNT(*) FROM email_messages m
            WHERE m.org_id=? AND m.aura_id=? AND m.direction='out' AND m.id<>? AND
            ((m.status='sent' AND substr(m.sent_at,1,10)=?) OR
             (m.status NOT IN ('sent','cancelled') AND EXISTS (SELECT 1 FROM email_reviews r
              WHERE r.message_id=m.id AND r.status='approved' AND substr(r.decided_at,1,10)=?)))''',
                                (msg['org_id'], msg['aura_id'], msg['id'], now[:10], now[:10])).fetchone()[0]
        return count >= limit

    def reason(self, msg, thread, policy, now):
        if self.limit_reached(msg, policy, now):
            return 'daily_limit'
        tier = policy['tier']
        if tier == '1':
            return 'tier_1_every_message'
        if tier == '4':
            return None
        scope = (msg['org_id'], msg['aura_id'], msg['thread_id'])
        inbound = self.db.execute('''SELECT MIN(activity_at) FROM email_messages
            WHERE org_id=? AND aura_id=? AND thread_id=? AND direction='in' AND activity_at<=?''',
                                  (*scope, now)).fetchone()[0]
        # Tier 3 only gates a reply after an inbound; Aura-initiated mail is automatic.
        if tier == '3' and inbound is None:
            return None
        sent = self.db.execute('''SELECT 1 FROM email_messages m WHERE m.org_id=? AND m.aura_id=?
            AND m.thread_id=? AND m.direction='out' AND m.status='sent' AND m.id<>?
            AND m.sent_at<=? AND (? IS NULL OR m.sent_at>=?) AND
            (?=0 OR EXISTS (SELECT 1 FROM email_reviews r WHERE r.message_id=m.id
              AND r.status='sent' AND r.thread_review_epoch=?)) LIMIT 1''',
                               (*scope, msg['id'], now, inbound if tier == '3' else None,
                                inbound, thread['review_epoch'], thread['review_epoch'])).fetchone()
        if sent:
            return None
        return 'tier_2_first_outbound' if tier == '2' else 'tier_3_first_inbound_reply'

    def evaluate(self, org, aura, message):
        with self.atomic():
            msg = self.message(org, aura, message)
            if msg['status'] not in ('draft', 'queued'):
                raise GovernanceError('Evaluate only draft or queued messages')
            thread = self.thread(msg)
            policy = self.policy(org, aura)
            now = self.now()
            self.add_copies(msg, policy)
            digest = self.fingerprint(msg)
            latest = self.db.execute('''SELECT * FROM email_reviews WHERE org_id=? AND aura_id=?
                AND message_id=? ORDER BY revision DESC LIMIT 1''', (org, aura, message)).fetchone()
            snapshot = canonical(policy)
            if latest and latest['status'] in ('pending', 'approved', 'rejected'):
                if (latest['thread_review_epoch'] == thread['review_epoch']
                        and latest['reviewed_content_sha256'] == digest
                        and latest['policy_snapshot_json'] == snapshot):
                    return self.result(dict(latest))
                self.db.execute("UPDATE email_reviews SET status='superseded' WHERE id=?", (latest['id'],))
            reason = self.reason(msg, thread, policy, now)
            status = 'pending' if reason else 'approved'
            review = uuid4().hex
            self.db.execute('''INSERT INTO email_reviews
                (id,org_id,aura_id,message_id,revision,tier_applied,thread_review_epoch,status,
                 decision_source,policy_snapshot_json,reviewed_content_sha256,reason,requested_at,decided_at,edited_before_send)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)''',
                (review, org, aura, message, latest['revision'] + 1 if latest else 1, policy['tier'],
                 thread['review_epoch'], status, 'human' if reason else 'automatic', snapshot,
                 digest, reason or 'tier_automatic', now, now if not reason else None,
                 int(bool(latest and latest['reviewed_content_sha256'] != digest))))
            self.db.execute('''UPDATE email_threads SET current_tier=?,tier_state=?,state_version=state_version+1
                WHERE org_id=? AND aura_id=? AND id=?''', (policy['tier'], status, org, aura, msg['thread_id']))
            return self.result(self.review(org, aura, review))

    @staticmethod
    def result(review):
        return {'decision': 'send now' if review['status'] == 'approved' else 'hold for review',
                'review_id': review['id'], 'status': review['status'],
                'tier': review['tier_applied'], 'reason': review['reason']}

    def review(self, org, aura, review):
        return self.one('SELECT * FROM email_reviews WHERE org_id=? AND aura_id=? AND id=?', (org, aura, review))

    def fresh(self, review, msg):
        policy = self.policy(msg['org_id'], msg['aura_id'])
        if (review['thread_review_epoch'] != self.thread(msg)['review_epoch']
                or review['reviewed_content_sha256'] != self.fingerprint(msg)
                or review['policy_snapshot_json'] != canonical(policy)):
            raise GovernanceError('Stale review: evaluate the current content, policy and epoch again')
        return policy

    def decide(self, org, aura, review_id, member, outcome):
        if outcome not in ('approved', 'rejected'):
            raise GovernanceError('A reviewer may only approve or reject')
        with self.atomic():
            review = self.review(org, aura, review_id)
            self.reviewer(org, aura, member)
            if review['status'] != 'pending':
                raise GovernanceError('Only pending reviews can be decided')
            msg = self.message(org, aura, review['message_id'])
            policy = self.fresh(review, msg)
            if msg['status'] not in ('draft', 'queued'):
                raise GovernanceError('Message is no longer reviewable')
            now = self.now()
            if outcome == 'approved' and self.limit_reached(msg, policy, now):
                raise GovernanceError('Daily limit cannot be bypassed by approval')
            self.db.execute('''UPDATE email_reviews SET status=?,approver_member_id=?,decided_at=?,decision_source='human'
                WHERE id=?''', (outcome, member, now, review_id))
            self.db.execute('''UPDATE email_threads SET tier_state=?,state_version=state_version+1
                WHERE org_id=? AND aura_id=? AND id=?''', (outcome, org, aura, msg['thread_id']))
            return self.result(self.review(org, aura, review_id))

    def mock_send(self, org, aura, review_id):
        """Trusted mock sender only. The live adapter must implement its own dispatch boundary."""
        with self.atomic():
            review = self.review(org, aura, review_id)
            msg = self.message(org, aura, review['message_id'])
            if review['status'] == 'sent' and msg['status'] == 'sent':
                return self.result(review) | {'decision': 'already sent'}
            if review['status'] != 'approved' or msg['status'] not in ('draft', 'queued'):
                raise GovernanceError('Only approved, unsent messages may be sent')
            policy = self.fresh(review, msg)
            if review['decision_source'] == 'human':
                self.reviewer(org, aura, review['approver_member_id'])
            now = self.now()
            if self.limit_reached(msg, policy, now):
                raise GovernanceError('Daily limit reached')
            self.one('''SELECT a.id FROM email_address_assignments a
                JOIN email_addresses e ON e.org_id=a.org_id AND e.id=a.address_id
                JOIN email_domains d ON d.org_id=e.org_id AND d.id=e.domain_id
                WHERE a.org_id=? AND a.aura_id=? AND a.id=? AND a.ended_at IS NULL
                AND a.assigned_at<=? AND e.status='active' AND d.status='active' ''',
                     (org, aura, msg['address_assignment_id'], now))
            self.db.execute("UPDATE email_messages SET status='sent',sent_at=? WHERE id=?", (now, msg['id']))
            self.db.execute("UPDATE email_reviews SET status='sent',sent_at=? WHERE id=?", (now, review_id))
            self.db.execute('''UPDATE email_threads SET tier_state='sent',last_activity_at=MAX(last_activity_at,?),
                state_version=state_version+1 WHERE org_id=? AND aura_id=? AND id=?''',
                            (now, org, aura, msg['thread_id']))
            return self.result(self.review(org, aura, review_id)) | {'decision': 'mock sent'}

    def reset_thread(self, org, aura, thread_id, member):
        """Explicit authorized hook; new participants/forwards do not auto-reset threads."""
        with self.atomic():
            self.reviewer(org, aura, member)
            self.one('SELECT id FROM email_threads WHERE org_id=? AND aura_id=? AND id=?', (org, aura, thread_id))
            self.db.execute('''UPDATE email_threads SET review_epoch=review_epoch+1,state_version=state_version+1,
                review_reset_at=?,review_reset_by_member_id=?,tier_state='reset'
                WHERE org_id=? AND aura_id=? AND id=?''', (self.now(), member, org, aura, thread_id))
            self.db.execute('''UPDATE email_reviews SET status='superseded'
                WHERE org_id=? AND aura_id=? AND status IN ('pending','approved') AND message_id IN
                (SELECT id FROM email_messages WHERE org_id=? AND aura_id=? AND thread_id=?)''',
                            (org, aura, org, aura, thread_id))
