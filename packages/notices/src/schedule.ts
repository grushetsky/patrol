import type { Pool } from "pg";
import type { Recipient } from "./statements.js";
import {
  ACTIVE_CITATION_STATES_SQL,
  composeInTransaction,
  type ComposeDeps,
} from "./compose.js";
import {
  compositionInterval,
  lastWindowOccurrence,
  previousWindowOccurrence,
} from "./window.js";

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
export type WindowSkipReason =
  | "paused"
  | "recipient_ineligible"
  | "template_absent"
  | "rights_holder_absent";

/** What one profile's window run did. */
export interface CompositionWindowOutcome {
  recipientProfileId: string;
  recipient: Recipient;
  windowAt: Date;
  composedNotices: number;
  skippedReason?: WindowSkipReason;
}

/** The scheduled runner: one pass over every scheduled profile. */
export async function runScheduledComposition(
  deps: ComposeDeps,
  log: (message: string, extra?: Record<string, unknown>) => void = () => undefined,
): Promise<CompositionWindowOutcome[]> {
  const profiles = await deps.pool.query<{
    id: string;
    recipient: Recipient;
    window_time: string;
    updated_by: string;
    paused: boolean;
  }>(
    `select id, recipient, window_time::text as window_time, updated_by, paused
     from recipient_profiles where composition_trigger = 'scheduled'
     order by recipient`,
  );
  const outcomes: CompositionWindowOutcome[] = [];
  for (const profile of profiles.rows) {
    const outcome = await runProfileWindow(deps, profile, log);
    if (outcome !== null) {
      outcomes.push(outcome);
    }
  }
  return outcomes;
}

interface ScheduledProfileRow {
  id: string;
  recipient: Recipient;
  window_time: string;
  updated_by: string;
  paused: boolean;
}

/**
 * One profile's most-recent-passed window, once. Returns null when the
 * window was already composed (the idempotent skip — not an outcome).
 */
async function runProfileWindow(
  deps: ComposeDeps,
  profile: ScheduledProfileRow,
  log: (message: string, extra?: Record<string, unknown>) => void,
): Promise<CompositionWindowOutcome | null> {
  const windowAt = lastWindowOccurrence(profile.window_time, deps.now());
  const client = await deps.pool.connect();
  try {
    await client.query("begin");
    // Serialize concurrent runs of the same profile's window: the loser of
    // this insert learns the window is already composed.
    const claimed = await client.query<{ recipient_profile_id: string }>(
      `insert into notice_composition_runs (recipient_profile_id, window_at)
       values ($1, $2)
       on conflict (recipient_profile_id, window_at) do nothing
       returning recipient_profile_id`,
      [profile.id, windowAt.toISOString()],
    );
    if (claimed.rows.length === 0) {
      await client.query("rollback");
      return null;
    }
    if (profile.paused) {
      // The rejection threshold's pause stops scheduled drafting only; the
      // window is consumed so the next attempt is the next window.
      await client.query(
        `update notice_composition_runs set skipped_reason = 'paused'
          where recipient_profile_id = $1 and window_at = $2`,
        [profile.id, windowAt.toISOString()],
      );
      await client.query("commit");
      log("submission.draft skipped a paused profile", {
        recipientProfileId: profile.id,
        windowAt: windowAt.toISOString(),
      });
      return {
        recipientProfileId: profile.id,
        recipient: profile.recipient,
        windowAt,
        composedNotices: 0,
        skippedReason: "paused",
      };
    }

    // The cut-off's start: the profile's last UNSKIPPED window — the last
    // one the profile actually composed from. A skipped window (paused,
    // ineligible) must not move the cut-off, or the interval it stood over
    // would fall out of every future window. A first run has none, so the
    // arithmetic previous occurrence stands in.
    const lastRun = await client.query<{ window_at: Date }>(
      `select window_at from notice_composition_runs
        where recipient_profile_id = $1 and window_at < $2 and skipped_reason is null
        order by window_at desc limit 1`,
      [profile.id, windowAt.toISOString()],
    );
    const previousWindow =
      lastRun.rows[0]?.window_at ?? previousWindowOccurrence(profile.window_time, windowAt);
    const { from, to } = compositionInterval(previousWindow, windowAt);

    // Violations confirmed inside the cut-off that no active notice cites.
    const due = await client.query<{ id: string }>(
      `select v.id from violations v
        where v.state = 'open'
          and v.confirmed_at > $1 and v.confirmed_at <= $2
          and not exists (
            select 1 from notice_citations c
              where c.violation_id = v.id and c.state in ${ACTIVE_CITATION_STATES_SQL}
          )
        order by v.confirmed_at, v.id`,
      [from.toISOString(), to.toISOString()],
    );

    // The compose runs INSIDE this transaction (composeInTransaction):
    // claiming the window took a KEY SHARE lock on the profile row, and a
    // second connection's compose would block on its own `for update` —
    // one transaction, one lock chain, no self-deadlock.
    const outcome = await composeInTransaction(client, deps.now, {
      recipient: profile.recipient,
      recipientProfileId: profile.id,
      violationIds: due.rows.map((row) => row.id),
      trigger: "scheduled",
      // No operator drives a window; the profile's last editor is the
      // administrator the notice records. The contract's createdBy is an
      // operator id, and the trigger_kind column carries the truth.
      composedBy: profile.updated_by,
    });

    let composedNotices = 0;
    let skippedReason: WindowSkipReason | undefined;
    if (outcome.status === "composed") {
      composedNotices = outcome.notices.length;
    } else if (outcome.refusal.status === "recipient_ineligible") {
      skippedReason = "recipient_ineligible";
    } else if (outcome.refusal.status === "template_absent") {
      skippedReason = "template_absent";
    } else if (outcome.refusal.status === "rights_holder_absent") {
      // Cannot happen behind the setup gate, but it is recorded truthfully
      // under its own name so the skip reads what happened.
      skippedReason = "rights_holder_absent";
    } else if (outcome.refusal.status === "empty_selection") {
      composedNotices = 0;
    } else {
      // Any other refusal (a profile whose recipient changed mid-window,
      // a violation that closed inside the transaction) is a skip worth a
      // log line, not a crash that would block the other profiles.
      log("submission.draft refused a profile's window", {
        recipientProfileId: profile.id,
        refusal: outcome.refusal.status,
      });
    }

    if (skippedReason !== undefined) {
      await client.query(
        `update notice_composition_runs set skipped_reason = $3
          where recipient_profile_id = $1 and window_at = $2`,
        [profile.id, windowAt.toISOString(), skippedReason],
      );
    }
    await client.query(
      `update notice_composition_runs set composed_notices = $3
        where recipient_profile_id = $1 and window_at = $2`,
      [profile.id, windowAt.toISOString(), composedNotices],
    );
    await client.query("commit");
    if (composedNotices > 0 || skippedReason !== undefined) {
      log("submission.draft ran a profile window", {
        recipientProfileId: profile.id,
        windowAt: windowAt.toISOString(),
        composedNotices,
        skippedReason,
      });
    }
    return {
      recipientProfileId: profile.id,
      recipient: profile.recipient,
      windowAt,
      composedNotices,
      ...(skippedReason === undefined ? {} : { skippedReason }),
    };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
