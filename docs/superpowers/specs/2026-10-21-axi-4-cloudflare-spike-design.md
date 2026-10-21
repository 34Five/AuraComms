# AXI-4: Cloudflare Email Service validation spike (design)

Ticket: [AXI-4](https://linear.app/34five/issue/AXI-4/e01-cloudflare-validation-spike-in-34five-account)
Branch (local only, do not push): `pavanchindukuri/axi-4-e01-cloudflare-validation-spike-in-34five-account`
Code location: `spikes/cf-email/`

## 1. Goal

Prove the full Cloudflare Email Service path in the `34Five - Production` account before Phase 1 work starts. The spike must give evidence for each item in the ticket's "Done when" list. Spike code does not need tests and is not production code.

## 2. Current state (checked 2026-10-21, read-only)

| Item | State |
|---|---|
| Account | `34Five - Production` (`3973e13ac59e8e3799ee812ad57ad3cb`) |
| Wrangler OAuth scopes | `email_routing (write)`, `email_sending (write)`, `workers (write)`, `zone (read)` |
| Zone | `34five.studio` (`1c60311626bbfe94b6fe3496d15de727`) |
| Email Routing | Enabled |
| Email Sending | Enabled for `34five.studio` |
| MX | `route1/2/3.mx.cloudflare.net` |
| SPF (apex) | `v=spf1 include:_spf.mx.cloudflare.net ~all` |
| DKIM | `cf2024-1._domainkey.34five.studio` |
| Bounce domain | `cf-bounce.34five.studio` (MX, SPF and DKIM present) |
| DMARC | `v=DMARC1; p=reject; sp=reject; adkim=s; aspf=s` |
| Existing rules | `anthony@34five.studio` to Worker `anthony`. Catch-all: `drop` |

Consequences:

- Ticket steps 1 and 2 need no DNS change. Record this state in the findings note.
- Do not change the `anthony` rule or the catch-all rule.
- DMARC uses strict alignment. The Return-Path is on `cf-bounce.34five.studio`, so SPF alignment will probably fail. DMARC passes only if the DKIM `d=` value is exactly `34five.studio`. Step 5 must confirm this.

## 3. Facts from Cloudflare docs (to confirm in the spike)

- `Message-ID` is platform-controlled. Cloudflare generates it with a Cloudflare domain. We cannot set it.
- `In-Reply-To`, `References`, `Thread-Index` and `Thread-Topic` are on the header allowlist.
- `From`, `To`, `Subject` and `Reply-To` must use API fields, not `headers`.
- Outbound message size: 5 MiB (25 MiB to verified destination addresses only).
- Inbound message size: 25 MiB. Routing rules: 200 per domain.
- `message.reply()` throws when `References` has more than 100 entries.
- Sends from a Worker show as "dropped" in the Email Routing summary. Use Email Sending metrics instead.
- Delivery events: GraphQL datasets `emailSendingAdaptive` and `emailSendingAdaptiveGroups` (zone level, 31 days). Hard bounces go to the suppression list.

## 4. Components

All files are in `spikes/cf-email/`. The folder has its own `package.json`, so the repo-root CI bootstrap guard stays unchanged.

### 4.1 Worker `aura-spike-email`

`wrangler.jsonc`:

- `account_id` set to the 34Five account, so deploy does not ask for an account.
- `send_email` binding `EMAIL`.
- KV namespace `SENT` (stores sent Message-IDs for the threading check).
- `observability.enabled: true` (Workers Logs, searchable after the test).
- Secret `SPIKE_SEND_TOKEN` (set with `wrangler secret put`, never in code).

`src/index.ts`, `email()` handler (ticket steps 3, 6, 7):

1. Read `message.raw` into an `ArrayBuffer` one time. Parse with `postal-mime`.
2. Log one JSON line, `event: "inbound"`, with: envelope from and to, header `From`, `To`, `Subject`, `Message-ID`, `In-Reply-To`, `References` (as a list), `Thread-Index` when present, `Authentication-Results`, raw size in bytes, and attachment count.
3. Normalize every Message-ID: trim, remove angle brackets, lower-case the domain part.
4. For `In-Reply-To` and each `References` entry, look up the normalized value in `SENT`. Log `thread_match: true | false` and the matched send.
5. Do not reply or forward. The spike only observes.

`src/index.ts`, `fetch()` handler (ticket steps 4, 6, 8):

- `POST /send`, with `Authorization: Bearer <SPIKE_SEND_TOKEN>`. Other requests get 401 or 404.
- Body: `{ to, subject?, inReplyTo?, references? }`.
- Sends with:
  - `from: { email: "spike-test@34five.studio", name: "Aura Spike" }`
  - `replyTo: "spike-test@34five.studio"`
  - `text` and `html` bodies
  - one small `spike.txt` attachment
  - `In-Reply-To` and `References` headers only when the body gives them
- Stores the returned `messageId` (normalized) in `SENT` with the recipient and time.
- Returns the full send result as JSON and logs `event: "outbound"`.
- On a send error, returns the error code (for example `E_RECIPIENT_SUPPRESSED`) and logs it.

### 4.2 Scripts (REST API, not the dashboard)

The scripts read `CF_API_TOKEN`, `CF_ACCOUNT_ID` and `CF_ZONE_ID` from the environment. They never store a token in a file.

- `scripts/routing-rule.sh create|list|delete <id>` (step 7): `POST`, `GET` and `DELETE` on `/zones/{zone_id}/email/routing/rules`. Rule: `to: spike-test-2@34five.studio` to Worker `aura-spike-email`.
- `scripts/send.sh <to> [inReplyTo]` (steps 4, 6, 8): calls `POST /send` on the deployed Worker.
- `scripts/events.sh [since]` (step 8): GraphQL query on `emailSendingAdaptive` (status, eventType, messageId, errorCause, dkim, spf, dmarc), and `GET /accounts/{account_id}/email/sending/suppression`.
- `scripts/limits.sh` (step 9): `GET /accounts/{account_id}/email/sending/limits`.

### 4.3 `FINDINGS.md`

A template for the "Cloudflare spike findings" comment. It has one section for each "Done when" item, a list of the endpoints and token permissions, the limits table, the Message-ID format, and the impact on E04, E11/E12 and E17.

## 5. Routing setup

- Ticket step 3: one routing rule, `spike-test@34five.studio` to Worker `aura-spike-email`. Create it with `wrangler email routing rules create` after the first deploy.
- Ticket step 7: the second address `spike-test-2@34five.studio` is created and deleted only through `routing-rule.sh`.
- After the spike, delete both rules. Leave the Worker deployed until the findings are posted.

## 6. Test matrix

| # | Case | How | Pass when |
|---|---|---|---|
| T1 | Receive from Gmail | Send to `spike-test@` | `inbound` log has all fields |
| T2 | Receive from Outlook | Send to `spike-test@` | Same. Note `Thread-Index` |
| T3 | Attachment count | Gmail mail with 2 attachments | `attachments: 2` |
| T4 | Plus-address | Send to `spike-test+x@` | Record behavior (expected: catch-all drops it) |
| T5 | Send to Gmail | `send.sh <gmail>` | Inbox, not spam. HTML, text and attachment present |
| T6 | Send to Outlook | `send.sh <outlook>` | Inbox, not spam |
| T7 | Authentication | Gmail "Show original" | SPF, DKIM, DMARC PASS. Record DKIM `d=` and Return-Path. Screenshot |
| T8 | Message-ID format | Compare send result with Gmail "Show original" | Format recorded. Record if result and header differ |
| T9 | Reply threading (Gmail) | Reply in Gmail to T5 | `thread_match: true` on `In-Reply-To` |
| T10 | Reply threading (Outlook) | Reply in Outlook to T6 | `thread_match` result and `References` shape recorded |
| T11 | Outbound threaded send | `send.sh <gmail> <T9 Message-ID>` | Gmail shows it in the same conversation |
| T12 | Routing rule through API | `routing-rule.sh create`, send mail, `delete` | Mail reaches Worker, then stops after delete |
| T13 | Hard bounce | `send.sh` to a non-existent mailbox at a real provider | Bounce visible in `events.sh` and in the suppression list |
| T14 | Suppressed resend | Send again to the T13 address | `E_RECIPIENT_SUPPRESSED` |
| T15 | Limits | `limits.sh` | Quota recorded with the doc limits |

Send only one bounce (T13). Bounces reduce sender reputation.

## 7. Prerequisites from the user

- A Gmail inbox and an Outlook inbox for tests.
- A Cloudflare API token on the 34Five account with these permissions:
  - Zone, Email Routing Rules: Edit (`34five.studio` only)
  - Account, Email Sending: Read
  - Zone, Analytics: Read (`34five.studio` only)
  - Record the exact permission names in the findings.
- Permission to deploy one new Worker (`aura-spike-email`) and one KV namespace to `34Five - Production`.

## 8. Out of scope

- Custom tenant domains (E04).
- Studio UI, D1, Durable Objects and the drafting logic from `aura-thread-worker`.
- Tests and CI for the spike folder.

## 9. Known risks

- Strict DMARC can cause outbound mail to fail DMARC. If T7 fails, stop and tell the team. Do not change DNS.
- The `messageId` from `send()` can differ from the delivered `Message-ID` header (angle brackets or domain). The normalization in 4.1 and T8 cover this.
- Outlook can shorten `References`. The `thread_match` check uses `In-Reply-To` and all `References` entries, so one match is sufficient.
