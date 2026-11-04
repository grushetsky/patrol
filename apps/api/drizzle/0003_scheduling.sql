CREATE TABLE IF NOT EXISTS scan (
  id text PRIMARY KEY,
  title_group_id text NOT NULL,
  engine text NOT NULL,
  trigger text NOT NULL,
  due_date text NOT NULL,
  requested_by text,
  tracked_title_id text,
  planned_queries int NOT NULL DEFAULT 0,
  query_plan text,
  state text NOT NULL,
  queued_at timestamptz NOT NULL,
  queued_reason text,
  started_at timestamptz,
  last_heartbeat_at timestamptz,
  finished_at timestamptz,
  issued_queries int,
  failure_reason text,
  failures text,
  created_at timestamptz NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS scan_identity_key
  ON scan (title_group_id, engine, due_date);

CREATE INDEX IF NOT EXISTS scan_queue_idx
  ON scan (engine, state, created_at);

CREATE TABLE IF NOT EXISTS scan_query (
  id text PRIMARY KEY,
  scan_id text NOT NULL,
  tracked_title_id text NOT NULL,
  locale text NOT NULL,
  kind text NOT NULL,
  text text NOT NULL,
  variant_id text,
  intent_phrase_text text,
  intent_phrase_version int,
  ordinal int NOT NULL
);

CREATE INDEX IF NOT EXISTS scan_query_scan_idx ON scan_query (scan_id, ordinal);

CREATE TABLE IF NOT EXISTS search_result (
  id text PRIMARY KEY,
  scan_id text NOT NULL,
  query_id text NOT NULL,
  engine text NOT NULL,
  url text NOT NULL,
  normalized_url text NOT NULL,
  rank int NOT NULL,
  title text NOT NULL,
  snippet text NOT NULL,
  locale text NOT NULL,
  territory text,
  observed_at timestamptz NOT NULL,
  raw_payload_ref text NOT NULL,
  host text NOT NULL,
  registrable_domain text NOT NULL,
  candidate_id text
);

CREATE INDEX IF NOT EXISTS search_result_scan_idx
  ON search_result (scan_id, query_id);

CREATE TABLE IF NOT EXISTS serp_payload (
  id text PRIMARY KEY,
  scan_id text NOT NULL,
  engine text NOT NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS budget_reservation (
  id text PRIMARY KEY,
  scan_id text NOT NULL,
  engine text NOT NULL,
  bucket text NOT NULL,
  units int NOT NULL,
  month_start text NOT NULL,
  state text NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  settled_at timestamptz,
  committed_units int,
  released_units int
);

CREATE INDEX IF NOT EXISTS budget_reservation_scan_idx
  ON budget_reservation (scan_id);

CREATE INDEX IF NOT EXISTS budget_reservation_state_idx
  ON budget_reservation (state, expires_at);

CREATE TABLE IF NOT EXISTS recheck_schedule (
  id text PRIMARY KEY,
  title_group_id text NOT NULL,
  engine text NOT NULL,
  rung int NOT NULL,
  started_at timestamptz NOT NULL,
  next_due_at timestamptz NOT NULL,
  active boolean NOT NULL,
  started_by_scan_id text,
  updated_at timestamptz NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS recheck_schedule_pair_key
  ON recheck_schedule (title_group_id, engine);

CREATE TABLE IF NOT EXISTS engine_route (
  engine text PRIMARY KEY,
  disabled_at timestamptz,
  disabled_reason text,
  last_probe_at timestamptz,
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS budget_alert (
  id text PRIMARY KEY,
  engine text NOT NULL,
  bucket text NOT NULL,
  threshold text NOT NULL,
  level text NOT NULL,
  percent_used real NOT NULL,
  message text NOT NULL,
  groups_not_scanned int NOT NULL,
  month_start text NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS budget_alert_key
  ON budget_alert (engine, bucket, threshold, month_start);

CREATE TABLE IF NOT EXISTS intent_phrase (
  id text PRIMARY KEY,
  locale text NOT NULL,
  text text NOT NULL,
  version int NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS intent_phrase_text_key
  ON intent_phrase (locale, text);

INSERT INTO acquisition_budget (engine, currency, monthly_cap_minor)
SELECT 'google', 'usd', 4800
 WHERE NOT EXISTS (SELECT 1 FROM acquisition_budget WHERE engine = 'google');
INSERT INTO acquisition_budget (engine, currency, monthly_cap_minor)
SELECT 'bing', 'usd', 0
 WHERE NOT EXISTS (SELECT 1 FROM acquisition_budget WHERE engine = 'bing');
INSERT INTO acquisition_budget (engine, currency, monthly_cap_minor)
SELECT 'yandex', 'usd', 1200
 WHERE NOT EXISTS (SELECT 1 FROM acquisition_budget WHERE engine = 'yandex');

INSERT INTO application_setting (key, value)
SELECT 'recheck_share_percent', '30'
 WHERE NOT EXISTS (SELECT 1 FROM application_setting WHERE key = 'recheck_share_percent');

INSERT INTO intent_phrase (id, locale, text, version) VALUES
  ('b0f2b2c0-0000-4000-8000-000000000001', 'ru', 'смотреть онлайн', 1),
  ('b0f2b2c0-0000-4000-8000-000000000002', 'ru', 'скачать', 1),
  ('b0f2b2c0-0000-4000-8000-000000000003', 'en', 'watch online', 1),
  ('b0f2b2c0-0000-4000-8000-000000000004', 'en', 'download', 1);

ALTER TABLE violation ADD COLUMN engine text;
ALTER TABLE violation ADD COLUMN title_group_id text;
ALTER TABLE violation ADD COLUMN started_by_scan_id text;

CREATE INDEX IF NOT EXISTS violation_scan_idx
  ON violation (title_group_id, engine, state);
