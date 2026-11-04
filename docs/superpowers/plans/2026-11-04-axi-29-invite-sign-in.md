# AXI-29 Invite-Only Sign-In Implementation Plan

**Goal:** Only invited people can see inbox data. They sign in with a 6-digit code sent by email.

**Architecture:** One new Worker module, `worker/auth.ts`, holds the endpoints, code and session logic. `worker/index.ts` gates every `/api` route. Static assets stay public, as one bundle, and hold no data: `App.tsx` asks `/api/auth/me` and renders the sign-in screen until the user is signed in. The `email()` handler is untouched.

**Tech Stack:** Cloudflare Workers, D1, `send_email` binding, WebCrypto, React 19, `node --test`.

**Spec:** Linear AXI-29 and the CTO brief of 2026-11-04. This feature is temporary, until Access or Studio login replaces it. Keep it small.

## Decisions

Reviewed by CTO on 2026-11-04.

1. **One bundle.** Once `/api` is gated, hiding minified JS has near-zero security value. `run_worker_first` stays `["/api", "/api/*"]`, so static assets, including the app shell, pass through without the Worker. This is what the brief's "gate the ASSETS branch" became.
2. **Structured `env.EMAIL.send({ from, to, subject, text })`, not `EmailMessage`.** The repo's only existing sends use it (`spikes/cf-email/src/index.ts:135`), Cloudflare recommends it, and it needs no MIME dependency. `cloudflare:email` also cannot be imported under `node --test`.
3. **`demo_auth_` table prefix.** The Worker shares `development_replica` with other schemas, and `CREATE TABLE IF NOT EXISTS` would silently keep a colliding table.
4. **The code hash is HMAC-SHA256 over `email:code`, keyed with `SESSION_SECRET`.** It uses the same primitive as the cookie. A plain hash of a 6-digit code reverses instantly from a database copy.
5. **Attempts are charged before the compare.** Concurrent guesses therefore cannot exceed 5.
6. **The clickable email link is skipped.** It is optional, and code-only keeps this smaller.

`34five.studio` is onboarded for Email Sending (`wrangler email sending list`, checked by CTO), so no verified-destination handling is needed. CTO proves external delivery on first deploy.

## Global Constraints

- Non-invited message, exact: `This address hasn't been invited.`
- Email subject, exact: `Your sign-in code for the Aura inbox`. Plain text body. Sender: `no-reply@34five.studio`.
- Codes: 6 digits from `crypto.getRandomValues`, stored hashed, single-use, 10-minute expiry.
- 5 wrong attempts locks that email for 15 minutes. At most 3 code requests per email per 10 minutes. Constant-time compare.
- Session: random 256-bit id in D1. Cookie `aura_session` = id signed with HMAC-SHA256 using `SESSION_SECRET`; `HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800`.
- `SESSION_SECRET` missing: 503 `{ error: 'Sign-in is unavailable right now.' }` on every `/api` route except `/api/health`.
- Exempt from the gate: only `/api/health` and `/api/auth/*`.
- Every `/api/auth/*` response and any response with `Set-Cookie` has `Cache-Control: no-store`.
- Never log codes or full emails. `frontend/public/_headers` does not change. No new dependencies, fonts or libraries.
- No deploys, no secrets set, no remote migrations. No AI attribution in commits or the PR. Don't touch Linear.

## Review Focus

Each has a test in its owning task.

1. The invitee types `  Akash@AxiaTechnologies.AI `: sign-in works, and mail goes to the lower-cased invite row, never to the typed text.
2. The email send fails: a clear 502, no usable code left behind, and the 3-per-10-minute budget not spent.
3. A forged, tampered or wrong-secret cookie gets 401 and never reaches a data route.
4. An invite is removed while its session is live: `GET /api/auras` with that cookie is 401.
5. D1 fails during the session check: 500, never data.

---

### Task 1: Schema, seed, config, harness

**Files:**
- Create: `scripts/0004_demo_auth.sql`, `apps/aura-inbox/scripts/provision-invites.sql`, `apps/aura-inbox/tests/auth.test.mjs`
- Modify: `apps/aura-inbox/worker/types.ts`, `.dev.vars.example`, `wrangler.jsonc`, `tests/harness.mjs`

**Interfaces:**
- Produces: tables below. `Env.SESSION_SECRET?: string`, `Env.EMAIL: SendEmail`. Harness: `env.SESSION_SECRET = 'test-session-secret'`, `env.EMAIL` recording into `x.sent` (setting `x.failSend` makes it throw), `x.anon(path, options)` sending no cookie.

```sql
demo_auth_invites  (email PK CHECK (email = lower(email)), invited_by NOT NULL, invited_at NOT NULL, last_sign_in_at)
demo_auth_codes    (id PK, email FK ON DELETE CASCADE, code_hash NOT NULL, created_at NOT NULL, expires_at NOT NULL, consumed_at)
                   index on (email, created_at)
demo_auth_throttle (email PK FK ON DELETE CASCADE, failed_attempts INTEGER NOT NULL, locked_until)
demo_auth_sessions (id PK, email FK ON DELETE CASCADE, created_at NOT NULL, expires_at NOT NULL, revoked_at)
```

- [ ] **Step 1: Write failing tests** in `tests/auth.test.mjs`
  - `both environments may send login mail`: `no-reply@34five.studio` in both `allowed_sender_addresses`. The existing `demo.test.mjs` order check must still pass, so add it last in the default env and before Merlin in demo.
  - `the invite seed adds Akash once`: run `provision-invites.sql` twice, expect one row with `email='akash@axiatechnologies.ai'`, and `PRAGMA foreign_key_check` empty.
- [ ] **Step 2: Run** `node --test tests/auth.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement.** Migration idempotent with `CREATE TABLE IF NOT EXISTS` and a header comment in the `0003` style. Seed `ON CONFLICT(email) DO NOTHING`, same comment style as `provision-atlas.sql`. Add `0004` to the harness list. `SESSION_SECRET=` in `.dev.vars.example`.
- [ ] **Step 4: Run** `npm test`. Expected: all pass, including existing tests.
- [ ] **Step 5: Commit** `feat(aura-inbox): add invite tables and login mail config`

### Task 2: Code and session endpoints

**Files:**
- Create: `apps/aura-inbox/worker/auth.ts`
- Modify: `apps/aura-inbox/worker/index.ts` (route `/api/auth/*` to `authApi`)
- Test: `apps/aura-inbox/tests/auth.test.mjs`

**Interfaces:**
- Consumes: Task 1 tables and harness.
- Produces:
  - `authApi(request: Request, env: Env, path: string): Promise<Response>` routes `/api/auth/{request,verify,signout,me}`; anything else is 404, wrong method 405, POST without JSON content type 415 (same rule as `api.ts`).
  - `signedInEmail(request: Request, env: Env): Promise<string | null>`: verifies the signature with `crypto.subtle.verify`, then `SELECT` joined to the invite with `revoked_at IS NULL AND expires_at > now`.
  - `createSession(env: Env, email: string): Promise<string>`: returns the `Set-Cookie` value. The harness uses it too.

Responses:

| Case | Status | Body |
|---|---|---|
| request, not invited | 403 | `{ error: "This address hasn't been invited." }` |
| request, sent | 200 | `{ ok: true }` |
| request, over 3 in 10 minutes | 429 | `{ error: 'Too many codes requested. Try again in a few minutes.' }` |
| request or verify, locked | 429 | `{ error: 'Too many wrong codes. Try again in 15 minutes.' }` |
| request, send threw | 502 | `{ error: "We couldn't send the code. Please retry." }` |
| verify, wrong, expired, reused or not invited | 401 | `{ error: 'That code is wrong or has expired.' }` |
| verify, correct | 200 | `{ email }` and `Set-Cookie` |
| signout | 200 | `{ ok: true }`, revokes the row, clears the cookie with `Max-Age=0` |
| me | 200 or 401 | `{ email }` or `{ error: 'Sign in to continue.' }` |

Algorithms the tests do not fully determine:

- Request: normalise with `trim().toLowerCase()`, reject over 254 characters as not invited, read the invite row, check the lock, then `INSERT ... SELECT ... WHERE (SELECT COUNT(*) ... created_at >= now-10m) < 3` so the limit is atomic. `changes === 0` means 429. Send to the email from the invite row. If the send throws, delete the new row and return 502.
- Verify: not invited, or a code that is not 6 digits after removing spaces, returns 401 with no write. Delete an expired lock row. Then charge first: upsert `failed_attempts + 1`, setting `locked_until = now+15m` only when the new count is exactly 5, `RETURNING failed_attempts`. Over 5 returns 429. Load the newest unconsumed unexpired code, compare hashes with an XOR loop, and claim with `UPDATE ... WHERE id=? AND consumed_at IS NULL` (`changes` must be 1). On success consume all that email's codes, delete the throttle row, set `last_sign_in_at`, create the session. On failure at count 5 return the lock message, else the wrong-code message.
- Code: `Uint32` from `getRandomValues` with rejection sampling above `floor(2^32/1e6)*1e6`, zero-padded to 6.
- Logs: `inbox_auth_code_sent`, `inbox_auth_send_failed` (error code only, never its message), `inbox_auth_locked`, `inbox_auth_signed_in`, with the email masked as `ak***@domain`.

- [ ] **Step 1: Write failing tests** using the harness. `signIn(x, email)` helper: request, read the code from `x.sent.at(-1).text` with `/\b\d{6}\b/`, verify.
  - `a non-invited address gets the exact message and no mail`: 403, exact string, `x.sent.length === 0`.
  - `an invited address is mailed a code from the login sender`: `from.email` is `no-reply@34five.studio`, exact subject, 6 digits; the stored `code_hash` is 64 hex and not the code.
  - `email case and spaces are ignored and mail goes to the invite row` (Focus 1).
  - `a fourth code request inside 10 minutes is refused`: three 200s, then 429, `x.sent.length === 3`.
  - `five wrong codes lock the email`: four 401s, fifth 429, then the correct code 429, and a new request 429; after moving `locked_until` to the past the correct code works.
  - `concurrent wrong guesses cannot exceed five`: `Promise.all` of 10 wrong verifies, then `failed_attempts >= 5` and the correct code 429.
  - `the correct code sets a hardened cookie`: `Set-Cookie` contains `aura_session=`, `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, `Max-Age=604800`; `Cache-Control: no-store`; `/api/auth/me` returns the email; `last_sign_in_at` set.
  - `an expired code is rejected`, `a used code is rejected`, `an older code stops working once a newer one is requested`.
  - `a failed send gives 502, leaves no code and spends no budget` (Focus 2): `x.failSend = true`, 502, zero code rows; then three requests succeed.
  - `sign-out revokes on the server`: reuse the old cookie after signout, `me` is 401, `revoked_at` set, response clears the cookie and is `no-store`.
  - `a forged cookie is refused` (Focus 3): flipped signature, signed with another secret, valid signature on an unknown id, garbage; `me` 401 for each.
  - `an expired session is refused`: move `expires_at` to the past, `me` 401.
  - `logs never hold the code or the full email`: capture `console.log` and `console.error` across a whole sign-in and a failed send, and assert neither appears.
- [ ] **Step 2: Run** `node --test tests/auth.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement** `worker/auth.ts` and the `/api/auth/*` route.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(aura-inbox): add email code sign-in endpoints`

### Task 3: The gate

**Files:**
- Modify: `apps/aura-inbox/worker/index.ts`, `tests/harness.mjs`
- Test: `apps/aura-inbox/tests/auth.test.mjs`

**Interfaces:**
- Consumes: `authApi`, `signedInEmail`, `createSession`.
- Produces: harness `x.request(path, options)` sends a cookie for a seeded invite, so existing tests stay as they are.

Order for `/api` paths, inside the existing `try`, so a D1 failure is a 500:

```ts
const route = path.replace(/\/$/, '');   // the same rule api.ts uses
if (route === '/api/health') return await api(request, env);
if (!env.SESSION_SECRET) return json({ error: 'Sign-in is unavailable right now.' }, 503);
if (route === '/api/auth' || route.startsWith('/api/auth/')) return await authApi(request, env, route);
if (!await signedInEmail(request, env)) return json({ error: 'Sign in to continue.' }, 401);
return await api(request, env);
```

The static asset branch does not change.

- [ ] **Step 1: Write failing tests**
  - `anonymous API calls get 401`: `/api/auras`, `/api/auras/x/inbox`, POST `/api/auras/x/address`, `/api`, `/api/auras/`.
  - `static assets stay public and hold no gate`: `x.anon('/')` returns the asset, also with `SESSION_SECRET` removed.
  - `health stays open`: `x.anon('/api/health')` 200, also with `SESSION_SECRET` removed.
  - `a correct code opens /api/auras and sign-out closes it`: anonymous full flow through `fetch()`, 200 then 401.
  - `a missing or empty SESSION_SECRET returns 503 on every API route but health`: `/api/auras`, `/api/auth/me`, POST `/api/auth/request`.
  - `removing an invite locks out its live session` (Focus 4): `DELETE` the invite, then `/api/auras` with the valid cookie is 401.
  - `a database failure during the session check is a 500 with no data` (Focus 5): make `env.DB.prepare` throw, signed-in cookie, `/api/auras` is 500.
  - `inbound mail still stores and replies with the gate on`: `worker.email(demo.message(...), x.env)` with `SESSION_SECRET` removed, one stored message, one reply.
- [ ] **Step 2: Run** `npm test`. Expected: new tests FAIL, existing pass.
- [ ] **Step 3: Implement** the gate and the harness change.
- [ ] **Step 4: Run** `npm test`. Expected: all pass.
- [ ] **Step 5: Commit** `feat(aura-inbox): gate the API behind sign-in`

### Task 4: Sign-in screen and app changes

**Files:**
- Create: `apps/aura-inbox/frontend/src/SignIn.tsx`, `frontend/src/auth-state.ts`
- Modify: `frontend/src/App.tsx`, `frontend/src/style.css`
- Test: `apps/aura-inbox/tests/auth.test.mjs`

**Interfaces:**
- Consumes: the Task 2 responses.
- Produces: `sessionFrom(status: number, body: { email?: string } | null): { state: 'signed-in'; email: string } | { state: 'signed-out' } | { state: 'unavailable' }`, in `auth-state.ts`, following `address-state.ts`.

- `App.tsx`: the current `App` becomes `Inbox({ email, onSignOut })`, with its effects unchanged. A new `App` calls `GET /api/auth/me` on mount and renders nothing while loading, `<SignIn/>` full-screen when signed out, `Sign-in is unavailable right now.` on 503 or a network failure, and `<Inbox/>` only when signed in, so no data fetch starts earlier. Sign-in success sets state with no page reload, and the URL never changes, so deep links keep working.
- `get` and `post`: a 401 calls a module-level handler that flips `App` to `<SignIn/>`. Unmounting `Inbox` stops its polling through the existing effect cleanups.
- `SignIn`: email step, code step (`inputMode="numeric"`, `autoComplete="one-time-code"`), "Use a different email". Show server errors as they arrive, with `role="alert"`. `<form>` with `preventDefault`, because the CSP has `form-action 'none'`.
- Sign out: POST `/api/auth/signout`, then render `<SignIn/>`. If the POST fails, stay in the inbox and show the error, because the session is still live.
- Top bar: `Signed in as <email>` and a `Sign out` button. Rail note: `Invited users only. Use test messages only.`
- CSS: `.signin*` rules and `input:focus-visible`, using existing tokens only.

- [ ] **Step 1: Write failing tests** `sessionFrom`: 200 with email is signed-in; 401 signed-out; 503, 500 and 200 without an email are unavailable.
- [ ] **Step 2: Run** `node --test tests/auth.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement** `auth-state.ts`, `SignIn.tsx`, the `App.tsx` changes, the CSS.
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm run build`. Expected: all pass.
- [ ] **Step 5: Commit** `feat(aura-inbox): add the sign-in screen and signed-in top bar`

### Task 5: README and end-to-end check

**Files:**
- Modify: `apps/aura-inbox/README.md`

- [ ] **Step 1: Update the README.** Line 5 (no longer public), endpoints (`/api/auth/*`), line 129 (no longer "no login"). Runbook: replace the Zero Trust instruction in step 3 with: apply `0004_demo_auth.sql`, apply `provision-invites.sql`, `openssl rand -hex 32 | npx wrangler secret put SESSION_SECRET --env demo`, how to add and remove an invite. Note that rotating `SESSION_SECRET` invalidates pending codes and all sessions, and that the default Worker needs the secret too if it is ever deployed from here, or its API returns 503.
- [ ] **Step 2: Run in a browser with `wrangler dev --local --env demo`,** with a temporary `.dev.vars` and local D1 fixtures. Confirm: anonymous `/` shows sign-in and `/api/auras` is 401; a non-invited address shows the exact message; email to code to inbox works with no reload; the top bar shows the email; a deep link survives; sign-out returns to sign-in; `Secure` cookie accepted on localhost; no CSP errors in the console. Take the code from the local send output. Screenshots stay out of the repo.
- [ ] **Step 3: Run** `npm ci && npm run check`. Expected: typecheck, tests, build and dry-run all pass. Save the counts for the PR.
- [ ] **Step 4: Commit** `docs(aura-inbox): document invite sign-in and the runbook`
- [ ] **Step 5: Request code review** with `superpowers:requesting-code-review`, fix findings, re-run the check, push, and open the PR to `spikes/cf-email`. Body: what changed, security notes (non-invited message reveals invite status by design; anyone can lock out an invited email for 15 minutes; the app bundle is public but holds no data; `/api/health` still reveals the org id), how verified. Check `git log` and the PR body for attribution lines before pushing.
