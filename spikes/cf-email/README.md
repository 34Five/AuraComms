# AXI-4 basic email Worker

This package implements the Cloudflare email spike. See [FINDINGS.md](FINDINGS.md) for live results and remaining validation gaps.
The Worker logs inbound mail and sends fixed demo replies. It also supports manual sends through a protected endpoint.
It uses one email binding and one KV namespace. It does not create routing rules or change DNS.

## Implemented behavior

- `email()` logs envelope addresses, required headers, raw Message-IDs, threading headers, authentication results, and raw size.
- Attachment logs include count, filename, MIME type, disposition, and decoded byte size. Bodies and attachment contents are not logged.
- `POST /send` sends text, HTML, `replyTo`, and one small `spike.txt` attachment.
- `POST /thread-check` repeats KV lookups after propagation. This endpoint remains available when sending is disabled.
- Both endpoints require `Authorization: Bearer <SPIKE_SEND_TOKEN>`. The token must contain at least 32 characters.
- Sending requires `SEND_ENABLED=true`. Authenticated requests can send to any valid recipient address without a configured recipient list.
- Inbound mail has no sender allowlist. Any sender can email an address routed to this Worker.
- Automatic demo replies require `AUTO_REPLY_ENABLED=true` and `SEND_ENABLED=true`. Sending through Gmail needs no API token.
- Native `message.reply()` handles threading and replies to the original envelope sender, subject to Cloudflare's DMARC checks.
- The sender is fixed at `spike-test@34five.studio`. Unknown request fields and header injection are rejected.
- Sent IDs expire from KV after seven days. Normalization preserves local-part case and folds only domain case.
- Direct-parent matches and older reference matches have separate fields. A KV miss stays `pending` until an operator resolves it.

The Worker records the returned Message-ID verbatim. It cannot obtain the delivered Message-ID from an inbox.
Compare those values during live tests. A genuinely different domain or local part requires a finding, not normalization.
No endpoint can add a manual alias that would turn a mismatch into a passing test.

## Local checks

Use Node.js 22.18 or later. Run these commands from this directory:

```sh
npm ci
npm run typecheck
npm test
npm run build
```

`build` only bundles the Worker with `wrangler deploy --dry-run`. It does not deploy.
The tests use fake email and KV bindings. They parse a real MIME fixture and cover authorization, validation, threading, and storage failures.
They do not prove delivery, authentication alignment, inbox placement, or Cloudflare error behavior.

For local development, copy `.dev.vars.example` to `.dev.vars` and replace the token.
Run `npm run dev`. Local KV is separate from the Cloudflare namespace.
Local sending uses the simulator and does not prove external delivery.

## Cassius demo

Send an email from Gmail or Outlook to `spike-test@34five.studio`.

1. Send a normal message. Expect a fixed acknowledgement in the same conversation.
2. Reply with the word `attachment` or `attachments` in the subject or body. Expect a reply with `aura-demo.txt`.
3. Send a message with a file. Expect a receipt count and the same sample file in the reply.

Keyword matching is case-insensitive and also checks HTML messages. The sample file contains 75 decoded bytes.
The demo does not echo uploaded files or read their contents. Replies state that they are fixed test responses.
Quoted message text can also match the attachment keywords.

Automated messages, mailing lists, bounce senders, and the demo address itself do not trigger replies.
Messages with missing or ambiguous Message-IDs are logged without a reply. Threads with 20 or more References entries stop receiving demo replies.
Seven-day KV attempt records limit duplicate replies. KV is eventually consistent, so these records are not a strict concurrent-delivery lock.
If the claim store fails, the Worker logs the message without sending a reply. Failed or uncertain reply attempts are logged and never retried automatically.
Reply errors do not reject the incoming email. Inspect `auto_reply`, `auto_reply_skipped`, and `auto_reply_error` logs during testing.

## HTTP requests

`POST /send` accepts this JSON shape:

```json
{
  "to": "your-test-inbox@example.com",
  "subject": "Re: Original subject",
  "inReplyTo": "<parent@provider.example>",
  "references": ["<root@provider.example>"]
}
```

Only `to` is required. Omit the threading fields for a new conversation.
For replies, preserve the original subject and pass its existing reference chain.
The Worker appends `inReplyTo` once if the chain does not already include it.
The Worker accepts at most 100 references and a 16 KiB request body.
Bodies, sender, attachment, and `replyTo` use fixed fixtures.

`POST /thread-check` accepts `inReplyTo` and `references` in the same format, without `to` or `subject`.
Use the inbound log's raw values. Recheck pending matches after propagation, for up to five minutes.
An unresolved match after that deadline is inconclusive or a correlation failure, never a passing result.
Lookups check at most 100 distinct IDs and report `lookup_complete=false` if the input exceeds that limit.

A successful send returns HTTP 202 with the raw `messageId`, a request ID, and these states:

- `send_status=accepted` means the binding accepted the message. Delivery remains `unverified`.
- `tracking_status=stored` means the KV write completed. Other locations can still see a stale value.
- `tracking_status=failed` means the message was accepted but tracking failed. Preserve the result and inspect logs.

A binding error returns HTTP 502 and its error code. An error can have an uncertain delivery outcome.
The Worker never retries a send. A request ID supports investigation but does not provide idempotency.
Do not repeat a send after a timeout or tracking failure until you check the delivery evidence.

## Remaining validation and deployment

The basic Worker and KV were deployed for the live spike. The checked-in configuration enables authenticated sending without a recipient allowlist.
Automatic demo replies are enabled in the deployment configuration. The local development example keeps both send switches disabled until you enable them.

1. Confirm the ticket acceptance checklist against the observed results in `FINDINGS.md`.
2. Complete Outlook inbound delivery, outbound delivery, and threading checks.
3. Test an eligible unknown-mailbox bounce and automatic suppression before testing an automatically suppressed resend.
4. Complete the other live acceptance cases, including plus-addressing and message-size boundaries.
5. Add reusable API scripts for routing, events, suppressions, and limits if the ticket requires them. Handle pagination, final-event flags, and analytics rate limits. Use `/suppressions`, plural.
6. Validate a separate scoped API token if required. The live investigation used the existing Wrangler OAuth login successfully.
7. At the end of live testing, deploy `SEND_ENABLED=false`, verify an authorized send is blocked, and remove only the saved spike routes after checking their targets. Agree when to remove the basic Worker and KV.

Use the isolated fixture in [bounce-test](bounce-test/README.md) for controlled rejection and manual suppression checks. It was removed from Cloudflare after validation.

New deployments, routing changes, and test sends need authorization. Preserve existing DNS, the `anthony` rule, and catch-all behavior. Never commit credentials or local Wrangler state.

The repository's current root scaffold guard does not run this nested package's checks. Run the local commands above before review. Do not interpret a skipped root check as validation of the spike.

## Evidence and limits

Workers Logs contain test addresses and email headers. Use test messages and retain only the evidence needed for this spike.
Log sampling is set to 100 percent, but platform log limits and retention still apply. Capture evidence during each test.
Inbound raw data is bounded at 25 MiB. The maximum-size path still needs live resource-limit validation.
Outbound messages use small fixed fixtures. This implementation does not test the 5 MiB boundary.
Cloudflare retains control of the outbound Message-ID. This Worker uses `message.reply()` for the demo and never forwards inbound mail.

Cloudflare's [Email Service limits](https://developers.cloudflare.com/email-service/platform/limits/) apply to the complete encoded message, not each attachment:

- Inbound: 25 MiB, including all attachments and MIME overhead.
- Outbound to ordinary recipients: 5 MiB, including all attachments and encoding overhead.
- Outbound to Cloudflare-verified destination addresses: 25 MiB.

Raw files must be smaller than the message limit because base64 encoding increases their size by roughly one third before MIME overhead.
