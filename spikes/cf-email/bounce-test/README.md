# Controlled bounce and suppression fixture

This separate Worker exists only for manual spike validation. It has no KV binding and does not modify the basic spike Worker.

The `email()` handler rejects mail addressed to `spike-bounce@34five.studio` with a permanent SMTP error. Unexpected recipients also reject. The live test produced SMTP `555 5.7.1`, which did not establish automatic suppression for an unknown mailbox.

Both HTTP endpoints require the temporary `TEST_TOKEN` secret:

- `POST /send` sends only to a reserved `.invalid` destination. Change the fixed `RECIPIENT` in source if another controlled failure case is required.
- `POST /send-manual` sends only to the operator-configured `MANUAL_TEST_RECIPIENT`. It fails closed when that variable is empty. Request bodies cannot select a recipient.

## Manual validation sequence

1. Confirm that the Worker name and exact test address are unused. Save the existing routing rules and catch-all.
2. Review the fixed sender and recipient. Configure only an inbox you control for the manual suppression test.
3. After deployment authorization, deploy from this directory and set `TEST_TOKEN` with `wrangler secret put TEST_TOKEN`.
4. Create one literal `to` rule for the rejection address, targeting this Worker. Save the returned rule ID. Allow the route to propagate before sending.
5. Watch `wrangler tail aura-spike-bounce-check --format json`. Confirm unauthorized HTTP sends return 401.
6. Send one controlled message, retain its Message-ID, and inspect analytics until a final event appears. HTTP 202 alone proves acceptance.
7. Query automatic suppressions for the exact recipient. Test an automatically suppressed resend only after the entry appears. A manual entry does not prove automatic creation.
8. For the separate manual test, first confirm no existing suppression affects the configured inbox. Create a temporary sending-domain entry scoped to `34five.studio`, with an expiration. Retain its ID.
9. Allow propagation, verify that the entry remains active, and call `/send-manual`. With `drop_suppressed_recipients=false`, expect `E_RECIPIENT_SUPPRESSED`. The live test allowed two minutes; this is not a documented propagation guarantee.
10. Remove only the manual entry created for this test and verify cleanup. Remove only the saved exact-address route after verifying its address and Worker target. Delete this test Worker and its secret.
11. Compare remaining rules and catch-all with the baseline. Keep unresolved sends and missing automatic suppressions marked inconclusive.

Use the existing authenticated CLI or API tooling. Never commit OAuth credentials, TEST_TOKEN, raw personal inbox headers, or generated Wrangler state. Back off on analytics rate-limit errors.

The fixture was removed from Cloudflare after the live run. See `../FINDINGS.md` for observed results and remaining gaps.
