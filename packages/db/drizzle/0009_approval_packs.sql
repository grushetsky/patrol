-- Slice 6b: approval, the handoff pack, and the pending submission
-- (docs/design/notice-composition.md "Approval", "The handoff pack",
-- "Re-verification before handoff"; ADR 0020; ADR 0021). Approval freezes
-- the content 0008's columns were waiting for; this migration adds what the
-- freeze needs beside them: the submission row the captures settle into, the
-- content-addressed pack record, the linkage that tells the settle watcher
-- which queued captures a notice is waiting on, the superseding OPERATOR
-- (0008 named only the replacement notice), the recorded second-operator
-- check, and the triggers that hold the freeze at the storage layer — the
-- notice's child rows refuse every mutation once it has left draft (the
-- citations' denormalized state mirror excepted), and the notices row's own
-- content columns refuse mutation under the same condition. What the
-- triggers do NOT hold: the lifecycle and administrative columns on the
-- notices row itself (state, actors, timestamps, the second-operator flag)
-- stay writable, because the state machine writes them by design.

-- The single delivery attempt of an approved notice. One row per notice,
-- ever (UNIQUE notice_id): a retry reuses the row and raises attempt_count,
-- and no operation creates a second delivery. Slice 6b creates the row in
-- state pending once the pre-handoff captures approval queued have settled
-- (the worker's settle hook writes DATABASE rows only — the deployment
-- topology grants the object store to the API, so the pack's BYTES are
-- built and stored from the API, idempotently, on the first pack read);
-- slice 7 owns the transitions (delivered, acknowledged, rejected, failed)
-- and fills the operator, delivery, and failure columns that stand nullable
-- here. cancelled_at marks the pending or failed row a withdrawal or
-- supersession cancelled so the notice can be re-drafted (a failed row is
-- still retryable, so a supersession must kill that path too).
CREATE TABLE submissions (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  notice_id uuid NOT NULL UNIQUE REFERENCES notices (id),
  recipient_profile_id uuid NOT NULL REFERENCES recipient_profiles (id),
  channel text NOT NULL CHECK (channel IN ('web_form', 'trusted_program')),
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'delivered', 'acknowledged', 'rejected', 'failed')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  -- The operator-facing handoff checklist's language, copied from the
  -- notice's approval_language (the approving operator's language, frozen
  -- the moment approval landed); a later preference change never rewrites
  -- the pack.
  pack_language text NOT NULL CHECK (pack_language IN ('en', 'ru')),
  -- Filled when the pack is generated; the pack row is the authority.
  pack_ref text,
  pack_sha256 text CHECK (pack_sha256 IS NULL OR pack_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  cancelled_at timestamptz,
  -- The delivery half (slice 7): nullable until an operator files.
  operator_id uuid REFERENCES operators (id),
  delivered_at timestamptz,
  decided_at timestamptz,
  failed_at timestamptz,
  failure_reason text,
  failure_note text,
  failure_recorded_at timestamptz,
  CHECK (state <> 'pending' OR (operator_id IS NULL AND delivered_at IS NULL
                                 AND decided_at IS NULL AND failed_at IS NULL
                                 AND failure_reason IS NULL AND failure_note IS NULL
                                 AND failure_recorded_at IS NULL)),
  -- The operator's attestation that the notice was filed as presented
  -- (contract Patrol.Domain.OperatorAttestation): written by the delivery
  -- and acknowledgement paths, cleared by a retry.
  attested_at timestamptz,
  statement_version text,
  -- What the recipient returned, in the contract's Acknowledgement shape
  -- (one object with the per-recipient fields present for its recipient).
  acknowledgement jsonb CHECK (acknowledgement IS NULL OR jsonb_typeof(acknowledgement) = 'object'),
  acknowledged_at timestamptz,
  -- Set once, at the third failed attempt, and never cleared: the row is
  -- flagged for an administrator, who decides whether to withdraw the
  -- notice or try again — nothing is cancelled automatically, and a
  -- successful retry does not un-flag history. The attempt counter and
  -- this flag are the two facts a retry KEEPS; every delivery, failure,
  -- and acknowledgement column is cleared for the fresh attempt.
  flagged_at timestamptz,
  -- When the operator last re-filed (retry) the same row.
  last_retried_at timestamptz,
  CHECK ((attested_at IS NULL) = (statement_version IS NULL)),
  CHECK (state <> 'pending' OR (attested_at IS NULL AND statement_version IS NULL
                                 AND acknowledgement IS NULL AND acknowledged_at IS NULL)),
  CHECK (state <> 'delivered' OR (operator_id IS NOT NULL AND delivered_at IS NOT NULL
                                   AND attested_at IS NOT NULL AND statement_version IS NOT NULL
                                   AND decided_at IS NULL AND failed_at IS NULL
                                   AND failure_reason IS NULL AND failure_note IS NULL
                                   AND failure_recorded_at IS NULL
                                   AND acknowledgement IS NULL AND acknowledged_at IS NULL)),
  CHECK (state <> 'acknowledged' OR (operator_id IS NOT NULL AND delivered_at IS NOT NULL
                                      AND attested_at IS NOT NULL AND statement_version IS NOT NULL
                                      AND acknowledgement IS NOT NULL AND acknowledged_at IS NOT NULL
                                      AND decided_at IS NULL AND failed_at IS NULL
                                      AND failure_reason IS NULL AND failure_note IS NULL
                                      AND failure_recorded_at IS NULL)),
  CHECK (state <> 'rejected' OR (operator_id IS NOT NULL AND decided_at IS NOT NULL
                                  AND failure_reason IS NOT NULL AND failure_note IS NOT NULL
                                  AND failure_recorded_at IS NOT NULL
                                  AND delivered_at IS NULL AND failed_at IS NULL
                                  AND attested_at IS NULL AND statement_version IS NULL
                                  AND acknowledgement IS NULL AND acknowledged_at IS NULL)),
  CHECK (state <> 'failed' OR (operator_id IS NOT NULL AND failed_at IS NOT NULL
                                AND failure_reason IS NOT NULL AND failure_note IS NOT NULL
                                AND failure_recorded_at IS NOT NULL
                                AND delivered_at IS NULL AND decided_at IS NULL
                                AND attested_at IS NULL AND statement_version IS NULL
                                AND acknowledgement IS NULL AND acknowledged_at IS NULL))
);

CREATE INDEX submissions_profile_idx ON submissions (recipient_profile_id, created_at DESC);
CREATE INDEX submissions_state_idx ON submissions (state);
-- The seven-day reminder and the olderThanDays backlog filter both scan
-- live pending rows by age; the list's default order is newest first.
CREATE INDEX submissions_created_idx ON submissions (created_at DESC);
CREATE INDEX submissions_pending_backlog_idx
  ON submissions (created_at) WHERE state = 'pending' AND cancelled_at IS NULL;

-- The frozen handoff pack (ADR 0020): generated once from the approved
-- notice, content-addressed in the evidence bucket under the packs prefix,
-- and never regenerated with different content — a pack that must change
-- means a superseded notice. `files` is the ordered manifest
-- [{name, sha256, size}] in artifact order; `hash` is the pack-level digest
-- over that manifest, so an identical rebuild lands on the identical row.
CREATE TABLE handoff_packs (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  notice_id uuid NOT NULL UNIQUE REFERENCES notices (id),
  content_key text NOT NULL,
  built_at timestamptz NOT NULL,
  built_by uuid NOT NULL REFERENCES operators (id),
  hash text NOT NULL CHECK (hash ~ '^[0-9a-f]{64}$'),
  -- The ordered manifest [{name, sha256, size}] in artifact order; the
  -- write path (packages/notices pack builder) is its only producer, so a
  -- CHECK cannot add anything a trigger would — Postgres refuses subqueries
  -- in CHECK constraints, and the array check below is the floor.
  files jsonb NOT NULL CHECK (jsonb_typeof(files) = 'array')
);

-- The pre-handoff captures approval queued, per notice: the settle watcher's
-- worklist. A URL whose enqueue came back fresh, refused, or skipped has no
-- row here — there is nothing to wait on, and the submission is created as
-- soon as every cited URL is in that state.
CREATE TABLE notice_pre_handoff_captures (
  notice_id uuid NOT NULL REFERENCES notices (id) ON DELETE CASCADE,
  capture_id uuid NOT NULL REFERENCES captures (id) ON DELETE CASCADE,
  queued_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (notice_id, capture_id)
);

CREATE INDEX notice_pre_handoff_captures_capture_idx
  ON notice_pre_handoff_captures (capture_id);

-- The seven-day reminder's durable half, in the budget alerts' fire-once
-- pattern (0003): exactly one row per submission the reminder has named,
-- held by the UNIQUE submission_id, so the second daily run that still
-- sees the backlog inserts nothing. The row stands exactly while the
-- submission stays a named, still-pending, overdue delivery — every
-- transition out of pending and the cancellation a withdrawal or
-- supersession writes delete it — so a re-filed submission that goes
-- overdue again is re-raised by the next run. Slice 8/9's dashboard badge
-- and reminder surfacing read this table; the backlog filter and the
-- remind job's log line name the same rows it does.
CREATE TABLE submission_alerts (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  submission_id uuid NOT NULL UNIQUE REFERENCES submissions (id) ON DELETE CASCADE,
  raised_at timestamptz NOT NULL
);

CREATE INDEX submission_alerts_raised_idx ON submission_alerts (raised_at);

-- The superseding OPERATOR (the person), beside 0008's
-- superseded_by_notice_id (the replacement). The contract's SupersededNotice
-- carries both; until a supersession runs the column stands null and the
-- read model rendered it so.
ALTER TABLE notices
  ADD COLUMN superseded_by uuid REFERENCES operators (id),
  ADD COLUMN second_operator_required boolean,
  -- The approving operator's interface language, read from their preference
  -- the moment approval lands and frozen on the row: the handoff pack's
  -- operator checklist renders in it whenever the pack is later built, so a
  -- preference change after approval never rewrites what the operator at
  -- handoff reads. Null until approval writes it.
  ADD COLUMN approval_language text
    CHECK (approval_language IS NULL OR approval_language IN ('en', 'ru'));

-- "An approved notice cannot be mutated" (implementation rules "Notices and
-- submissions / Approval"; acceptance "an approved notice cannot be
-- mutated"), held by the database: once a notice's state has left draft,
-- its statement, citation, work-identification, and resolved-field rows are
-- frozen. The ONE sanctioned write afterwards is the citations' denormalized
-- `state` mirror, which the withdrawal, supersession, and (in slice 7)
-- submission-outcome paths move to release or end the reservation — a
-- lifecycle fact, never a content fact. Everything else — an edited
-- evidence pin, a re-ordered field, a smuggled statement, a deleted work
-- identification — is refused, so "a later capture never changes its cited
-- captures" is true at the storage layer, not only in the write path.

-- The same freeze for the notices row itself. The trigger judges the OLD
-- row: the transition OUT of draft is approval's own write, which lands the
-- frozen content (the three snapshots, the pins) and the state flip in one
-- UPDATE, so it passes; from that moment every content column is frozen.
-- The columns the lifecycle owns — the state machine and its actor and
-- timestamp columns, the superseding operator, the second-operator flag,
-- updated_at — stay writable: withdrawal, supersession, and (in slice 7)
-- the submission outcomes write them by design, and they are lifecycle
-- facts, never content facts.
CREATE OR REPLACE FUNCTION patrol_freeze_notice_content() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state = 'draft' THEN
    RETURN NEW;
  END IF;
  IF NEW.recipient IS DISTINCT FROM OLD.recipient
     OR NEW.recipient_profile_id IS DISTINCT FROM OLD.recipient_profile_id
     OR NEW.channel IS DISTINCT FROM OLD.channel
     OR NEW.template_version IS DISTINCT FROM OLD.template_version
     OR NEW.language IS DISTINCT FROM OLD.language
     OR NEW.composed_at IS DISTINCT FROM OLD.composed_at
     OR NEW.composed_by IS DISTINCT FROM OLD.composed_by
     OR NEW.trigger_kind IS DISTINCT FROM OLD.trigger_kind
     OR NEW.rights_holder_snapshot IS DISTINCT FROM OLD.rights_holder_snapshot
     OR NEW.signatory_snapshot IS DISTINCT FROM OLD.signatory_snapshot
     OR NEW.profile_snapshot IS DISTINCT FROM OLD.profile_snapshot THEN
    RAISE EXCEPTION 'notice % has left draft: its content columns are frozen and cannot be mutated',
      OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER notices_content_frozen
  BEFORE UPDATE ON notices
  FOR EACH ROW EXECUTE FUNCTION patrol_freeze_notice_content();
CREATE OR REPLACE FUNCTION patrol_freeze_notice_children() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  parent_state text;
  notice_id uuid;
BEGIN
  notice_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.notice_id ELSE NEW.notice_id END;
  SELECT state INTO parent_state FROM notices WHERE id = notice_id;
  IF parent_state IS NULL OR parent_state = 'draft' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'notice_citations' THEN
    IF NEW.notice_id IS NOT DISTINCT FROM OLD.notice_id
       AND NEW.violation_id IS NOT DISTINCT FROM OLD.violation_id
       AND NEW.recipient_profile_id IS NOT DISTINCT FROM OLD.recipient_profile_id
       AND NEW.tracked_title_id IS NOT DISTINCT FROM OLD.tracked_title_id
       AND NEW.url IS NOT DISTINCT FROM OLD.url
       AND NEW.normalized_url IS NOT DISTINCT FROM OLD.normalized_url
       AND NEW.position IS NOT DISTINCT FROM OLD.position
       AND NEW.evidence IS NOT DISTINCT FROM OLD.evidence THEN
      -- The state-only mirror update the lifecycle paths write.
      RETURN NEW;
    END IF;
  END IF;

  RAISE EXCEPTION 'notice % is %: its % rows are frozen and cannot be mutated',
    notice_id, parent_state, TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER notice_citations_frozen
  BEFORE INSERT OR UPDATE OR DELETE ON notice_citations
  FOR EACH ROW EXECUTE FUNCTION patrol_freeze_notice_children();

CREATE TRIGGER notice_work_identifications_frozen
  BEFORE INSERT OR UPDATE OR DELETE ON notice_work_identifications
  FOR EACH ROW EXECUTE FUNCTION patrol_freeze_notice_children();

CREATE TRIGGER notice_statements_frozen
  BEFORE INSERT OR UPDATE OR DELETE ON notice_statements
  FOR EACH ROW EXECUTE FUNCTION patrol_freeze_notice_children();

CREATE TRIGGER notice_resolved_fields_frozen
  BEFORE INSERT OR UPDATE OR DELETE ON notice_resolved_fields
  FOR EACH ROW EXECUTE FUNCTION patrol_freeze_notice_children();
