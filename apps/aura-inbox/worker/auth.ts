import type { Env } from './types.ts';
import { HttpError } from './types.ts';
import { json } from './utils.ts';

// AXI-29: invite-only sign-in for the demo inbox, until Access or Studio login replaces it.
const COOKIE = 'aura_session';
const COOKIE_FLAGS = 'HttpOnly; Secure; SameSite=Lax; Path=/';
const SESSION_SECONDS = 604_800;
const CODE_MS = 600_000;
const REQUEST_WINDOW_MS = 600_000;
const MAX_REQUESTS = 3;
const MAX_ATTEMPTS = 5;
const LOCK_MS = 900_000;
const SENDER = 'no-reply@34five.studio';
const SUBJECT = 'Your sign-in code for the Aura inbox';
const NOT_INVITED = "This address hasn't been invited.";
const WRONG_CODE = 'That code is wrong or has expired.';
const LOCKED = 'Too many wrong codes. Try again in 15 minutes.';
const encoder = new TextEncoder();

function log(event: string, email: string, fields: Record<string, unknown> = {}): void {
  const [local, domain] = email.split('@');
  console.log(JSON.stringify({ event, email: `${local.slice(0, 1)}***@${domain}`, ...fields }));
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function fromBase64url(value: string): Uint8Array<ArrayBuffer> | null {
  try { return Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0)); }
  catch { return null; }
}

function secretKey(env: Env): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', encoder.encode(env.SESSION_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

async function sign(env: Env, data: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.sign('HMAC', await secretKey(env), encoder.encode(data)));
}

async function hashCode(env: Env, email: string, code: string): Promise<string> {
  return [...await sign(env, `${email}:${code}`)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

function randomCode(): string {
  // Values at or above the largest multiple of a million are redrawn, so every code is equally likely.
  const limit = Math.floor(2 ** 32 / 1_000_000) * 1_000_000;
  const value = new Uint32Array(1);
  do crypto.getRandomValues(value); while (value[0] >= limit);
  return String(value[0] % 1_000_000).padStart(6, '0');
}

async function sessionId(request: Request, env: Env): Promise<string | null> {
  const prefix = `${COOKIE}=`;
  const cookie = (request.headers.get('cookie') ?? '').split(';').map(part => part.trim()).find(part => part.startsWith(prefix));
  const [id, signature, extra] = cookie?.slice(prefix.length).split('.') ?? [];
  if (!id || !signature || extra !== undefined) return null;
  const bytes = fromBase64url(signature);
  if (!bytes) return null;
  return await crypto.subtle.verify('HMAC', await secretKey(env), bytes, encoder.encode(id)) ? id : null;
}

export async function signedInEmail(request: Request, env: Env): Promise<string | null> {
  const id = await sessionId(request, env);
  if (!id) return null;
  return env.DB.prepare(`SELECT s.email FROM demo_auth_sessions s JOIN demo_auth_invites i ON i.email=s.email
    WHERE s.id=? AND s.revoked_at IS NULL AND s.expires_at>?`).bind(id, new Date().toISOString()).first<string>('email');
}

export async function createSession(env: Env, email: string): Promise<string> {
  const id = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const now = Date.now();
  await env.DB.prepare('INSERT INTO demo_auth_sessions (id,email,created_at,expires_at) VALUES (?,?,?,?)')
    .bind(id, email, new Date(now).toISOString(), new Date(now + SESSION_SECONDS * 1000).toISOString()).run();
  return `${COOKIE}=${id}.${base64url(await sign(env, id))}; ${COOKIE_FLAGS}; Max-Age=${SESSION_SECONDS}`;
}

async function invitedEmail(env: Env, value: unknown): Promise<string | null> {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!email || email.length > 254) return null;
  return env.DB.prepare('SELECT email FROM demo_auth_invites WHERE email=?').bind(email).first<string>('email');
}

async function requestCode(env: Env, body: Record<string, unknown> | null): Promise<Response> {
  // Only the stored invite row is used from here on, so typed text never reaches the mail headers.
  const email = await invitedEmail(env, body?.email);
  if (!email) return json({ error: NOT_INVITED }, 403);
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const locked = await env.DB.prepare('SELECT 1 FROM demo_auth_throttle WHERE email=? AND locked_until>?').bind(email, nowIso).first();
  if (locked) return json({ error: LOCKED }, 429);
  const id = crypto.randomUUID();
  const code = randomCode();
  // One statement, so concurrent requests cannot both pass the count.
  const inserted = await env.DB.prepare(`INSERT INTO demo_auth_codes (id,email,code_hash,created_at,expires_at)
    SELECT ?,?,?,?,? WHERE (SELECT COUNT(*) FROM demo_auth_codes WHERE email=? AND created_at>=?)<?`)
    .bind(id, email, await hashCode(env, email, code), nowIso, new Date(now + CODE_MS).toISOString(),
      email, new Date(now - REQUEST_WINDOW_MS).toISOString(), MAX_REQUESTS).run();
  if (!inserted.meta.changes) return json({ error: 'Too many codes requested. Try again in a few minutes.' }, 429);
  try {
    await env.EMAIL.send({ from: { email: SENDER, name: 'Aura inbox' }, to: email, subject: SUBJECT,
      text: `Your sign-in code for the Aura inbox is ${code}.\n\nIt expires in 10 minutes and works once. If you didn't ask for it, you can ignore this email.\n` });
  } catch (error) {
    // The error message can name the recipient, so only its code is logged.
    const failure = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'unknown';
    log('inbox_auth_send_failed', email, { code: failure.replace(/[^A-Z_]/g, '').slice(0, 64) || 'unknown' });
    await env.DB.prepare('DELETE FROM demo_auth_codes WHERE id=?').bind(id).run();
    return json({ error: "We couldn't send the code. Please retry." }, 502);
  }
  log('inbox_auth_code_sent', email);
  return json({ ok: true });
}

async function verifyCode(env: Env, body: Record<string, unknown> | null): Promise<Response> {
  const email = await invitedEmail(env, body?.email);
  const code = typeof body?.code === 'string' ? body.code.replace(/\s/g, '') : '';
  if (!email || !/^\d{6}$/.test(code)) return json({ error: WRONG_CODE }, 401);
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  await env.DB.prepare('DELETE FROM demo_auth_throttle WHERE email=? AND locked_until<=?').bind(email, nowIso).run();
  // Charged before the compare, so concurrent guesses cannot exceed the limit.
  const attempts = await env.DB.prepare(`INSERT INTO demo_auth_throttle (email,failed_attempts) VALUES (?,1)
    ON CONFLICT(email) DO UPDATE SET failed_attempts=failed_attempts+1,
    locked_until=CASE WHEN failed_attempts+1=? THEN ? ELSE locked_until END RETURNING failed_attempts`)
    .bind(email, MAX_ATTEMPTS, new Date(now + LOCK_MS).toISOString()).first<number>('failed_attempts') ?? MAX_ATTEMPTS + 1;
  if (attempts > MAX_ATTEMPTS) return json({ error: LOCKED }, 429);
  const row = await env.DB.prepare(`SELECT id,code_hash FROM demo_auth_codes WHERE email=? AND consumed_at IS NULL AND expires_at>?
    ORDER BY created_at DESC,rowid DESC LIMIT 1`).bind(email, nowIso).first<{ id: string; code_hash: string }>();
  const matches = row !== null && constantTimeEqual(row.code_hash, await hashCode(env, email, code));
  const claimed = matches && (await env.DB.prepare('UPDATE demo_auth_codes SET consumed_at=? WHERE id=? AND consumed_at IS NULL')
    .bind(nowIso, row.id).run()).meta.changes === 1;
  if (!claimed) {
    if (attempts < MAX_ATTEMPTS) return json({ error: WRONG_CODE }, 401);
    log('inbox_auth_locked', email);
    return json({ error: LOCKED }, 429);
  }
  await env.DB.batch([
    env.DB.prepare('UPDATE demo_auth_codes SET consumed_at=? WHERE email=? AND consumed_at IS NULL').bind(nowIso, email),
    env.DB.prepare('DELETE FROM demo_auth_throttle WHERE email=?').bind(email),
    env.DB.prepare('UPDATE demo_auth_invites SET last_sign_in_at=? WHERE email=?').bind(nowIso, email),
  ]);
  const cookie = await createSession(env, email);
  log('inbox_auth_signed_in', email);
  const response = json({ email });
  response.headers.set('Set-Cookie', cookie);
  return response;
}

async function signOut(request: Request, env: Env): Promise<Response> {
  const id = await sessionId(request, env);
  if (id) await env.DB.prepare('UPDATE demo_auth_sessions SET revoked_at=? WHERE id=? AND revoked_at IS NULL').bind(new Date().toISOString(), id).run();
  const response = json({ ok: true });
  response.headers.set('Set-Cookie', `${COOKIE}=; ${COOKIE_FLAGS}; Max-Age=0`);
  return response;
}

export async function authApi(request: Request, env: Env, path: string): Promise<Response> {
  const route = path.slice('/api/auth/'.length);
  if (route === 'me') {
    if (request.method !== 'GET') return json({ error: 'Use GET.' }, 405);
    const email = await signedInEmail(request, env);
    return email ? json({ email }) : json({ error: 'Sign in to continue.' }, 401);
  }
  if (route !== 'request' && route !== 'verify' && route !== 'signout') throw new HttpError(404, 'Endpoint not found.');
  if (request.method !== 'POST') return json({ error: 'Use POST.' }, 405);
  // A JSON content type forces a CORS preflight, which this API never grants, so other sites cannot post here.
  if (!/^application\/json\b/i.test(request.headers.get('content-type') ?? '')) return json({ error: 'Send a JSON request.' }, 415);
  if (route === 'signout') return signOut(request, env);
  const body = await request.json<Record<string, unknown> | null>().catch(() => null);
  return route === 'request' ? requestCode(env, body) : verifyCode(env, body);
}
