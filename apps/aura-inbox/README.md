# Aura inbox test

An inbox and email governance console for four demo Auras, with real incoming email. One Cloudflare Worker serves the React/Vite UI and `/api` endpoints.

The current configuration requires email-and-password login for all inbox and management APIs. Login is enabled by default. `DEMO_LOGIN_ENABLED=true` explicitly enables fixed Admin, Manager, and Reviewer demo accounts. `DEMO_ORG_ID` selects the workspace. Use test messages only. The shared dummy accounts are for the demo workspace, not customer access.

Deployed at https://aura-inbox-test.cassius-kellogg.workers.dev. The API uses the same origin under `/api`.

## Run locally

For the authenticated demo, run `npm run demo` from this directory. It initializes a separate local database, builds the UI, and serves [the login screen](http://127.0.0.1:8788). See **Demo login and fixed roles** below for accounts and restart commands.

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

The UI refreshes every five seconds while visible. It preserves older loaded pages. Quoted `>` history and its reply attribution collapse behind “Show quoted text.” Inline answers between quote blocks stay visible. HTML-only blockquotes and Gmail quote containers also collapse. Expanding a quote preserves its content and stays open across automatic refreshes.

Email HTML becomes text. Scripts, remote images, and interactive email content do not run.

## Incoming mail

Cloudflare Email Routing sends the four test aliases to `aura-inbox-test`:

- `orbi@34five.studio` → existing `aura_demo_001` (Orbi, customer support specialist, Tier 1).
- `daniel@34five.studio` → existing `aura_demo_002` (Daniel, sales advisor, Tier 2).
- `olivia@34five.studio` → `aura_demo_003` (Olivia, operations coordinator, Tier 3).
- `sophia@34five.studio` → `aura_demo_004` (Sophia, communications coordinator, Tier 4).

Merlin remains the general assistant at `merlin@34five.studio`, served by its existing `aura-inbox-demo` Worker. Its route stays separate.

The existing `spike-test` and `anthony` routes and catch-all remain unchanged.

### Default test replies

`AUTO_REPLY_ENABLED=true` creates a fixed demo response for valid incoming test mail. The governance engine evaluates the draft before dispatch. Tier 1 holds every response. Tier 2 holds the first outgoing message in a conversation. Tier 3 holds the first reply after incoming mail, but allows proactive outreach. Tier 4 allows automatic sending. Tier 2/3 unlock only after the qualifying approved message successfully sends.

Responses use the Aura name and address. Mention `attachment` or include an attachment to receive `aura-demo.txt`. Uploaded files are not echoed back. The sender uses the email binding so held drafts can send after review. Stored `In-Reply-To` and `References` headers preserve threading. Only new incoming mail creates responses. Existing seeded mail is not answered retroactively.

`AUTO_REPLY_MODE` chooses the reply text. `fixed` (the default) sends the fixed demo response. `llm` generates the reply as described below. Any other value behaves as `fixed`.

Outgoing replies, recipients, and sample attachments are saved in the same Aura conversation. A reply is marked `sent` only after provider acceptance. Recipient delivery remains `accepted`, not `delivered`. The existing seeded messages are not answered retroactively.

The handler skips automated mail, mailing lists, bounces, known test-address senders, invalid Message-IDs, and threads with 20 references. Delayed replies require a passing DMARC result from Cloudflare’s first trusted authentication header. The header sender must match the envelope sender. It ignores incoming Reply-To redirection. A unique D1 send key claims each sender/Message-ID pair within the Aura before a provider call. The active address assignment, policy snapshot, content hash, review epoch, reviewer assignment and daily limit are checked before dispatch. Duplicate deliveries cannot create a second reply claim.

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

The prompt uses the Aura's name, any role, facet, personality, system instructions, and blocklist (topics to decline) on its row, plus the thread's received and sent messages with quoted history removed. HTML-only mail is converted to text. A thread is limited to 24000 characters: the oldest messages drop first, and the email being answered is always kept. Thread content is wrapped as untrusted data. Attachments are not read: the reply acknowledges them and sends no file back.

The 345 team's existing persona instructions are the intended source (AXI-24). Until they arrive, `worker/llm/demo-personas.ts` supplies temporary hardcoded personalities:

- Orbi (Tier 1): patient, empathetic, and reassuring.
- Daniel (Tier 2): curious, upbeat, and thoughtful.
- Olivia (Tier 3): calm, methodical, and dependable.
- Sophia (Tier 4): bright, observant, and concise.
- Merlin: warm, friendly, and approachable.

Each demo Aura has a role, a personal name, a personality, and a separate sending tier. Roles and voices apply only to known Aura IDs in `org_demo_001`, including after a name change. Other Auras receive no default personality. Stored roles take precedence over demo roles. A stored `facet`, `personality`, `system_instructions`, or a role different from the demo role replaces the temporary voice. The seeded demo role keeps its matching personality. The prompt passes stored instructions through without rewriting them. Blocklists and email rules still apply. The prompt boundary supports the team's configuration but does not connect to their source yet.

The email migration adds a nullable `role` column when the bound `auras` table lacks it. It fills blank roles for the five demo identities and preserves custom roles. Other optional persona fields work when the source supplies them. Hardcoded personalities affect LLM mode only. Fixed reply mode keeps its test response.

To update existing demo names, roles, and email addresses without changing policies or message history:

```sh
node scripts/migrate-persona-emails.mjs --remote
```

Omit `--remote` for local D1. Use `--persist-to .wrangler/login-demo` for the authenticated local demo. `npm run demo:setup` also applies this migration.

Address identities are immutable. The migration reserves new addresses, assigns them to the existing Auras, closes old assignments, and disables old addresses. Historical message addresses and references stay unchanged. It preserves custom names, custom roles, all policy versions, and Merlin's existing address. Reruns are idempotent. Ownership conflicts, unsent messages from old aliases, or concurrent edits abort the change. Wrangler executes the SQL file as one transaction.

Coordinate the database migration with the Worker sender allowlist and four Cloudflare routing rules. Use `--stage` to create the new addresses while retaining previous aliases. Deploy and switch the four routes, then rerun without `--stage` to retire previous aliases. The database command does not deploy code or update routes. Keep the other Workers and catch-all unchanged. `scripts/provision-personas.mjs` remains available for name-only updates.

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

Create the two literal `to` routing rules with `wrangler email routing rules create`, action `worker:aura-inbox-test`. List existing rules before changes and verify them afterward. Do not replace the domain catch-all or repoint the spike Worker.

To verify externally, send a test email to each alias. Confirm the message appears only in its Aura's inbox within five seconds. Reply from the external sender to the same alias to verify thread grouping. Local integration tests cover MIME storage and routing, but cannot establish external provider delivery.

## Verification on November 2, 2026

- 31 inbox/reply and quote-parser tests passed, including SQLite with the real schema, foreign keys, and MIME parser.
- The existing 51 schema/lifecycle tests and 68 spike tests passed.
- TypeScript, Vite production build, and Wrangler deployment checks passed.
- The local Cloudflare runtime processed a synthetic MIME email twice and stored one Sales message. The Support inbox did not return it.
- Before governance integration, native default replies passed in the local Cloudflare emulator for both real test addresses. Each conversation stored one incoming message and one sent reply with a sample attachment. Repeated deliveries did not send another reply.
- Live API checks returned populated seeded messages for each Aura and `404` for cross-Aura thread lookups.
- Both real receiving addresses are active in D1 and have enabled Cloudflare rules. The spike-test, anthony, and catch-all rules retained their prior IDs and actions.
- Live browser checks covered both inboxes and conversation loading. No external SMTP test message was sent during setup.

## Governance management

Sign in once, then open **Manage governance**. The server uses the session identity for all actions. Request bodies cannot select the acting member or organization. Governance still requires an active designated reviewer. The demo setup assigns all three demo users to the existing Auras.

The browser sends an HttpOnly session cookie. Refresh preserves the session, and Sign out revokes it on the server. Passwords and session tokens are not stored in browser local storage. Legacy bearer management access remains available only when `DEMO_LOGIN_ENABLED` is disabled. It cannot bypass session authentication in the supplied configuration.

The console provides review and rejection, a separate Send email action, draft editing and reevaluation, tier settings, daily limits, Tier 4 Cc/Bcc, new outgoing conversations, and the latest 100 review revisions. Open the Conversations tab on the Governance page to reset a review requirement. A reset preserves sent history and supersedes unsent decisions. Editing content or changing policy invalidates old approvals. An unchanged rejected draft stays rejected.

`GovernanceCoordinator` serializes the organization’s API requests and incoming mail with a Durable Object concurrency barrier. D1 batches preserve atomic state transitions. Every provider call has a persistent `sending` claim. Uncertain results keep that claim and consume daily capacity until reconciled. There is no automatic retry or scheduled drain. Held drafts require an explicit send after approval. Newly evaluated automatic inbound drafts send immediately. A composed draft always requires the separate Send email action, which makes the outbound demo reviewable.

Daily limits count sent messages, same-day approval reservations, and unresolved sends. Days use UTC. Unknown guardrails and invalid tier values fail closed. Copies apply to Tier 4 and are included in the reviewed content hash. Policy changes preserve existing draft recipient rows. This UI edits subject and text only. It does not remove existing copies or edit attachments.

### Provision the four Auras

After the governance migration and the original address provisioning, run:

```sh
node scripts/provision-governance.mjs --remote
```

The script checks existing Aura identities, the migrated reviews table, reviewer membership and address ownership. It reuses Customer Support and Sales. It creates only Operations and Notifications. It assigns tiers only to unconfigured policies and never overwrites an existing different tier. Repeated runs preserve messages, policy versions and reviewer revocations. Add only the two new literal Email Routing rules, each targeting `aura-inbox-test`. Inspect existing rules and catch-all before and after the change.

Do not import the parent fixture, local seed or schema migrations into the populated remote database. The governance provisioning SQL changes demo data only. The Worker deployment adds the `governance-v1` Durable Object migration. Existing D1 schema migrations remain unchanged.


### Verification on November 4, 2026

- 63 inbox, MIME, quote-parser and governance tests pass with the real SQLite schema and foreign keys. They cover all four tiers, policy/content changes, rejection, resets, reviewer revocation, limits, concurrent dispatch, copies and uncertain sends.
- The 79 schema and reference-engine tests pass. TypeScript, Vite build and Wrangler deployment checks pass.
- The deployed browser shows all four Auras and their tiers. Reviewer unlock, policy settings, compose controls and switching Auras pass browser checks.
- Both new address assignments and literal routing rules are active. Existing Support, Sales, spike-test, anthony and catch-all rules retain their IDs and actions.
- Email Sending is enabled for `34five.studio`. No external SMTP message was sent during this change. Provider dispatch is covered by local binding mocks. External receipt and delivery still require a test from a real mailbox.


## Separate management pages

- `/` is the inbox. It links to management and retains conversation deep links through `?aura=...&thread=...`.
- `/governance` has an Aura picker, policy creation/update/removal, reviews, draft cancellation, compose and conversation resets. Policy removal pauses outgoing sends. It preserves the policy row with a higher version, so recreating a policy cannot revive old decisions.
- `/auras` provides Aura creation, reading, renaming and deletion of unused Auras. It also provides reviewer assignment/revocation and address enable/disable controls. New Auras default to Tier 1 and designate the configured manager as reviewer. New Aura creation does not provision a mail address or Cloudflare route.
- `/users` provides the Admin-only user directory and access history. It is read-only in the fixed-role demo.
- `/email-settings` provides domain-level DKIM setup instructions, exact provider-issued records, copy controls and live DNS verification. All Auras on a domain share its setup. Key generation and DNS changes remain in Cloudflare. The app never accepts a private signing key.

Aura deletion refuses any message/thread or address assignment history. Disabling an assigned address preserves its assignment and mail history, rejects incoming mail for that address and blocks sends. Disabling and re-enabling an address cannot revive old approvals. Reviewer revocation similarly supersedes that reviewer’s unsent approvals. Workspace administration remains available to reassign a reviewer if the manager removes their own reviewer designation.

### Load the domain’s public DNS records

After enabling Email Sending in Cloudflare, import its public records:

```sh
node scripts/sync-email-dns.mjs --remote --domain 34five.studio --zone-id 1c60311626bbfe94b6fe3496d15de727
```

The script checks tenant/domain/zone ownership, reads provider DNS records and records their values and provider identity in `email_domains`. It does not modify DNS, enable a domain, or change mail routes. Never invent or manually generate DKIM key values for this page.

The Verify DNS records action compares the provider values with the fixed Cloudflare DNS-over-HTTPS resolver. TXT comparison handles split quoted strings. Resolver failure is reported as unavailable. Missing or different records are reported separately. Verification does not change domain activation or prove recipient delivery.

These changes use the existing migrated tables. No new D1 schema migration is required.


### Management verification

The deployed desktop and mobile pages pass isolated browser checks. The checks select an Aura on the standalone governance page and create, rename and delete a temporary Aura. The final demo contains the same four Auras. Live DNS verification confirms DKIM, SPF, bounce MX and DMARC records for `34five.studio`. The verifier compares required authentication tags and accepts valid additional reporting tags. No DNS records or external email messages are changed by verification.

## Company email domains (AXI-12 / AXI-21)

`/email-settings` now provides the tenant domain registry and custom-domain setup flow. It lists the default company subdomain and custom domains. Managers can add a domain, copy its nameservers, check delegation and email readiness, inspect public authentication records, and remove an unused custom domain. Removal disables the registry entry. It preserves addresses, assignments, mail, Cloudflare zones and DNS records.

The existing `email_domains` and `email_addresses` schema is unchanged. Do not apply another migration for this feature.

### Server configuration

The Worker uses these variables:

- `CLOUDFLARE_ACCOUNT_ID`: the account that owns the email zones.
- `DEFAULT_EMAIL_DOMAIN`: `34five.studio`.
- `DEFAULT_EMAIL_ZONE_ID`: the existing Cloudflare zone for that default domain.
- `TENANT_COMPANY_NAME`: trusted company name for this demo workspace. The supplied value is `Axia`.
- `CLOUDFLARE_DOMAIN_API_TOKEN`: a server secret. Set it with `wrangler secret put CLOUDFLARE_DOMAIN_API_TOKEN`. Never put it in frontend code or request bodies.

Use a token with access to the required account/zones and Zone Read/Edit, Email Routing and Email Sending operations. Cloudflare also requires the account's Email Sending entitlement. A failed request shows its method, path, HTTP status and provider error codes. It does not expose provider error text or credentials. Confirm the exact permission needed from the failed operation before expanding a token.

An active Admin or Manager credential protects all domain endpoints. Mutations require the same origin. The organization coordinator serializes them with the app's other management changes. Do not call the mutation service concurrently outside that coordinator.

The app uses the configured demo organization. An Admin or Manager can adopt an exact existing zone in the configured Cloudflare account. Account ownership does not prove a customer's entitlement to that zone. Before a multi-tenant production rollout, require an operator-approved adoption list or tenant-specific ownership proof.

### Registry interface

`DomainRegistry` in `worker/domain-registry.ts` exposes:

- `ensureDefault(companyName)`: reserve the tenant's default domain on the first address request, then attempt onboarding. The caller supplies a company name from trusted tenant data. The management screen also exposes an explicit setup action when no default exists.
- `addCustom(domain)`: reserve a domain, create or reconcile its Cloudflare zone, and return nameservers.
- `list(activeOnly)`, `get(id)` and `view(row)`: tenant-scoped domain and setup records. `list(true)` returns domains usable by the address-generation flow.
- `check(id)`: reconcile delegation, sending identity, routing and public DNS. It activates the domain only after all required checks pass.
- `remove(id)`: refuse default-domain removal and custom-domain removal with active addresses. Disable an unused custom domain while preserving history.

Slugs use lowercase ASCII letters, digits and hyphens from the company name. Accents are normalized. A collision uses the company slug, normalized organization ID and a stable SHA-256 suffix, bounded to one 63-character DNS label. An empty company slug uses the organization fallback. Existing tenant subdomains do not change when a company is renamed. Domain reservation is atomic. Different tenants cannot reserve the same domain or overlapping parent/child custom domains. Removed domains remain reserved.

HTTP endpoints are `GET/POST /api/manage/domains`, `POST /api/manage/domains/default`, `GET/DELETE /api/manage/domains/:id`, and `POST /api/manage/domains/:id/check`. The list accepts `?active=true`. The existing `POST /api/manage/domains/:id/verify` still checks public DNS without activating a domain. Request bodies cannot select a tenant, zone, provider ID or activation status.

### Provider operations and manual steps

The adapter uses the documented Cloudflare API:

1. `GET /zones?name=...&account.id=...` and, when absent, `POST /zones` with a full zone in the configured account.
2. `GET /zones/:zone` to reconcile delegation. The response must match the expected account, zone name and full-zone type.
3. `GET/POST /zones/:zone/email/sending/subdomains` to reuse or create the exact sending identity.
4. `GET /zones/:zone/email/sending/subdomains/:tag/dns` for provider-issued DKIM, SPF, DMARC and bounce MX values.
5. `GET /zones/:zone/email/routing` and, for custom apex domains, `POST /zones/:zone/email/routing/dns` to enable routing through the Email Service API.
6. Public DNS checks through the fixed Cloudflare DNS-over-HTTPS resolver.

The customer must change nameservers at their registrar. The app cannot make that delegation. Preserve the domain's existing website and mail records in the new zone before delegation. The UI explains that DNS moves to 34Five's Cloudflare.

Cloudflare documents a separate routing-subdomain onboarding flow. The available zone-level routing API does not establish that a particular subdomain is onboarded. The adapter does not change the parent zone's MX records. If a default subdomain has no public Cloudflare routing MX, it remains verifying. In Cloudflare, select the parent zone, open Email Service → Email Routing, and add the exact tenant subdomain. In Email Sending, choose Onboard Domain for that subdomain and complete its provider DNS setup. Select Check now afterward. Missing sending authentication also remains visible until Cloudflare onboarding installs the provider records. No fabricated DKIM records or manual DNS-writing endpoint is used.

Cloudflare limits a zone to **30 domains across Email Routing and Email Sending, including the apex**. The default zone therefore has limited tenant capacity. Report capacity or entitlement failures before changing the default-domain design. Sources: [subdomain configuration](https://developers.cloudflare.com/email-service/configuration/subdomains/), [limits](https://developers.cloudflare.com/email-service/platform/limits/), [sending-domain creation](https://developers.cloudflare.com/api/resources/email_sending/subresources/subdomains/methods/create/) and [routing DNS enablement](https://developers.cloudflare.com/api/resources/email_routing/subresources/dns/methods/create/).

### Address-generation handoff and verification boundary

Akash's AXI-19 button can continue to read active `email_domains` rows using the existing columns. No prerequisite-check function is required for Thursday. When its default-domain bootstrap is connected, call `ensureDefault()` before querying active domains. AXI-19 owns choosing an address/local part and assigning it to an Aura. AXI-11 owns each address's Cloudflare routing rule.

The current demo sender remains restricted to the four `TEST_ADDRESSES` and Wrangler's allowed sender list. Activating a domain does not lift that restriction or create an Aura email address. A real-domain end-to-end proof requires the address assignment and routing integration, an appropriate sender binding, actual delegation and an external mailbox test.

Local tests use the real SQLite schema and foreign keys plus a mocked Cloudflare transport. They cover ownership, overlap races, slug collisions, retries, state transitions, incomplete authentication, provider failures, removal and address reactivation. They do not prove live account permissions, DNS propagation or delivery. No remote zone, DNS record or email message is changed by these tests.

### Local verification on November 4, 2026

- 184 app tests pass, including 14 domain tests and the governed LLM integration regression.
- 79 schema/lifecycle/rules tests and 68 spike tests pass.
- TypeScript, the Vite build and Wrangler deployment dry run pass.
- Browser checks against disposable local D1 data cover management unlock, the nameserver display, domain creation, setup failures, retry and confirmed soft removal.
- No deployment, remote D1 change, customer DNS delegation or external mail test was performed for this change.


## Demo login and fixed roles

The app requires login before showing inbox or management content. All `/api` inbox, message-body, attachment, governance, and management routes require a valid session. Login, session status, and logout use the authentication endpoints below.

The local demo provides these shared dummy accounts:

| Role | Email | Password |
| --- | --- | --- |
| Admin | `admin@345.demo` | `Admin345!Demo` |
| Manager | `manager@345.demo` | `Manager345!Demo` |
| Reviewer | `reviewer@345.demo` | `Reviewer345!Demo` |

Admin can read the user directory and configure Auras, domains, and policies. Manager can configure Auras, domains, and policies. Reviewer can read assigned inboxes, review drafts, approve or reject, and send approved messages. Reviewers cannot configure policies, compose or edit drafts, cancel drafts, reset conversations, or manage users. The API enforces each restriction. It also hides unassigned Auras and rejects direct message or attachment access through an unassigned Aura.

The three account roles are fixed on the server. The Admin directory has no add, edit, suspension, credential reset, or role-change controls. User mutation endpoints reject requests in demo login mode, including requests from Admin. This demo does not include custom permission editing, self-signup, mailbox verification, password recovery, or SSO.

### Start or reset the local demo

From `apps/aura-inbox`:

```sh
npm run demo
```

This command initializes the isolated `.wrangler/login-demo` state directory, creates any missing local schema, provisions the three accounts, builds the frontend, and starts the app on `http://127.0.0.1:8788`.

To restart with existing accounts and sessions:

```sh
npm run demo:worker
```

To restore the dummy passwords and revoke existing demo sessions:

```sh
npm run demo:setup
```

Setup accepts no remote or custom database options. It preserves email history and existing policy settings. It checks demo account and Aura ownership before provisioning. It assigns the three accounts as designated reviewers for the organization's existing Auras. Reprovisioning revokes existing sessions and legacy credentials, resets login-attempt limits, and supersedes approved unsent decisions made by the dummy accounts.

Existing `studio_members.role` values stay unchanged. New parent memberships use the base `member` role. App roles live in `email_workspace_access`. Demo session validation also requires the expected fixed role for that member ID.

### Sessions and password checks

Passwords use per-account random salts and PBKDF2-SHA-256 with 100,000 iterations. D1 stores no plaintext passwords. Session tokens contain 256 random bits, and D1 stores only their SHA-256 hashes. A session expires after eight hours. Login rotates a previous browser session, and logout deletes the current server session.

Cookies use HttpOnly, SameSite=Strict, and Path=/. HTTPS responses also set Secure. HTTP login is permitted only on localhost or loopback addresses. Passwords and session tokens never enter browser URLs or browser storage.

Login, logout, and API mutations require the exact same origin. Failed login responses do not reveal whether an account exists. Persistent limits allow 10 attempts per normalized login and 30 per client address per 15-minute window. Successful attempts also count. Expired limiter and session rows are removed during login. The organization coordinator serializes login and session operations with management changes.

### Migration and rollout order

Apply `scripts/0003_email_workspace_access.sql`, then `scripts/0004_email_workspace_login.sql`, before deploying code with `DEMO_LOGIN_ENABLED=true`. Both migrations add tables and indexes without rebuilding email history. Provision approved login identities before enabling access. Management or login returns `503` when its required schema is missing.

The local setup command handles these prerequisites in isolated local storage. For an approved remote demo rollout, apply the two additive migrations and provision authentication only:

```sh
npx wrangler d1 execute DB --remote --file ../../scripts/0003_email_workspace_access.sql
npx wrangler d1 execute DB --remote --file ../../scripts/0004_email_workspace_login.sql
node scripts/provision-demo-logins.mjs --remote
npm run build
npx wrangler deploy --keep-vars
```

The remote provisioner inspects the actual membership schema, including the minimal live table with required name and no role column. It preserves existing member details, credentials, sessions, policy settings, messages, approvals, and reviewer revocations. It adds only missing demo access records, passwords, and reviewer assignments for the four named demo Auras. Reruns never reset passwords. Conflicting identities or unsupported parent columns stop provisioning. No local fixture or persona/address migration runs through this command.

Inspect the live Worker settings before deploying. Preserve its existing secrets, non-authentication variables, resource bindings, sender allowlist, runtime settings, workers.dev setting, and email routes. The frontend assets intentionally change to include the login screen. Provision accounts before enabling login. No external email needs to be sent to verify authentication.

Retain the additive access, login, session, and audit tables during an application rollback. Setting `DEMO_LOGIN_ENABLED=false` explicitly restores the legacy public test inbox and bearer management model. An older Worker also lacks the new session restrictions. The Python rules engine remains an E08 schema/rules reference and does not implement app authentication.

### API and verification

- `POST /api/auth/login` accepts `{email,password}` and returns the fixed user identity plus a session cookie.
- `GET /api/auth/session` returns the current identity or `user:null` when signed out.
- `POST /api/auth/logout` revokes the current session and clears the cookie.
- `GET /api/manage/workspace` returns the authenticated member, role, and active reviewer assignments.
- `GET /api/manage/users` returns the Admin directory and latest access audit events. User mutations are disabled in demo login mode.

Authentication tests cover all three accounts, invalid passwords, normalized usernames, spoofed role and tenant fields, bearer bypass attempts, session refresh, logout, rotation, expiry, forged and duplicate cookies, cross-tenant access, suspension, fixed-role tampering, same-origin checks, throttling, migration constraints, and reseeding. Browser checks cover incorrect login, all three valid logins, refresh persistence, sign-out, the read-only Admin directory, Manager controls, and Reviewer page restrictions.

## Generated address provisioning (PR #15)

The replica provides `POST /api/manage/auras` with `generate_email:true`, `local_part`, and `domain_id`, plus the address/proposal/retry controls for an existing Aura. Prefix rules and reserved names come from `shared/email-prefix.ts`, the same module used by the inbox branch. Names are lowercase letters/digits with single dots or hyphens between groups. Reserved service and live mailbox names are unavailable even without a D1 row. Existing assignments cannot be changed by resubmitting generation.

Apply the canonical `scripts/0005_email_address_provisioning.sql` before deploying. This is the same additive table migration as the inbox branch; `0003_email_address_provisioning.sql` is retired there. Existing installations can run `0005` idempotently; do not apply the parent schema/seed against shared D1.

The Studio Worker owns `CLOUDFLARE_DOMAIN_API_TOKEN` (or the legacy `CF_API_TOKEN`) and the routing zone. The inbox must not receive that provider token. Both Workers need the same dedicated `ADDRESS_PROVISIONING_SECRET` secret. Set it separately on `aura-inbox-test` and `aura-inbox-demo`; do not commit its value. The inbox's `env.demo.services` binding `ADDRESS_PROVISIONER` targets `aura-inbox-test`. The server endpoint `/internal/provision-address` is supplied by this branch/PR #15, and is protected by that secret before entering the organization coordinator. Deploy the server before enabling the client from PR #16; merging the client into `spikes/cf-email` alone does not add its server.

Routing calls share a 12-second total deadline (5 seconds per request), below the coordinator's 30-second reset. The client has a 15-second timeout and requires the shared D1 provisioning row to become active. Only exact AuraComms-owned routing rules may be adopted; unrelated manual rules and catch-all are preserved.

The default remains `AUTO_REPLY_MODE=fixed` for existing predefined routes. Generated assignments with a provisioning row use LLM replies and the selected governance tier even in fixed mode. This PR does not enable LLM calls for every existing address. An explicit deployment-wide `llm` setting still applies to all eligible routes.

The hand-written persona code, shared-password login, competing authentication migrations/cookies, and identity-rename migration come from the base branch and are **unresolved merge blockers** for integration into `spikes/cf-email`. Keep the two existing Workers/configurations separate until governance and roles are integrated with the invite-only sign-in. Do not run `migrate-persona-emails.mjs` against shared D1 as part of this fix.

## Inline draft review (AXI-18 first slice)

The inbox draft card exposes approve, reject and a separate **Send email** action to designated reviewers. Designated Admins and Managers can also edit subject/text, cancel a draft and reevaluate its sending policy. Recipient and attachment editing remain outside this slice. Reevaluate policy does not generate an AI reply.

The message response includes the latest review revision and server-derived permissions. Inline edit, cancellation and policy reevaluation carry a draft version that covers content, review status, policy version and thread review epoch. A stale version returns 409. Existing Governance clients can omit this optional version; the review-ID and content/policy freshness checks still apply to every approval and send. Editing supersedes the previous decision; held drafts need approval again and then an explicit Send. Edited-before-send stays set through later policy reevaluations.

The card refreshes after successful and failed actions. Cancellation confirmation stays bound to the version shown when it opens and must be reopened after a change. Send locks are scoped to the attempted version; a rejected request recovers only after a successful server refresh confirms an approved unsent draft. If refreshing fails, actions stay disabled until the user refreshes the card successfully. Unknown send outcomes have no retry action. Provider acceptance does not prove recipient delivery. The existing server claim and organization coordinator prevent duplicate dispatches. The existing inline-body/12 KB edit limit remains; R2-backed bodies can be loaded for review but are not editable here.

Local browser verification uses an in-memory database and replaces the email transport with a mock. It never calls an email provider:

```sh
npm run build
# Install Playwright in a disposable directory, then point to its ESM entry point.
npm install --prefix /tmp/axi18-browser --no-audit --no-fund playwright
PLAYWRIGHT_MODULE=/tmp/axi18-browser/node_modules/playwright/index.mjs node tests/inline-review.browser.mjs
```

Install the matching Chromium with Playwright, or set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to an existing compatible executable. The script writes screenshots under `docs/verification/axi-18`; override with `SCREENSHOT_DIR`. It checks keyboard interaction, 390px width, long text, edits after approval, rejection/cancellation, stale editor preservation, refresh failure recovery, role restrictions and both failed and unconfirmed dispatch.

Studio entry points, full review/history presentation and other AXI-18 acceptance criteria remain open. This slice requires no schema migration.
