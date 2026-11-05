import type { Pool, PoolClient } from "pg";

/**
 * The profile pause (docs/design/notice-composition.md "Volume and accuracy
 * safeguards"; implementation rules "Profile pause"): a profile whose
 * `Rejected` plus `Failed` share exceeds 10% over its last twenty
 * submissions pauses SCHEDULED drafting — on demand stays available, so a
 * single bad batch never stops urgent work — and resumes only on an
 * administrator's explicit clearance (the settings route). This module is
 * the computation the submission write paths call; it never un-pauses on
 * its own, because the design's resume is the clearance, not a threshold
 * drifting back under.
 */

/** The rejection-share window and threshold the design fixes. */
export const PAUSE_WINDOW = 20;
export const PAUSE_THRESHOLD = 0.1;

/** The recorded pause reason's stable prefix. */
export const PAUSE_REASON_PREFIX = "rejection_threshold";

export interface PauseComputation {
  windowSize: number;
  rejected: number;
  failed: number;
  thresholdExceeded: boolean;
  paused: boolean;
}

/** Reads the profile's last-twenty outcome and the pause it implies. */
export async function readPauseComputation(
  pool: Pool | PoolClient,
  recipientProfileId: string,
): Promise<PauseComputation | null> {
  const profile = await pool.query<{ paused: boolean }>(
    "select paused from recipient_profiles where id = $1",
    [recipientProfileId],
  );
  if (profile.rows.length === 0) {
    return null;
  }
  const window = await pool.query<{ state: string }>(
    `select s.state from submissions s
      where s.recipient_profile_id = $1 and s.cancelled_at is null
      order by s.created_at desc, s.id desc
      limit ${PAUSE_WINDOW}`,
    [recipientProfileId],
  );
  const rejected = window.rows.filter((row) => row.state === "rejected").length;
  const failed = window.rows.filter((row) => row.state === "failed").length;
  const windowSize = window.rows.length;
  const thresholdExceeded = windowSize > 0 && (rejected + failed) / windowSize > PAUSE_THRESHOLD;
  return {
    windowSize,
    rejected,
    failed,
    thresholdExceeded,
    paused: profile.rows[0].paused,
  };
}

/**
 * Recomputes the profile's recent-submission counters and applies the
 * pause: the counters always refresh, the pause only ever SETS (never
 * clears) — the clearance route owns the resume. The scheduled runner
 * already reads `paused`; on-demand composition never does.
 */
export async function recomputeProfilePause(
  pool: Pool | PoolClient,
  now: () => Date,
  recipientProfileId: string,
): Promise<PauseComputation | null> {
  const computation = await readPauseComputation(pool, recipientProfileId);
  if (computation === null) {
    return null;
  }
  const reason = `${PAUSE_REASON_PREFIX}: ${computation.rejected + computation.failed} of the last ${computation.windowSize} submissions were rejected or failed, past the 10% share`;
  await pool.query(
    `update recipient_profiles set
        recent_window_size = $2,
        recent_rejected = $3,
        recent_failed = $4,
        paused = case when $5 then true else paused end,
        pause_reason = case when $5 and not paused then $6 else pause_reason end,
        updated_at = $7
      where id = $1`,
    [
      recipientProfileId,
      computation.windowSize,
      computation.rejected,
      computation.failed,
      computation.thresholdExceeded,
      reason,
      now().toISOString(),
    ],
  );
  return { ...computation, paused: computation.paused || computation.thresholdExceeded };
}
