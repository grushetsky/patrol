-- Slice 5b: review decisions and violations (docs/design/matching-and-
-- classification-rules.md "Review decisions", "Dismissal and reopening";
-- contract Patrol.Domain.ReviewDecision / Violation / ViolationEvidence).
-- A review decision is one operator disposition of one candidate: the five
-- actions, the evidence the operator relied on, and the title an
-- authorized-here or wrong-work decision names. A violation is created only
-- from a confirmed candidate, keyed by (normalized URL, tracked title) with
-- at most one open row per pair, and cites at least one pinned capture.

-- Review decisions are immutable: they are the audit record a reproduction
-- of a score or a defence of a notice reads back. The wrong-work remap and
-- the authorized-here proposal carry their targets here, not on the
-- candidate: the candidate's dismissal column holds the contract's Dismissal
-- projection, this row holds the facts every later reader needs.
CREATE TABLE review_decisions (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  candidate_id uuid NOT NULL REFERENCES candidates (id),
  operator_id uuid NOT NULL REFERENCES operators (id),
  action text NOT NULL CHECK (
    action IN ('violation', 'not_a_violation', 'wrong_work', 'authorized_here', 'page_dead')
  ),
  decided_at timestamptz NOT NULL,
  -- The captures the operator cited, pinned at decision time. Each id names
  -- an evidence row of the candidate's URL; the array can be empty only in
  -- the database's permissive sense -- the application guard refuses a
  -- decision with no evidence (evidence_required).
  evidence_ids uuid[] NOT NULL DEFAULT '{}',
  -- The correct tracked title, required when the action is wrong work.
  rematched_tracked_title_id uuid REFERENCES tracked_titles (id),
  -- The allowlist entry the decision proposed, set for authorized here.
  proposed_allowlist_entry_id uuid,
  -- The violation a confirm created, set only for the violation action.
  violation_id uuid,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (action <> 'wrong_work' OR rematched_tracked_title_id IS NOT NULL),
  CHECK (action <> 'authorized_here' OR proposed_allowlist_entry_id IS NOT NULL),
  CHECK (action <> 'violation' OR violation_id IS NOT NULL),
  CHECK (action <> 'violation' OR rematched_tracked_title_id IS NULL)
);

-- The pair's decision history, newest first, for the queue's prior-decision
-- flag and the detail's decision list.
CREATE INDEX review_decisions_candidate_idx
  ON review_decisions (candidate_id, decided_at DESC);

-- Violations: keyed by URL and tracked title, one open row per pair
-- (INVARIANTS.md "Relational rules"). Identity columns are frozen at
-- confirmation; only the lifecycle columns (state and the closure quartet)
-- ever change, and only forward: open -> removed or closed, both terminal.
-- A reappearing URL creates a new row linked through
-- predecessor_violation_id; no row ever returns to open.
CREATE TABLE violations (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tracked_title_id uuid NOT NULL REFERENCES tracked_titles (id),
  candidate_id uuid NOT NULL REFERENCES candidates (id),
  review_decision_id uuid NOT NULL REFERENCES review_decisions (id),
  url text NOT NULL,
  normalized_url text NOT NULL,
  host text NOT NULL,
  host_source text NOT NULL CHECK (host_source IN ('landing_page', 'submitted_url')),
  registrable_domain text NOT NULL,
  -- When the pair was first observed; the candidate's first_observed_at.
  detected_at timestamptz NOT NULL,
  confirmed_at timestamptz NOT NULL,
  confirmed_by uuid NOT NULL REFERENCES operators (id),
  predecessor_violation_id uuid REFERENCES violations (id),
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'removed', 'closed')),
  -- Equal to confirmed_at: a violation enters open by being confirmed.
  opened_at timestamptz NOT NULL,
  closed_at timestamptz,
  closure_reason text CHECK (closure_reason IN ('url_removed', 'operator_closed')),
  closure_note text,
  -- The capture that showed the URL gone; the newest capture at removal,
  -- retained with the reason (implementation rules "Violations / Removal").
  closure_evidence_id uuid REFERENCES evidence (id),
  closed_by uuid REFERENCES operators (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (state = 'open' OR closed_at IS NOT NULL),
  CHECK (
    state <> 'open'
    OR (
      closed_at IS NULL AND closure_reason IS NULL AND closure_note IS NULL
      AND closure_evidence_id IS NULL AND closed_by IS NULL
    )
  ),
  CHECK (state <> 'removed' OR closure_reason = 'url_removed'),
  CHECK (
    state <> 'closed'
    OR (closure_reason = 'operator_closed' AND closed_by IS NOT NULL AND closure_note IS NOT NULL)
  )
);

-- The one-open-per-pair invariant (INVARIANTS.md). A second confirm of the
-- same pair while one stands open loses here; a reappearance confirms only
-- after the earlier row left the open state.
CREATE UNIQUE INDEX violations_open_pair_uniq
  ON violations (normalized_url, tracked_title_id) WHERE state = 'open';

-- The violations screen groups by tracked title; reputation counts by
-- registrable domain; the worker's removal hook and the read models look
-- the URL up directly.
CREATE INDEX violations_title_state_idx ON violations (tracked_title_id, state);
CREATE INDEX violations_domain_idx ON violations (registrable_domain, state);
CREATE INDEX violations_state_idx ON violations (state);
CREATE INDEX violations_url_idx ON violations (normalized_url);
CREATE INDEX violations_host_idx ON violations (host);
CREATE INDEX violations_confirmed_idx ON violations (confirmed_at DESC);

-- The citations: which captures a violation relies on, with the object
-- versions the artifacts pinned at citation time. A citation is never
-- rewritten; a later capture is a new evidence row and a new citation.
CREATE TABLE violation_evidence (
  violation_id uuid NOT NULL REFERENCES violations (id),
  evidence_id uuid NOT NULL REFERENCES evidence (id),
  -- Why the cited capture was taken (the contract's CitedEvidence.role).
  role text NOT NULL CHECK (role IN ('detection', 'review', 'pre_handoff')),
  cited_at timestamptz NOT NULL,
  -- The artifact versions frozen at citation: one {kind, sha256,
  -- objectVersion} per artifact. The evidence row is immutable, but the
  -- store's version ids are the stronger pin, so the citation carries them.
  pinned_versions jsonb NOT NULL,
  PRIMARY KEY (violation_id, evidence_id)
);

CREATE INDEX violation_evidence_evidence_idx ON violation_evidence (evidence_id);

-- The candidate columns slice 5b adds: the page facts the worker's rescore
-- last saw (the episode count and the landing registrable domain of the
-- newest capture) and the snapshot a dismissal freezes for the
-- material-change detector (a new strong signal, an expanded episode range,
-- a different landing registrable domain).
ALTER TABLE candidates
  ADD COLUMN last_page_facts jsonb,
  ADD COLUMN material_snapshot jsonb;

-- Reappearance (ADR 0001): a URL that reappears after a violation left the
-- open state surfaces as a NEW candidate for the same pair, whose confirm
-- is a new violation linked to its predecessor. A confirmed candidate is
-- the terminal record of one wave, so the pair's uniqueness narrows to the
-- live rows — at most one pending or dismissed candidate per pair stands,
-- while a pair's confirmed history accumulates one row per wave. The
-- full uniqueness 0006 shipped is replaced in place; a destructive change
-- to data this never is (no row violates the narrower key).
ALTER TABLE candidates
  DROP CONSTRAINT candidates_normalized_url_tracked_title_id_key;
CREATE UNIQUE INDEX candidates_live_pair_uniq
  ON candidates (normalized_url, tracked_title_id) WHERE state <> 'confirmed';

-- A decision is never rewritten; a correction is a new decision on the pair.
CREATE OR REPLACE FUNCTION patrol_review_decisions_never_update() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'review_decisions are immutable (id %)', OLD.id
    USING ERRCODE = 'restrict_violation';
END;
$$;
CREATE TRIGGER review_decisions_never_update
  BEFORE UPDATE ON review_decisions
  FOR EACH ROW EXECUTE FUNCTION patrol_review_decisions_never_update();

-- A citation is never rewritten either: what a violation claimed about a
-- capture stays claimable exactly as it was cited.
CREATE OR REPLACE FUNCTION patrol_violation_evidence_never_update() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'violation_evidence rows are immutable (violation %)', OLD.violation_id
    USING ERRCODE = 'restrict_violation';
END;
$$;
CREATE TRIGGER violation_evidence_never_update
  BEFORE UPDATE ON violation_evidence
  FOR EACH ROW EXECUTE FUNCTION patrol_violation_evidence_never_update();

-- A violation's identity is frozen at confirmation; only the lifecycle
-- columns move, and only forward out of open: one update, open -> removed
-- or open -> closed, and a terminal row never changes again. The trigger
-- keeps the invariant one enforcement point, the same contract the
-- search-results trigger holds.
CREATE OR REPLACE FUNCTION patrol_violations_lifecycle_only() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.id IS DISTINCT FROM NEW.id
      OR OLD.tracked_title_id IS DISTINCT FROM NEW.tracked_title_id
      OR OLD.candidate_id IS DISTINCT FROM NEW.candidate_id
      OR OLD.review_decision_id IS DISTINCT FROM NEW.review_decision_id
      OR OLD.url IS DISTINCT FROM NEW.url
      OR OLD.normalized_url IS DISTINCT FROM NEW.normalized_url
      OR OLD.host IS DISTINCT FROM NEW.host
      OR OLD.host_source IS DISTINCT FROM NEW.host_source
      OR OLD.registrable_domain IS DISTINCT FROM NEW.registrable_domain
      OR OLD.detected_at IS DISTINCT FROM NEW.detected_at
      OR OLD.confirmed_at IS DISTINCT FROM NEW.confirmed_at
      OR OLD.confirmed_by IS DISTINCT FROM NEW.confirmed_by
      OR OLD.predecessor_violation_id IS DISTINCT FROM NEW.predecessor_violation_id
      OR OLD.opened_at IS DISTINCT FROM NEW.opened_at
      OR (OLD.state = 'open' AND NEW.state IN ('removed', 'closed')) = false THEN
    RAISE EXCEPTION 'violation identity is frozen and lifecycle moves only forward out of open (id %)', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER violations_lifecycle_only
  BEFORE UPDATE ON violations
  FOR EACH ROW EXECUTE FUNCTION patrol_violations_lifecycle_only();
