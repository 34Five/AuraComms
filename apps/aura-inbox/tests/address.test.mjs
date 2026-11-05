import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { receive } from '../worker/inbound.ts';
import { addressChip, isReceiving } from '../frontend/src/address-state.ts';
import { email, enableReplies, ORG, SALES, setup } from './harness.mjs';

const NEW = 'aura_new', ZONE = 'zone_from_env', TOKEN = 'secret-token-value';
const STAMP = '2026-10-22T08:00:00.000Z';

function world(t, name = 'Megan') {
  const x = setup(t);
  x.sql.prepare('INSERT INTO auras (id,org_id,name) VALUES (?,?,?)').run(NEW, ORG, name);
  return x;
}
const post = (x, path, body = {}) => x.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const generate = (x, body, id = NEW) => post(x, `/api/auras/${id}/address`, body);
const secrets = x => Object.assign(x.env, { CF_API_TOKEN: TOKEN, CF_ZONE_ID: ZONE });

function addDomain(x, id, domain, zone = null) {
  x.sql.prepare(`INSERT INTO email_domains (id,org_id,domain,domain_key,kind,status,cloudflare_zone_id,verified_at,activated_at)
    VALUES (?,?,?,?,'custom','active',?,?,?)`).run(id, ORG, domain, domain, zone, STAMP, STAMP);
}
function noActiveDomains(x) {
  x.sql.prepare("UPDATE email_domains SET status='disabled',disabled_at=? WHERE org_id=?").run(STAMP, ORG);
}
function currentAddresses(x, auraId = NEW) {
  return x.sql.prepare(`SELECT a.address FROM email_address_assignments s JOIN email_addresses a ON a.org_id=s.org_id AND a.id=s.address_id
    WHERE s.org_id=? AND s.aura_id=? AND s.ended_at IS NULL`).all(ORG, auraId).map(r => r.address);
}
function cloudflare(t, { rules = [], create } = {}) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    const method = init.method || 'GET';
    calls.push({ url: String(url), method, authorization: init.headers?.Authorization, body: init.body ? JSON.parse(init.body) : null });
    if (method === 'GET') return Response.json({ success: true, result: rules, errors: [] });
    return create ? create() : Response.json({ success: true, result: { id: 'rule_new' }, errors: [] });
  });
  return calls;
}
const ruleFor = (address, worker = 'aura-inbox-demo') => ({
  name: `AuraComms ${address}`, enabled: true,
  matchers: [{ type: 'literal', field: 'to', value: address }],
  actions: [{ type: 'worker', value: [worker] }],
});

test('no active domain refuses with a reason and writes nothing', async t => {
  const x = world(t); noActiveDomains(x);
  const response = await generate(x);
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.reason, 'no_active_domain');
  assert.match(body.error, /domain/i);
  assert.deepEqual(currentAddresses(x), []);
});

test('one active domain is used without asking', async t => {
  const x = world(t);
  const response = await generate(x);
  assert.equal(response.status, 201);
  const { address } = await response.json();
  assert.equal(address.address, 'megan@demo.34five.studio');
  assert.equal(address.domain_id, 'domain_default');
  assert.deepEqual(currentAddresses(x), ['megan@demo.34five.studio']);
  assert.deepEqual(x.sql.prepare('PRAGMA foreign_key_check').all(), []);
});

test('several active domains return the choices until one is named', async t => {
  const x = world(t); addDomain(x, 'domain_second', 'second.example.com');
  const response = await generate(x);
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.reason, 'domain_choice_required');
  assert.deepEqual(body.domains.map(d => d.id).sort(), ['domain_default', 'domain_second']);
  assert.deepEqual(currentAddresses(x), []);
  const chosen = await generate(x, { domain_id: 'domain_second' });
  assert.equal(chosen.status, 201);
  assert.equal((await chosen.json()).address.address, 'megan@second.example.com');
});

test('a domain that is not active for the org is refused', async t => {
  const x = world(t);
  for (const domain_id of ['domain_custom', 'no_such_domain', 42]) {
    const response = await generate(x, { domain_id });
    assert.equal(response.status, 400, String(domain_id));
    assert.equal((await response.json()).reason, 'invalid_domain');
  }
  assert.deepEqual(currentAddresses(x), []);
});

for (const [name, expected] of [
  ['Merlin', 'merlin-2'],
  ['Customer Support Aura', 'customer-support-aura'],
  ['  --Dr. Émile  O\'Neil_3!-- ', 'dr.emile-o-neil-3'],
  ['a..b', 'a.b'],
  ['日本語', 'aura'],
  ['x'.repeat(200), 'x'.repeat(64)],
]) {
  test(`the name ${JSON.stringify(name.slice(0, 30))} slugs to ${expected.slice(0, 30)}`, async t => {
    const x = world(t, name);
    const { address } = await (await generate(x)).json();
    assert.equal(address.address, `${expected}@demo.34five.studio`);
  });
}

test('a taken local part gets the next numeric suffix', async t => {
  const x = world(t, 'Sales');
  assert.equal((await (await generate(x)).json()).address.address, 'sales-2@demo.34five.studio');
});

test('a released address is not reused', async t => {
  const x = world(t);
  x.sql.exec(`INSERT INTO email_addresses (id,org_id,domain_id,local_part,address,address_key,status,disabled_at,released_at)
    VALUES ('old','${ORG}','domain_default','megan','megan@demo.34five.studio','megan@demo.34five.studio','released','${STAMP}','${STAMP}')`);
  assert.equal((await (await generate(x)).json()).address.address, 'megan-2@demo.34five.studio');
});

test('a suffix keeps a long local part within the limit', async t => {
  const long = 'x'.repeat(64);
  const x = world(t, long);
  x.sql.exec(`INSERT INTO email_addresses (id,org_id,domain_id,local_part,address,address_key)
    VALUES ('old','${ORG}','domain_default','${long}','${long}@demo.34five.studio','${long}@demo.34five.studio')`);
  assert.equal((await (await generate(x)).json()).address.address, `${'x'.repeat(62)}-2@demo.34five.studio`);
});

test('generating twice returns the same address with 200', async t => {
  const x = world(t);
  const first = await (await generate(x)).json();
  const again = await generate(x);
  assert.equal(again.status, 200);
  assert.equal((await again.json()).address.id, first.address.id);
  assert.equal(currentAddresses(x).length, 1);
});

test('concurrent generates create one address', async t => {
  const x = world(t);
  const responses = await Promise.all([generate(x), generate(x), generate(x)]);
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 200, 201]);
  assert.equal(currentAddresses(x).length, 1);
  assert.equal(x.sql.prepare('SELECT COUNT(*) AS n FROM email_addresses WHERE org_id=? AND domain_id=? AND local_part LIKE ?').get(ORG, 'domain_default', 'megan%').n, 1);
});

test('an existing assignment is returned and not provisioned', async t => {
  const x = setup(t); secrets(x);
  const calls = cloudflare(t);
  const response = await generate(x, {}, SALES);
  assert.equal(response.status, 200);
  const { address } = await response.json();
  assert.equal(address.address, 'sales@demo.34five.studio');
  assert.equal(address.provisioning.status, 'active');
  assert.equal(calls.length, 0);
  assert.deepEqual(currentAddresses(x, SALES), ['sales@demo.34five.studio']);
});

test('reading an address returns it with its status, or 404 when there is none', async t => {
  const x = world(t);
  const missing = await x.request(`/api/auras/${NEW}/address`);
  assert.equal(missing.status, 404);
  await generate(x);
  const found = await x.request(`/api/auras/${NEW}/address`);
  assert.equal(found.status, 200);
  const { address } = await found.json();
  assert.equal(address.address, 'megan@demo.34five.studio');
  assert.equal(address.provisioning.status, 'provisioning_pending');
});

test('another org\'s Aura is not found', async t => {
  const x = world(t);
  assert.equal((await generate(x, {}, 'other_aura')).status, 404);
  assert.equal((await x.request('/api/auras/other_aura/address')).status, 404);
  assert.equal((await post(x, '/api/auras/other_aura/address/provision')).status, 404);
});

test('writes need a JSON request and stay limited to the address routes', async t => {
  const x = world(t);
  const form = await x.request(`/api/auras/${NEW}/address`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
  assert.equal(form.status, 415);
  assert.deepEqual(currentAddresses(x), []);
  assert.equal((await post(x, '/api/auras')).status, 405);
  assert.equal((await post(x, `/api/auras/${NEW}/inbox`)).status, 405);
  assert.equal((await x.request(`/api/auras/${NEW}/address`, { method: 'DELETE' })).status, 405);
});

test('a malformed body is refused', async t => {
  const x = world(t);
  const response = await x.request(`/api/auras/${NEW}/address`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not json' });
  assert.equal(response.status, 400);
  assert.deepEqual(currentAddresses(x), []);
});

test('without the secrets the address is created pending with the exact rule and no call', async t => {
  const x = world(t);
  const calls = cloudflare(t);
  const response = await generate(x);
  assert.equal(response.status, 201);
  const { address } = await response.json();
  assert.equal(calls.length, 0);
  assert.equal(address.provisioning.status, 'provisioning_pending');
  assert.deepEqual(address.provisioning.rule, ruleFor('megan@demo.34five.studio'));
});

test('with the secrets a routing rule is created for the demo Worker', async t => {
  const x = world(t); secrets(x);
  const calls = cloudflare(t);
  const response = await generate(x);
  assert.equal(response.status, 201);
  const { address } = await response.json();
  const created = calls.find(c => c.method === 'POST');
  assert.equal(created.url, `https://api.cloudflare.com/client/v4/zones/${ZONE}/email/routing/rules`);
  assert.equal(created.authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(created.body, ruleFor('megan@demo.34five.studio'));
  assert.equal(address.provisioning.status, 'active');
  assert.equal(address.provisioning.rule_id, 'rule_new');
  assert.equal(address.provisioning.rule, null);
});

test('DEMO_WORKER_NAME overrides the target Worker', async t => {
  const x = world(t); secrets(x); x.env.DEMO_WORKER_NAME = 'another-worker';
  const calls = cloudflare(t);
  await generate(x);
  assert.deepEqual(calls.find(c => c.method === 'POST').body.actions, [{ type: 'worker', value: ['another-worker'] }]);
});

test('a domain with its own zone uses that zone', async t => {
  const x = world(t); secrets(x); addDomain(x, 'domain_second', 'second.example.com', 'zone_of_domain');
  const calls = cloudflare(t);
  await generate(x, { domain_id: 'domain_second' });
  assert.ok(calls.some(c => c.method === 'POST'));
  assert.ok(calls.every(c => c.url.includes('/zones/zone_of_domain/')));
});

test('a failed call never blocks the address and retry recovers it', async t => {
  const x = world(t); secrets(x);
  let fail = true;
  const calls = cloudflare(t, { create: () => fail
    ? Response.json({ success: false, errors: [{ code: 2007, message: 'Invalid worker' }] }, { status: 400 })
    : Response.json({ success: true, result: { id: 'rule_retry' } }) });
  const response = await generate(x);
  assert.equal(response.status, 201);
  const { address } = await response.json();
  assert.equal(address.provisioning.status, 'failed');
  assert.match(address.provisioning.reason, /2007.*Invalid worker/);
  assert.deepEqual(address.provisioning.rule, ruleFor('megan@demo.34five.studio'));
  assert.equal(currentAddresses(x).length, 1);
  fail = false;
  const retried = await post(x, `/api/auras/${NEW}/address/provision`);
  assert.equal(retried.status, 200);
  const after = (await retried.json()).address.provisioning;
  assert.equal(after.status, 'active');
  assert.equal(after.rule_id, 'rule_retry');
  assert.equal(after.reason, null);
  assert.equal(calls.filter(c => c.method === 'POST').length, 2);
});

test('a network failure is recorded without leaking the token', async t => {
  const x = world(t); secrets(x);
  t.mock.method(globalThis, 'fetch', async () => { throw new TypeError(`connection refused with ${TOKEN}`); });
  const response = await generate(x);
  assert.equal(response.status, 201);
  const text = await response.text();
  assert.ok(!text.includes(TOKEN));
  assert.equal(JSON.parse(text).address.provisioning.status, 'failed');
  const stored = x.sql.prepare('SELECT failure_reason FROM email_address_provisioning').get().failure_reason;
  assert.ok(!stored.includes(TOKEN));
});

test('a response body that is not JSON is recorded as a failure', async t => {
  const x = world(t); secrets(x);
  t.mock.method(globalThis, 'fetch', async () => new Response('<html>bad gateway</html>', { status: 502 }));
  const { address } = await (await generate(x)).json();
  assert.equal(address.provisioning.status, 'failed');
  assert.match(address.provisioning.reason, /502/);
});

test('retry without secrets stays pending', async t => {
  const x = world(t);
  await generate(x);
  const response = await post(x, `/api/auras/${NEW}/address/provision`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).address.provisioning.status, 'provisioning_pending');
});

test('adding the secrets later lets retry finish a pending address', async t => {
  const x = world(t);
  await generate(x);
  secrets(x); cloudflare(t);
  const { address } = await (await post(x, `/api/auras/${NEW}/address/provision`)).json();
  assert.equal(address.provisioning.status, 'active');
});

test('retry on an active address makes no call', async t => {
  const x = world(t); secrets(x);
  const calls = cloudflare(t);
  await generate(x);
  const before = calls.length;
  const response = await post(x, `/api/auras/${NEW}/address/provision`);
  assert.equal(response.status, 200);
  assert.equal(calls.length, before);
});

test('retry on an address routed by hand makes no call', async t => {
  const x = setup(t); secrets(x);
  const calls = cloudflare(t);
  const response = await post(x, `/api/auras/${SALES}/address/provision`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).address.provisioning.status, 'active');
  assert.equal(calls.length, 0);
});

test('retry on a disabled address is refused and makes no call', async t => {
  const x = world(t);
  await generate(x);
  x.sql.prepare("UPDATE email_addresses SET status='disabled',disabled_at=? WHERE address_key=?").run(STAMP, 'megan@demo.34five.studio');
  secrets(x);
  const calls = cloudflare(t);
  const response = await post(x, `/api/auras/${NEW}/address/provision`);
  assert.equal(response.status, 409);
  assert.equal((await response.json()).reason, 'address_not_active');
  assert.equal(calls.length, 0);
});

test('retry with no address is not found', async t => {
  const x = world(t);
  assert.equal((await post(x, `/api/auras/${NEW}/address/provision`)).status, 404);
});

test('an existing rule for this address and Worker is adopted, not duplicated', async t => {
  const x = world(t); secrets(x);
  const calls = cloudflare(t, { rules: [{ id: 'rule_existing', ...ruleFor('megan@demo.34five.studio') }] });
  const { address } = await (await generate(x)).json();
  assert.equal(address.provisioning.status, 'active');
  assert.equal(address.provisioning.rule_id, 'rule_existing');
  assert.equal(calls.filter(c => c.method === 'POST').length, 0);
});

test('an address already routed elsewhere fails and the rule is left alone', async t => {
  const x = world(t); secrets(x);
  const calls = cloudflare(t, { rules: [{ id: 'rule_human', name: 'human', enabled: true,
    matchers: [{ type: 'literal', field: 'to', value: 'megan@demo.34five.studio' }],
    actions: [{ type: 'forward', value: ['someone@example.com'] }] }] });
  const { address } = await (await generate(x)).json();
  assert.equal(address.provisioning.status, 'failed');
  assert.match(address.provisioning.reason, /already routed/i);
  assert.equal(calls.filter(c => c.method !== 'GET').length, 0);
});

test('a catch-all rule does not count as routing this address', async t => {
  const x = world(t); secrets(x);
  const calls = cloudflare(t, { rules: [{ id: 'rule_all', name: 'catch-all', enabled: true,
    matchers: [{ type: 'all' }], actions: [{ type: 'worker', value: ['spike'] }] }] });
  const { address } = await (await generate(x)).json();
  assert.equal(address.provisioning.status, 'active');
  assert.equal(calls.filter(c => c.method === 'POST').length, 1);
});

test('every page of existing rules is checked before creating', async t => {
  const x = world(t); secrets(x);
  const urls = [];
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    urls.push(String(url));
    assert.equal(init.method || 'GET', 'GET');
    const page = Number(new URL(url).searchParams.get('page'));
    const filler = Array.from({ length: 50 }, (_, i) => ({ id: `r${i}`, matchers: [{ type: 'literal', field: 'to', value: `f${i}@example.com` }], actions: [] }));
    return Response.json({ success: true, result: page === 1 ? filler : [{ id: 'rule_page2', ...ruleFor('megan@demo.34five.studio') }] });
  });
  const { address } = await (await generate(x)).json();
  assert.equal(address.provisioning.rule_id, 'rule_page2');
  assert.equal(urls.length, 2);
});

test('the Aura list carries the provisioning status', async t => {
  const x = world(t);
  await generate(x);
  const { auras } = await (await x.request('/api/auras')).json();
  assert.equal(auras.find(a => a.id === NEW).addresses[0].provisioning_status, 'provisioning_pending');
  assert.equal(auras.find(a => a.id === SALES).addresses[0].provisioning_status, 'active');
});

test('the proposal names the address for each active domain and writes nothing', async t => {
  const x = world(t); addDomain(x, 'domain_second', 'second.example.com');
  const response = await x.request(`/api/auras/${NEW}/address/proposal`);
  assert.equal(response.status, 200);
  const { domains } = await response.json();
  assert.deepEqual(domains.map(d => d.address).sort(), ['megan@demo.34five.studio', 'megan@second.example.com']);
  assert.deepEqual(currentAddresses(x), []);
});

test('the proposal explains when there is no active domain', async t => {
  const x = world(t); noActiveDomains(x);
  const response = await x.request(`/api/auras/${NEW}/address/proposal`);
  assert.equal(response.status, 409);
  assert.equal((await response.json()).reason, 'no_active_domain');
});

test('mail to a generated address reaches the Aura inbox', async t => {
  const x = world(t);
  await generate(x);
  const message = email('megan@demo.34five.studio');
  await receive(message, x.env);
  assert.equal(message.rejected, null);
  const { threads } = await (await x.request(`/api/auras/${NEW}/inbox`)).json();
  assert.equal(threads.length, 1);
});

test('the chip names each state and offers retry only when it can help', () => {
  const live = { status: 'active', domain_status: 'active' };
  assert.deepEqual(addressChip({ ...live, provisioning_status: 'active' }), { label: 'Active', tone: 'open', retry: false });
  assert.deepEqual(addressChip({ ...live, provisioning_status: 'provisioning_pending' }), { label: 'Provisioning pending', tone: 'closed', retry: true });
  assert.deepEqual(addressChip({ ...live, provisioning_status: 'failed' }), { label: 'Failed', tone: 'failed', retry: true });
  assert.deepEqual(addressChip({ status: 'disabled', domain_status: 'active', provisioning_status: 'failed' }), { label: 'Disabled', tone: 'archived', retry: false });
  assert.deepEqual(addressChip({ status: 'active', domain_status: 'disabled', provisioning_status: 'active' }), { label: 'Domain not active', tone: 'archived', retry: false });
});

test('only a fully provisioned address counts as receiving', () => {
  const live = { status: 'active', domain_status: 'active' };
  assert.equal(isReceiving({ ...live, provisioning_status: 'active' }), true);
  assert.equal(isReceiving({ ...live, provisioning_status: 'provisioning_pending' }), false);
  assert.equal(isReceiving({ ...live, provisioning_status: 'failed' }), false);
  assert.equal(isReceiving({ ...live, domain_status: 'failed', provisioning_status: 'active' }), false);
});

function demoOrg(t) {
  const x = setup(t);
  enableReplies(x);
  return x;
}
const provisionAtlas = readFileSync(new URL('../scripts/provision-atlas.sql', import.meta.url), 'utf8');
const atlasRows = x => x.sql.prepare("SELECT id,org_id,name FROM auras WHERE id='aura_demo_atlas'").all().map(r => ({ ...r }));

test('the Atlas script adds the Aura once, gives it no address and changes no existing row', t => {
  const x = demoOrg(t);
  const snapshot = () => ['auras', 'email_addresses', 'email_address_assignments', 'email_domains']
    .map(table => x.sql.prepare(`SELECT * FROM ${table} WHERE id<>'aura_demo_atlas' ORDER BY id`).all());
  const before = snapshot();
  x.sql.exec(provisionAtlas); x.sql.exec(provisionAtlas);
  assert.deepEqual(snapshot(), before);
  assert.deepEqual(atlasRows(x), [{ id: 'aura_demo_atlas', org_id: 'org_demo_001', name: 'Atlas' }]);
  assert.equal(x.sql.prepare("SELECT COUNT(*) AS n FROM email_address_assignments WHERE aura_id='aura_demo_atlas'").get().n, 0);
  assert.deepEqual(x.sql.prepare('PRAGMA foreign_key_check').all(), []);
});

test('generating for reserved Atlas suggests atlas-2@34five.studio', async t => {
  const x = demoOrg(t);
  x.sql.exec(provisionAtlas);
  const response = await generate(x, {}, 'aura_demo_atlas');
  assert.equal(response.status, 201);
  assert.equal((await response.json()).address.address, 'atlas-2@34five.studio');
});

test('the Atlas script adds nothing when another Aura has that name', t => {
  const x = demoOrg(t);
  x.sql.exec("INSERT INTO auras (id,org_id,name) VALUES ('someone_else','org_demo_001','atlas')");
  x.sql.exec(provisionAtlas);
  assert.deepEqual(atlasRows(x), []);
});

test('the Atlas script adds nothing when atlas@34five.studio is taken', t => {
  const x = demoOrg(t);
  x.sql.exec(`INSERT INTO email_addresses (id,org_id,domain_id,local_part,address,address_key)
    SELECT 'taken','org_demo_001',id,'atlas','atlas@34five.studio','atlas@34five.studio' FROM email_domains WHERE domain_key='34five.studio'`);
  x.sql.exec(provisionAtlas);
  assert.deepEqual(atlasRows(x), []);
});

test('the Atlas script adds nothing when the domain is not active', t => {
  const x = demoOrg(t);
  x.sql.prepare("UPDATE email_domains SET status='disabled',disabled_at=? WHERE domain_key='34five.studio'").run(STAMP);
  x.sql.exec(provisionAtlas);
  assert.deepEqual(atlasRows(x), []);
});


test('explicit reserved names and invalid separator characters create no address rows',async t=>{
 const x=world(t),before=x.sql.prepare('SELECT count(*) n FROM email_addresses').get().n;
 for(const local_part of ['anthony','melina','merlin','support','no-reply','postmaster'])assert.equal((await generate(x,{local_part})).status,409);
 for(const local_part of ['a+b','x/y',"o'brien",'a.-b','a--b'])assert.equal((await generate(x,{local_part})).status,400);
 assert.equal(x.sql.prepare('SELECT count(*) n FROM email_addresses').get().n,before);assert.deepEqual(currentAddresses(x),[]);
});

test('explicit collision, concurrent reservation, and changed existing prefixes return 409',async t=>{
 const x=world(t);await generate(x,{local_part:'megan'});
 assert.equal((await generate(x,{local_part:'different'})).status,409);
 x.sql.prepare('INSERT INTO auras(id,org_id,name) VALUES (?,?,?)').run('aura_collision',ORG,'Another');
 assert.equal((await generate(x,{local_part:'megan'},'aura_collision')).status,409);
 const batch=x.env.DB.batch;x.env.DB.batch=async()=>{throw Error('UNIQUE constraint failed: email_addresses.domain_id, email_addresses.local_part');};
 assert.equal((await generate(x,{local_part:'race-check'},'aura_collision')).status,409);x.env.DB.batch=batch;
 assert.equal(currentAddresses(x,'aura_collision').length,0);
});
