# AXI-18 inline draft review verification

Verified locally on November 6, 2026. All data is disposable; every provider call is mocked. No real email, shared D1 mutation, merge or deployment was performed.

## Integration and deployed application

- Base: `feature/aura-demo-authentication`, `f31efa112f3bba46661382f5c52b16db9f805099` (PR #18 merge).
- Cloudflare `aura-inbox-test`: 100% traffic on `43463b16-4482-46b2-9dac-75b157c3db2a`, created November 5 at 18:43 IST. Inspected with `wrangler deployments list` and `wrangler versions view`.
- Live `/api/health` rejects unauthenticated access with HTTP 401.
- Deployed JS `index-DE1425BL.js`: SHA-256 `d0f88d973e35abcf9d89d87ab32994b58686de2bb6ec47eb59d1db162c600ff4`.
- Deployed CSS `index-DKbEJpzH.css`: SHA-256 `c15b3b901f58c700c45b81f804db03f1d3758e5249f76a723bd299d7acd5cf95`.
- Both public assets match the primary checkout's PR #18 build. Worker version metadata lacks a Git commit tag; exact backend source parity is unproven.

## Validation

- `npm run check`: TypeScript, all 305 app tests, production build and Wrangler deployment dry run. The sandbox blocked Wrangler's normal log path; the dry run passed again with `WRANGLER_LOG_PATH=/tmp/axi18-wrangler-logs`.
- `python3 -m unittest discover -s tests/email -v`: all 79 schema/lifecycle/reference-rule tests passed.
- Browser fixture: `apps/aura-inbox/tests/inline-review.browser.mjs`; real app/API, SQLite with foreign keys, mocked email transport. Three mocked dispatches: accepted, unknown, rejected.
- API tests: fixed-role authorization, designated reviewer revocation, edit/approval invalidation, stale approvals/edits/cancel/reevaluation, separate approval and Send, concurrent duplicate Send, unknown claim preservation, rejection/cancellation history, and edited flag persistence through policy reevaluation.
- Browser checks: keyboard approval/Send, focus restoration, long text, 390px width without horizontal overflow, edit-after-approval, stale editor text preservation, Reviewer controls, failed/unconfirmed distinction and refresh-error recovery.

## Screenshots

| View | Screenshot |
| --- | --- |
| Pending draft, desktop | [Pending](desktop-pending.png) |
| Approved, separate Send | [Approved](desktop-approved.png) |
| Provider acceptance | [Sent](desktop-sent.png) |
| Long editor, 390px | [Editor](mobile-long-editor.png) |
| Reachable editor actions, 390px | [Editor actions](mobile-editor-actions.png) |
| Unconfirmed send, no retry | [Unconfirmed](mobile-unconfirmed.png) |
| Confirmed provider rejection | [Failed](desktop-failed.png) |
| Stale edit, unsaved text preserved | [Stale editor](desktop-stale-edit.png) |
| Reviewer permissions | [Reviewer](reviewer-permissions.png) |
| Refresh failed, actions disabled | [Refresh error](desktop-refresh-error.png) |

Visual checks retain the existing inbox layout, typography, colors and control styles. No new Studio conventions were assumed.

## Remaining scope and limits

AXI-18 stays open. Studio entry points, broader audit/history presentation, the full filter/access acceptance criteria and analytics are not completed by this slice. Reply-all (AXI-30), recipient editing (AXI-31), address availability (AXI-32), and AI regeneration are excluded.

Existing edit limits remain: inline text bodies only, subject up to 200 characters and text up to 12 KB. R2 bodies remain readable and reviewable. Unknown sends require administrator/provider reconciliation; no retry is introduced. External receipt/delivery is unverified; Akash sends real test emails.
