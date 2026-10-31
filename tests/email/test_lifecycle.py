"""Review regressions: temporal ownership, domain scope and reproducible execution."""
import importlib.util
from pathlib import Path
import sqlite3
import tempfile
import unittest
import hashlib
import json
import test_schema as base

ORG = 'e07_demo_org'
SALES = 'e07_demo_aura_sales'
SUPPORT = 'e07_demo_aura_support'
ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('email_schema', ROOT / 'scripts/email_schema.py')
tool = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tool)


class LifecycleTests(unittest.TestCase):
    setUp = base.SchemaTests.setUp
    tearDown = base.SchemaTests.tearDown
    clone = base.SchemaTests.clone
    reject = base.SchemaTests.reject

    def reassign(self):
        self.db.execute("UPDATE email_address_assignments SET ended_at='2026-10-22T10:00:00.000Z' WHERE id='assignment_sales'")
        self.db.execute("INSERT INTO email_address_assignments(id,org_id,address_id,aura_id,assigned_at) VALUES ('assignment_sales_new',?,'addr_sales',?,'2026-10-22T10:00:00.000Z')",(ORG,SUPPORT))

    def test_reassign_after_mail_preserves_history_and_new_owner(self):
        self.reassign()
        self.clone('email_messages','msg_quote_in',id='new_owner_mail',aura_id=SUPPORT,thread_id='thread_support',address_assignment_id='assignment_sales_new',ingest_key='new-owner',activity_at='2026-10-22T10:00:00.000Z',received_at='2026-10-22T10:00:00.000Z')
        self.assertEqual(self.db.execute("SELECT aura_id,address_assignment_id FROM email_messages WHERE id='msg_quote_in'").fetchone()[:],(SALES,'assignment_sales'))
        self.assertEqual(self.db.execute("SELECT aura_id,address_assignment_id FROM email_messages WHERE id='new_owner_mail'").fetchone()[:],(SUPPORT,'assignment_sales_new'))
        self.assertEqual(self.db.execute("SELECT aura_id FROM email_address_assignments WHERE address_id='addr_sales' AND ended_at IS NULL").fetchone()[0],SUPPORT)
        self.assertEqual(self.db.execute('PRAGMA foreign_key_check').fetchall(),[])

    def test_two_current_assignments_rejected(self):
        self.reject(lambda:self.clone('email_address_assignments','assignment_sales',id='duplicate-owner',aura_id=SUPPORT))

    def test_historical_overlap_rejected(self):
        self.reassign()
        self.reject(lambda:self.clone('email_address_assignments','assignment_sales',id='overlap',assigned_at='2026-10-22T08:30:00.000Z',ended_at='2026-10-22T08:45:00.000Z'))

    def test_zero_length_assignment_rejected(self):
        self.reject(lambda:self.db.execute("UPDATE email_address_assignments SET ended_at=assigned_at WHERE id='assignment_sales'"))

    def test_assignment_end_cannot_exclude_existing_mail(self):
        self.reject(lambda:self.db.execute("UPDATE email_address_assignments SET ended_at='2026-10-22T09:00:00.000Z' WHERE id='assignment_sales'"))

    def test_closed_assignment_cannot_reopen(self):
        self.reassign()
        self.reject(lambda:self.db.execute("UPDATE email_address_assignments SET ended_at=NULL WHERE id='assignment_sales'"))

    def test_assignment_cannot_rewrite_historical_aura(self):
        self.reject(lambda:self.db.execute("UPDATE email_address_assignments SET aura_id=? WHERE id='assignment_sales'",(SUPPORT,)))

    def test_old_assignment_rejects_new_mail(self):
        self.reassign()
        self.reject(lambda:self.clone('email_messages','msg_quote_in',id='stale-mail',ingest_key='stale',activity_at='2026-10-22T10:01:00.000Z'))

    def test_late_ingestion_uses_historical_assignment(self):
        self.reassign()
        self.clone('email_messages','msg_quote_in',id='late-mail',ingest_key='late',activity_at='2026-10-22T09:30:00.000Z',received_at='2026-10-22T09:30:00.000Z')

    def test_message_cannot_change_assignment(self):
        self.reassign()
        self.reject(lambda:self.db.execute("UPDATE email_messages SET address_assignment_id='assignment_sales_new' WHERE id='msg_quote_in'"))

    def test_message_time_cannot_escape_assignment(self):
        self.reassign()
        self.reject(lambda:self.db.execute("UPDATE email_messages SET activity_at='2026-10-22T10:01:00.000Z' WHERE id='msg_quote_in'"))

    def test_released_address_cannot_be_reassigned(self):
        self.db.execute("UPDATE email_address_assignments SET ended_at='2026-10-22T10:00:00.000Z' WHERE id='assignment_sales'")
        self.db.execute("UPDATE email_addresses SET status='released',disabled_at='2026-10-22T10:00:00.000Z',released_at='2026-10-22T10:00:00.000Z' WHERE id='addr_sales'")
        self.reject(lambda:self.db.execute("INSERT INTO email_address_assignments(id,org_id,address_id,aura_id,assigned_at) VALUES ('released',?,'addr_sales',?,'2026-10-22T11:00:00.000Z')",(ORG,SUPPORT)))

    def test_assignment_cannot_use_other_org_aura(self):
        self.db.execute("INSERT INTO auras(id,name,org_id) VALUES ('other-aura','Other','other-org')")
        self.db.execute("UPDATE email_address_assignments SET ended_at='2026-10-22T10:00:00.000Z' WHERE id='assignment_sales'")
        self.reject(lambda:self.db.execute("INSERT INTO email_address_assignments(id,org_id,address_id,aura_id,assigned_at) VALUES ('cross-org',?,'addr_sales','other-aura','2026-10-22T11:00:00.000Z')",(ORG,)))

    def test_domain_and_address_must_share_org(self):
        self.clone('email_domains','domain_default',id='other-domain',org_id='other-org',domain='other.invalid',domain_key='other.invalid')
        self.reject(lambda:self.clone('email_addresses','addr_sales',id='cross-domain',domain_id='other-domain',local_part='other',address='other@other.invalid',address_key='other@other.invalid'))

    def test_address_must_match_domain_name(self):
        self.reject(lambda:self.clone('email_addresses','addr_sales',id='bad-domain',local_part='new',address='new@wrong.invalid',address_key='new@wrong.invalid'))

    def test_same_local_part_on_different_domains(self):
        self.clone('email_addresses','addr_sales',id='custom-sales',domain_id='domain_custom',address='sales@demo.example.invalid',address_key='sales@demo.example.invalid')

    def test_domain_and_address_identities_immutable(self):
        self.reject(lambda:self.db.execute("UPDATE email_domains SET domain_key='changed.invalid' WHERE id='domain_default'"))
        self.reject(lambda:self.db.execute("UPDATE email_addresses SET domain_id='domain_custom' WHERE id='addr_sales'"))

    def test_domain_activation_requires_verification(self):
        self.reject(lambda:self.db.execute("UPDATE email_domains SET status='active' WHERE id='domain_custom'"))
        self.db.execute("UPDATE email_domains SET status='active',verified_at='2026-10-22T10:00:00.000Z',activated_at='2026-10-22T10:00:00.000Z' WHERE id='domain_custom'")

    def test_multiple_reviewers_and_revocation(self):
        self.db.execute("INSERT INTO studio_members(org_id,member_id,role) VALUES (?,'second','admin')",(ORG,))
        self.db.execute("INSERT INTO email_aura_reviewers(org_id,aura_id,member_id) VALUES (?,?,'second')",(ORG,SALES))
        count=lambda:self.db.execute('SELECT count(*) FROM email_aura_reviewers WHERE org_id=? AND aura_id=? AND revoked_at IS NULL',(ORG,SALES)).fetchone()[0]
        self.assertEqual(count(),2)
        self.db.execute("UPDATE email_aura_reviewers SET revoked_at='2026-10-22T10:00:00.000Z' WHERE member_id='second'")
        self.assertEqual(count(),1)

    def test_contact_member_link_must_be_valid(self):
        self.db.execute("UPDATE email_contacts SET member_id='e07_demo_reviewer' WHERE id='contact_alex'")
        self.reject(lambda:self.db.execute("UPDATE email_contacts SET member_id='missing' WHERE id='contact_alex'"))

    def test_policy_requires_json_object(self):
        self.reject(lambda:self.db.execute("UPDATE email_aura_policies SET rules_json='[]'"))

    def test_current_route_uses_new_owner_after_reassignment(self):
        query=(ROOT/'scripts/email/current_address.sql').read_text()
        params={'address_key':'sales@demo.34five.studio'}
        self.assertEqual(self.db.execute(query,params).fetchone()['aura_id'],SALES)
        self.reassign()
        route=self.db.execute(query,params).fetchone()
        self.assertEqual((route['aura_id'],route['address_assignment_id']),(SUPPORT,'assignment_sales_new'))

    def test_disabled_address_or_domain_has_no_current_route(self):
        query=(ROOT/'scripts/email/current_address.sql').read_text()
        params={'address_key':'sales@demo.34five.studio'}
        self.db.execute("UPDATE email_addresses SET status='disabled',disabled_at='2026-10-22T10:00:00.000Z' WHERE id='addr_sales'")
        self.assertIsNone(self.db.execute(query,params).fetchone())
        self.db.execute("UPDATE email_addresses SET status='active',disabled_at=NULL WHERE id='addr_sales'")
        self.db.execute("UPDATE email_domains SET status='disabled',disabled_at='2026-10-22T10:00:00.000Z' WHERE id='domain_default'")
        self.assertIsNone(self.db.execute(query,params).fetchone())


class ToolingTests(unittest.TestCase):
    def test_exported_parent_fixture_matches_provenance(self):
        manifest=json.loads((ROOT/'tests/email/fixtures/parent-schema-provenance.json').read_text())
        self.assertEqual(hashlib.sha256(tool.PARENTS.read_bytes()).hexdigest(),manifest['sha256'])

    def test_missing_parents_reported(self):
        with sqlite3.connect(':memory:') as db:
            with self.assertRaisesRegex(ValueError,'auras.id'):
                tool.apply_migration(db)

    def test_incompatible_member_key_reported(self):
        with sqlite3.connect(':memory:') as db:
            db.executescript('CREATE TABLE auras(id TEXT PRIMARY KEY,org_id TEXT); CREATE TABLE studio_members(org_id TEXT,member_id TEXT);')
            with self.assertRaisesRegex(ValueError,'studio_members'):
                tool.check_parents(db)

    def test_exported_parents_support_migration(self):
        with sqlite3.connect(':memory:') as db:
            db.execute('PRAGMA foreign_keys=ON')
            db.executescript(tool.PARENTS.read_text())
            tool.apply_migration(db)
            self.assertEqual(db.execute("SELECT count(*) FROM sqlite_schema WHERE type='table' AND name GLOB 'email_*'").fetchone()[0],12)
            self.assertEqual(db.execute('PRAGMA foreign_key_check').fetchall(),[])

    def test_existing_email_schema_is_not_silently_rebuilt(self):
        with sqlite3.connect(':memory:') as db:
            db.executescript(tool.PARENTS.read_text())
            tool.apply_migration(db)
            with self.assertRaisesRegex(ValueError,'not an upgrade'):
                tool.apply_migration(db)

    def test_demo_refuses_to_overwrite(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'demo.sqlite'
            tool.demo_database(path)
            original=path.read_bytes()
            with self.assertRaises(FileExistsError):
                tool.demo_database(path)
            self.assertEqual(path.read_bytes(),original)
