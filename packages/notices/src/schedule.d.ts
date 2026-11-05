import type { Recipient } from "./statements.js";
import { type ComposeDeps } from "./compose.js";
/**
 * The scheduled composition trigger (docs/design/notice-composition.md
 * "Composition triggers and windows"; implementation rules "Composition
 * triggers"): every profile with the scheduled trigger composes, at its own
 * daily window, the drafts for violations confirmed since the profile's
 * previous window. The window is a CUT-OFF, not a rolling queue — the
 * interval is (previous window, this window], so a violation confirmed
 * while the window stands open waits for the next one.
 *
 * The cron (worker `submission.draft`, daily at the 07:00 UTC default)
 * wakes this runner; each profile's own most-recent-passed window decides
 * what composes, and `notice_composition_runs` makes a window compose at
 * most once whatever the cron does. A worker that was down for days reads
 * the profile's last RECORDED window as the cut-off's start, so no day is
 * skipped; the reservation indexes keep the catch-up from double-noticing.
 *
 * A SKIPPED window (paused or ineligible) never moves the cut-off: the
 * start is the last run the profile actually composed from — a run with no
 * `skipped_reason` — so every interval a pause or an ineligibility stood
 * over folds into the first window that runs after the clearance, and a
 * violation confirmed during the pause composes then instead of falling
 * out of every future window.
 */
/** Why one profile's window composed nothing. */
export type WindowSkipReason = "paused" | "recipient_ineligible" | "template_absent" | "rights_holder_absent";
/** What one profile's window run did. */
export interface CompositionWindowOutcome {
    recipientProfileId: string;
    recipient: Recipient;
    windowAt: Date;
    composedNotices: number;
    skippedReason?: WindowSkipReason;
}
/** The scheduled runner: one pass over every scheduled profile. */
export declare function runScheduledComposition(deps: ComposeDeps, log?: (message: string, extra?: Record<string, unknown>) => void): Promise<CompositionWindowOutcome[]>;
