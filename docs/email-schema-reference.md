# Email schema field reference

Generated from scripts/0001_email_model.sql. See [email-model.md](email-model.md) for behavior, relationships and prerequisite provenance.

## email_address_assignments

| Field | Type | Required | Default |
| --- | --- | --- | --- |
| `id` | TEXT | yes | — |
| `org_id` | TEXT | yes | — |
| `address_id` | TEXT | yes | — |
| `aura_id` | TEXT | yes | — |
| `assigned_at` | TEXT | yes | — |
| `ended_at` | TEXT | no | — |
| `assigned_by_member_id` | TEXT | no | — |
| `ended_by_member_id` | TEXT | no | — |
| `reason` | TEXT | no | — |

Foreign keys:

- `(org_id, ended_by_member_id)` → `studio_members(org_id, member_id)`.
- `(org_id, assigned_by_member_id)` → `studio_members(org_id, member_id)`.
- `(org_id, aura_id)` → `auras(org_id, id)`.
- `(org_id, address_id)` → `email_addresses(org_id, id)`.

Keys/checks:

```sql
CREATE TABLE email_address_assignments (
  id TEXT PRIMARY KEY NOT NULL,
  org_id TEXT NOT NULL,
  address_id TEXT NOT NULL,
  aura_id TEXT NOT NULL,
  assigned_at TEXT NOT NULL,
  ended_at TEXT,
  assigned_by_member_id TEXT,
  ended_by_member_id TEXT,
  reason TEXT,
  UNIQUE (org_id, aura_id, address_id, id),
  FOREIGN KEY (org_id, address_id) REFERENCES email_addresses(org_id, id),
  FOREIGN KEY (org_id, aura_id) REFERENCES auras(org_id, id),
  FOREIGN KEY (org_id, assigned_by_member_id) REFERENCES studio_members(org_id, member_id),
  FOREIGN KEY (org_id, ended_by_member_id) REFERENCES studio_members(org_id, member_id),
  CHECK (length(assigned_at) = 24 AND assigned_at GLOB '????-??-??T??:??:??.???Z'),
  CHECK (ended_at IS NULL OR (length(ended_at) = 24 AND ended_at GLOB '????-??-??T??:??:??.???Z' AND ended_at > assigned_at))
);
```

## email_addresses

| Field | Type | Required | Default |
| --- | --- | --- | --- |
| `id` | TEXT | yes | — |
| `org_id` | TEXT | yes | — |
| `domain_id` | TEXT | yes | — |
| `local_part` | TEXT | yes | — |
| `address` | TEXT | yes | — |
| `address_key` | TEXT | yes | — |
| `status` | TEXT | yes | `'active'` |
| `created_at` | TEXT | yes | `strftime('%Y-%m-%dT%H:%M:%fZ','now')` |
| `disabled_at` | TEXT | no | — |
| `released_at` | TEXT | no | — |

Foreign keys:

- `(org_id, domain_id)` → `email_domains(org_id, id)`.

Keys/checks:

```sql
CREATE TABLE email_addresses (
  id TEXT PRIMARY KEY NOT NULL,
  org_id TEXT NOT NULL CHECK (org_id <> '' AND org_id <> 'org'),
  domain_id TEXT NOT NULL,
  local_part TEXT NOT NULL CHECK (local_part <> '' AND local_part = lower(local_part) AND local_part NOT LIKE '%@%'),
  address TEXT NOT NULL,
  address_key TEXT NOT NULL UNIQUE CHECK (address_key = lower(address_key) AND address = address_key),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled','released')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  disabled_at TEXT,
  released_at TEXT,
  UNIQUE (org_id, id),
  UNIQUE (domain_id, local_part),
  FOREIGN KEY (org_id, domain_id) REFERENCES email_domains(org_id, id),
  CHECK ((status = 'active' AND disabled_at IS NULL AND released_at IS NULL)
      OR (status = 'disabled' AND disabled_at IS NOT NULL AND released_at IS NULL)
      OR (status = 'released' AND disabled_at IS NOT NULL AND released_at IS NOT NULL))
);
```

## email_attachments

| Field | Type | Required | Default |
| --- | --- | --- | --- |
| `id` | TEXT | yes | — |
| `org_id` | TEXT | yes | — |
| `aura_id` | TEXT | yes | — |
| `message_id` | TEXT | yes | — |
| `ordinal` | INTEGER | yes | — |
| `filename` | TEXT | no | — |
| `content_type` | TEXT | yes | — |
| `size_bytes` | INTEGER | yes | — |
| `r2_key` | TEXT | yes | — |
| `content_id` | TEXT | no | — |
| `disposition` | TEXT | yes | `'attachment'` |
| `extraction_status` | TEXT | yes | `'not_requested'` |
| `extracted_text_r2_key` | TEXT | no | — |
| `extraction_error` | TEXT | no | — |
| `extracted_at` | TEXT | no | — |
| `created_at` | TEXT | yes | `strftime('%Y-%m-%dT%H:%M:%fZ','now')` |

Foreign keys:

- `(org_id, aura_id, message_id)` → `email_messages(org_id, aura_id, id)`.

Keys/checks:

```sql
CREATE TABLE email_attachments (
  id TEXT PRIMARY KEY NOT NULL,
  org_id TEXT NOT NULL,
  aura_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  filename TEXT,
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  r2_key TEXT NOT NULL UNIQUE,
  content_id TEXT,
  disposition TEXT NOT NULL DEFAULT 'attachment' CHECK (disposition IN ('attachment','inline')),
  extraction_status TEXT NOT NULL DEFAULT 'not_requested' CHECK (extraction_status IN ('not_requested','pending','processing','completed','failed','unsupported')),
  extracted_text_r2_key TEXT,
  extraction_error TEXT,
  extracted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (org_id, aura_id, message_id, ordinal),
  FOREIGN KEY (org_id, aura_id, message_id) REFERENCES email_messages(org_id, aura_id, id)
);
```

## email_aura_policies

| Field | Type | Required | Default |
| --- | --- | --- | --- |
| `org_id` | TEXT | yes | — |
| `aura_id` | TEXT | yes | — |
| `tier` | TEXT | no | — |
| `rules_json` | TEXT | yes | `'{}'` |
| `version` | INTEGER | yes | `1` |
| `updated_by_member_id` | TEXT | no | — |
| `updated_at` | TEXT | yes | `strftime('%Y-%m-%dT%H:%M:%fZ','now')` |

Foreign keys:

- `(org_id, updated_by_member_id)` → `studio_members(org_id, member_id)`.
- `(org_id, aura_id)` → `auras(org_id, id)`.

Keys/checks:

```sql
CREATE TABLE email_aura_policies (
  org_id TEXT NOT NULL,
  aura_id TEXT NOT NULL,
  tier TEXT, -- Nullable until the exact Tier 1–4 identifiers/semantics are agreed.
  rules_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(rules_json) AND json_type(rules_json) = 'object'),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_by_member_id TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (org_id, aura_id),
  FOREIGN KEY (org_id, aura_id) REFERENCES auras(org_id, id),
  FOREIGN KEY (org_id, updated_by_member_id) REFERENCES studio_members(org_id, member_id)
);
```

## email_aura_reviewers

| Field | Type | Required | Default |
| --- | --- | --- | --- |
| `org_id` | TEXT | yes | — |
| `aura_id` | TEXT | yes | — |
| `member_id` | TEXT | yes | — |
| `configured_by_member_id` | TEXT | no | — |
| `configured_at` | TEXT | yes | `strftime('%Y-%m-%dT%H:%M:%fZ','now')` |
| `revoked_at` | TEXT | no | — |

Foreign keys:

- `(org_id, configured_by_member_id)` → `studio_members(org_id, member_id)`.
- `(org_id, member_id)` → `studio_members(org_id, member_id)`.
- `(org_id, aura_id)` → `auras(org_id, id)`.

Keys/checks:

```sql
CREATE TABLE email_aura_reviewers (
  org_id TEXT NOT NULL,
  aura_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  configured_by_member_id TEXT,
  configured_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  revoked_at TEXT,
  PRIMARY KEY (org_id, aura_id, member_id),
  FOREIGN KEY (org_id, aura_id) REFERENCES auras(org_id, id),
  FOREIGN KEY (org_id, member_id) REFERENCES studio_members(org_id, member_id),
  FOREIGN KEY (org_id, configured_by_member_id) REFERENCES studio_members(org_id, member_id)
);
```

## email_contacts

| Field | Type | Required | Default |
| --- | --- | --- | --- |
| `id` | TEXT | yes | — |
| `org_id` | TEXT | yes | — |
| `address` | TEXT | yes | — |
| `address_key` | TEXT | yes | — |
| `display_name` | TEXT | no | — |
| `member_id` | TEXT | no | — |
| `participant_id` | TEXT | no | — |
| `suppressed_at` | TEXT | no | — |
| `suppression_reason` | TEXT | no | — |
| `created_at` | TEXT | yes | `strftime('%Y-%m-%dT%H:%M:%fZ','now')` |
| `updated_at` | TEXT | yes | `strftime('%Y-%m-%dT%H:%M:%fZ','now')` |

Foreign keys:

- `(org_id, member_id)` → `studio_members(org_id, member_id)`.

Keys/checks:

```sql
CREATE TABLE email_contacts (
  id TEXT PRIMARY KEY NOT NULL,
  org_id TEXT NOT NULL CHECK (org_id <> '' AND org_id <> 'org'),
  address TEXT NOT NULL,
  address_key TEXT NOT NULL,
  display_name TEXT,
  member_id TEXT, -- Optional internal-person link. NULL in Phase 1; no matching logic.
  participant_id TEXT, -- Reserved Phase 2 cross-modality mapping; opaque in Phase 1.
  suppressed_at TEXT, -- Metadata only; suppression policy/enforcement is outside E07.
  suppression_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (org_id, address_key),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, member_id) REFERENCES studio_members(org_id, member_id),
  CHECK ((suppressed_at IS NULL AND suppression_reason IS NULL)
      OR (suppressed_at IS NOT NULL AND suppression_reason IS NOT NULL))
);
```

## email_domains

| Field | Type | Required | Default |
| --- | --- | --- | --- |
| `id` | TEXT | yes | — |
| `org_id` | TEXT | yes | — |
| `domain` | TEXT | yes | — |
| `domain_key` | TEXT | yes | — |
| `kind` | TEXT | yes | — |
| `status` | TEXT | yes | `'pending'` |
| `dns_records_json` | TEXT | yes | `'[]'` |
| `cloudflare_zone_id` | TEXT | no | — |
| `cloudflare_domain_id` | TEXT | no | — |
| `failure_reason` | TEXT | no | — |
| `verified_at` | TEXT | no | — |
| `activated_at` | TEXT | no | — |
| `disabled_at` | TEXT | no | — |
| `created_at` | TEXT | yes | `strftime('%Y-%m-%dT%H:%M:%fZ','now')` |
| `updated_at` | TEXT | yes | `strftime('%Y-%m-%dT%H:%M:%fZ','now')` |

Foreign keys:

No organization parent table was supplied; validate org existence in the service.

Keys/checks:

```sql
CREATE TABLE email_domains (
  id TEXT PRIMARY KEY NOT NULL,
  org_id TEXT NOT NULL CHECK (org_id <> '' AND org_id <> 'org'),
  domain TEXT NOT NULL,
  domain_key TEXT NOT NULL UNIQUE CHECK (domain_key = lower(domain_key) AND domain_key <> '' AND domain_key NOT LIKE '%@%'),
  kind TEXT NOT NULL CHECK (kind IN ('default_subdomain','custom')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verifying','active','failed','disabled')),
  dns_records_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(dns_records_json) AND json_type(dns_records_json) = 'array'),
  cloudflare_zone_id TEXT,
  cloudflare_domain_id TEXT,
  failure_reason TEXT,
  verified_at TEXT,
  activated_at TEXT,
  disabled_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (org_id, id),
  CHECK (status <> 'active' OR (verified_at IS NOT NULL AND activated_at IS NOT NULL)),
  CHECK (status <> 'failed' OR failure_reason IS NOT NULL),
  CHECK (status <> 'disabled' OR disabled_at IS NOT NULL)
);
```

## email_events

| Field | Type | Required | Default |
| --- | --- | --- | --- |
| `id` | TEXT | yes | — |
| `org_id` | TEXT | yes | — |
| `aura_id` | TEXT | yes | — |
| `message_id` | TEXT | yes | — |
| `recipient_id` | TEXT | no | — |
| `event_type` | TEXT | yes | — |
| `provider_event_type` | TEXT | no | — |
| `provider` | TEXT | yes | `'cloudflare'` |
| `provider_event_id` | TEXT | no | — |
| `dedup_key` | TEXT | yes | — |
| `occurred_at` | TEXT | yes | — |
| `ingested_at` | TEXT | yes | `strftime('%Y-%m-%dT%H:%M:%fZ','now')` |
| `raw_payload_json` | TEXT | no | — |
| `raw_payload_r2_key` | TEXT | no | — |

Foreign keys:

- `(org_id, aura_id, message_id, recipient_id)` → `email_message_recipients(org_id, aura_id, message_id, id)`.
- `(org_id, aura_id, message_id)` → `email_messages(org_id, aura_id, id)`.

Keys/checks:

```sql
CREATE TABLE email_events (
  id TEXT PRIMARY KEY NOT NULL,
  org_id TEXT NOT NULL,
  aura_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  recipient_id TEXT,
  event_type TEXT NOT NULL CHECK (event_type IN ('accepted','delivered','bounced','complained','deferred','failed','rejected','unknown')),
  provider_event_type TEXT,
  provider TEXT NOT NULL DEFAULT 'cloudflare',
  provider_event_id TEXT,
  dedup_key TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  ingested_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  raw_payload_json TEXT CHECK (raw_payload_json IS NULL OR json_valid(raw_payload_json)),
  raw_payload_r2_key TEXT,
  UNIQUE (org_id, aura_id, provider, dedup_key),
  FOREIGN KEY (org_id, aura_id, message_id) REFERENCES email_messages(org_id, aura_id, id),
  FOREIGN KEY (org_id, aura_id, message_id, recipient_id) REFERENCES email_message_recipients(org_id, aura_id, message_id, id),
  CHECK ((raw_payload_json IS NOT NULL AND raw_payload_r2_key IS NULL)
      OR (raw_payload_json IS NULL AND raw_payload_r2_key IS NOT NULL)),
  CHECK (raw_payload_json IS NULL OR length(CAST(raw_payload_json AS BLOB)) <= 65536)
);
```

## email_message_recipients

| Field | Type | Required | Default |
| --- | --- | --- | --- |
| `id` | TEXT | yes | — |
| `org_id` | TEXT | yes | — |
| `aura_id` | TEXT | yes | — |
| `message_id` | TEXT | yes | — |
| `kind` | TEXT | yes | — |
| `ordinal` | INTEGER | yes | — |
| `address` | TEXT | yes | — |
| `address_key` | TEXT | yes | — |
| `display_name` | TEXT | no | — |
| `contact_id` | TEXT | no | — |
| `delivery_status` | TEXT | no | — |
| `delivery_status_at` | TEXT | no | — |

Foreign keys:

- `(org_id, contact_id)` → `email_contacts(org_id, id)`.
- `(org_id, aura_id, message_id)` → `email_messages(org_id, aura_id, id)`.

Keys/checks:

```sql
CREATE TABLE email_message_recipients (
  id TEXT PRIMARY KEY NOT NULL,
  org_id TEXT NOT NULL,
  aura_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('to','cc','bcc')),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  address TEXT NOT NULL,
  address_key TEXT NOT NULL,
  display_name TEXT,
  contact_id TEXT,
  delivery_status TEXT CHECK (delivery_status IS NULL OR delivery_status IN ('accepted','delivered','bounced','complained','deferred','failed','rejected','unknown')),
  delivery_status_at TEXT,
  UNIQUE (org_id, aura_id, message_id, kind, ordinal),
  UNIQUE (org_id, aura_id, message_id, id),
  FOREIGN KEY (org_id, aura_id, message_id) REFERENCES email_messages(org_id, aura_id, id),
  FOREIGN KEY (org_id, contact_id) REFERENCES email_contacts(org_id, id)
);
```

## email_messages

| Field | Type | Required | Default |
| --- | --- | --- | --- |
| `id` | TEXT | yes | — |
| `org_id` | TEXT | yes | — |
| `aura_id` | TEXT | yes | — |
| `thread_id` | TEXT | yes | — |
| `email_address_id` | TEXT | yes | — |
| `address_assignment_id` | TEXT | yes | — |
| `direction` | TEXT | yes | — |
| `status` | TEXT | yes | — |
| `rfc_message_id` | TEXT | no | — |
| `provider` | TEXT | yes | `'cloudflare'` |
| `provider_message_id` | TEXT | no | — |
| `ingest_key` | TEXT | no | — |
| `send_idempotency_key` | TEXT | no | — |
| `envelope_from` | TEXT | no | — |
| `envelope_to` | TEXT | no | — |
| `from_address` | TEXT | yes | — |
| `from_name` | TEXT | no | — |
| `sender_contact_id` | TEXT | no | — |
| `reply_to_json` | TEXT | yes | `'[]'` |
| `subject` | TEXT | no | — |
| `body_storage` | TEXT | yes | `'inline'` |
| `body_text` | TEXT | no | — |
| `body_html` | TEXT | no | — |
| `body_r2_key` | TEXT | no | — |
| `body_size_bytes` | INTEGER | yes | `0` |
| `raw_mime_r2_key` | TEXT | no | — |
| `in_reply_to` | TEXT | no | — |
| `references_json` | TEXT | yes | `'[]'` |
| `sent_at` | TEXT | no | — |
| `received_at` | TEXT | no | — |
| `activity_at` | TEXT | yes | — |
| `created_at` | TEXT | yes | `strftime('%Y-%m-%dT%H:%M:%fZ','now')` |
| `reply_recipient_decision_json` | TEXT | no | — |
| `reply_recipient_reason` | TEXT | no | — |
| `reply_recipient_decided_at` | TEXT | no | — |

Foreign keys:

- `(org_id, sender_contact_id)` → `email_contacts(org_id, id)`.
- `(org_id, aura_id, email_address_id, address_assignment_id)` → `email_address_assignments(org_id, aura_id, address_id, id)`.
- `(org_id, aura_id, thread_id)` → `email_threads(org_id, aura_id, id)`.

Keys/checks:

```sql
CREATE TABLE email_messages (
  id TEXT PRIMARY KEY NOT NULL,
  org_id TEXT NOT NULL,
  aura_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  email_address_id TEXT NOT NULL,
  address_assignment_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('in','out')),
  status TEXT NOT NULL,
  rfc_message_id TEXT, -- Canonical parsed RFC header ID; NULL when missing/unavailable.
  provider TEXT NOT NULL DEFAULT 'cloudflare',
  provider_message_id TEXT,
  ingest_key TEXT, -- Stable inbound dedup key supplied by adapter, not an invented event ID.
  send_idempotency_key TEXT,
  envelope_from TEXT,
  envelope_to TEXT,
  from_address TEXT NOT NULL,
  from_name TEXT,
  sender_contact_id TEXT,
  reply_to_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(reply_to_json) AND json_type(reply_to_json) = 'array'),
  subject TEXT,
  body_storage TEXT NOT NULL DEFAULT 'inline' CHECK (body_storage IN ('inline','r2')),
  body_text TEXT,
  body_html TEXT,
  body_r2_key TEXT,
  body_size_bytes INTEGER NOT NULL DEFAULT 0 CHECK (body_size_bytes >= 0),
  raw_mime_r2_key TEXT,
  in_reply_to TEXT,
  references_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(references_json) AND json_type(references_json) = 'array'),
  sent_at TEXT,
  received_at TEXT,
  activity_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  reply_recipient_decision_json TEXT CHECK (reply_recipient_decision_json IS NULL OR (json_valid(reply_recipient_decision_json) AND json_type(reply_recipient_decision_json) = 'object')),
  reply_recipient_reason TEXT,
  reply_recipient_decided_at TEXT,
  UNIQUE (org_id, aura_id, id),
  UNIQUE (org_id, aura_id, thread_id, id),
  FOREIGN KEY (org_id, aura_id, thread_id) REFERENCES email_threads(org_id, aura_id, id),
  FOREIGN KEY (org_id, aura_id, email_address_id, address_assignment_id)
    REFERENCES email_address_assignments(org_id, aura_id, address_id, id),
  FOREIGN KEY (org_id, sender_contact_id) REFERENCES email_contacts(org_id, id),
  CHECK ((direction = 'in' AND status = 'received' AND received_at IS NOT NULL AND send_idempotency_key IS NULL)
      OR (direction = 'out' AND status IN ('draft','queued','sending','sent','failed','cancelled') AND received_at IS NULL AND send_idempotency_key IS NOT NULL)),
  CHECK (status <> 'sent' OR sent_at IS NOT NULL),
  CHECK ((body_storage = 'inline' AND body_r2_key IS NULL AND body_size_bytes <= 65536
          AND body_size_bytes = length(CAST(COALESCE(body_text,'') AS BLOB)) + length(CAST(COALESCE(body_html,'') AS BLOB)))
      OR (body_storage = 'r2' AND body_r2_key IS NOT NULL AND body_text IS NULL AND body_html IS NULL))
);
```

## email_reviews

| Field | Type | Required | Default |
| --- | --- | --- | --- |
| `id` | TEXT | yes | — |
| `org_id` | TEXT | yes | — |
| `aura_id` | TEXT | yes | — |
| `message_id` | TEXT | yes | — |
| `revision` | INTEGER | yes | — |
| `tier_applied` | TEXT | yes | — |
| `thread_review_epoch` | INTEGER | yes | `0` |
| `status` | TEXT | yes | `'pending'` |
| `approver_member_id` | TEXT | no | — |
| `edited_before_send` | INTEGER | yes | `0` |
| `reviewed_content_sha256` | TEXT | no | — |
| `reason` | TEXT | no | — |
| `requested_at` | TEXT | yes | `strftime('%Y-%m-%dT%H:%M:%fZ','now')` |
| `decided_at` | TEXT | no | — |
| `sent_at` | TEXT | no | — |

Foreign keys:

- `(org_id, approver_member_id)` → `studio_members(org_id, member_id)`.
- `(org_id, aura_id, message_id)` → `email_messages(org_id, aura_id, id)`.

Keys/checks:

```sql
CREATE TABLE email_reviews (
  id TEXT PRIMARY KEY NOT NULL,
  org_id TEXT NOT NULL,
  aura_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  tier_applied TEXT NOT NULL,
  thread_review_epoch INTEGER NOT NULL DEFAULT 0 CHECK (thread_review_epoch >= 0),
  -- Snapshot the parent thread review_epoch at request time. A reset increments it.
  -- The service must refuse stale approvals; this field does not implement tiers.
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','sent','superseded')),
  approver_member_id TEXT,
  edited_before_send INTEGER NOT NULL DEFAULT 0 CHECK (edited_before_send IN (0,1)),
  reviewed_content_sha256 TEXT, -- Hash of exact body/recipients/attachment revision approved.
  reason TEXT,
  requested_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  decided_at TEXT,
  sent_at TEXT,
  UNIQUE (org_id, aura_id, message_id, revision),
  FOREIGN KEY (org_id, aura_id, message_id) REFERENCES email_messages(org_id, aura_id, id),
  FOREIGN KEY (org_id, approver_member_id) REFERENCES studio_members(org_id, member_id),
  CHECK (status NOT IN ('approved','rejected','sent') OR (approver_member_id IS NOT NULL AND decided_at IS NOT NULL AND reviewed_content_sha256 IS NOT NULL)),
  CHECK (status <> 'sent' OR sent_at IS NOT NULL)
);
```

## email_threads

| Field | Type | Required | Default |
| --- | --- | --- | --- |
| `id` | TEXT | yes | — |
| `org_id` | TEXT | yes | — |
| `aura_id` | TEXT | yes | — |
| `subject` | TEXT | no | — |
| `first_message_id` | TEXT | no | — |
| `last_activity_at` | TEXT | yes | — |
| `inbox_status` | TEXT | yes | `'open'` |
| `current_tier` | TEXT | no | — |
| `tier_state` | TEXT | no | — |
| `state_version` | INTEGER | yes | `0` |
| `review_epoch` | INTEGER | yes | `0` |
| `review_reset_at` | TEXT | no | — |
| `review_reset_by_member_id` | TEXT | no | — |
| `created_at` | TEXT | yes | `strftime('%Y-%m-%dT%H:%M:%fZ','now')` |

Foreign keys:

- `(org_id, aura_id, id, first_message_id)` → `email_messages(org_id, aura_id, thread_id, id)`.
- `(org_id, review_reset_by_member_id)` → `studio_members(org_id, member_id)`.
- `(org_id, aura_id)` → `auras(org_id, id)`.

Keys/checks:

```sql
CREATE TABLE email_threads (
  id TEXT PRIMARY KEY NOT NULL,
  org_id TEXT NOT NULL,
  aura_id TEXT NOT NULL,
  subject TEXT,
  first_message_id TEXT,
  last_activity_at TEXT NOT NULL,
  inbox_status TEXT NOT NULL DEFAULT 'open' CHECK (inbox_status IN ('open','closed','archived')),
  current_tier TEXT, -- Opaque, nullable until E08/E09 tier contract is agreed.
  tier_state TEXT,
  state_version INTEGER NOT NULL DEFAULT 0 CHECK (state_version >= 0),
  review_epoch INTEGER NOT NULL DEFAULT 0 CHECK (review_epoch >= 0),
  review_reset_at TEXT,
  review_reset_by_member_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (org_id, aura_id, id),
  FOREIGN KEY (org_id, aura_id) REFERENCES auras(org_id, id),
  FOREIGN KEY (org_id, review_reset_by_member_id) REFERENCES studio_members(org_id, member_id),
  FOREIGN KEY (org_id, aura_id, id, first_message_id)
    REFERENCES email_messages(org_id, aura_id, thread_id, id)
);
```

## Explicit indexes and triggers

### idx_e07_auras_org_id

```sql
CREATE UNIQUE INDEX idx_e07_auras_org_id ON auras(org_id, id);
```

### idx_email_addresses_domain

```sql
CREATE INDEX idx_email_addresses_domain ON email_addresses(org_id, domain_id, status);
```

### idx_email_assignments_aura

```sql
CREATE INDEX idx_email_assignments_aura ON email_address_assignments(org_id, aura_id, ended_at);
```

### idx_email_assignments_current

```sql
CREATE UNIQUE INDEX idx_email_assignments_current ON email_address_assignments(org_id, address_id) WHERE ended_at IS NULL;
```

### idx_email_assignments_history

```sql
CREATE INDEX idx_email_assignments_history ON email_address_assignments(org_id, address_id, assigned_at);
```

### idx_email_contacts_member

```sql
CREATE INDEX idx_email_contacts_member ON email_contacts(org_id, member_id) WHERE member_id IS NOT NULL;
```

### idx_email_domains_default

```sql
CREATE UNIQUE INDEX idx_email_domains_default ON email_domains(org_id) WHERE kind = 'default_subdomain';
```

### idx_email_domains_status

```sql
CREATE INDEX idx_email_domains_status ON email_domains(org_id, status);
```

### idx_email_events_analytics

```sql
CREATE INDEX idx_email_events_analytics ON email_events(org_id, event_type, occurred_at, id);
```

### idx_email_events_message

```sql
CREATE INDEX idx_email_events_message ON email_events(org_id, aura_id, message_id, occurred_at, id);
```

### idx_email_messages_assignment

```sql
CREATE INDEX idx_email_messages_assignment ON email_messages(org_id, address_assignment_id, activity_at);
```

### idx_email_messages_inbox

```sql
CREATE INDEX idx_email_messages_inbox ON email_messages(org_id, aura_id, direction, status, activity_at DESC, id DESC);
```

### idx_email_messages_ingest

```sql
CREATE UNIQUE INDEX idx_email_messages_ingest ON email_messages(org_id, aura_id, ingest_key) WHERE ingest_key IS NOT NULL;
```

### idx_email_messages_provider

```sql
CREATE INDEX idx_email_messages_provider ON email_messages(provider, provider_message_id) WHERE provider_message_id IS NOT NULL;
```

### idx_email_messages_rfc

```sql
CREATE INDEX idx_email_messages_rfc ON email_messages(org_id, aura_id, rfc_message_id) WHERE rfc_message_id IS NOT NULL;
```

### idx_email_messages_send

```sql
CREATE UNIQUE INDEX idx_email_messages_send ON email_messages(org_id, aura_id, send_idempotency_key) WHERE send_idempotency_key IS NOT NULL;
```

### idx_email_messages_thread

```sql
CREATE INDEX idx_email_messages_thread ON email_messages(org_id, aura_id, thread_id, activity_at, id);
```

### idx_email_recipients_contact

```sql
CREATE INDEX idx_email_recipients_contact ON email_message_recipients(org_id, contact_id);
```

### idx_email_reviewers_active

```sql
CREATE INDEX idx_email_reviewers_active ON email_aura_reviewers(org_id, aura_id, member_id) WHERE revoked_at IS NULL;
```

### idx_email_reviewers_member

```sql
CREATE INDEX idx_email_reviewers_member ON email_aura_reviewers(org_id, member_id, revoked_at, aura_id);
```

### idx_email_reviews_pending

```sql
CREATE UNIQUE INDEX idx_email_reviews_pending ON email_reviews(org_id, aura_id, message_id) WHERE status = 'pending';
```

### idx_email_reviews_queue

```sql
CREATE INDEX idx_email_reviews_queue ON email_reviews(org_id, aura_id, status, requested_at DESC, id DESC);
```

### idx_email_threads_activity

```sql
CREATE INDEX idx_email_threads_activity ON email_threads(org_id, aura_id, last_activity_at DESC, id DESC);
```

### idx_email_threads_org_activity

```sql
CREATE INDEX idx_email_threads_org_activity ON email_threads(org_id, last_activity_at DESC, id DESC);
```

### idx_email_threads_status

```sql
CREATE INDEX idx_email_threads_status ON email_threads(org_id, aura_id, inbox_status, last_activity_at DESC, id DESC);
```

### idx_email_threads_tier

```sql
CREATE INDEX idx_email_threads_tier ON email_threads(org_id, aura_id, current_tier, last_activity_at DESC, id DESC);
```

### email_addresses_domain_match

```sql
CREATE TRIGGER email_addresses_domain_match BEFORE INSERT ON email_addresses
WHEN EXISTS (SELECT 1 FROM email_domains d WHERE d.org_id = NEW.org_id AND d.id = NEW.domain_id
  AND NEW.address_key <> NEW.local_part || '@' || d.domain_key)
BEGIN SELECT RAISE(ABORT, 'Address must match its registered domain'); END;
```

### email_addresses_identity_immutable

```sql
CREATE TRIGGER email_addresses_identity_immutable BEFORE UPDATE OF id, org_id, domain_id, local_part, address, address_key ON email_addresses
WHEN NEW.id IS NOT OLD.id OR NEW.org_id IS NOT OLD.org_id OR NEW.domain_id IS NOT OLD.domain_id
  OR NEW.local_part IS NOT OLD.local_part OR NEW.address IS NOT OLD.address OR NEW.address_key IS NOT OLD.address_key
BEGIN SELECT RAISE(ABORT, 'Address identity is immutable; reserve another address'); END;
```

### email_assignments_identity_immutable

```sql
CREATE TRIGGER email_assignments_identity_immutable BEFORE UPDATE ON email_address_assignments
WHEN NEW.id IS NOT OLD.id OR NEW.org_id IS NOT OLD.org_id OR NEW.aura_id IS NOT OLD.aura_id
  OR NEW.address_id IS NOT OLD.address_id OR NEW.assigned_at IS NOT OLD.assigned_at
  OR (OLD.ended_at IS NOT NULL AND NEW.ended_at IS NOT OLD.ended_at)
BEGIN SELECT RAISE(ABORT, 'Close an assignment and insert a new row; do not rewrite its history'); END;
```

### email_assignments_no_released_address

```sql
CREATE TRIGGER email_assignments_no_released_address BEFORE INSERT ON email_address_assignments
WHEN EXISTS (SELECT 1 FROM email_addresses WHERE org_id = NEW.org_id AND id = NEW.address_id AND status = 'released')
BEGIN SELECT RAISE(ABORT, 'Released addresses cannot be assigned under the current no-reuse policy'); END;
```

### email_assignments_overlap_insert

```sql
CREATE TRIGGER email_assignments_overlap_insert BEFORE INSERT ON email_address_assignments
WHEN EXISTS (SELECT 1 FROM email_address_assignments a WHERE a.org_id = NEW.org_id AND a.address_id = NEW.address_id
  AND NEW.assigned_at < COALESCE(a.ended_at, '9999-12-31T23:59:59.999Z')
  AND a.assigned_at < COALESCE(NEW.ended_at, '9999-12-31T23:59:59.999Z'))
BEGIN SELECT RAISE(ABORT, 'Address assignment intervals must not overlap'); END;
```

### email_assignments_overlap_update

```sql
CREATE TRIGGER email_assignments_overlap_update BEFORE UPDATE ON email_address_assignments
WHEN EXISTS (SELECT 1 FROM email_address_assignments a WHERE a.id <> OLD.id AND a.org_id = NEW.org_id AND a.address_id = NEW.address_id
  AND NEW.assigned_at < COALESCE(a.ended_at, '9999-12-31T23:59:59.999Z')
  AND a.assigned_at < COALESCE(NEW.ended_at, '9999-12-31T23:59:59.999Z'))
BEGIN SELECT RAISE(ABORT, 'Address assignment intervals must not overlap'); END;
```

### email_assignments_preserve_message_history

```sql
CREATE TRIGGER email_assignments_preserve_message_history BEFORE UPDATE OF ended_at ON email_address_assignments
WHEN NEW.ended_at IS NOT NULL AND EXISTS (
  SELECT 1 FROM email_messages m WHERE m.org_id = OLD.org_id AND m.address_assignment_id = OLD.id AND m.activity_at >= NEW.ended_at)
BEGIN SELECT RAISE(ABORT, 'Assignment end would exclude existing message history'); END;
```

### email_domains_identity_immutable

```sql
CREATE TRIGGER email_domains_identity_immutable BEFORE UPDATE OF id, org_id, domain_key ON email_domains
WHEN NEW.id IS NOT OLD.id OR NEW.org_id IS NOT OLD.org_id OR NEW.domain_key IS NOT OLD.domain_key
BEGIN SELECT RAISE(ABORT, 'Domain identity is immutable; register a new domain'); END;
```

### email_messages_assignment_time_insert

```sql
CREATE TRIGGER email_messages_assignment_time_insert BEFORE INSERT ON email_messages
WHEN EXISTS (SELECT 1 FROM email_address_assignments a WHERE a.id = NEW.address_assignment_id AND a.org_id = NEW.org_id
  AND (NEW.activity_at < a.assigned_at OR (a.ended_at IS NOT NULL AND NEW.activity_at >= a.ended_at)))
BEGIN SELECT RAISE(ABORT, 'Message activity is outside its address assignment interval'); END;
```

### email_messages_assignment_time_update

```sql
CREATE TRIGGER email_messages_assignment_time_update BEFORE UPDATE OF activity_at ON email_messages
WHEN EXISTS (SELECT 1 FROM email_address_assignments a WHERE a.id = NEW.address_assignment_id AND a.org_id = NEW.org_id
  AND (NEW.activity_at < a.assigned_at OR (a.ended_at IS NOT NULL AND NEW.activity_at >= a.ended_at)))
BEGIN SELECT RAISE(ABORT, 'Message activity is outside its address assignment interval'); END;
```

### email_messages_identity_immutable

```sql
CREATE TRIGGER email_messages_identity_immutable BEFORE UPDATE OF org_id, aura_id, thread_id, email_address_id, address_assignment_id, direction ON email_messages
WHEN NEW.org_id IS NOT OLD.org_id OR NEW.aura_id IS NOT OLD.aura_id OR NEW.thread_id IS NOT OLD.thread_id
  OR NEW.email_address_id IS NOT OLD.email_address_id OR NEW.address_assignment_id IS NOT OLD.address_assignment_id OR NEW.direction IS NOT OLD.direction
BEGIN SELECT RAISE(ABORT, 'Message scope and direction are immutable; use an explicit reconciliation migration'); END;
```

### email_reviews_outbound_insert

```sql
CREATE TRIGGER email_reviews_outbound_insert BEFORE INSERT ON email_reviews
WHEN EXISTS (SELECT 1 FROM email_messages WHERE id = NEW.message_id AND direction <> 'out')
BEGIN SELECT RAISE(ABORT, 'Email reviews require an outbound message'); END;
```

### email_reviews_outbound_update

```sql
CREATE TRIGGER email_reviews_outbound_update BEFORE UPDATE ON email_reviews
WHEN EXISTS (SELECT 1 FROM email_messages WHERE id = NEW.message_id AND direction <> 'out')
BEGIN SELECT RAISE(ABORT, 'Email reviews require an outbound message'); END;
```
