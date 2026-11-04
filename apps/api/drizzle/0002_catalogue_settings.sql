CREATE TABLE IF NOT EXISTS title_group (
  id text PRIMARY KEY,
  name text NOT NULL,
  locales text NOT NULL,
  scan_time text NOT NULL,
  priority text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS title_group_name_idx ON title_group (name);

CREATE TABLE IF NOT EXISTS tracked_title (
  id text PRIMARY KEY,
  title_group_id text NOT NULL,
  release_year int NOT NULL,
  title_type text NOT NULL,
  runtime_minutes int,
  original_variant_id text,
  paused boolean NOT NULL DEFAULT false,
  merged_into_title_id text,
  source text NOT NULL,
  entered_by text NOT NULL,
  entered_at timestamptz NOT NULL,
  updated_by text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS tracked_title_group_idx
  ON tracked_title (title_group_id);

CREATE TABLE IF NOT EXISTS title_variant (
  id text PRIMARY KEY,
  tracked_title_id text NOT NULL,
  text text NOT NULL,
  normalized_text text NOT NULL,
  kind text NOT NULL,
  language text NOT NULL,
  script text NOT NULL,
  territory text,
  source text NOT NULL,
  added_by text NOT NULL,
  added_at timestamptz NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS title_variant_text_key
  ON title_variant (tracked_title_id, normalized_text);

CREATE TABLE IF NOT EXISTS external_identifier (
  id text PRIMARY KEY,
  tracked_title_id text NOT NULL,
  scheme text NOT NULL,
  value text NOT NULL,
  source text NOT NULL,
  retrieved_at timestamptz NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS external_identifier_scheme_value_key
  ON external_identifier (scheme, value);

CREATE TABLE IF NOT EXISTS allowlist_entry (
  id text PRIMARY KEY,
  kind text NOT NULL,
  match_kind text NOT NULL,
  value text NOT NULL,
  scope text NOT NULL,
  title_group_id text,
  tracked_title_id text,
  territory text,
  origin text NOT NULL,
  proposed_by_decision_id text,
  confirmed_by text NOT NULL,
  confirmed_at timestamptz NOT NULL,
  removed_by text,
  removed_at timestamptz
);

CREATE INDEX IF NOT EXISTS allowlist_entry_scope_idx
  ON allowlist_entry (scope, title_group_id, tracked_title_id);

CREATE TABLE IF NOT EXISTS acquisition_budget (
  engine text PRIMARY KEY,
  currency text NOT NULL,
  monthly_cap_minor int NOT NULL
);

CREATE TABLE IF NOT EXISTS application_setting (
  key text PRIMARY KEY,
  value text NOT NULL
);

CREATE TABLE IF NOT EXISTS quota_ledger (
  id text PRIMARY KEY,
  engine text NOT NULL,
  month_start text NOT NULL,
  allowance_units int NOT NULL,
  scan_reserved int NOT NULL,
  scan_committed int NOT NULL,
  recheck_reserved int NOT NULL,
  recheck_committed int NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS quota_ledger_month_engine_key
  ON quota_ledger (engine, month_start);

CREATE TABLE IF NOT EXISTS recipient_profile (
  id text PRIMARY KEY,
  recipient text NOT NULL,
  channel text NOT NULL,
  account text NOT NULL,
  contact_email text,
  composition_trigger text NOT NULL,
  window_time text,
  eligible_territories text NOT NULL,
  max_urls_per_notice int,
  max_urls_per_file int,
  max_urls_per_day int,
  last_observed_max_urls_per_file int,
  last_observed_daily_quota int,
  paused boolean NOT NULL DEFAULT false,
  pause_reason text,
  version int NOT NULL,
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL,
  cleared_by text,
  cleared_at timestamptz,
  clearance_reason text
);

CREATE UNIQUE INDEX IF NOT EXISTS recipient_profile_recipient_key
  ON recipient_profile (recipient);

CREATE TABLE IF NOT EXISTS submission (
  id text PRIMARY KEY,
  recipient_profile_id text NOT NULL,
  state text NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS submission_profile_idx
  ON submission (recipient_profile_id, created_at);

CREATE TABLE IF NOT EXISTS candidate (
  id text PRIMARY KEY,
  tracked_title_id text NOT NULL,
  state text NOT NULL
);

CREATE INDEX IF NOT EXISTS candidate_title_idx ON candidate (tracked_title_id);

CREATE TABLE IF NOT EXISTS violation (
  id text PRIMARY KEY,
  tracked_title_id text NOT NULL,
  state text NOT NULL
);

CREATE INDEX IF NOT EXISTS violation_title_idx ON violation (tracked_title_id);
