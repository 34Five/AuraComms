#!/usr/bin/env python3
"""Run all four governance tiers on E07 seed mail, entirely in memory."""
from datetime import datetime, timezone
from pathlib import Path
import sqlite3
from email_rules import RulesEngine

ROOT = Path(__file__).resolve().parents[1]
ORG = 'e07_demo_org'
AURA = 'e07_demo_aura_sales'
MEMBER = 'e07_demo_reviewer'


def main():
    print('Tier | First outbound/reply | Later reply | Final review states')
    print('---- | -------------------- | ----------- | -------------------')
    for tier in range(1, 5):
        with sqlite3.connect(':memory:') as db:
            db.execute('PRAGMA foreign_keys=ON')
            for source in ('tests/email/fixtures/studio_parents_2026_10_22.sql',
                           'scripts/0001_email_model.sql', 'scripts/email/seed.sql',
                           'scripts/0002_email_governance.sql'):
                db.executescript((ROOT / source).read_text())
            db.execute('UPDATE email_aura_policies SET tier=?,version=version+1 WHERE org_id=? AND aura_id=?',
                       (str(tier), ORG, AURA))
            engine = RulesEngine(db, lambda: datetime(2026, 10, 22, 10, tzinfo=timezone.utc))
            decisions = []
            for number in (1, 2):
                message_id = 'demo-' + str(number)
                row = dict(db.execute("SELECT * FROM email_messages WHERE id='msg_quote_draft'").fetchone())
                row.update(id=message_id, send_idempotency_key=message_id)
                db.execute('INSERT INTO email_messages (' + ','.join(row) + ') VALUES (' +
                           ','.join('?' for _ in row) + ')', tuple(row.values()))
                db.execute('''INSERT INTO email_message_recipients
                    (id,org_id,aura_id,message_id,kind,ordinal,address,address_key)
                    VALUES (?,?,?,?,'to',0,'alex@example.invalid','alex@example.invalid')''',
                           ('to-' + message_id, ORG, AURA, message_id))
                result = engine.evaluate(ORG, AURA, message_id)
                decisions.append(result['decision'])
                if result['status'] == 'pending':
                    engine.decide(ORG, AURA, result['review_id'], MEMBER, 'approved')
                engine.mock_send(ORG, AURA, result['review_id'])
            states = [r[0] for r in db.execute("SELECT status FROM email_reviews WHERE message_id IN ('demo-1','demo-2') ORDER BY message_id")]
            print(f"{tier} | {decisions[0]} | {decisions[1]} | {', '.join(states)}")
            assert not db.execute('PRAGMA foreign_key_check').fetchall()
    print('\nAll sends are mocked. Each tier uses a fresh copy of the E07 seed in memory.')


if __name__ == '__main__':
    main()
