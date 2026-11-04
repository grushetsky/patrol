-- Slice 3: the budget core — the quota ledger, reservations, and alerts
-- (docs/design/scan-scheduling.md "Quota accounting", ADR 0023). The
-- ledger, not the provider, is the budget authority: one row per engine
-- and UTC calendar month, its allowance snapshotted from the settings cap
-- when the month opened. Committed units are history: no code path
-- deletes a row or decrements a committed counter, so lowering a cap
-- never un-spends. Database-role guards against direct table writes
-- arrive with slice 9.

-- One engine's allowance for one UTC calendar month. allowance_units is
-- the snapshot taken when the month opened; a later cap change never
-- rewrites it — it is month history, not the spend authority. The
-- reservation path spends against the LIVE settings cap, so raising the
-- cap lets queued work run in the opened month, while lowering it refuses
-- new reservations without un-spending: the conditional update protects
-- what is already committed, and the month over its new cap reads as
-- exhausted until the next month or a raise. month_start is always the
-- first day of its month.
CREATE TABLE quota_ledger (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  engine text NOT NULL CHECK (engine IN ('google', 'bing', 'yandex')),
  month_start date NOT NULL,
  allowance_units integer NOT NULL CHECK (allowance_units >= 0),
  scan_reserved integer NOT NULL DEFAULT 0 CHECK (scan_reserved >= 0),
  scan_committed integer NOT NULL DEFAULT 0 CHECK (scan_committed >= 0),
  recheck_reserved integer NOT NULL DEFAULT 0 CHECK (recheck_reserved >= 0),
  recheck_committed integer NOT NULL DEFAULT 0 CHECK (recheck_committed >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (month_start = date_trunc('month', month_start)::date)
);

CREATE UNIQUE INDEX quota_ledger_engine_month_key ON quota_ledger (engine, month_start);
CREATE INDEX quota_ledger_month_idx ON quota_ledger (month_start, engine);

-- A scan's hold on a slice of an engine allowance: held, then committed,
-- released, or expired (the contract's ReservationState). month_start
-- pins the hold to the month it was made, so a scan that finishes after
-- midnight settles into the month it reserved. scan_id is the scans
-- table's key; scans arrive with slice 3b, so it stays nullable and
-- untyped until then, and one held hold per scan keeps a retry from
-- double-holding before its previous hold settles. created_at and
-- expires_at carry no database default: both come from the injected
-- clock (config.now), which the expiry sweep and the tests control.
CREATE TABLE budget_reservations (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  scan_id uuid,
  engine text NOT NULL CHECK (engine IN ('google', 'bing', 'yandex')),
  month_start date NOT NULL,
  bucket text NOT NULL CHECK (bucket IN ('scan', 'recheck')),
  units integer NOT NULL CHECK (units > 0),
  state text NOT NULL DEFAULT 'held'
    CHECK (state IN ('held', 'committed', 'released', 'expired')),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  settled_at timestamptz,
  committed_units integer CHECK (committed_units >= 0),
  released_units integer CHECK (released_units >= 0),
  CHECK (state <> 'committed' OR committed_units IS NOT NULL),
  CHECK (state NOT IN ('released', 'expired') OR released_units IS NOT NULL),
  CHECK (month_start = date_trunc('month', month_start)::date),
  CHECK (state = 'held' OR settled_at IS NOT NULL)
);

CREATE UNIQUE INDEX budget_reservations_one_held_per_scan
  ON budget_reservations (scan_id) WHERE state = 'held' AND scan_id IS NOT NULL;
CREATE INDEX budget_reservations_expiry_idx
  ON budget_reservations (expires_at) WHERE state = 'held';
CREATE INDEX budget_reservations_ledger_idx
  ON budget_reservations (engine, month_start);

ALTER TABLE budget_reservations
  ADD CONSTRAINT budget_reservations_ledger_fk
  FOREIGN KEY (engine, month_start) REFERENCES quota_ledger (engine, month_start);

-- An alert that has fired: exactly one row per threshold per engine per
-- month, so a spent bucket does not produce a message a minute. bucket is
-- null for the engine-level thresholds (the 75%-of-allowance warning and
-- the provider-balance critical) and carries the bucket for the 90% and
-- 100% thresholds; NULLS NOT DISTINCT makes those nulls equal in the key,
-- keeping fire-once exact for the engine-level rows too. The message is
-- composed at read time in the requesting operator's language, so no text
-- is stored.
CREATE TABLE budget_alerts (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  engine text NOT NULL CHECK (engine IN ('google', 'bing', 'yandex')),
  month_start date NOT NULL,
  threshold text NOT NULL
    CHECK (threshold IN ('warning', 'critical', 'exhausted', 'balance')),
  bucket text CHECK (bucket IN ('scan', 'recheck')),
  level text NOT NULL CHECK (level IN ('warning', 'critical')),
  percent_used real NOT NULL CHECK (percent_used >= 0),
  groups_not_scanned integer NOT NULL DEFAULT 0 CHECK (groups_not_scanned >= 0),
  fired_at timestamptz NOT NULL,
  CHECK ((threshold IN ('critical', 'exhausted')) = (bucket IS NOT NULL)),
  CHECK (month_start = date_trunc('month', month_start)::date)
);

CREATE UNIQUE INDEX budget_alerts_fire_once_key
  ON budget_alerts (engine, month_start, threshold, bucket) NULLS NOT DISTINCT;
CREATE INDEX budget_alerts_month_idx ON budget_alerts (month_start, fired_at);
