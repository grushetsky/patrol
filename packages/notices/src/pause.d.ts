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
export declare const PAUSE_WINDOW = 20;
export declare const PAUSE_THRESHOLD = 0.1;
/** The recorded pause reason's stable prefix. */
export declare const PAUSE_REASON_PREFIX = "rejection_threshold";
export interface PauseComputation {
    windowSize: number;
    rejected: number;
    failed: number;
    thresholdExceeded: boolean;
    paused: boolean;
}
/** Reads the profile's last-twenty outcome and the pause it implies. */
export declare function readPauseComputation(pool: Pool | PoolClient, recipientProfileId: string): Promise<PauseComputation | null>;
/**
 * Recomputes the profile's recent-submission counters and applies the
 * pause: the counters always refresh, the pause only ever SETS (never
 * clears) — the clearance route owns the resume. The scheduled runner
 * already reads `paused`; on-demand composition never does.
 */
export declare function recomputeProfilePause(pool: Pool | PoolClient, now: () => Date, recipientProfileId: string): Promise<PauseComputation | null>;
