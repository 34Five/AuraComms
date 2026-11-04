# AXI-8: tier rules and mocked-mail state machine

Week-1 E08/E09 implementation for [AXI-8](https://linear.app/34five/issue/AXI-8/e08-e09-tier-rules-model-and-state-machine-on-mocked-mail).
`scripts/email_rules.py` is a Python/SQLite reference engine alongside E07's existing
local tooling. It has no network, HTTP API or live sender. Worker/D1 integration is
later work: preserve these contracts using atomic D1 batches and conditional writes.

## Run

From repository root, using Python 3.10+ with SQLite JSON functions:

```bash
python3 -m unittest discover -s tests/email -v
python3 scripts/email_rules_demo.py
```

The demo creates a fresh in-memory database per tier using the original E07 parent
fixture, migration and seed, then applies `0002_email_governance.sql`. It evaluates
two replies to the seed's inbound quote, approves when needed and mocks dispatch.

| Tier | First outbound/reply | Later reply after successful send |
| --- | --- | --- |
| 1 | Hold for review | Hold for review |
| 2 | Hold for review | Send now |
| 3 | Hold for review after inbound | Send now |
| 4 | Send now | Send now |

Only sent history counts. Pending, approved-but-unsent, failed and rejected drafts
cannot unlock automatic replies. Tier 3 allows Aura-initiated mail before inbound;
the first reply after inbound needs approval. Subsequent inbound in the same epoch
does not require another initial approval. History is scoped to tenant/Aura/thread.
Tier 2 epoch 0 recognizes pre-engine sent history; after reset, only sent reviews in
the current epoch count. Tier 3 requires a sent human Tier 3 review that explicitly
observed the first inbound message in the current epoch. Proactive sends and legacy
timestamp-only history cannot establish that boundary. These interpretation choices
remain subject to product review.

## Rules model

Reuse `email_aura_policies`: TEXT tier `"1"` through `"4"`, positive version incremented
on policy changes, and extensible `rules_json`. Example, not a product default:

```json
{"cc":["reviewer@example.invalid"],"bcc":["audit@example.invalid"],"daily_limit":100}
```

Empty rules mean no configured copies/limit. Copies apply to Tier 4, are added to
recipient rows before hashing and deduplicated within each kind. A policy change
does not remove existing recipient rows: explicitly edit unwanted recipients and
reevaluate. Every policy change invalidates existing unsent decisions.
Configured copies must be bare ASCII dot-atom mailboxes with valid domain labels.
Display names, brackets, address-list separators, whitespace/control characters,
quoted local parts, domain literals and internationalized addresses are rejected.
All copies are validated before any recipient rows are modified.

If configured, daily limits apply to every tier, per Aura per UTC calendar day.
Count sent messages plus today's approved unsent reservations, once per message.
Pending reviews do not reserve slots. Approval and dispatch both recheck capacity;
human approval cannot bypass the limit. Old-day approvals acquire capacity again
at dispatch. Cancelled messages release capacity; stale approvals may conservatively
hold capacity until superseded or cancelled.

Unknown guardrails, invalid tiers, malformed copy addresses and invalid limits raise
configuration errors instead of silently allowing sends. Valid evaluations always
persist a review. New guardrails require an evaluator and a JSON key, not SQL columns.
A future tenant ceiling belongs in policy resolution: effective tier is the lower
of Aura tier and ceiling, with both versions snapshotted. No tenant policy source or
ceiling enforcement is introduced by this slice.

Approvers use existing `email_aura_reviewers` and `studio_members.member_id`. Any one
active designated reviewer can decide. The calling application must authenticate and
derive authorized org/Aura/member scope; accepting arbitrary library arguments is not
authentication. Reviewer designation is checked at approval and again before sending.
Revocation invalidates unsent human approvals. The sender method is trusted internal
code; no public endpoint is exposed.

## State machine

| Transition | Actor and conditions |
| --- | --- |
| Evaluate → pending | Engine: human review needed or daily capacity unavailable |
| Evaluate → approved | Engine: automatic tier path, no fabricated human actor |
| pending → approved/rejected | Active designated reviewer; current hash, policy and epoch |
| approved → sent | Trusted mock sender; current review, capacity and active route |
| pending/approved/rejected → superseded | Reevaluation after content/policy/epoch change |
| pending/approved → superseded | Authorized explicit thread reset |

Rejected reviews cannot be silently reevaluated into automatic approval. Edit or
change policy and submit a new revision. Identical evaluation returns the same review,
including a rejection/hold. A daily-limit hold stays pending until a reviewer decides
once capacity is available. Replayed successful dispatch returns `already sent`.
Pending/rejected/superseded reviews cannot be sent. Resets preserve sent history.

Each operation uses a SQLite savepoint and leaves an existing outer transaction under
caller control. With no outer transaction, releasing the savepoint commits. Retry
locking/serialization failures from the operation boundary. There is no network side
effect inside these transactions. Live sending needs provider idempotency and timeout
reconciliation; mock replay protection does not prove exactly-once live delivery.

## Upgrade and audit

`scripts/0002_email_governance.sql` upgrades the exact `0001` schema, preserving every
review ID, revision and original field. It rebuilds reviews, indexes and outbound-only
triggers to relax the human-only decision constraint for automatic approved/sent rows.
Apply with the transactional migration runner; do not rerun `0001` on existing tables.
Earlier demo schema variants require a drift check before applying the upgrade.

| Added review field | Meaning |
| --- | --- |
| decision_source | `human` (default for old rows) or `automatic` |
| policy_snapshot_json | Tier, policy version, rules and Tier 3 inbound boundary used for this revision |

Automatic decisions have no human approver; human approved/rejected/sent records still
require one. Automatic rejection is disallowed. Legacy `{}` policy snapshots require
reevaluation before dispatch, while legacy sent reviews remain untouched.
Tier 3 snapshots also store `tier_3_inbound_id`: the first observed inbound ID, or
null before inbound. A first inbound arriving after evaluation invalidates the cached
review, including an automatic approval waiting for dispatch. Reevaluation supersedes
it and applies the first-reply gate. Later inbound messages do not change this boundary
or reset a reviewed thread automatically. Timestamps alone never establish that a
proactive send was a reviewed reply. This uses the existing JSON field; no SQL upgrade
beyond `0002` is required. Older Tier 3 snapshots without this marker must be reevaluated.

Each revision stores tier, epoch, source, reason, status, snapshot, content hash,
timestamps and any human decision actor. Transitions update that revision; superseded
revisions preserve previous content decisions. This supplies E16's review record,
not an append-only transition event log. Thread `tier_state` is the last operation's
summary; queue state must come from per-message reviews when several drafts coexist.

The hash covers body or R2 reference, sender/envelope, subject, reply headers,
ordered recipients, and attachment metadata/references. R2 keys must identify immutable
objects; actual object-byte verification is outside this mock. Edits invalidate approval,
create a new revision on reevaluation and set `edited_before_send`. Before dispatch,
recheck hash, policy, epoch, reviewer authority, limit and active address/domain/assignment.
Dispatch also rechecks automatic conversation eligibility. Successful mock dispatch
updates message `activity_at` and `sent_at` atomically to the actual send time, so
conversation order and the existing assignment-history triggers reflect that send.
Delivery/bounce events remain separate from sent status.

## Reset hook and open product choices

`reset_thread(org, aura, thread_id, member)` requires an active Aura reviewer. It
atomically increments review_epoch/state_version, records actor/time and supersedes
pending/approved reviews in the thread. Next Tier 2/3 reply needs review again.
There is no automatic reset for new participants or forwards: AXI-5 says default to
keeping the thread and leaves detailed use cases open.

Review with Pavan/product:

- Tier 3 Aura-initiated mail is automatic until inbound; approval is once per
  thread/epoch, not once per inbound message.
- Any one configured reviewer can approve. Quorum, hierarchy and edit-then-send UX
  remain deferred; edited content needs fresh approval.
- Tier 4 has optional copies and no mandatory default limit. UTC/per-Aura counting
  is the mock convention; final defaults remain open in AXI-5's follow-up.
- Explicit reset exists; automatic participant/forward criteria remain open.

The existing CI email-schema job discovers the new tests. They cover all tiers,
first/later mail, approval-before-send ordering, Aura-initiated Tier 3, copies,
daily reservations/rollover, authorization/revocation, scope, inbound rejection,
content/recipient/attachment/policy changes, reset, active routing, replay, migration
preservation and invalid configuration. No live D1 deployment or mail is performed.
