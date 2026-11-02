# Aura inbox test

A read-only inbox for each Aura, with real incoming email. One Cloudflare Worker serves the React/Vite UI and `/api` endpoints.

This is a public test deployment with no login. `DEMO_ORG_ID` limits all queries and inbound routing to `org_demo_001`. It is not authentication. Use test messages only. Add authentication and member/Aura authorization before using customer data.

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

- `GET /api/health`: database connectivity and test mode.
- `GET /api/auras`: names, assigned addresses, and record counts.
- `GET /api/auras/:auraId/inbox`: threads with sender, preview, and message count. Supports `limit` (1–50), `cursor`, `q` (subject/sender), and `status` (`open`, `closed`, `archived`).
- `GET /api/auras/:auraId/threads/:threadId/messages`: chronological messages, recipients, and attachment metadata. Supports `limit` and `cursor` for earlier messages. Bcc is omitted.
- `GET /api/auras/:auraId/messages/:messageId/body`: full body for R2-backed messages.
- `GET /api/auras/:auraId/messages/:messageId/attachments/:attachmentId`: forced-download attachment bytes.

The UI refreshes every five seconds while visible. It preserves older loaded pages. Email HTML becomes text. Scripts, remote images, and interactive email content do not run.

## Incoming mail

Cloudflare Email Routing sends only the two new test aliases to `aura-inbox-test`:

- `support-test@34five.studio` → existing `aura_demo_001` (Customer Support Aura).
- `sales-test@34five.studio` → existing `aura_demo_002` (Sales Aura).

The existing `spike-test` and `anthony` routes and catch-all remain unchanged. The new Worker has no send-email binding and sends no replies.

The handler resolves the active domain, address, and assignment from the envelope recipient. It matches RFC reply headers only within that organization and Aura. Conflicting or unknown parents start a new thread. A SHA-256 fingerprint of organization, envelope sender/recipient, and exact MIME bytes deduplicates identical redeliveries. Header Message-ID alone does not deduplicate mail. Providers can change MIME bytes between deliveries, so this does not guarantee deduplication of modified redeliveries.

The handler uploads raw MIME, attachments, and large bodies to private R2. D1 batch commits contacts, thread, message, recipients, and attachment references together. Private object keys include a delivery-attempt ID. Concurrent duplicate cleanup cannot delete another delivery's objects. An ambiguous database failure may leave unreferenced R2 objects for later cleanup. No automatic deletion runs against referenced mail.

The test limits are 25 MiB per raw email, 20 To/Cc recipients, and 20 attachments. Body text and HTML above 64 KiB use R2. Unknown/inactive receiving addresses are rejected. Address reassignment preserves historical messages with their original Aura and assignment.

## Deploy and provision

The Wrangler configuration binds `development_replica` and private R2 bucket `aura-inbox-test-mail`.

```sh
npm run deploy
```

After verifying Cloudflare Email Routing is ready for `34five.studio`, run:

```sh
node scripts/provision-addresses.mjs --remote
```

This command checks existing ownership before adding the real addresses and active assignments. It preserves placeholder addresses and seeded message history. Reruns are idempotent. Conflicts stop the command. The SQL file is provisioning data, not a schema migration.

Create the two literal `to` routing rules with `wrangler email routing rules create`, action `worker:aura-inbox-test`. List existing rules before changes and verify them afterward. Do not replace the domain catch-all or repoint the spike Worker.

To verify externally, send a test email to each alias. Confirm the message appears only in its Aura's inbox within five seconds. Reply from the external sender to the same alias to verify thread grouping. Local integration tests cover MIME storage and routing, but cannot establish external provider delivery.

## Verification on November 2, 2026

- 10 inbox integration tests passed against SQLite with the real schema, foreign keys, and MIME parser.
- The existing 51 schema/lifecycle tests and 68 spike tests passed.
- TypeScript, Vite production build, and Wrangler deployment checks passed.
- The local Cloudflare runtime processed a synthetic MIME email twice and stored one Sales message. The Support inbox did not return it.
- Live API checks returned populated seeded messages for each Aura and `404` for cross-Aura thread lookups.
- Both real receiving addresses are active in D1 and have enabled Cloudflare rules. The spike-test, anthony, and catch-all rules retained their prior IDs and actions.
- Live browser checks covered both inboxes and conversation loading. No external SMTP test message was sent during setup.
