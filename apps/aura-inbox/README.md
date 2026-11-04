# Aura inbox test

A read-only inbox for each Aura, with real incoming email. One Cloudflare Worker serves the React/Vite UI and `/api` endpoints. The only writes are generating an address for an Aura and retrying its provisioning.

This is a test deployment. Only invited people can see inbox data, and they sign in with a code sent by email (see [Sign-in](#sign-in)). This is temporary, until Access or Studio login replaces it. Every invited person sees every Aura: `DEMO_ORG_ID` limits all queries and inbound routing to `org_demo_001`, and there is no member or Aura authorization. Use test messages only, and add that authorization before using customer data.

Deployed at https://aura-inbox-test.cassius-kellogg.workers.dev. The API uses the same origin under `/api`.

## Run locally

Use Node 22.18 or later. The integration tests need Node 24 or later for `node:sqlite`.

```sh
cd apps/aura-inbox
npm ci
npm run check
```

Start the Worker with `npm run dev:worker` and Vite in a second terminal with `npm run dev`. Vite proxies `/api` to port 8788. Local D1 and R2 are separate from Cloudflare.

The Worker expects the existing email schema. For a fresh local database, import the parent fixture, migration, and seed from the repository with `wrangler d1 execute DB --local --file PATH`. The supplied repository seed uses organization `e07_demo_org`. Override `DEMO_ORG_ID` locally to view that seed. The remote database uses Prajwal's `org_demo_001` seed. Do not import the local seed or parent fixture remotely.

## Endpoints

Every `/api` route needs a signed-in session except `/api/health` and `/api/auth/*`. Static files, including the app bundle, are public and hold no data.

- `GET /api/health`: database connectivity and test mode.
- `POST /api/auth/request`, `POST /api/auth/verify`, `POST /api/auth/signout`, `GET /api/auth/me`: see [Sign-in](#sign-in).
- `GET /api/auras`: names, assigned addresses, and record counts.
- `GET /api/auras/:auraId/inbox`: threads with sender, preview, and message count. Supports `limit` (1–50), `cursor`, `q` (subject/sender), and `status` (`open`, `closed`, `archived`).
- `GET /api/auras/:auraId/threads/:threadId/messages`: chronological messages, recipients, and attachment metadata. Supports `limit` and `cursor` for earlier messages. Bcc is omitted.
- `GET /api/auras/:auraId/messages/:messageId/body`: full body for R2-backed messages.
- `GET /api/auras/:auraId/messages/:messageId/attachments/:attachmentId`: forced-download attachment bytes.

The UI refreshes every five seconds while visible. It preserves older loaded pages. Quoted `>` history and its reply attribution collapse behind “Show quoted text.” Inline answers between quote blocks stay visible. HTML-only blockquotes and Gmail quote containers also collapse. Expanding a quote preserves its content and stays open across automatic refreshes.

Email HTML becomes text. Scripts, remote images, and interactive email content do not run.

## Sign-in

Only addresses in `demo_auth_invites` can sign in. Anyone else sees "This address hasn't been invited."

| Endpoint | What it does |
|---|---|
| `POST /api/auth/request` `{email}` | Sends a 6-digit code from `no-reply@34five.studio` |
| `POST /api/auth/verify` `{email,code}` | Sets the session cookie |
| `POST /api/auth/signout` | Revokes the session on the server and clears the cookie |
| `GET /api/auth/me` | `{email}`, or 401 |

A code lasts 10 minutes and works once, and only the newest one works. Three requests per email per 10 minutes are allowed. Five wrong codes lock that email for 15 minutes, and anyone who knows an invited address can trigger that lock. Sessions last 7 days.

`SESSION_SECRET` signs cookies and keys the stored code hashes. Without it, every `/api` route except `/api/health` returns 503. Rotating it invalidates pending codes and all sessions, so everyone signs in again. Inbound mail never depends on it.

To invite someone, add a line to `scripts/provision-invites.sql` and apply it, or insert the lower-case address directly. To remove someone, delete their row, which also ends their sessions at once:

```sh
npx wrangler d1 execute DB --remote --file scripts/provision-invites.sql
npx wrangler d1 execute DB --remote --command "DELETE FROM demo_auth_invites WHERE email='person@example.com'"
```

The migration only adds tables. Earlier deployed code ignores them. Apply it before deploying, or sign-in returns 500:

```sh
npx wrangler d1 execute DB --remote --file ../../scripts/0004_demo_auth.sql
```

Every Worker running this code needs its own `SESSION_SECRET`. The default `aura-inbox-test` Worker's API returns 503 without one if it is ever deployed from here.

## Incoming mail

Cloudflare Email Routing sends only the two new test aliases to `aura-inbox-test`:

- `support-test@34five.studio` → existing `aura_demo_001` (Customer Support Aura).
- `sales-test@34five.studio` → existing `aura_demo_002` (Sales Aura).

The existing `spike-test` and `anthony` routes and catch-all remain unchanged.

### Default test replies

`AUTO_REPLY_ENABLED=true` enables a fixed demo response for both real test addresses. The reply uses the receiving Aura's name and address. It preserves the conversation subject and uses Cloudflare's native reply API for sender validation and threading. Mention `attachment` or include an attachment to receive `aura-demo.txt`. Uploaded files are not echoed back.

`AUTO_REPLY_MODE` chooses the reply text and which addresses reply. `fixed` (the default) sends the fixed demo response from the two test addresses only. `llm` generates the reply as described below, from any active address on an active domain with an open assignment, including addresses made with **Generate email**. It never answers mail from an address in `email_addresses`, in any status. Any other value behaves as `fixed`.

Outgoing replies, recipients, and sample attachments are saved in the same Aura conversation. A reply is marked `sent` only after provider acceptance. Recipient delivery remains `accepted`, not `delivered`. The existing seeded messages are not answered retroactively.

The handler skips automated mail, mailing lists, bounces, known test-address senders, invalid Message-IDs, and threads with 20 references. It ignores incoming Reply-To redirection. A unique D1 send key claims each sender/Message-ID pair within the Aura before a provider call. The active address assignment is checked again before dispatch. Duplicate deliveries cannot create a second reply claim.

Provider timeouts leave the claimed reply in `sending` with an `unknown` event. They do not trigger retries. A tracking failure after provider acceptance also keeps the claim. Reconciliation is manual in this test version. A crash after incoming persistence but before the reply claim can leave mail without a reply. It does not resend automatically. Set `AUTO_REPLY_ENABLED=false` and deploy to disable replies.

The handler resolves the active domain, address, and assignment from the envelope recipient. It matches RFC reply headers only within that organization and Aura. Conflicting or unknown parents start a new thread. A SHA-256 fingerprint of organization, envelope sender/recipient, and exact MIME bytes deduplicates identical redeliveries. Header Message-ID alone does not deduplicate mail. Providers can change MIME bytes between deliveries, so this does not guarantee deduplication of modified redeliveries.

The handler uploads raw MIME, attachments, and large bodies to private R2. D1 batch commits contacts, thread, message, recipients, and attachment references together. Private object keys include a delivery-attempt ID. Concurrent duplicate cleanup cannot delete another delivery's objects. An ambiguous database failure may leave unreferenced R2 objects for later cleanup. No automatic deletion runs against referenced mail.

The test limits are 25 MiB per raw email, 20 To/Cc recipients, and 20 attachments. Body text and HTML above 64 KiB use R2. Unknown/inactive receiving addresses are rejected. Address reassignment preserves historical messages with their original Aura and assignment.

### LLM replies

With `AUTO_REPLY_MODE=llm`, the reply text comes from a model instead of the fixed response. Claiming, threading, the headers, and the send path stay the same. `sendReply()` in `worker/auto-reply.ts` is the single dispatch point for later routing through the rules engine.

The model is config, not code. An Aura's `auras.llm_id` selects it in the form `provider:model`, for example `gemini:gemini-3.5-flash-lite` or `anthropic:claude-sonnet-4-5`. A null or unparseable `llm_id` falls back to `DEFAULT_LLM_MODEL` in `wrangler.jsonc`. Providers live in `worker/llm/`.

Keys are Worker secrets: `GEMINI_API_KEY` and `ANTHROPIC_API_KEY`. Locally, copy `.dev.vars.example` to `.dev.vars` (gitignored). To prove a key and model work without deploying:

```sh
npm run llm:smoke -- "hello"
npm run llm:smoke -- --model anthropic:claude-sonnet-4-5 "hello"
```

The prompt uses the Aura's name, any role, facet, personality, and blocklist (topics to decline) on its row, plus the thread's received and sent messages with quoted history removed. HTML-only mail is converted to text. A thread is limited to 24000 characters: the oldest messages drop first, and the email being answered is always kept. Thread content is wrapped as untrusted data. Attachments are not read: the reply acknowledges them and sends no file back.

The demo uses a neutral system instruction plus whatever config the Aura's row holds. Empty fields are left out, and nothing here adds a voice or tone. The bound `auras` table currently has only `id`, `org_id`, and `name`, so replies use the Aura's name and the email rules alone. The authoritative source for Aura configuration is to be agreed with 34Five (AXI-24).

Replies are capped at 1024 output tokens and 2000 characters at a sentence boundary. A reply cut off by the token limit is still sent, trimmed to its last complete sentence.

If the provider fails, times out after 20 seconds, returns nothing, or blocks the reply, nothing is sent. There is no fallback to the fixed text. The claimed row becomes `failed`, an `email_events` row keeps the sanitized detail, and the log records `inbox_llm_reply_failed`. The inbox shows "Reply failed" with a fixed public phrase for the error class. A reply row that is still `sending` with no body after 120 seconds shows "Reply timed out". That state is derived when read and writes nothing.

Each generated reply costs a provider call, and these addresses are public. `LLM_SENDER_HOURLY_CAP` (default 10, rolling hour, per sender) and `LLM_AURA_DAILY_CAP` (default 200, UTC day, per Aura) limit them. Every attempt counts, including failed ones. Over a cap, the handler makes no call, sends nothing, creates no reply row, and logs `inbox_llm_reply_skipped`.

## Deploy and provision

**Do not deploy `spikes/cf-email` over the live Worker until the live source is merged in.** The live Worker has code and config that are not in this repository, and deploying from here would drop the `env.GOVERNANCE` Durable Object binding and its `GovernanceCoordinator` class.

The Wrangler configuration binds `development_replica` and private R2 bucket `aura-inbox-test-mail`.

```sh
npm run deploy
```

After verifying Cloudflare Email Routing is ready for `34five.studio`, run:

```sh
node scripts/provision-addresses.mjs --remote
```

This command checks existing ownership before adding the real addresses and active assignments. It preserves placeholder addresses and seeded message history. Reruns are idempotent. Conflicts stop the command. The SQL file is provisioning data, not a schema migration.

The demo environment is a separate Worker, `aura-inbox-demo`, with `AUTO_REPLY_MODE` set to `llm`, no Durable Object, and the same D1 and R2. The default config stays in fixed mode. Set its key and deploy it with:

```sh
node scripts/provision-merlin.mjs --remote
npx wrangler secret put GEMINI_API_KEY --env demo
npm run build && npx wrangler deploy --env demo
```

`provision-merlin.mjs` adds the Merlin Aura and `merlin@34five.studio` without touching rows outside Merlin's own, and stops on any conflict. Merlin appears in the API of every Worker bound to this D1. Route `merlin@34five.studio` to `aura-inbox-demo`, and do not repoint the existing addresses.

Create the two literal `to` routing rules with `wrangler email routing rules create`, action `worker:aura-inbox-test`. List existing rules before changes and verify them afterward. Do not replace the domain catch-all or repoint the spike Worker.

To verify externally, send a test email to each alias. Confirm the message appears only in its Aura's inbox within five seconds. Reply from the external sender to the same alias to verify thread grouping. Local integration tests cover MIME storage and routing, but cannot establish external provider delivery.

## Generate an address for an Aura

An Aura with no address shows **Generate email** on its card. The button proposes `<aura-name>@<domain>` from the active rows in `email_domains`. With several active domains it lists them. Confirming creates the address and its assignment in one D1 batch, then asks Cloudflare to route it. An Aura keeps one address: if it has one, the API returns it and creates nothing.

| Endpoint | What it does |
|---|---|
| `GET /api/auras/:id/address` | The current address and provisioning status, or 404 |
| `GET /api/auras/:id/address/proposal` | The address each active domain would give |
| `POST /api/auras/:id/address` | Creates the address. With several active domains, send `domain_id`. With none, returns 409 |
| `POST /api/auras/:id/address/provision` | Retries the routing rule |

POST requests must be JSON, which stops other sites posting from a browser. Any invited person can generate an address for any Aura in the demo org and create its routing rule. Each Aura gets one address, routed only to the demo Worker.

Provisioning state lives in `email_address_provisioning`:

- `provisioning_pending`: the secrets are not set. The response and the card show the exact rule to create.
- `failed`: Cloudflare refused or could not be reached, or another rule already routes this address. That rule is never changed. The card shows the reason and a retry.
- `active`: the rule exists. An address with no row was routed by hand before this table existed, and also counts as active.

A failure never blocks the address. Retry finishes it once the cause is fixed.

Apply the migration before deploying, because `/api/auras` reads the new table. It only adds a table, and earlier deployed code ignores it.

```sh
npx wrangler d1 execute DB --remote --file ../../scripts/0003_email_address_provisioning.sql
```

To let the Worker create rules, set a token limited to Email Routing Rules on the zone, and the zone ID. A domain row's `cloudflare_zone_id` takes priority over `CF_ZONE_ID`. `DEMO_WORKER_NAME` sets the target Worker and defaults to `aura-inbox-demo`.

```sh
npx wrangler secret put CF_API_TOKEN --env demo
npx wrangler secret put CF_ZONE_ID --env demo
```

## Thursday demo runbook

Run this after the AXI-23 PR that adds the `demo` environment has merged. Until then `--env demo` fails. Run everything from `apps/aura-inbox` on an up-to-date `spikes/cf-email`, after `npm ci`.

**1. Add the provisioning table.** Do this before deploying, or `/api/auras` returns 500 on the new code.

```sh
npx wrangler d1 execute DB --remote --file ../../scripts/0003_email_address_provisioning.sql
```

**2. Add the Atlas Aura, then check it.** The check must return one row. No row means a guard stopped the insert: the domain is not active, another Aura has the name, or the address is taken.

```sh
npx wrangler d1 execute DB --remote --file scripts/provision-atlas.sql
npx wrangler d1 execute DB --remote --command "SELECT id,org_id,name FROM auras WHERE id='aura_demo_atlas'"
```

**3. Set up sign-in, then deploy the demo Worker.** It is served only at https://inbox-demo.34five.studio (a custom domain on the zone; the workers.dev URL is off). Do the first three commands before deploying, or the API returns 503 or 500. Add the people to invite to `scripts/provision-invites.sql` first. Inbound mail is unaffected: Email Routing hands mail to the Worker directly.

```sh
npx wrangler d1 execute DB --remote --file ../../scripts/0004_demo_auth.sql
npx wrangler d1 execute DB --remote --file scripts/provision-invites.sql
openssl rand -hex 32 | npx wrangler secret put SESSION_SECRET --env demo
npm run build && npx wrangler deploy --env demo
```

**4. Set the secrets, if the token is ready.** Each command prompts for the value. The zone ID for `34five.studio` is `1c60311626bbfe94b6fe3496d15de727`. Skip this step to demo the pending state.

```sh
npx wrangler secret put CF_API_TOKEN --env demo
npx wrangler secret put CF_ZONE_ID --env demo
```

**5. Generate the address.** If the chip shows Failed with 'Already routed by another Cloudflare rule', pick a different Aura; do not change the existing rule. Open the demo URL and sign in with an invited address. On Atlas's card, choose **Generate email**, check that it proposes `atlas@34five.studio`, then choose **Create address**.

- With the secrets, the chip shows **Active** and the rule exists. Skip step 6.
- Without them, the chip shows **Provisioning pending** with the rule to create.
- **Failed** shows the reason. Fix the cause and choose **Retry**.

**6. Without the secrets, create the rule by hand.** Do this after step 5, because mail to an address the database does not know is rejected. List the rules first and stop if one already matches this address.

```sh
npx wrangler email routing rules list 34five.studio
npx wrangler email routing rules create 34five.studio --name "AuraComms atlas@34five.studio" --match-type literal --match-field to --match-value atlas@34five.studio --action-type worker --action-value aura-inbox-demo
```

The chip stays on **Provisioning pending** because the Worker cannot see this rule. Mail still flows. If the secrets are set later, **Retry** finds the rule and the chip shows **Active**.

**7. Send a real test email to `atlas@34five.studio`.** It should appear in Atlas's inbox within five seconds, and a reply should come back from that address. This needs the demo Worker in `llm` mode. Fixed mode does not reply from generated addresses. This is the first real test of a reply from a generated address. If the thread shows **Reply failed**, report that as a finding: inbound mail still counts as working.

## Verification on November 2, 2026

- 31 inbox/reply and quote-parser tests passed, including SQLite with the real schema, foreign keys, and MIME parser.
- The existing 51 schema/lifecycle tests and 68 spike tests passed.
- TypeScript, Vite production build, and Wrangler deployment checks passed.
- The local Cloudflare runtime processed a synthetic MIME email twice and stored one Sales message. The Support inbox did not return it.
- Native default replies passed in the local Cloudflare emulator for both real test addresses. Each conversation stored one incoming message and one sent reply with a sample attachment. Repeated deliveries did not send another reply.
- Live API checks returned populated seeded messages for each Aura and `404` for cross-Aura thread lookups.
- Both real receiving addresses are active in D1 and have enabled Cloudflare rules. The spike-test, anthony, and catch-all rules retained their prior IDs and actions.
- Live browser checks covered both inboxes and conversation loading. No external SMTP test message was sent during setup.
