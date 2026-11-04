CREATE INDEX IF NOT EXISTS violation_closed_idx
  ON violation (closed_at);

CREATE INDEX IF NOT EXISTS violation_detected_idx
  ON violation (detected_at);

CREATE INDEX IF NOT EXISTS scan_finished_idx
  ON scan (finished_at DESC);

CREATE INDEX IF NOT EXISTS review_decision_decided_idx
  ON review_decision (decided_at DESC);

CREATE INDEX IF NOT EXISTS notice_approved_idx
  ON notice (approved_at DESC);

CREATE INDEX IF NOT EXISTS notice_recipient_created_idx
  ON notice (recipient, created_at DESC);

CREATE INDEX IF NOT EXISTS submission_state_created_idx
  ON submission (state, created_at DESC);

CREATE INDEX IF NOT EXISTS submission_updated_idx
  ON submission (updated_at DESC);
