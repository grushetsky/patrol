ALTER TABLE recipient_profile ADD COLUMN form_url text;

CREATE TABLE IF NOT EXISTS notice_template (
  id text PRIMARY KEY,
  recipient text NOT NULL,
  language text NOT NULL,
  major int NOT NULL,
  hash text NOT NULL,
  statements text NOT NULL,
  source_urls text NOT NULL,
  accessed_at timestamptz NOT NULL,
  verified_by text,
  verified_at timestamptz,
  supersedes text,
  created_at timestamptz NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS notice_template_revision_key
  ON notice_template (recipient, language, major);

CREATE TABLE IF NOT EXISTS notice (
  id text PRIMARY KEY,
  recipient text NOT NULL,
  recipient_profile_id text NOT NULL,
  channel text NOT NULL,
  state text NOT NULL,
  template_version text NOT NULL,
  content text,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  approved_by text,
  approved_at timestamptz,
  rights_holder_snapshot text,
  signatory_snapshot text,
  profile_snapshot text,
  pack_language text,
  withdrawn_by text,
  withdrawn_at timestamptz,
  withdrawal_reason text,
  superseded_by text,
  superseded_at timestamptz,
  superseded_by_notice_id text,
  second_operator_check text
);

CREATE INDEX IF NOT EXISTS notice_state_idx ON notice (state, created_at DESC);
CREATE INDEX IF NOT EXISTS notice_profile_idx
  ON notice (recipient_profile_id, state);

CREATE TABLE IF NOT EXISTS notice_citation (
  notice_id text NOT NULL,
  violation_id text NOT NULL,
  evidence_ids text NOT NULL,
  cited_at timestamptz NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS notice_citation_key
  ON notice_citation (notice_id, violation_id);

CREATE INDEX IF NOT EXISTS notice_citation_violation_idx
  ON notice_citation (violation_id);

CREATE TABLE IF NOT EXISTS notice_work (
  notice_id text NOT NULL,
  tracked_title_id text NOT NULL,
  display_title text NOT NULL,
  release_year int NOT NULL,
  title_type text NOT NULL,
  authorized_example_url text
);

CREATE UNIQUE INDEX IF NOT EXISTS notice_work_key
  ON notice_work (notice_id, tracked_title_id);

CREATE TABLE IF NOT EXISTS notice_resolved_field (
  notice_id text NOT NULL,
  ordinal int NOT NULL,
  name text NOT NULL,
  value text NOT NULL,
  required boolean NOT NULL,
  max_length int
);

CREATE UNIQUE INDEX IF NOT EXISTS notice_resolved_field_key
  ON notice_resolved_field (notice_id, ordinal);

CREATE TABLE IF NOT EXISTS notice_statement (
  notice_id text NOT NULL,
  ordinal int NOT NULL,
  key text NOT NULL,
  text text NOT NULL,
  template_version text NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS notice_statement_key
  ON notice_statement (notice_id, key);

ALTER TABLE submission ADD COLUMN notice_id text;
ALTER TABLE submission ADD COLUMN channel text;
ALTER TABLE submission ADD COLUMN pack_language text;
ALTER TABLE submission ADD COLUMN attempt_count int NOT NULL DEFAULT 0;
ALTER TABLE submission ADD COLUMN pack_ref text;
ALTER TABLE submission ADD COLUMN pack_sha256 text;
ALTER TABLE submission ADD COLUMN pack_generated_at timestamptz;
ALTER TABLE submission ADD COLUMN cancelled_at timestamptz;
ALTER TABLE submission ADD COLUMN delivered_at timestamptz;
ALTER TABLE submission ADD COLUMN delivered_by text;
ALTER TABLE submission ADD COLUMN attestation text;
ALTER TABLE submission ADD COLUMN acknowledgement text;
ALTER TABLE submission ADD COLUMN failure text;
ALTER TABLE submission ADD COLUMN updated_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS submission_notice_key ON submission (notice_id);

CREATE TABLE IF NOT EXISTS notice_pack_artifact (
  submission_id text NOT NULL,
  kind text NOT NULL,
  file_name text NOT NULL,
  content_type text NOT NULL,
  byte_size int NOT NULL,
  sha256 text NOT NULL,
  object_key text NOT NULL,
  object_version text,
  created_at timestamptz NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS notice_pack_artifact_key
  ON notice_pack_artifact (submission_id, kind);
