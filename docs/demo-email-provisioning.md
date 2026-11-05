# Generate Aura email in the Studio replica

Issue draft: Axia / Email for Auras Phase 1.

The Studio replica previously created an Aura without email provisioning. The inbox assigned addresses but lacked Cloudflare routing credentials, leaving Megan pending. The governed sender also restricted new addresses to four fixed identities.

The Create Aura and email form suggests an editable prefix, lets the user choose an active company domain, and provisions the address and routing in one submission. Invalid or reserved prefixes fail before creating the Aura. Existing Auras also have Generate email, editable prefixes, and Retry email setup in their configuration. It reuses the shared address/assignment/provisioning records. Literal routing rules target the governed Worker; conflicting routes and catch-all remain unchanged. A service binding with a dedicated server secret lets the inbox delegate setup without receiving the Cloudflare API token. Generated senders use the account Email Sending API after active-tenant assignment and governance checks. Generated addresses use LLM replies even when the existing predefined routes remain in fixed mode; existing tiers stay unchanged.

## Acceptance criteria

- Create an Aura, generate an address on an active domain, and see its active route in both apps.
- Repeat generation without creating extra assignments; recover failed setup through Retry.
- Receive an external message, generate an LLM draft, and preserve threading.
- Tier 1 holds for explicit approval and send; Tier 4 sends automatically.
- Reject unauthorized, reviewer, cross-tenant and cross-origin management mutations.
- Preserve existing email history, unrelated routing rules and catch-all.

## Client question

Should email generation remain in both interfaces, or live exclusively in Studio Aura configuration? Keep both for the demo using one provisioning service.

## Verification

Replica: 270 app tests. Inbox: 281 app tests. Schema/governance: 79 tests. Typecheck, builds and Wrangler dry runs pass. Provider transport is mocked in automated tests. The user will perform the external mailbox delivery test themselves.

## Deployed demo

Both fixes are deployed. Megan's existing address is active and its literal rule targets `aura-inbox-test`. Megan stays Tier 1 and requires approval/send. External delivery awaits the user's mailbox test. Browser visual QA was unavailable in this session; live Admin API sign-in and provisioning were verified.

## Review follow-up

Addressed the provisioning review in PRs #15 and #16:

- One shared `shared/email-prefix.ts` policy on both branches, with identical content. Reserved service/live names are rejected before inserts, and automatic suggestions skip them. Prefixes allow only letters/digits separated by single dots or hyphens.
- Existing assignments reject a different requested prefix/domain (409). Collision races return 409; failed one-step creation removes its own unassigned Aura rather than reporting success.
- Delegation requires an active shared D1 row, so 200 HTML, pending state, and unconfirmed JSON cannot appear successful. Sanitized failure logs include the HTTP status and Aura ID. Failures cannot downgrade active rows.
- Provider requests share a 12-second total routing deadline, with a 15-second client timeout. Only exact AuraComms-owned routing rules are reused.
- `0005_email_address_provisioning.sql` is canonical on both branches; #16 removes the old `0003` filename and updates consumers. No new table or data migration is introduced.
- Default reply mode is restored to fixed. Only generated addresses opt into LLM automatically; this fix does not turn every existing route into an LLM endpoint.
- README and local secret examples explain the shared secret, service binding, server-first deployment, and separate-branch dependency.

### Base branch integration blockers (not resolved by these provisioning PRs)

Do not merge the replica base wholesale into `spikes/cf-email`. The follow-up integration must:

1. Remove invented persona/role defaults and use only the client's authoritative Aura configuration.
2. Replace/disable repo-published shared-password access and revoke its sessions; build roles on the invite-only sign-in from PR #14.
3. Reconcile the competing auth routes, cookies and migrations.
4. Exclude the persona/address rename migration; do not disable or rename existing live identities as part of provisioning.
5. Preserve both Workers' resource bindings, Merlin/Atlas/Anthony behavior, governance prerequisites and the `no-reply` sender used for invite codes.

These items remain unresolved in the base branch and the deployed replica. The provisioning fixes do not claim the base branch is ready for full integration.
