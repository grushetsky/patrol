ALTER TABLE candidate ADD COLUMN url text;
ALTER TABLE candidate ADD COLUMN normalized_url text;
ALTER TABLE candidate ADD COLUMN final_url text;
ALTER TABLE candidate ADD COLUMN host text;
ALTER TABLE candidate ADD COLUMN registrable_domain text;
ALTER TABLE candidate ADD COLUMN source text;
ALTER TABLE candidate ADD COLUMN engine text;
ALTER TABLE candidate ADD COLUMN rank int;
ALTER TABLE candidate ADD COLUMN query_text text;
ALTER TABLE candidate ADD COLUMN locale text;
ALTER TABLE candidate ADD COLUMN territory text;
ALTER TABLE candidate ADD COLUMN matched_variant_id text;
ALTER TABLE candidate ADD COLUMN matched_variant text;
ALTER TABLE candidate ADD COLUMN score double precision;
ALTER TABLE candidate ADD COLUMN score_components text;
ALTER TABLE candidate ADD COLUMN reputation text;
ALTER TABLE candidate ADD COLUMN allowlist_entry_id text;
ALTER TABLE candidate ADD COLUMN first_observed_at timestamptz;
ALTER TABLE candidate ADD COLUMN last_observed_at timestamptz;
ALTER TABLE candidate ADD COLUMN review_decision_id text;
ALTER TABLE candidate ADD COLUMN violation_id text;
ALTER TABLE candidate ADD COLUMN confirmed_at timestamptz;
ALTER TABLE candidate ADD COLUMN dismissal text;
ALTER TABLE candidate ADD COLUMN dismissal_signals text;
ALTER TABLE candidate ADD COLUMN episode_max int;
ALTER TABLE candidate ADD COLUMN dismissal_episode_max int;
ALTER TABLE candidate ADD COLUMN dismissal_registrable_domain text;
ALTER TABLE candidate ADD COLUMN created_by text;
ALTER TABLE candidate ADD COLUMN created_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS candidate_pair_key
  ON candidate (normalized_url, tracked_title_id);

CREATE INDEX IF NOT EXISTS candidate_queue_idx
  ON candidate (state, score DESC, rank ASC, last_observed_at DESC);

CREATE INDEX IF NOT EXISTS candidate_host_idx ON candidate (host);
CREATE INDEX IF NOT EXISTS candidate_allowlist_idx
  ON candidate (allowlist_entry_id);

ALTER TABLE violation ADD COLUMN candidate_id text;
ALTER TABLE violation ADD COLUMN review_decision_id text;
ALTER TABLE violation ADD COLUMN url text;
ALTER TABLE violation ADD COLUMN normalized_url text;
ALTER TABLE violation ADD COLUMN host text;
ALTER TABLE violation ADD COLUMN host_source text;
ALTER TABLE violation ADD COLUMN registrable_domain text;
ALTER TABLE violation ADD COLUMN detected_at timestamptz;
ALTER TABLE violation ADD COLUMN confirmed_at timestamptz;
ALTER TABLE violation ADD COLUMN confirmed_by text;
ALTER TABLE violation ADD COLUMN predecessor_violation_id text;
ALTER TABLE violation ADD COLUMN closed_at timestamptz;
ALTER TABLE violation ADD COLUMN closure_reason text;
ALTER TABLE violation ADD COLUMN closure_evidence_id text;
ALTER TABLE violation ADD COLUMN closed_by text;
ALTER TABLE violation ADD COLUMN closure_note text;

CREATE UNIQUE INDEX IF NOT EXISTS violation_open_pair_key
  ON violation (normalized_url, tracked_title_id)
  WHERE state = 'open';

CREATE INDEX IF NOT EXISTS violation_state_idx
  ON violation (state, confirmed_at DESC);

CREATE INDEX IF NOT EXISTS violation_domain_idx
  ON violation (registrable_domain, confirmed_at DESC);

CREATE TABLE IF NOT EXISTS review_decision (
  id text PRIMARY KEY,
  candidate_id text NOT NULL,
  action text NOT NULL,
  operator_id text NOT NULL,
  decided_at timestamptz NOT NULL,
  note text,
  evidence_ids text NOT NULL,
  violation_id text,
  rematched_tracked_title_id text,
  proposed_allowlist_entry_id text,
  score_snapshot text,
  signals_snapshot text,
  episode_max int,
  registrable_domain text
);

CREATE INDEX IF NOT EXISTS review_decision_candidate_idx
  ON review_decision (candidate_id, decided_at DESC);

CREATE TABLE IF NOT EXISTS violation_evidence (
  violation_id text NOT NULL,
  evidence_id text NOT NULL,
  role text NOT NULL,
  cited_at timestamptz NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS violation_evidence_key
  ON violation_evidence (violation_id, evidence_id);

CREATE INDEX IF NOT EXISTS violation_evidence_evidence_idx
  ON violation_evidence (evidence_id);

CREATE TABLE IF NOT EXISTS capture_request (
  id text PRIMARY KEY,
  url text NOT NULL,
  normalized_url text NOT NULL,
  reason text NOT NULL,
  candidate_id text,
  violation_id text,
  tracked_title_id text,
  title_group_id text,
  capture_point text,
  state text NOT NULL,
  created_at timestamptz NOT NULL,
  queued_at timestamptz,
  finished_at timestamptz
);

CREATE INDEX IF NOT EXISTS capture_request_pending_idx
  ON capture_request (state, created_at);

CREATE TABLE IF NOT EXISTS blocklist (
  domain text PRIMARY KEY,
  reason text,
  added_at timestamptz NOT NULL
);
