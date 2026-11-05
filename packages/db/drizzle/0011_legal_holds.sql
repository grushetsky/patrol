-- Slice 9: legal holds (docs/design/evidence-capture.md "Retention"; ADR
-- 0017) and the retention job's second purge marker. A hold — a dispute, a
-- counter-notice, a threatened claim, or an operator's own instruction —
-- outranks every other retention rule and is recorded with its reason, its
-- operator, and its release. The scopes are id arrays rather than join
-- tables because a hold is one operator act over a set of records, never a
-- per-record edge anything else walks; the retention job reads them with
-- ANY comparisons and nothing else writes them. A released hold stays
-- (spoliation defence wants the history of the hold itself), so rows are
-- never deleted and never rewritten after placement: only the release
-- trio is writable.
CREATE TABLE legal_holds (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  reason text NOT NULL CHECK (length(btrim(reason)) > 0),
  evidence_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  violation_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  notice_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  created_by uuid NOT NULL REFERENCES operators (id),
  created_at timestamptz NOT NULL,
  released_at timestamptz,
  released_by uuid REFERENCES operators (id),
  release_reason text,
  CHECK (released_at IS NULL OR released_by IS NOT NULL),
  CHECK (released_at IS NULL OR length(btrim(release_reason)) > 0),
  -- The contract requires at least one of the three scopes.
  CHECK (cardinality(evidence_ids) + cardinality(violation_ids) + cardinality(notice_ids) > 0)
);

CREATE INDEX legal_holds_active_idx ON legal_holds (created_at DESC) WHERE released_at IS NULL;
CREATE INDEX legal_holds_created_idx ON legal_holds (created_at DESC);

-- A hold is never deleted and its scope never changes; only the release
-- trio an administrator's explicit decision records is writable.
CREATE FUNCTION patrol_legal_holds_release_only() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.reason IS DISTINCT FROM NEW.reason
      OR OLD.evidence_ids IS DISTINCT FROM NEW.evidence_ids
      OR OLD.violation_ids IS DISTINCT FROM NEW.violation_ids
      OR OLD.notice_ids IS DISTINCT FROM NEW.notice_ids
      OR OLD.created_by IS DISTINCT FROM NEW.created_by
      OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'a legal hold''s scope is frozen at placement; only the release may be recorded (id %)', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER legal_holds_release_only
  BEFORE UPDATE ON legal_holds
  FOR EACH ROW EXECUTE FUNCTION patrol_legal_holds_release_only();

CREATE FUNCTION patrol_legal_holds_never_delete() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'legal holds are never deleted; release one instead (id %)', OLD.id
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER legal_holds_no_delete
  BEFORE DELETE ON legal_holds
  FOR EACH ROW EXECUTE FUNCTION patrol_legal_holds_never_delete();

-- The retention job's completion marker: purged_at says the bytes passed
-- their window (set FIRST — metadata before bytes, so an interrupted run
-- leaves orphaned bytes, never a dangling citation); bytes_purged_at says
-- the object versions the row owed have been deleted (set after the store
-- confirms). The gap between the two is exactly the re-runnable backlog a
-- monitoring query wants, and a crash inside it costs a repeat delete of
-- an already-deleted version, which the store answers with success.
ALTER TABLE evidence ADD COLUMN bytes_purged_at timestamptz;

CREATE INDEX evidence_purge_backlog_idx
  ON evidence (purged_at) WHERE purged_at IS NOT NULL AND bytes_purged_at IS NULL;

-- The immutability trigger from 0005 whitelisted the purge markers that
-- existed; the same whitelist grows by the completion marker, and the
-- function is replaced in place (CREATE OR REPLACE cannot drop a column
-- check, so it is re-declared whole).
CREATE OR REPLACE FUNCTION patrol_evidence_never_rewrite() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.requested_url IS DISTINCT FROM NEW.requested_url
      OR OLD.normalized_url IS DISTINCT FROM NEW.normalized_url
      OR OLD.final_url IS DISTINCT FROM NEW.final_url
      OR OLD.redirect_chain IS DISTINCT FROM NEW.redirect_chain
      OR OLD.host IS DISTINCT FROM NEW.host
      OR OLD.host_source IS DISTINCT FROM NEW.host_source
      OR OLD.reason IS DISTINCT FROM NEW.reason
      OR OLD.outcome IS DISTINCT FROM NEW.outcome
      OR OLD.http_status IS DISTINCT FROM NEW.http_status
      OR OLD.failure_reason IS DISTINCT FROM NEW.failure_reason
      OR OLD.attempt_number IS DISTINCT FROM NEW.attempt_number
      OR OLD.observed_at IS DISTINCT FROM NEW.observed_at
      OR OLD.capture_profile IS DISTINCT FROM NEW.capture_profile
      OR OLD.capture_id IS DISTINCT FROM NEW.capture_id THEN
    RAISE EXCEPTION 'evidence rows are immutable outside the purge markers (id %)', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
