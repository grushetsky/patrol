-- Slice 8: dashboard and reporting (docs/design/dashboard-ui.md
-- "Dashboard", "Title chart"; implementation rules "Dashboard"). The
-- dashboard's read models run over the tables slices 2-7 already own, so
-- this migration adds only what the tracked-titles metric needs to answer
-- "not paused on that day" per day: the current-state column, the pause
-- history the chart derives its per-day answer from, and the indexes the
-- aggregations and the activity feed use at the design point.

-- When the running pause was stamped, so the catalogue can show "paused
-- since". Null while running; the pause path stamps it, the unpause path
-- clears it. It is CURRENT state only -- the history of past pauses lives
-- in title_pause_periods below, because a resume must not erase the
-- interval the title spent paused (a resumed title counts as tracked
-- again, but its paused days stay paused in the chart).
ALTER TABLE tracked_titles
  ADD COLUMN paused_at timestamptz;

UPDATE tracked_titles SET paused_at = '-infinity' WHERE paused;

-- One row per pause interval: opened when a title is paused, closed when
-- it resumes (resumed_at null = still paused). The tracked-titles metric
-- counts a title on a day only when no period covers that day, so a
-- pause-resume-pause history keeps every interval. Existing paused rows
-- open a period at the epoch -- "paused before any window", which reads as
-- paused on every day -- the only honest answer for history nobody
-- recorded.
CREATE TABLE title_pause_periods (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tracked_title_id uuid NOT NULL REFERENCES tracked_titles (id) ON DELETE CASCADE,
  paused_at timestamptz NOT NULL,
  resumed_at timestamptz,
  CHECK (resumed_at IS NULL OR resumed_at >= paused_at)
);

INSERT INTO title_pause_periods (tracked_title_id, paused_at)
SELECT id, '-infinity' FROM tracked_titles WHERE paused;

-- The chart's per-day probe reads one title's periods by title.
CREATE INDEX title_pause_periods_title_idx ON title_pause_periods (tracked_title_id);

-- The tracked-titles series walks the live (non-archived) catalogue day by
-- day keyed on the birth date, with the pause day as the drop-out filter.
CREATE INDEX tracked_titles_live_created_idx
  ON tracked_titles (created_at) WHERE merged_into_title_id IS NULL;

-- The titles-with-violations series expands each violation's open interval
-- of days from its detection; the resolved series reads the closure day.
-- Both are timestamptz ranges against plain btree indexes, so the day
-- predicates stay range-shaped (never casts on the column).
CREATE INDEX violations_detected_at_idx ON violations (detected_at);
CREATE INDEX violations_closed_at_idx ON violations (closed_at) WHERE closed_at IS NOT NULL;

-- The activity feed reads the newest finished events from four tables;
-- each source's timestamp leads its index so the merged feed's ORDER BY /
-- LIMIT 5 descends an index instead of sorting a full scan.
CREATE INDEX scans_finished_at_idx ON scans (finished_at DESC) WHERE finished_at IS NOT NULL;
CREATE INDEX review_decisions_decided_idx ON review_decisions (decided_at DESC);
CREATE INDEX notices_approved_at_idx ON notices (approved_at DESC) WHERE approved_at IS NOT NULL;
CREATE INDEX submissions_acknowledged_at_idx
  ON submissions (acknowledged_at DESC) WHERE acknowledged_at IS NOT NULL;
