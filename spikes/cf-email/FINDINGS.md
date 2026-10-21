# AXI-4 Cloudflare spike findings

Validation date: 21 October 2026. Status: partial validation complete.

## Confirmed live

- Inbound Gmail delivery reached `aura-spike-email`. The Worker parsed an attachment and recorded its decoded size.
- Outbound delivery to a Google-hosted inbox included plain text, HTML, Reply-To, and the attachment fixture.
- Outbound SPF, DKIM, and DMARC passed. A passing DKIM signature used exactly `d=34five.studio`.
- The returned Message-ID matched the delivered Message-ID. This deployment generated IDs under `34five.studio`.
- An incoming reply matched the stored send through In-Reply-To. A Worker-generated reply appeared in the same inbox conversation.
- Delivery events, suppression lists, domain settings, and account limits were queried with the existing Wrangler OAuth login. These checks did not require a separate API token.
- The account reported 200 sends per day. This is an observed account allowance, not a fixed product limit or a load-test result.
- A dedicated rejection Worker produced a final `deliveryFailed` event for the sent Message-ID. The SMTP response was `555 5.7.1 AXI-4 controlled permanent rejection`, with `isLastEvent=1`.
- A reserved `.invalid` destination produced a separate final failure with `upstream_no_psl_domain`. An unroutable subdomain produced retry events with `upstream_none_cf` and `isLastEvent=0`.
- Manual suppression enforcement passed through the Workers binding. After a two-minute propagation allowance, sending returned `E_RECIPIENT_SUPPRESSED` while the manual entry remained active.

## Findings that need follow-up

- No automatic suppression appeared for the tested failure categories during the observation window. An eligible unknown-mailbox rejection, such as SMTP `550 5.1.1`, and a subsequent automatically suppressed resend remain unverified.
- An earlier REST send queued immediately after a manual suppression was created. The later binding test passed after two minutes. The first result does not establish the cause or prove a required propagation duration.
- The analytics API required a five-minute cooldown during testing. A reusable polling script needs rate-limit handling.

## Not validated

- Outlook inbound delivery, outbound delivery, threading, and Outlook-specific headers.
- The full 15-case live acceptance checklist, including plus-address behavior and message-size boundaries.
- A separate scoped API token and its minimum permissions.
- Exhaustion or enforcement of account sending quotas.

## Cleanup and repository scope

The dedicated bounce-test Worker, its exact-address route, its token, and the temporary manual Gmail suppression were removed. Original routing rules and catch-all matched the saved baseline. No DNS records changed. The earlier basic spike Worker and KV remain deployed.

The package contains the basic Worker and the isolated bounce-test fixture. Routing, analytics, suppression, and limits queries were run as local investigation scripts; reusable API scripts are not included here.

Main Worker verification: TypeScript checks, automated tests, and a deployment dry run. The bounce fixture has separate automated tests. These local tests do not replace the live evidence above.
