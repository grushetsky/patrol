-- Slice 3b: scans, query plans, search results as provenance, query
-- failures with the retry schedule, the re-check ladder, the route state,
-- and the editable intent-phrase configuration
-- (docs/design/query-strategy.md, docs/design/scan-scheduling.md,
-- docs/design/serp-acquisition-route.md).

-- The intent phrases an operator edits without a release: two per
-- supported locale, each carrying the version a search result records.
-- Seeded lazily by the application on first read (migrations run before
-- any operator exists to record as the editor); editing bumps the version
-- so results stay reproducible against the phrase that issued them.
CREATE TABLE intent_phrases (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  language text NOT NULL,
  position integer NOT NULL CHECK (position >= 1),
  text text NOT NULL CHECK (length(btrim(text)) > 0),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at timestamptz NOT NULL,
  UNIQUE (language, position)
);

-- One execution of discovery for one title group on one engine. Idempotent
-- on (title_group_id, engine, due_date): a scheduler restart, a duplicate
-- wake-up, or a manual scan earlier the same day cannot produce a second
-- scan. trigger_kind is the contract's ScanTrigger (the SQL keyword
-- TRIGGER keeps its spelling out of column position). scan_time is the
-- group's slot snapshot; failure_reason serves both the queued-with-reason
-- state (budget_exhausted, route_unavailable) and the failed outcome.
-- tracked_title_id narrows an operator's manual request to one title.
-- created_at carries no database default: it is the request order manual
-- work is queued by, so it comes from the injected clock the tests
-- control.
CREATE TABLE scans (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  title_group_id uuid NOT NULL REFERENCES title_groups (id),
  tracked_title_id uuid REFERENCES tracked_titles (id),
  engine text NOT NULL CHECK (engine IN ('google', 'bing', 'yandex')),
  due_date date NOT NULL,
  trigger_kind text NOT NULL
    CHECK (trigger_kind IN ('scheduled', 'manual', 'recheck', 'manual_recheck')),
  scan_time time NOT NULL,
  state text NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued', 'running', 'succeeded', 'partial', 'failed')),
  failure_reason text CHECK (
    failure_reason IN ('budget_exhausted', 'route_unavailable', 'provider_error', 'worker_crash')
  ),
  created_by uuid REFERENCES operators (id),
  created_at timestamptz NOT NULL,
  started_at timestamptz,
  finished_at timestamptz,
  planned_queries integer NOT NULL DEFAULT 0 CHECK (planned_queries >= 0),
  issued_queries integer NOT NULL DEFAULT 0 CHECK (issued_queries >= 0),
  reserved_units integer CHECK (reserved_units >= 0),
  committed_units integer CHECK (committed_units >= 0),
  reservation_id uuid REFERENCES budget_reservations (id),
  CHECK (state = 'queued' OR started_at IS NOT NULL),
  CHECK (state IN ('queued', 'running') OR finished_at IS NOT NULL),
  CHECK (state <> 'failed' OR failure_reason IS NOT NULL),
  CHECK (state NOT IN ('succeeded', 'partial') OR failure_reason IS NULL)
);

CREATE UNIQUE INDEX scans_idempotency_key ON scans (title_group_id, engine, due_date);
CREATE INDEX scans_engine_state_idx ON scans (engine, state, created_at);
CREATE INDEX scans_group_idx ON scans (title_group_id, created_at DESC);
CREATE INDEX scans_due_date_idx ON scans (due_date);

-- The plan derived when a scan starts; no plan outlives its scan. The
-- queries are normalized rows so the read model joins without parsing.
CREATE TABLE query_plans (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  scan_id uuid NOT NULL UNIQUE REFERENCES scans (id),
  generated_at timestamptz NOT NULL
);

-- One query issued inside a scan (the contract's SearchQuery).
-- normalized_text is the plan's deduplication key; issued flips when the
-- query was handed to the adapter, so a partial run can be read exactly.
CREATE TABLE search_queries (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  query_plan_id uuid NOT NULL REFERENCES query_plans (id) ON DELETE CASCADE,
  tracked_title_id uuid NOT NULL REFERENCES tracked_titles (id),
  locale text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('variant', 'intent')),
  text text NOT NULL,
  normalized_text text NOT NULL,
  variant_id uuid REFERENCES title_variants (id),
  intent_phrase text,
  intent_phrase_version integer CHECK (
    intent_phrase_version IS NULL OR intent_phrase_version >= 1
  ),
  position integer NOT NULL CHECK (position >= 0),
  issued boolean NOT NULL DEFAULT false,
  issued_at timestamptz,
  CHECK (kind <> 'variant' OR variant_id IS NOT NULL),
  CHECK (kind <> 'intent' OR (intent_phrase IS NOT NULL AND intent_phrase_version IS NOT NULL)),
  UNIQUE (query_plan_id, normalized_text)
);

CREATE INDEX search_queries_plan_idx ON search_queries (query_plan_id, position);
CREATE INDEX search_queries_title_idx ON search_queries (tracked_title_id);

-- One ranked row a query returned: provenance, never evidence and never
-- edited. A trigger refuses every UPDATE on the table — the raw URL, rank,
-- and snippet are the observation the way the engine made it; corrections
-- are new rows from new queries. (Retention deletes whole rows under its
-- windows in slice 9; deletion is not an edit.) candidate_id stays an
-- untyped uuid until the candidates table arrives with slice 5.
CREATE TABLE search_results (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  scan_id uuid NOT NULL REFERENCES scans (id),
  query_id uuid NOT NULL REFERENCES search_queries (id),
  url text NOT NULL,
  normalized_url text NOT NULL,
  rank integer NOT NULL CHECK (rank >= 1),
  title text NOT NULL,
  snippet text NOT NULL DEFAULT '',
  locale text NOT NULL,
  territory text CHECK (territory ~ '^[A-Z]{2}$'),
  observed_at timestamptz NOT NULL,
  raw_payload_ref text NOT NULL,
  host text NOT NULL,
  registrable_domain text NOT NULL,
  candidate_id uuid
);

CREATE INDEX search_results_scan_idx ON search_results (scan_id, rank);
CREATE INDEX search_results_query_idx ON search_results (query_id);
CREATE INDEX search_results_normalized_idx ON search_results (normalized_url);

CREATE FUNCTION patrol_search_results_never_update() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'search_results rows are provenance and are never updated (id %)', OLD.id
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER search_results_immutable
  BEFORE UPDATE ON search_results
  FOR EACH ROW EXECUTE FUNCTION patrol_search_results_never_update();

-- One failed query inside a scan (the contract's QueryFailure): the
-- provider's error class, how many attempts it consumed, and the attempt
-- log recording the 1/5/15-minute retry schedule as it ran.
CREATE TABLE query_failures (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  scan_id uuid NOT NULL REFERENCES scans (id),
  query_id uuid NOT NULL REFERENCES search_queries (id),
  reason text NOT NULL,
  attempts integer NOT NULL CHECK (attempts >= 0),
  attempt_log jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL,
  UNIQUE (scan_id, query_id)
);

CREATE INDEX query_failures_scan_idx ON query_failures (scan_id);

-- The re-check ladder, one row per title group and engine. The continue
-- condition — any violation from the pair still open — is a pluggable
-- predicate in the worker; violations arrive with slice 5, so the default
-- predicate sees none and a ladder stops after rung three until that
-- slice wires the real query in.
CREATE TABLE recheck_schedules (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  title_group_id uuid NOT NULL REFERENCES title_groups (id),
  engine text NOT NULL CHECK (engine IN ('google', 'bing', 'yandex')),
  rung integer NOT NULL CHECK (rung >= 1),
  next_due_at timestamptz NOT NULL,
  active boolean NOT NULL DEFAULT true,
  anchored_scan_id uuid NOT NULL REFERENCES scans (id),
  updated_at timestamptz NOT NULL,
  UNIQUE (title_group_id, engine)
);

CREATE INDEX recheck_schedules_due_idx ON recheck_schedules (next_due_at) WHERE active;

-- One row per engine: whether the acquisition route is disabled and why,
-- and when the hourly probe next checks recovery. An authentication
-- failure, a revoked key, or an empty provider balance disables an
-- engine; the probe re-enables it.
CREATE TABLE route_state (
  engine text PRIMARY KEY CHECK (engine IN ('google', 'bing', 'yandex')),
  disabled boolean NOT NULL DEFAULT false,
  disabled_reason text CHECK (disabled_reason IN ('authentication', 'revoked_key', 'empty_balance')),
  disabled_at timestamptz,
  probe_next_at timestamptz,
  CHECK (disabled = (disabled_reason IS NOT NULL)),
  CHECK (NOT disabled OR disabled_at IS NOT NULL)
);

-- The reservations table's scan reference, promised as an untyped uuid in
-- 0003 until scans existed.
ALTER TABLE budget_reservations
  ADD CONSTRAINT budget_reservations_scan_fk
  FOREIGN KEY (scan_id) REFERENCES scans (id);
