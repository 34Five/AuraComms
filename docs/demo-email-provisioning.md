# Generate Aura email in the Studio replica

Issue draft: Axia / Email for Auras Phase 1.

The Studio replica previously created an Aura without email provisioning. The inbox assigned addresses but lacked Cloudflare routing credentials, leaving Megan pending. The governed sender also restricted new addresses to four fixed identities.

The Create Aura and email form suggests an editable prefix, lets the user choose an active company domain, and provisions the address and routing in one submission. Invalid or reserved prefixes fail before creating the Aura. Existing Auras also have Generate email, editable prefixes, and Retry email setup in their configuration. It reuses the shared address/assignment/provisioning records. Literal routing rules target the governed Worker; conflicting routes and catch-all remain unchanged. A service binding with a dedicated server secret lets the inbox delegate setup without receiving the Cloudflare API token. Generated senders use the account Email Sending API after active-tenant assignment and governance checks. LLM mode is enabled; existing tiers stay unchanged.

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

Replica: 242 app tests. Inbox: 251 app tests. Schema/governance: 79 tests. Typecheck, builds and Wrangler dry runs pass. Provider transport is mocked in automated tests. The user will perform the external mailbox delivery test themselves.

## Deployed demo

Both fixes are deployed. Megan's existing address is active and its literal rule targets `aura-inbox-test`. Megan stays Tier 1 and requires approval/send. External delivery awaits the user's mailbox test. Browser visual QA was unavailable in this session; live Admin API sign-in and provisioning were verified.
