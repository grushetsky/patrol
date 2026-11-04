CREATE TABLE IF NOT EXISTS evidence (
  id text PRIMARY KEY,
  tracked_title_id text,
  title_group_id text,
  requested_url text NOT NULL,
  normalized_requested_url text NOT NULL,
  redirect_chain text NOT NULL,
  final_url text,
  host text,
  host_source text,
  reason text NOT NULL,
  capture_point text,
  outcome text NOT NULL,
  http_status int,
  failure_reason text,
  attempt_number int NOT NULL,
  observed_at timestamptz NOT NULL,
  profile text NOT NULL,
  purged_at timestamptz,
  purge_reason text,
  created_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS evidence_url_idx
  ON evidence (normalized_requested_url, observed_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS evidence_capture_point_key
  ON evidence (normalized_requested_url, capture_point)
  WHERE capture_point IS NOT NULL;

CREATE INDEX IF NOT EXISTS evidence_host_idx
  ON evidence (host, observed_at DESC);

CREATE TABLE IF NOT EXISTS evidence_artifact (
  evidence_id text NOT NULL,
  kind text NOT NULL,
  sha256 text NOT NULL,
  byte_size int NOT NULL,
  content_type text NOT NULL,
  width int,
  height int,
  truncated boolean NOT NULL,
  object_key text NOT NULL,
  object_version text,
  created_at timestamptz NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS evidence_artifact_key
  ON evidence_artifact (evidence_id, kind, sha256);

CREATE INDEX IF NOT EXISTS evidence_artifact_sha_idx
  ON evidence_artifact (sha256);

CREATE TABLE IF NOT EXISTS host_objection (
  id text PRIMARY KEY,
  host text NOT NULL,
  registrable_domain text NOT NULL,
  reason text NOT NULL,
  source text NOT NULL,
  recorded_at timestamptz NOT NULL,
  recorded_by text,
  affected_candidate_count int NOT NULL,
  cleared_at timestamptz,
  cleared_by text,
  clearance_reason text
);

CREATE UNIQUE INDEX IF NOT EXISTS host_objection_active_key
  ON host_objection (host)
  WHERE cleared_at IS NULL;

CREATE INDEX IF NOT EXISTS host_objection_host_idx
  ON host_objection (host, recorded_at DESC);
