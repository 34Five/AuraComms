# Generate Aura email in the Studio replica

Issue draft: Axia / Email for Auras Phase 1.

The Studio replica previously created an Aura without email provisioning. The inbox assigned addresses but lacked Cloudflare routing credentials, leaving Megan pending. The governed sender also restricted new addresses to four fixed identities.

The fix adds Generate email, active company domain selection, and Retry email setup to Aura configuration. It reuses the shared address/assignment/provisioning records. Literal routing rules target the governed Worker; conflicting routes and catch-all remain unchanged. A service binding with a dedicated server secret lets the inbox delegate setup without receiving the Cloudflare API token. Generated senders use the account Email Sending API after active-tenant assignment and governance checks. LLM mode is enabled; existing tiers stay unchanged.

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

Replica: 240 app tests. Inbox: 251 app tests. Schema/governance: 79 tests. Typecheck, builds and Wrangler dry runs pass. Provider transport is mocked in automated tests. The user will perform the external mailbox delivery test themselves.
