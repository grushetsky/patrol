-- Slice 4: evidence capture (docs/design/evidence-capture.md; ADRs 0002,
-- 0006, 0016, 0017, 0018). One capture is one fetch of one URL: a
-- captures queue row (the point, the attempts, the state), one evidence
-- row per attempt (immutable, content-addressed blobs aside), the
-- artifact manifest, and host objections with their clearance.

-- One queued evidentiary fetch for one capture point. The point identity
-- is (normalized_url, reason, point_key): point_key is the caller's token
-- for the event that wanted the capture — slice 5 passes the candidate
-- formation, the review open, or the notice approval; without one the
-- enqueue derives the freshness window's bucket, so a second operator
-- action inside the window deduplicates instead of re-fetching
-- ("One fetch per URL per capture point"). state 'skipped' records the
-- allowlist guard's decision to never fetch; skip_reason names why.
CREATE TABLE captures (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  requested_url text NOT NULL,
  normalized_url text NOT NULL,
  reason text NOT NULL CHECK (reason IN ('detection', 'review', 'pre_handoff')),
  point_key text NOT NULL,
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'running', 'done', 'failed', 'skipped')),
  skip_reason text CHECK (skip_reason IN ('allowlist', 'host_objection')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  requested_at timestamptz NOT NULL,
  last_attempt_at timestamptz,
  next_attempt_at timestamptz,
  finished_at timestamptz,
  evidence_id uuid,
  CHECK (state <> 'skipped' OR skip_reason IS NOT NULL),
  CHECK (state NOT IN ('done', 'failed', 'skipped') OR next_attempt_at IS NULL),
  CHECK (state NOT IN ('pending', 'running') OR finished_at IS NULL),
  CHECK (state <> 'skipped' OR evidence_id IS NULL),
  UNIQUE (normalized_url, reason, point_key)
);

CREATE INDEX captures_pending_idx ON captures (next_attempt_at) WHERE state = 'pending';
CREATE INDEX captures_url_idx ON captures (normalized_url, requested_at DESC);

-- One capture attempt of one URL (the contract's Evidence). Append-only:
-- the trigger below refuses every UPDATE except the purge markers, which
-- the retention role writes in slice 9 — a corrected capture is a new row,
-- never an edit (docs/design/evidence-capture.md "Immutability"). The
-- purge columns stand from day one so the retention job never alters the
-- table. failure_reason is exactly the complement of a captured outcome.
CREATE TABLE evidence (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  capture_id uuid NOT NULL,
  requested_url text NOT NULL,
  normalized_url text NOT NULL,
  final_url text,
  redirect_chain jsonb NOT NULL DEFAULT '[]'::jsonb,
  host text,
  host_source text CHECK (host_source IN ('landing_page', 'submitted_url')),
  reason text NOT NULL CHECK (reason IN ('detection', 'review', 'pre_handoff')),
  outcome text NOT NULL CHECK (outcome IN ('captured', 'dead', 'blocked', 'error')),
  http_status integer CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
  failure_reason text,
  attempt_number integer NOT NULL CHECK (attempt_number >= 1),
  observed_at timestamptz NOT NULL,
  capture_profile jsonb NOT NULL,
  purged_at timestamptz,
  purge_reason text,
  CHECK ((outcome = 'captured') = (failure_reason IS NULL)),
  CHECK ((host IS NULL) = (host_source IS NULL))
);

ALTER TABLE captures
  ADD CONSTRAINT captures_evidence_fk FOREIGN KEY (evidence_id) REFERENCES evidence (id);
ALTER TABLE evidence
  ADD CONSTRAINT evidence_capture_fk FOREIGN KEY (capture_id) REFERENCES captures (id);

CREATE INDEX evidence_capture_idx ON evidence (capture_id, attempt_number);
CREATE INDEX evidence_url_time_idx ON evidence (normalized_url, observed_at DESC);
CREATE INDEX evidence_outcome_idx ON evidence (normalized_url, observed_at DESC) WHERE outcome = 'captured';

-- One artifact one capture produced, keyed by the SHA-256 of its bytes,
-- which is also the object-store key. The same hash repeats across
-- captures that share bytes — that sharing is the dedup, so no unique
-- constraint exists on the hash. object_version pins the read to the
-- version the write observed (a delete marker must not hide a citation).
CREATE TABLE evidence_artifacts (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  evidence_id uuid NOT NULL REFERENCES evidence (id),
  kind text NOT NULL CHECK (
    kind IN ('response_body', 'response_headers', 'rendered_dom', 'screenshot', 'thumbnail', 'extraction_sidecar')
  ),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  size_bytes integer NOT NULL CHECK (size_bytes >= 0),
  content_type text NOT NULL,
  width integer CHECK (width IS NULL OR width >= 0),
  height integer CHECK (height IS NULL OR height >= 0),
  truncated boolean NOT NULL DEFAULT false,
  object_version text,
  UNIQUE (evidence_id, kind)
);

CREATE INDEX evidence_artifacts_sha_idx ON evidence_artifacts (sha256);

-- A recorded objection from a host — a cease-and-desist, a block notice,
-- or an abuse complaint naming Patrol — that suspends every capture of the
-- host until an operator clears it. At most one active objection per host;
-- the objection is never deleted, only cleared, and the triggers below
-- enforce both.
CREATE TABLE host_objections (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  host text NOT NULL,
  registrable_domain text NOT NULL,
  source text NOT NULL CHECK (source IN ('host_contact', 'operator')),
  reason text NOT NULL CHECK (length(btrim(reason)) > 0),
  recorded_at timestamptz NOT NULL,
  recorded_by uuid REFERENCES operators (id),
  affected_candidate_count integer NOT NULL DEFAULT 0 CHECK (affected_candidate_count >= 0),
  cleared_at timestamptz,
  cleared_by uuid REFERENCES operators (id),
  clearance_reason text,
  CHECK (cleared_at IS NULL OR cleared_by IS NOT NULL)
);

CREATE UNIQUE INDEX host_objections_one_active
  ON host_objections (host) WHERE cleared_at IS NULL;
CREATE INDEX host_objections_domain_idx
  ON host_objections (registrable_domain) WHERE cleared_at IS NULL;
CREATE INDEX host_objections_recorded_idx ON host_objections (recorded_at DESC);

-- Immutability (docs/design/evidence-capture.md "Immutability" #1): the
-- application appends; only the retention role writes, and the only
-- columns it may write on an evidence row are the purge markers.
CREATE FUNCTION patrol_evidence_never_rewrite() RETURNS trigger
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

CREATE TRIGGER evidence_immutable
  BEFORE UPDATE ON evidence
  FOR EACH ROW EXECUTE FUNCTION patrol_evidence_never_rewrite();

CREATE FUNCTION patrol_evidence_never_delete() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'evidence rows are never deleted; retention purges bytes and leaves the record (id %)', OLD.id
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER evidence_no_delete
  BEFORE DELETE ON evidence
  FOR EACH ROW EXECUTE FUNCTION patrol_evidence_never_delete();

-- Artifacts are the manifest of an immutable row; the bytes live in the
-- bucket keyed by the hash, so the row never changes and is never removed
-- (a purge keeps the manifest and marks the bytes gone).
CREATE FUNCTION patrol_evidence_artifacts_never_update() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'evidence artifact rows are never updated (id %)', OLD.id
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER evidence_artifacts_immutable
  BEFORE UPDATE ON evidence_artifacts
  FOR EACH ROW EXECUTE FUNCTION patrol_evidence_artifacts_never_update();

CREATE TRIGGER evidence_artifacts_no_delete
  BEFORE DELETE ON evidence_artifacts
  FOR EACH ROW EXECUTE FUNCTION patrol_evidence_never_delete();

-- An objection is never deleted; the only writable columns are the
-- clearance trio an operator's explicit decision records.
CREATE FUNCTION patrol_host_objections_never_delete() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'host objections are never deleted; clear one instead (id %)', OLD.id
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE FUNCTION patrol_host_objections_clearance_only() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.host IS DISTINCT FROM NEW.host
      OR OLD.registrable_domain IS DISTINCT FROM NEW.registrable_domain
      OR OLD.source IS DISTINCT FROM NEW.source
      OR OLD.reason IS DISTINCT FROM NEW.reason
      OR OLD.recorded_at IS DISTINCT FROM NEW.recorded_at
      OR OLD.recorded_by IS DISTINCT FROM NEW.recorded_by
      OR OLD.affected_candidate_count IS DISTINCT FROM NEW.affected_candidate_count THEN
    RAISE EXCEPTION 'host objections record what the host said and are never rewritten (id %)', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER host_objections_no_delete
  BEFORE DELETE ON host_objections
  FOR EACH ROW EXECUTE FUNCTION patrol_host_objections_never_delete();

CREATE TRIGGER host_objections_clearance_only
  BEFORE UPDATE ON host_objections
  FOR EACH ROW EXECUTE FUNCTION patrol_host_objections_clearance_only();
