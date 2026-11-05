import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEMO_PERSONAS, DEMO_ORG } from '../worker/llm/demo-personas.ts';
import { migrateDemoAuraEmails } from '../scripts/migrate-persona-emails.mjs';
import { setup, email } from './harness.mjs';
import { receive } from '../worker/inbound.ts';
import { Governance, TEST_ADDRESSES } from '../worker/governance.ts';

const profiles = DEMO_PERSONAS.slice(0, 4);
function migrationDb(t, legacy = true) {
  const x = setup(t);
  x.env.DEMO_ORG_ID = DEMO_ORG;
  for (const p of DEMO_PERSONAS) x.sql.prepare('INSERT INTO auras (id,org_id,name) VALUES (?,?,?)').run(p.id, DEMO_ORG, p.previousName);
  x.sql.exec("INSERT INTO studio_members (org_id,member_id,role) VALUES ('org_demo_001','member_demo_001','admin')");
  for (const file of ['provision-addresses', 'provision-governance']) {
    let sql = readFileSync(new URL(`../scripts/${file}.sql`, import.meta.url), 'utf8');
    if (legacy) for (const p of profiles) {
      const local = p.name.toLowerCase(), oldLocal = p.previousEmail.split('@')[0];
      sql = sql.replaceAll(p.email, p.previousEmail).replaceAll(`'${local}'`, `'${oldLocal}'`)
        .replaceAll(`address_${local}`, `address_legacy_${local}`).replaceAll(`assignment_${local}`, `assignment_legacy_${local}`);
    }
    x.sql.exec(sql);
  }
  const db = {
    query: sql => x.sql.prepare(sql).all(),
    execute: sql => {
      x.sql.exec('BEGIN');
      try { x.sql.exec(sql); x.sql.exec('COMMIT'); } catch (e) { x.sql.exec('ROLLBACK'); throw e; }
    },
  };
  return { ...x, db };
}

test('migration replaces active aliases, stores roles, and preserves policies and message history on reruns', async t => {
  const x = migrationDb(t);
  await receive(email(profiles[0].previousEmail), x.env);
  const messages = x.db.query('SELECT * FROM email_messages'), policies = x.db.query('SELECT * FROM email_aura_policies');
  const result = migrateDemoAuraEmails(x.db);
  migrateDemoAuraEmails(x.db);
  assert.equal(result.auras.length, 5);
  for (const p of DEMO_PERSONAS) {
    const row = x.sql.prepare('SELECT name,role FROM auras WHERE id=?').get(p.id);
    assert.equal(row.name, p.name); assert.equal(row.role, p.role);
  }
  for (const p of profiles) {
    const old = x.sql.prepare('SELECT status FROM email_addresses WHERE address_key=?').get(p.previousEmail);
    assert.equal(old.status, 'disabled');
    assert.equal(result.addresses.find(a => a.address_key === p.email).aura_id, p.id);
  }
  assert.deepEqual(x.db.query('SELECT * FROM email_messages'), messages);
  assert.deepEqual(x.db.query('SELECT * FROM email_aura_policies'), policies);
  assert.deepEqual(x.db.query('PRAGMA foreign_key_check'), []);
});

test('fresh named addresses work with provisioning and the sender allowlist', async t => {
  const x = migrationDb(t, false);
  migrateDemoAuraEmails(x.db);
  assert.deepEqual(TEST_ADDRESSES, profiles.map(p => p.email));
  for (const p of profiles) {
    const msg = email(p.email, `${p.name}@example.invalid`);
    await receive(msg, x.env);
    assert.equal(msg.rejected, null);
    const old = email(p.previousEmail);
    await receive(old, x.env);
    assert.ok(old.rejected);
  }
  const g = new Governance(x.env);
  Object.assign(x.env, { GOVERNANCE_ADMIN_TOKEN: 'test-credential', GOVERNANCE_REVIEWER_MEMBER_ID: 'member_demo_001' });
  for (const p of profiles) {
    const response = await x.request(`/api/auras/${p.id}/governance/compose`, { method: 'POST', headers: { Authorization: 'Bearer test-credential', Origin: 'https://inbox.example', 'Content-Type': 'application/json' }, body: JSON.stringify({ to: 'alex@example.invalid', subject: 'Test', text: 'Hello.' }) });
    const d = await response.json();
    assert.equal(response.status, 201, JSON.stringify(d));
    const m = await g.message(p.id, d.message_id);
    assert.equal(m.from_address, p.email);
    await g.route(m);
  }
});

test('migration adds the optional role column on the live minimal Aura schema', t => {
  const x = migrationDb(t);
  for (const { name } of x.db.query("PRAGMA table_info('auras')")) {
    if (!['id', 'org_id', 'name'].includes(name)) x.sql.exec(`ALTER TABLE auras DROP COLUMN ${name}`);
  }
  migrateDemoAuraEmails(x.db);
  assert.ok(x.db.query("PRAGMA table_info('auras')").some(c => c.name === 'role'));
  assert.equal(x.sql.prepare("SELECT role FROM auras WHERE id='aura_demo_001'").get().role, DEMO_PERSONAS[0].role);
});

test('migration preserves custom names and roles and aborts if another session edits a record', t => {
  const x = migrationDb(t);
  x.sql.exec("UPDATE auras SET name='Custom name',role='Team role' WHERE id='aura_demo_001'");
  const execute = x.db.execute;
  x.db.execute = sql => {
    x.sql.exec("UPDATE auras SET name='Concurrent name' WHERE id='aura_demo_002'");
    execute(sql);
  };
  assert.throws(() => migrateDemoAuraEmails(x.db));
  assert.equal(x.sql.prepare("SELECT COUNT(*) AS n FROM email_addresses WHERE address_key='lyra@34five.studio'").get().n, 0);
  x.db.execute = execute;
  migrateDemoAuraEmails(x.db);
  const row = x.sql.prepare("SELECT name,role FROM auras WHERE id='aura_demo_001'").get();
  assert.equal(row.name, 'Custom name'); assert.equal(row.role, 'Team role');
});

test('conflicting target addresses and unsent legacy drafts prevent migration', async t => {
  const x = migrationDb(t);
  x.sql.exec("INSERT INTO email_addresses (id,org_id,domain_id,local_part,address,address_key,status,disabled_at) VALUES ('collision','org_demo_001','domain_34five_inbox_test','lyra','lyra@34five.studio','lyra@34five.studio','disabled','2026-11-01T00:00:00.000Z')");
  assert.throws(() => migrateDemoAuraEmails(x.db), /conflicting ownership or state/);
  x.sql.exec("DELETE FROM email_addresses WHERE id='collision'");
  await receive(email(profiles[0].previousEmail), x.env);
  const m = x.sql.prepare("SELECT * FROM email_messages WHERE org_id='org_demo_001'").get();
  x.sql.prepare(`INSERT INTO email_messages (id,org_id,aura_id,thread_id,email_address_id,address_assignment_id,direction,status,from_address,activity_at,send_idempotency_key)
    VALUES ('old_draft',?,?,?,?,?,'out','draft',?,?,'old_draft')`).run(m.org_id,m.aura_id,m.thread_id,m.email_address_id,m.address_assignment_id,profiles[0].previousEmail,m.activity_at);
  assert.throws(() => migrateDemoAuraEmails(x.db), /unsent messages/);
  assert.equal(x.sql.prepare("SELECT name FROM auras WHERE id='aura_demo_001'").get().name, profiles[0].previousName);
});

test('new Auras have roles and role edits reject blank values and stale changes', async t => {
  const x = migrationDb(t, false);
  Object.assign(x.env, { GOVERNANCE_ADMIN_TOKEN: 'test-credential', GOVERNANCE_REVIEWER_MEMBER_ID: 'member_demo_001' });
  const call = (path, method, body) => x.request('/api/manage/auras' + path, { method, headers: { Authorization: 'Bearer test-credential', Origin: 'https://inbox.example', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const created = await call('', 'POST', { name: 'Research Aura', role: 'Research assistant', tier: '1' });
  assert.equal(created.status, 201);
  const { aura } = await created.json();
  assert.equal(aura.role, 'Research assistant');
  const body = { name: aura.name, previous_name: aura.name, role: 'Product researcher', previous_role: aura.role };
  assert.equal((await call('/' + aura.id, 'PUT', body)).status, 200);
  assert.equal((await call('/' + aura.id, 'PUT', body)).status, 409);
  assert.equal((await call('/' + aura.id, 'PUT', { ...body, role: '  ', previous_role: 'Product researcher' })).status, 400);
  assert.equal(x.sql.prepare('SELECT role FROM auras WHERE id=?').get(aura.id).role, 'Product researcher');
  const defaultRole = await (await call('', 'POST', { name: 'Another Aura', tier: '1' })).json();
  assert.equal(defaultRole.aura.role, 'General assistant');
});
