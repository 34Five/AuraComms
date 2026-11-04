import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker from '../worker/index.ts';
import { sessionFrom } from '../frontend/src/auth-state.ts';
import { enableReplies, setup } from './harness.mjs';

const SENDER = 'no-reply@34five.studio';
const config = JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
const inviteSql = readFileSync(new URL('../scripts/provision-invites.sql', import.meta.url), 'utf8');

test('both environments may send login mail', () => {
  assert.ok(config.send_email[0].allowed_sender_addresses.includes(SENDER));
  assert.ok(config.env.demo.send_email[0].allowed_sender_addresses.includes(SENDER));
});

test('the invite seed adds Akash once', t => {
  const x = setup(t);
  x.sql.exec(inviteSql); x.sql.exec(inviteSql);
  const rows = x.sql.prepare("SELECT email FROM demo_auth_invites WHERE email='akash@axiatechnologies.ai'").all();
  assert.equal(rows.length, 1);
  assert.deepEqual(x.sql.prepare('PRAGMA foreign_key_check').all(), []);
});

const INVITED = 'pat@example.invalid';
const post = (x, path, body, headers = {}) => x.anon(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const requestCode = (x, email = INVITED) => post(x, '/api/auth/request', { email });
const verify = (x, code, email = INVITED) => post(x, '/api/auth/verify', { email, code });
const latestCode = x => x.sent.at(-1).text.match(/\b\d{6}\b/)[0];
const wrong = code => code === '000000' ? '000001' : '000000';
const cookieOf = response => response.headers.get('set-cookie').split(';')[0];
const me = (x, cookie) => x.anon('/api/auth/me', cookie ? { headers: { cookie } } : undefined);
const past = () => new Date(Date.now() - 1000).toISOString();
const WRONG_CODE = 'That code is wrong or has expired.';
const LOCKED = 'Too many wrong codes. Try again in 15 minutes.';

function invited(t, email = INVITED) {
  const x = setup(t);
  x.sql.prepare("INSERT INTO demo_auth_invites (email,invited_by,invited_at) VALUES (?,'test','2026-11-04T00:00:00.000Z')").run(email);
  return x;
}
async function signIn(x, email = INVITED) {
  assert.equal((await requestCode(x, email)).status, 200);
  const response = await verify(x, latestCode(x), email);
  assert.equal(response.status, 200);
  return cookieOf(response);
}

test('a non-invited address gets the exact message and no mail', async t => {
  const x = invited(t);
  const response = await requestCode(x, 'stranger@example.invalid');
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "This address hasn't been invited." });
  assert.equal(x.sent.length, 0);
  assert.equal(x.sql.prepare('SELECT COUNT(*) AS n FROM demo_auth_codes').get().n, 0);
});

test('an invited address is mailed a code from the login sender and only a hash is stored', async t => {
  const x = invited(t);
  const response = await requestCode(x);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(x.sent.length, 1);
  assert.equal(x.sent[0].from.email, SENDER);
  assert.equal(x.sent[0].to, INVITED);
  assert.equal(x.sent[0].subject, 'Your sign-in code for the Aura inbox');
  const code = latestCode(x);
  const row = x.sql.prepare('SELECT code_hash,created_at,expires_at FROM demo_auth_codes').get();
  assert.match(row.code_hash, /^[0-9a-f]{64}$/);
  assert.ok(!row.code_hash.includes(code));
  assert.equal(Date.parse(row.expires_at) - Date.parse(row.created_at), 600_000);
});

test('a stored hash is bound to its email, so it cannot be replayed for another invite', async t => {
  const x = invited(t);
  x.sql.exec("INSERT INTO demo_auth_invites (email,invited_by,invited_at) VALUES ('sam@example.invalid','test','2026-11-04T00:00:00.000Z')");
  await requestCode(x);
  const code = latestCode(x);
  await requestCode(x, 'sam@example.invalid');
  x.sql.exec("UPDATE demo_auth_codes SET code_hash=(SELECT code_hash FROM demo_auth_codes WHERE email='pat@example.invalid') WHERE email='sam@example.invalid'");
  assert.equal((await verify(x, code, 'sam@example.invalid')).status, 401);
});

test('email case and spaces are ignored and mail goes to the invite row', async t => {
  const x = invited(t);
  const typed = '  Pat@Example.INVALID ';
  assert.equal((await requestCode(x, typed)).status, 200);
  assert.equal(x.sent[0].to, INVITED);
  const response = await verify(x, latestCode(x), typed);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { email: INVITED });
});

test('a fourth code request inside 10 minutes is refused', async t => {
  const x = invited(t);
  for (let i = 0; i < 3; i++) assert.equal((await requestCode(x)).status, 200);
  const response = await requestCode(x);
  assert.equal(response.status, 429);
  assert.deepEqual(await response.json(), { error: 'Too many codes requested. Try again in a few minutes.' });
  assert.equal(x.sent.length, 3);
  x.sql.exec(`UPDATE demo_auth_codes SET created_at='${new Date(Date.now() - 601_000).toISOString()}'`);
  assert.equal((await requestCode(x)).status, 200);
});

test('concurrent code requests cannot beat the limit', async t => {
  const x = invited(t);
  const responses = await Promise.all(Array.from({ length: 8 }, () => requestCode(x)));
  assert.equal(responses.filter(r => r.status === 200).length, 3);
  assert.equal(x.sent.length, 3);
});

test('five wrong codes lock the email for 15 minutes', async t => {
  const x = invited(t);
  await requestCode(x);
  const code = latestCode(x);
  for (let i = 0; i < 4; i++) {
    const response = await verify(x, wrong(code));
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: WRONG_CODE });
  }
  const fifth = await verify(x, wrong(code));
  assert.equal(fifth.status, 429);
  assert.deepEqual(await fifth.json(), { error: LOCKED });
  assert.equal((await verify(x, code)).status, 429);
  const locked = await requestCode(x);
  assert.equal(locked.status, 429);
  assert.deepEqual(await locked.json(), { error: LOCKED });
  assert.equal(x.sent.length, 1);
  const until = Date.parse(x.sql.prepare('SELECT locked_until FROM demo_auth_throttle').get().locked_until);
  assert.ok(Math.abs(until - Date.now() - 900_000) < 5000);
  x.sql.exec(`UPDATE demo_auth_throttle SET locked_until='${past()}'`);
  assert.equal((await verify(x, code)).status, 200);
});

test('a correct code clears earlier wrong attempts', async t => {
  const x = invited(t);
  await requestCode(x);
  const first = latestCode(x);
  for (let i = 0; i < 4; i++) await verify(x, wrong(first));
  assert.equal((await verify(x, first)).status, 200);
  await requestCode(x);
  const second = latestCode(x);
  assert.equal((await verify(x, wrong(second))).status, 401);
  assert.equal(x.sql.prepare('SELECT failed_attempts FROM demo_auth_throttle').get().failed_attempts, 1);
});

test('concurrent wrong guesses cannot exceed five', async t => {
  const x = invited(t);
  await requestCode(x);
  const code = latestCode(x);
  const responses = await Promise.all(Array.from({ length: 10 }, () => verify(x, wrong(code))));
  assert.equal(responses.filter(r => r.status === 401).length, 4);
  assert.equal(responses.filter(r => r.status === 429).length, 6);
  assert.equal((await verify(x, code)).status, 429);
});

test('a badly formed code is refused without spending an attempt', async t => {
  const x = invited(t);
  await requestCode(x);
  for (const code of ['', '12345', '1234567', 'abcdef', 123456, null]) {
    assert.equal((await verify(x, code)).status, 401);
  }
  assert.equal(x.sql.prepare('SELECT COUNT(*) AS n FROM demo_auth_throttle').get().n, 0);
});

test('a code typed with spaces still works', async t => {
  const x = invited(t);
  await requestCode(x);
  const code = latestCode(x);
  assert.equal((await verify(x, ` ${code.slice(0, 3)} ${code.slice(3)} `)).status, 200);
});

test('verify for a non-invited address fails with no write', async t => {
  const x = invited(t);
  const response = await verify(x, '123456', 'stranger@example.invalid');
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: WRONG_CODE });
  assert.equal(x.sql.prepare('SELECT COUNT(*) AS n FROM demo_auth_throttle').get().n, 0);
});

test('the correct code sets a hardened session cookie', async t => {
  const x = invited(t);
  await requestCode(x);
  const response = await verify(x, latestCode(x));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { email: INVITED });
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const parts = response.headers.get('set-cookie').split('; ');
  assert.match(parts[0], /^aura_session=[\w-]+\.[\w-]+$/);
  assert.deepEqual(parts.slice(1).sort(), ['HttpOnly', 'Max-Age=604800', 'Path=/', 'SameSite=Lax', 'Secure']);
  const session = x.sql.prepare('SELECT id,email,created_at,expires_at,revoked_at FROM demo_auth_sessions').get();
  assert.equal(session.email, INVITED);
  assert.equal(session.revoked_at, null);
  assert.equal(Date.parse(session.expires_at) - Date.parse(session.created_at), 604_800_000);
  assert.equal(Buffer.from(session.id, 'base64url').length, 32);
  assert.ok(parts[0].startsWith(`aura_session=${session.id}.`));
  const signedIn = await me(x, parts[0]);
  assert.equal(signedIn.status, 200);
  assert.deepEqual(await signedIn.json(), { email: INVITED });
  assert.notEqual(x.sql.prepare('SELECT last_sign_in_at FROM demo_auth_invites WHERE email=?').get(INVITED).last_sign_in_at, null);
});

test('me without a cookie is 401', async t => {
  const x = invited(t);
  const response = await me(x);
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'Sign in to continue.' });
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('an expired code is rejected', async t => {
  const x = invited(t);
  await requestCode(x);
  x.sql.exec(`UPDATE demo_auth_codes SET expires_at='${past()}'`);
  const response = await verify(x, latestCode(x));
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('set-cookie'), null);
});

test('a used code is rejected', async t => {
  const x = invited(t);
  await requestCode(x);
  const code = latestCode(x);
  assert.equal((await verify(x, code)).status, 200);
  const again = await verify(x, code);
  assert.equal(again.status, 401);
  assert.equal(again.headers.get('set-cookie'), null);
});

test('two concurrent verifies of one code create one session', async t => {
  const x = invited(t);
  await requestCode(x);
  const code = latestCode(x);
  const responses = await Promise.all([verify(x, code), verify(x, code)]);
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 401]);
  assert.equal(x.sql.prepare('SELECT COUNT(*) AS n FROM demo_auth_sessions').get().n, 1);
});

test('an older code stops working once a newer one is requested, and stays dead after sign-in', async t => {
  const x = invited(t);
  await requestCode(x);
  const older = latestCode(x);
  await requestCode(x);
  const newer = latestCode(x);
  if (older !== newer) assert.equal((await verify(x, older)).status, 401);
  assert.equal((await verify(x, newer)).status, 200);
  assert.equal((await verify(x, older)).status, 401);
});

test('a failed send gives 502, leaves no code and spends no budget', async t => {
  const x = invited(t);
  x.failSend = true;
  const response = await requestCode(x);
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: "We couldn't send the code. Please retry." });
  assert.equal(x.sql.prepare('SELECT COUNT(*) AS n FROM demo_auth_codes').get().n, 0);
  x.failSend = false;
  for (let i = 0; i < 3; i++) assert.equal((await requestCode(x)).status, 200);
});

test('sign-out revokes the session on the server and clears the cookie', async t => {
  const x = invited(t);
  const cookie = await signIn(x);
  const response = await post(x, '/api/auth/signout', {}, { cookie });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('set-cookie'), /^aura_session=; .*Max-Age=0/);
  assert.notEqual(x.sql.prepare('SELECT revoked_at FROM demo_auth_sessions').get().revoked_at, null);
  assert.equal((await me(x, cookie)).status, 401);
});

test('a forged cookie is refused', async t => {
  const x = invited(t);
  const cookie = await signIn(x);
  const value = cookie.slice('aura_session='.length);
  const [id, signature] = value.split('.');
  const flipped = (signature[0] === 'A' ? 'B' : 'A') + signature.slice(1);
  const hmac = async (secret, data) => {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return Buffer.from(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data))).toString('base64url');
  };
  const forged = [
    `aura_session=${id}.${flipped}`,
    `aura_session=${id}`,
    `aura_session=${id}.`,
    `aura_session=.${signature}`,
    `aura_session=${id}.${await hmac('another-secret', id)}`,
    `aura_session=unknown.${await hmac('test-session-secret', 'unknown')}`,
    'aura_session=garbage',
    'aura_session=%%%.***',
    `other=${value}`,
  ];
  for (const candidate of forged) assert.equal((await me(x, candidate)).status, 401, candidate);
  assert.equal((await me(x, `first=1; ${cookie}; last=2`)).status, 200);
});

test('an expired session is refused', async t => {
  const x = invited(t);
  const cookie = await signIn(x);
  x.sql.exec(`UPDATE demo_auth_sessions SET expires_at='${past()}'`);
  assert.equal((await me(x, cookie)).status, 401);
});

test('auth routes refuse the wrong method, a non-JSON post and an unknown path', async t => {
  const x = invited(t);
  assert.equal((await x.anon('/api/auth/request')).status, 405);
  assert.equal((await x.anon('/api/auth/me', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 405);
  assert.equal((await x.anon('/api/auth/request', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ email: INVITED }) })).status, 415);
  assert.equal((await x.anon('/api/auth/signout', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' })).status, 415);
  assert.equal((await x.anon('/api/auth/nope')).status, 404);
  assert.equal(x.sent.length, 0);
});

test('a malformed or oversized email body is treated as not invited', async t => {
  const x = invited(t);
  for (const body of ['not json', '[]', '{"email":42}', JSON.stringify({ email: `${'a'.repeat(300)}@example.invalid` })]) {
    const response = await x.anon('/api/auth/request', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    assert.equal(response.status, 403, body.slice(0, 30));
  }
});

test('logs never hold the code or the full email', async t => {
  const x = invited(t);
  const lines = [];
  for (const level of ['log', 'error', 'warn']) t.mock.method(console, level, (...args) => { lines.push(args.join(' ')); });
  await requestCode(x);
  const code = latestCode(x);
  await verify(x, wrong(code));
  await verify(x, code);
  x.sql.exec('DELETE FROM demo_auth_codes');
  x.failSend = true;
  await requestCode(x);
  const logged = lines.join('\n');
  assert.ok(lines.length > 0);
  assert.ok(!logged.includes(code));
  assert.ok(!logged.includes(INVITED));
});

const provisionedTester = 'tester@example.invalid';

test('anonymous API calls get 401', async t => {
  const x = invited(t);
  for (const [path, options] of [
    ['/api/auras'], ['/api/auras/'], ['/api'], ['/api/auras/e07_demo_aura_sales/inbox'], ['/api/nope'],
    ['/api/auras/e07_demo_aura_sales/address', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }],
  ]) {
    const response = await x.anon(path, options);
    assert.equal(response.status, 401, path);
    assert.deepEqual(await response.json(), { error: 'Sign in to continue.' });
  }
});

test('a cookie that fails verification reaches no data route', async t => {
  const x = invited(t);
  const cookie = await signIn(x);
  // The first signature character: every bit of it counts, unlike the last one's.
  const [id, signature] = cookie.split('.');
  const tampered = `${id}.${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`;
  assert.equal((await x.anon('/api/auras', { headers: { cookie: tampered } })).status, 401);
});

test('static assets stay public, with or without the secret', async t => {
  const x = invited(t);
  assert.equal(await (await x.anon('/')).text(), 'app');
  delete x.env.SESSION_SECRET;
  assert.equal(await (await x.anon('/')).text(), 'app');
});

test('health stays open, with or without the secret', async t => {
  const x = invited(t);
  assert.equal((await x.anon('/api/health')).status, 200);
  assert.equal((await x.anon('/api/health/')).status, 200);
  delete x.env.SESSION_SECRET;
  assert.equal((await x.anon('/api/health')).status, 200);
});

test('a correct code opens /api/auras and sign-out closes it', async t => {
  const x = invited(t);
  const cookie = await signIn(x);
  const auras = await x.anon('/api/auras', { headers: { cookie } });
  assert.equal(auras.status, 200);
  assert.ok((await auras.json()).auras.length > 0);
  await post(x, '/api/auth/signout', {}, { cookie });
  assert.equal((await x.anon('/api/auras', { headers: { cookie } })).status, 401);
});

for (const [label, change] of [['missing', env => { delete env.SESSION_SECRET; }], ['empty', env => { env.SESSION_SECRET = ''; }]]) {
  test(`${label} SESSION_SECRET returns 503 on every API route but health`, async t => {
    const x = invited(t);
    const cookie = await signIn(x);
    change(x.env);
    for (const [path, options] of [
      ['/api/auras', { headers: { cookie } }], ['/api/auth/me', { headers: { cookie } }], ['/api'],
      ['/api/auth/request', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: INVITED }) }],
    ]) {
      const response = await x.anon(path, options);
      assert.equal(response.status, 503, path);
      assert.deepEqual(await response.json(), { error: 'Sign-in is unavailable right now.' });
    }
    assert.equal(x.sent.length, 1);
  });
}

test('removing an invite locks out its live session', async t => {
  const x = invited(t);
  const cookie = await signIn(x);
  assert.equal((await x.anon('/api/auras', { headers: { cookie } })).status, 200);
  x.sql.prepare('DELETE FROM demo_auth_invites WHERE email=?').run(INVITED);
  assert.equal((await x.anon('/api/auras', { headers: { cookie } })).status, 401);
  assert.equal(x.sql.prepare('SELECT COUNT(*) AS n FROM demo_auth_sessions WHERE email=?').get(INVITED).n, 0);
});

test('a database failure during the session check is a 500 with no data', async t => {
  const x = invited(t);
  const cookie = await signIn(x);
  t.mock.method(console, 'error', () => {});
  x.env.DB.prepare = () => { throw new Error('D1 is down'); };
  const response = await x.anon('/api/auras', { headers: { cookie } });
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: 'The inbox request failed. Please retry.' });
});

test('the harness request is signed in, so existing API tests run behind the gate', async t => {
  const x = setup(t);
  assert.equal((await x.request('/api/auras')).status, 200);
  assert.equal(x.sql.prepare('SELECT email FROM demo_auth_sessions').get().email, provisionedTester);
});

test('inbound mail still stores and replies with the gate on and no secret', async t => {
  const x = setup(t), demo = enableReplies(x);
  delete x.env.SESSION_SECRET;
  await worker.email(demo.message('sales-test@34five.studio', 'gate-on@example.invalid'), x.env);
  assert.equal(demo.replies.length, 1);
  const rows = x.sql.prepare("SELECT direction,status FROM email_messages WHERE aura_id='aura_demo_002' AND thread_id IN (SELECT thread_id FROM email_messages WHERE rfc_message_id='gate-on@example.invalid') ORDER BY direction").all();
  assert.deepEqual(rows.map(r => [r.direction, r.status]), [['in', 'received'], ['out', 'sent']]);
});

test('the sign-in state follows /api/auth/me', () => {
  assert.deepEqual(sessionFrom(200, { email: INVITED }), { state: 'signed-in', email: INVITED });
  assert.deepEqual(sessionFrom(401, { error: 'Sign in to continue.' }), { state: 'signed-out' });
  for (const [status, body] of [[503, { error: 'Sign-in is unavailable right now.' }], [500, null], [200, {}], [200, null], [200, { email: 42 }]]) {
    assert.deepEqual(sessionFrom(status, body), { state: 'unavailable' }, String(status));
  }
});
