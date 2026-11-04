import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { receive } from '../worker/inbound.ts';
import { enableReplies, setup } from './harness.mjs';

const MERLIN = 'merlin@34five.studio';
const config = JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
const provisionSql = readFileSync(new URL('../scripts/provision-merlin.sql', import.meta.url), 'utf8');

function merlin(t, x) {
  const demo = enableReplies(x);
  x.sql.exec(provisionSql);
  Object.assign(x.env, { GEMINI_API_KEY: 'test-gemini-key', AUTO_REPLY_MODE: 'llm', DEFAULT_LLM_MODEL: 'gemini:gemini-test' });
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  return { demo, reply: text => {
    globalThis.fetch = async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  } };
}

test('the demo environment runs llm replies on its own Worker and leaves the default config fixed', () => {
  const demo = config.env.demo;
  assert.equal(config.name, 'aura-inbox-test');
  assert.equal(config.vars.AUTO_REPLY_MODE, 'fixed');
  assert.ok(!config.send_email[0].allowed_sender_addresses.includes(MERLIN));
  assert.equal(demo.name, 'aura-inbox-demo');
  assert.equal(demo.vars.AUTO_REPLY_MODE, 'llm');
  assert.deepEqual({ ...demo.vars, AUTO_REPLY_MODE: 'fixed' }, config.vars);
  assert.deepEqual(demo.d1_databases, config.d1_databases);
  assert.deepEqual(demo.r2_buckets, config.r2_buckets);
  assert.equal(demo.durable_objects, undefined);
  assert.deepEqual(demo.send_email[0].allowed_sender_addresses, [...config.send_email[0].allowed_sender_addresses, MERLIN]);
});

test('provisioning adds Merlin once on the existing domain and changes no existing row', t => {
  const x = setup(t);
  enableReplies(x);
  const snapshot = () => ['auras', 'email_addresses', 'email_address_assignments', 'email_domains']
    .map(table => x.sql.prepare(`SELECT * FROM ${table} WHERE id NOT IN ('aura_demo_merlin','address_merlin','assignment_merlin') ORDER BY id`).all());
  const before = snapshot();
  x.sql.exec(provisionSql); x.sql.exec(provisionSql);
  assert.deepEqual(snapshot(), before);
  const rows = x.sql.prepare(`SELECT u.name,a.address,a.status,x.aura_id FROM email_address_assignments x
    JOIN email_addresses a ON a.org_id=x.org_id AND a.id=x.address_id JOIN auras u ON u.org_id=x.org_id AND u.id=x.aura_id
    WHERE a.address_key=? AND x.ended_at IS NULL`).all(MERLIN);
  assert.deepEqual(rows.map(r => ({ ...r })), [{ name: 'Merlin', address: MERLIN, status: 'active', aura_id: 'aura_demo_merlin' }]);
  assert.deepEqual(x.sql.prepare('PRAGMA foreign_key_check').all(), []);
});

test('provisioning retires the unused merlin-test address so Merlin has one active address', async t => {
  const x = setup(t), demo = enableReplies(x);
  x.sql.exec(`INSERT INTO auras (id,org_id,name) VALUES ('aura_demo_merlin','org_demo_001','Merlin');
    INSERT INTO email_addresses (id,org_id,domain_id,local_part,address,address_key) SELECT 'address_merlin_test','org_demo_001',id,'merlin-test','merlin-test@34five.studio','merlin-test@34five.studio' FROM email_domains WHERE domain_key='34five.studio';
    INSERT INTO email_address_assignments (id,org_id,address_id,aura_id,assigned_at) VALUES ('assignment_merlin_test','org_demo_001','address_merlin_test','aura_demo_merlin','2026-11-04T12:00:00.000Z');`);
  x.sql.exec(provisionSql); x.sql.exec(provisionSql);
  const active = x.sql.prepare(`SELECT a.address FROM email_addresses a JOIN email_address_assignments x ON x.org_id=a.org_id AND x.address_id=a.id
    WHERE x.aura_id='aura_demo_merlin' AND x.ended_at IS NULL AND a.status='active'`).all();
  assert.deepEqual(active.map(r => r.address), [MERLIN]);
  assert.equal(x.sql.prepare("SELECT status FROM email_addresses WHERE id='address_merlin_test'").get().status, 'disabled');
  await receive(demo.message('merlin-test@34five.studio'), x.env);
  assert.equal(demo.replies.length, 0);
  assert.deepEqual(x.sql.prepare('PRAGMA foreign_key_check').all(), []);
});

test('mail to Merlin gets a generated reply from Merlin in the same thread', async t => {
  const x = setup(t), { demo, reply } = merlin(t, x);
  reply('Thanks for writing in.\n\nMerlin');
  await receive(demo.message(MERLIN), x.env);
  assert.equal(demo.replies.length, 1);
  assert.equal(demo.replies[0].from.email, MERLIN);
  assert.equal(demo.replies[0].from.name, 'Merlin');
  assert.match(demo.replies[0].text, /Thanks for writing in/);
  const rows = x.sql.prepare("SELECT direction,status,aura_id,thread_id FROM email_messages WHERE aura_id='aura_demo_merlin' ORDER BY direction").all();
  assert.deepEqual(rows.map(r => [r.direction, r.status]), [['in', 'received'], ['out', 'sent']]);
  assert.equal(rows[0].thread_id, rows[1].thread_id);
});

test('the conversation list names the counterparty, not the Aura that replied last', async t => {
  const x = setup(t), { demo, reply } = merlin(t, x);
  reply('Thanks for writing in.\n\nMerlin');
  await receive(demo.message(MERLIN), x.env);
  const { threads } = await (await x.request('/api/auras/aura_demo_merlin/inbox')).json();
  assert.equal(threads[0].sender, 'alex@example.invalid');
  assert.equal(threads[0].reply_failed, 0);
});

test('the conversation list flags a failed reply until a later reply is sent', async t => {
  const x = setup(t), { demo, reply } = merlin(t, x);
  globalThis.fetch = async () => new Response('{}', { status: 500 });
  await receive(demo.message(MERLIN, 'first@example.invalid'), x.env);
  let { threads } = await (await x.request('/api/auras/aura_demo_merlin/inbox')).json();
  assert.equal(threads[0].reply_failed, 1);
  assert.equal(threads[0].sender, 'alex@example.invalid');
  reply('Thanks for writing in.\n\nMerlin');
  await receive(demo.message(MERLIN, 'second@example.invalid', 'In-Reply-To: <first@example.invalid>\r\nReferences: <first@example.invalid>\r\n'), x.env);
  ({ threads } = await (await x.request('/api/auras/aura_demo_merlin/inbox')).json());
  assert.equal(threads.length, 1);
  assert.equal(threads[0].reply_failed, 0);
});

test('a thread with no inbound mail names its To recipient and never a Bcc', async t => {
  const x = setup(t);
  enableReplies(x);
  x.sql.exec(provisionSql);
  const now = new Date().toISOString();
  x.sql.exec(`INSERT INTO email_threads (id,org_id,aura_id,subject,last_activity_at,created_at) VALUES ('t_out','org_demo_001','aura_demo_merlin','Outbound','${now}','${now}')`);
  x.sql.exec(`INSERT INTO email_messages (id,org_id,aura_id,thread_id,email_address_id,address_assignment_id,direction,status,send_idempotency_key,envelope_from,envelope_to,from_address,subject,body_storage,body_text,body_size_bytes,references_json,activity_at,created_at)
    VALUES ('m_out','org_demo_001','aura_demo_merlin','t_out','address_merlin','assignment_merlin','out','draft','k_out','${MERLIN}','pat@example.invalid','${MERLIN}','Outbound','inline','Hello',5,'[]','${now}','${now}')`);
  x.sql.exec(`INSERT INTO email_message_recipients (id,org_id,aura_id,message_id,kind,ordinal,address,address_key) VALUES
    ('r_b','org_demo_001','aura_demo_merlin','m_out','bcc',0,'hidden@example.invalid','hidden@example.invalid'),
    ('r_t','org_demo_001','aura_demo_merlin','m_out','to',0,'pat@example.invalid','pat@example.invalid')`);
  const { threads } = await (await x.request('/api/auras/aura_demo_merlin/inbox')).json();
  assert.equal(threads[0].sender, 'pat@example.invalid');
});

const provisionAnthony = readFileSync(new URL('../scripts/provision-anthony.sql', import.meta.url), 'utf8');
const ANTHONY = 'anthony@34five.studio';

async function generated(t, x) {
  const world = merlin(t, x);
  x.sql.exec(provisionAnthony);
  const response = await x.request('/api/auras/aura_demo_anthony/address', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 201);
  return world;
}
const rows = (x, aura) => x.sql.prepare('SELECT direction,status FROM email_messages WHERE aura_id=? ORDER BY direction').all(aura).map(r => [r.direction, r.status]);

test('in llm mode an address made by Generate email gets a reply from that address', async t => {
  const x = setup(t), { demo, reply } = await generated(t, x);
  reply('Thanks for writing in.\n\nAnthony');
  await receive(demo.message(ANTHONY), x.env);
  assert.equal(demo.replies.length, 1);
  assert.equal(demo.replies[0].from.email, ANTHONY);
  assert.equal(demo.replies[0].from.name, 'Anthony');
  assert.deepEqual(rows(x, 'aura_demo_anthony'), [['in', 'received'], ['out', 'sent']]);
});

test('in fixed mode a generated address and Merlin are stored and get no reply', async t => {
  const x = setup(t), { demo } = await generated(t, x);
  x.env.AUTO_REPLY_MODE = 'fixed';
  await receive(demo.message(ANTHONY, 'fixed-anthony@example.invalid'), x.env);
  await receive(demo.message(MERLIN, 'fixed-merlin@example.invalid'), x.env);
  assert.equal(demo.replies.length, 0);
  assert.deepEqual(rows(x, 'aura_demo_anthony'), [['in', 'received']]);
  assert.deepEqual(rows(x, 'aura_demo_merlin'), [['in', 'received']]);
});

test('in llm mode the two fixed test addresses still reply', async t => {
  const x = setup(t), { demo, reply } = merlin(t, x);
  reply('Thanks for writing in.');
  await receive(demo.message('support-test@34five.studio'), x.env);
  assert.equal(demo.replies.length, 1);
  assert.equal(demo.replies[0].from.email, 'support-test@34five.studio');
});

for (const [label, prepare] of [
  ['unknown', () => {}],
  ['disabled', x => {
    x.sql.exec("UPDATE email_address_assignments SET ended_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 second') WHERE address_id='address_merlin'");
    x.sql.exec("UPDATE email_addresses SET status='disabled',disabled_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='address_merlin'");
  }],
]) {
  test(`in llm mode a ${label} address is refused with no reply and no provider call`, async t => {
    const x = setup(t), { demo } = merlin(t, x);
    let calls = 0;
    globalThis.fetch = async () => { calls++; return new Response('{}', { status: 500 }); };
    prepare(x);
    const message = demo.message(label === 'unknown' ? 'nobody@34five.studio' : MERLIN);
    await receive(message, x.env);
    assert.match(message.rejected ?? '', /./);
    assert.equal(demo.replies.length, 0);
    assert.equal(calls, 0);
    assert.deepEqual(rows(x, 'aura_demo_merlin'), []);
  });
}

test('in llm mode mail from any address we own is stored and gets no reply, so Auras cannot loop', async t => {
  const x = setup(t), { demo } = await generated(t, x);
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response('{}', { status: 500 }); };
  const fromAura = demo.message(MERLIN, 'aura-to-aura@example.invalid');
  fromAura.from = ANTHONY.toUpperCase();
  await receive(fromAura, x.env);
  const fromRetired = demo.message(ANTHONY, 'retired@example.invalid');
  x.sql.exec("INSERT INTO email_addresses (id,org_id,domain_id,local_part,address,address_key,status,disabled_at) SELECT 'old_addr','org_demo_001',id,'old','old@34five.studio','old@34five.studio','disabled',strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM email_domains WHERE domain_key='34five.studio'");
  fromRetired.from = 'old@34five.studio';
  await receive(fromRetired, x.env);
  assert.equal(demo.replies.length, 0);
  assert.equal(calls, 0);
  assert.deepEqual(rows(x, 'aura_demo_merlin'), [['in', 'received']]);
  assert.deepEqual(rows(x, 'aura_demo_anthony'), [['in', 'received']]);
});
