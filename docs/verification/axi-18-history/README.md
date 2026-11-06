# AXI-18: per-message recorded review history

Built from `feature/aura-demo-authentication` at PR #19 merge `58aeb6df5167e56a019089d9d0de4b124d7d6748` in the isolated branch `feat/axi-18-inbox-review-history`. The base tree matched reviewed `5a685c1`. Other worktrees and `spikes/cf-email` were preserved.

## Completed slice

Outbound inbox cards have a read-only Review history disclosure with per-message revision pagination. It shows recorded status/tier/source, current same-org reviewer name or recorded ID fallback, the edited flag, available timestamps and fixed safe reason labels. Automatic records have no human attribution. Superseded records are displayed as recorded, with neutral reviewer/decision-time labels and an explicit warning that the earlier outcome may be lost. Provider acceptance is not presented as recipient delivery.

The message-scoped endpoint uses existing inbox read checks and allowlists fields. It never returns policy snapshots, body hashes, raw provider payloads or raw unknown reason text. Queries and reviewer joins stay within the organization; message queries are additionally scoped to Aura/message. No migration, mutation logic or schema changes are included.

Revision ordering is newest first. Default limit 25/max 50; `cursor=revision:N` is exclusive. Unique message revision ordering handles equal timestamps and avoids page shifts when newer revisions arrive. Refresh sees new revisions; statuses remain mutable. An open history refreshes its loaded revision range after message changes. Unchanged five-second inbox polling does not fetch history. Error/page retry preserves loaded rows; cancellation and request-sequence checks prevent old responses populating a different message/Aura.

## Validation

- `WRANGLER_LOG_PATH=/tmp/axi18-history-wrangler npm --prefix apps/aura-inbox run check`: TypeScript, all **314 app tests**, build and deployment dry run passed.
- Nine new API tests cover approve/edit/reapprove/send metadata; revocation and historical names; missing-name fallback; cross-org/Aura/message/session boundaries; 131 target revisions plus more than 100 unrelated revisions; strict pagination, equal timestamps/new arrivals; unknown reasons and automatic/no-review records; reject/edit, policy/reset/cancellation supersession; and failed/unconfirmed sends.
- `total_changes()` checks verify history opening/paging/retries—including malformed requests—perform no writes; provider counters verify no dispatch. Review rows remain unchanged across reads.
- `python3 -m unittest discover -s tests/email -v`: **79 tests passed**. The reference engine/schema was unchanged.
- Existing `tests/inline-review.browser.mjs`: passed, including both CTO P2 regressions and uncertain-send protection; **four mocked provider calls**.
- New `tests/review-history.browser.mjs`: passed against real local API/disposable SQLite; keyboard disclosure, 390px/long names, pagination and older-page retry, no normal polling fetches, read-only reads, refresh after approve/edit/reapprove/send while retaining Revision 1, empty/automatic states, error recovery, and delayed responses across thread and Aura navigation; **one mocked provider call** for explicit Send.

No real email, shared D1 mutation or deployment occurred. Screenshots were visually inspected. They use existing inbox styling; no new Studio convention was assumed.

## Screenshots

| State | Evidence |
| --- | --- |
| Original recorded reviewer and neutral superseded metadata | [Desktop](desktop-recorded-reviewer.png) |
| Long reviewer name and reason at 390px | [Mobile](mobile-long-reviewer.png) |
| Open history updated after editing, older range retained | [After edit](desktop-refreshed-history.png) |
| Recorded provider acceptance | [Accepted](desktop-provider-acceptance.png) |
| Failed refresh with earlier rows retained | [Error](desktop-history-error.png) |
| Legacy message without recorded reviews | [Empty](desktop-no-reviews.png) |
| Automatic approval without a human actor | [Automatic](desktop-automatic.png) |

## Remaining AXI-18 acceptance and source limitations

This is a recorded revision trail, not full immutable audit acceptance. `email_reviews.status` changes to `superseded`; old approval/rejection outcomes are not always retained. Stored rows do not establish who edited/cancelled, the time of every edit/cancellation, or a content diff. Display names come from current workspace records rather than historical name snapshots. No reconstruction, backfill or new event ledger is attempted.

Original Admin-only/per-Aura view-list acceptance is unresolved: this slice preserves existing broader Admin/Manager reads and assigned Reviewer visibility. It does not introduce a new access list or alter action permissions. Message direction/status/tier/date filters and oldest-pending-with-age remain open; current filters are conversation status/search. Analytics remain separate.

Actual Studio core and an agreed authenticated handoff/tenant-Aura ID contract are absent here. Existing replica provisioning is not rebuilt, and no integration contract is guessed. Studio entry work remains open alongside these full audit, filter and access requirements. Leave AXI-18 open. Linear changes require Akash's approval of a draft. Stop before merge/deployment; external mail testing remains Akash's responsibility.
