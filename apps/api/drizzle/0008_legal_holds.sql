CREATE TABLE IF NOT EXISTS legal_hold (
  id text PRIMARY KEY,
  reason text NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL,
  evidence_ids text NOT NULL,
  violation_ids text NOT NULL,
  notice_ids text NOT NULL,
  released_at timestamptz,
  released_by text,
  release_reason text
);

CREATE INDEX IF NOT EXISTS legal_hold_created_idx
  ON legal_hold (created_at DESC);

CREATE INDEX IF NOT EXISTS legal_hold_active_idx
  ON legal_hold (created_at DESC)
  WHERE released_at IS NULL;

CREATE INDEX IF NOT EXISTS evidence_purged_idx
  ON evidence (purged_at);

CREATE INDEX IF NOT EXISTS serp_payload_created_idx
  ON serp_payload (created_at);
