-- AXI-19: additive. Cloudflare routing state for an address, kept apart from its lifecycle status.
-- An address with no row here was routed by hand before this table existed.
CREATE TABLE email_address_provisioning (
  org_id TEXT NOT NULL,
  address_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('provisioning_pending','active','failed')),
  worker_name TEXT NOT NULL,
  cloudflare_rule_id TEXT,
  failure_reason TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (org_id, address_id),
  FOREIGN KEY (org_id, address_id) REFERENCES email_addresses(org_id, id),
  CHECK (status <> 'active' OR cloudflare_rule_id IS NOT NULL),
  CHECK (status <> 'failed' OR failure_reason IS NOT NULL)
);
