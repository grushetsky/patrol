import type { Pool } from "pg";
import {
  RESERVATION_TTL_MS,
  evaluateBudgetAlerts,
  expireReservations,
  rollOverMonth,
} from "@patrol/budget";
import {
  deliverBudgetAlertEmail,
  deliverSubmissionReminderEmail,
  type MailTransport,
} from "@patrol/mail";
import {
  duePendingCaptureIds,
  reapStaleRunningCaptures,
  runRetentionPurge,
  type RetentionStore,
} from "@patrol/evidence";
import {
  raiseSubmissionAlerts,
  REMINDER_DAYS,
  runScheduledComposition,
} from "@patrol/notices";
import { CAPTURE_QUEUE_NAME, ENGINE_QUEUE_NAMES } from "@patrol/domain";
import type PgBoss from "pg-boss";
import type { SerpAcquisitor } from "./acquisition/port.js";
import { runNextScan, type ExecutorDeps } from "./scans/executor.js";
import {
  insertDueRecheckScans,
  insertDueScheduledScans,
  requeueCrashedScans,
  SCHEDULED_ENGINES,
} from "./scans/store.js";
import { probeRoutes } from "./scans/route-state.js";
import { readRouteState } from "./scans/route-state.js";
import { runCapture, type CaptureRunnerDeps } from "./capture/runner.js";

/**
 * The pg-boss wiring (docs/design/scan-scheduling.md "Jobs"; ADR 0005:
 * one PostgreSQL for jobs). One queue per engine holds concurrency at one
 * so a provider never sees a burst from Patrol, and the cron jobs drive
 * the schedule, the re-checks, the capture sweep, the submission-draft
 * windows, the rollover, the balance probe, the route probe, and the
 * daily retention purge.
 *
 * pg-boss keeps its tables in its own schema (PATROL_BOSS_SCHEMA,
 * `pgboss` by default), created and versioned by `boss.start()` — the
 * schema is deliberately NOT reflected into the forward-only drizzle
 * migrations, which own Patrol's domain tables alone; the startup order
 * is: domain migrations (the migrate task), the stamp check, then
 * `boss.start()`.
 */

/**
 * The engine queues, named for the job they run. Single-sourced in
 * `@patrol/domain` so the API's producer and this consumer cannot drift.
 */
export const ENGINE_QUEUES = ENGINE_QUEUE_NAMES;

export type EngineQueueName = (typeof ENGINE_QUEUES)[keyof typeof ENGINE_QUEUES];

/** The cron jobs and their schedules (implementation rules "Job cadence"). */
export const CRON_JOBS = {
  "scan.schedule": "*/15 * * * *",
  "recheck.schedule": "*/15 * * * *",
  "capture.sweep": "*/15 * * * *",
  "submission.draft": "0 7 * * *",
  // The seven-day reminder (scan-scheduling.md "Jobs"): daily, after the
  // morning composition window so the backlog it names is the day's own.
  "submission.remind": "0 8 * * *",
  "budget.rollover": "0 0 1 * *",
  "budget.balance": "0 6 * * *",
  "route.probe": "0 * * * *",
  // Retention purging (evidence-capture.md "Retention"): daily, in the
  // quiet window after the balance probe and before the day's scans, so a
  // large backlog of object deletes never races the morning's captures.
  "retention.purge": "20 4 * * *",
} as const;

export type CronJobName = keyof typeof CRON_JOBS;

/** The capture queue's name, single-sourced in @patrol/domain. */
export const CAPTURE_QUEUE = CAPTURE_QUEUE_NAME;

/**
 * Sends one capture wake-up. The enqueue port (packages/evidence) calls
 * this after its guards admit a URL; slice 5's HTTP surface reaches the
 * same port through the API's own producer.
 */
export function captureDispatcher(boss: PgBoss): (captureId: string) => Promise<void> {
  return async (captureId) => {
    await boss.send(CAPTURE_QUEUE, { captureId });
  };
}

/**
 * Schedules a retry attempt's wake-up after the backoff — a delayed send,
 * so the retry matrix lives in one place (the runner's schedule) and the
 * queue holds nothing in memory.
 */
export function captureRetryScheduler(
  boss: PgBoss,
  now: () => Date,
): (captureId: string, delayMs: number) => Promise<void> {
  return async (captureId, delayMs) => {
    await boss.send(CAPTURE_QUEUE, { captureId }, {
      startAfter: new Date(now().getTime() + delayMs),
    });
  };
}

/**
 * `capture.run`: one attempt of one queued capture. The job carries no
 * retry of its own — the runner decides per the retry matrix (dead and
 * captured never retry; blocked and error retry up to three attempts with
 * backoff inside 24 hours) and schedules its own wake-up, so an exhausted
 * job is a decision, not a loss.
 */
export async function captureRunJob(
  deps: CaptureRunnerDeps,
  captureId: string,
  log: (message: string, extra?: Record<string, unknown>) => void,
): Promise<void> {
  await runCapture(deps, captureId, log);
}

/**
 * `capture.sweep` (every 15 minutes): the capture sweeper, the backstop
 * for rows a dead process would strand — the capture queue carries no
 * retry of its own. A pending capture whose next attempt has come due gets
 * its wake-up re-sent (a crash between the record and the schedule loses
 * the original), and a running attempt older than the stale threshold —
 * the 45-second budget with the queue's expiry and margin — is a dead
 * worker's row, reaped back to pending for the next dispatch. Duplicate
 * wake-ups are safe by construction: the claim is atomic and the runner
 * stands down any wake-up ahead of its scheduled attempt.
 */
export async function captureSweepJob(
  deps: {
    pool: Pool;
    now: () => Date;
    dispatch: (captureId: string) => Promise<void>;
    staleRunningMs?: number;
  },
  log: (message: string, extra?: Record<string, unknown>) => void,
): Promise<void> {
  const reaped = await reapStaleRunningCaptures(
    deps.pool,
    deps.now,
    deps.staleRunningMs,
  );
  for (const captureId of reaped) {
    log("capture.sweep reaped a stale running capture", { captureId });
  }
  const due = await duePendingCaptureIds(deps.pool, deps.now);
  for (const captureId of due) {
    await deps.dispatch(captureId);
  }
  if (reaped.length > 0 || due.length > 0) {
    log("capture.sweep re-dispatched due captures", {
      reaped: reaped.length,
      dispatched: due.length,
    });
  }
}

/** Sends one scan.run picker job into an engine's queue. */
export type DispatchScanRun = (engine: "google" | "yandex") => Promise<void>;

/** The dispatcher over a started pg-boss instance. */
export function bossDispatcher(boss: PgBoss): DispatchScanRun {
  return async (engine) => {
    await boss.send(ENGINE_QUEUES[engine], { engine });
  };
}

/**
 * `scan.schedule` (every 15 minutes): expire the holds whose hour ran
 * out, sweep the scans a dead worker left running back to the queue,
 * enqueue one scan per title group and engine whose local scan time has
 * passed and which has not been scanned today, and wake the engine
 * queues. While a route is disabled the day's rows are still created —
 * the day is spent either way — and wait queued with `route_unavailable`
 * until the probe recovers the engine.
 */
export async function scanScheduleJob(
  deps: { pool: Pool; now: () => Date; dispatch: DispatchScanRun },
  log: (message: string, extra?: Record<string, unknown>) => void,
): Promise<void> {
  const { pool, now, dispatch } = deps;
  const expired = await expireReservations(pool, now);
  const crashed = await requeueCrashedScans(pool, now, RESERVATION_TTL_MS);
  for (const engine of SCHEDULED_ENGINES) {
    const created = await insertDueScheduledScans(pool, now, engine);
    const route = await readRouteState(pool, engine);
    if (route.disabled) {
      await pool.query(
        `update scans set failure_reason = 'route_unavailable'
          where engine = $1 and state = 'queued' and failure_reason is null`,
        [engine],
      );
      log("scan.schedule skipped a disabled route", { engine });
      continue;
    }
    if (created > 0) {
      log("scan.schedule enqueued scans", { engine, created });
    }
    await dispatch(engine);
  }
  if (expired > 0) {
    log("scan.schedule expired reservations", { expired });
  }
  if (crashed > 0) {
    log("scan.schedule requeued scans left running by a dead worker", { crashed });
  }
}

/**
 * `recheck.schedule` (every 15 minutes): enqueue the re-check scans whose
 * ladder rung fell due, then wake the engine queues. A pair that already
 * has a scan for the day is left to it.
 */
export async function recheckScheduleJob(
  deps: { pool: Pool; now: () => Date; dispatch: DispatchScanRun },
  log: (message: string, extra?: Record<string, unknown>) => void,
): Promise<void> {
  const { pool, now, dispatch } = deps;
  const created = await insertDueRecheckScans(pool, now);
  if (created > 0) {
    log("recheck.schedule enqueued rechecks", { created });
  }
  for (const engine of SCHEDULED_ENGINES) {
    await dispatch(engine);
  }
}

/**
 * `submission.draft` (daily at the default 07:00 UTC window): compose the
 * scheduled profiles' drafts. The cron wakes the runner once a day; each
 * profile's OWN window time decides what composes — the runner takes the
 * profile's most recent window occurrence at or before the run, so a
 * profile whose window is later than the default composes at the next
 * daily run with its own cut-off, and a window is composed at most once
 * (`notice_composition_runs`). The window is a cut-off, not a rolling
 * queue: violations confirmed inside (previous window, this window]
 * compose, and one confirmed after the window waits for the next.
 */
export async function submissionDraftJob(
  deps: { pool: Pool; now: () => Date },
  log: (message: string, extra?: Record<string, unknown>) => void,
): Promise<void> {
  const outcomes = await runScheduledComposition(deps, log);
  const composed = outcomes.reduce((total, outcome) => total + outcome.composedNotices, 0);
  if (composed > 0 || outcomes.length > 0) {
    log("submission.draft composed scheduled drafts", {
      profiles: outcomes.length,
      composed,
    });
  }
}

/**
 * `submission.remind` (daily): surfaces the Pending submissions older than
 * seven days to the operators. The reminder's durable act is the deduped
 * `submission_alerts` row it raises per backlog submission (one row per
 * submission, ever, until the submission leaves pending — the budget
 * alerts' fire-once pattern), which slice 8/9's dashboard badge and
 * reminder surfacing read beside the `olderThanDays` filter; the log line
 * names the same ids the rows do. Nothing contacts a recipient and nothing
 * is retried by it (the contact rule: every submission names an operator).
 */
export async function submissionRemindJob(
  deps: {
    pool: Pool;
    now: () => Date;
    /** The operator-mailbox delivery; absent skips it (the rows still stand). */
    mail?: MailTransport;
    /** The configured operator mailbox the digest lands in. */
    alertEmail?: string | null;
  },
  log: (message: string, extra?: Record<string, unknown>) => void,
): Promise<void> {
  const { pool, now } = deps;
  const { backlog, raised } = await raiseSubmissionAlerts(pool, now, REMINDER_DAYS);
  if (backlog.length > 0) {
    log("submission.remind surfaced pending submissions older than seven days", {
      count: backlog.length,
      ids: backlog.map((item) => item.submissionId),
      raised: raised.length,
    });
  }
  // The mailbox half follows the rows' own fire-once: one digest, and only
  // for a run that raised at least one new alert row — an unchanged
  // backlog never re-emails. A delivery failure is logged, not thrown:
  // the durable half already stands and tomorrow's run re-sends nothing,
  // so the operator's recovery is the dashboard badge the rows feed.
  if (deps.mail !== undefined && deps.alertEmail && raised.length > 0) {
    try {
      await deliverSubmissionReminderEmail(deps.mail, {
        to: deps.alertEmail,
        items: backlog,
      });
      log("submission.remind delivered the backlog digest", {
        to: deps.alertEmail,
        count: backlog.length,
      });
    } catch (error) {
      log("submission.remind could not deliver the backlog digest", {
        to: deps.alertEmail,
        err: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/** `budget.rollover` (the first at 00:00 UTC): open the new month. */
export async function budgetRolloverJob(
  deps: { pool: Pool; now: () => Date },
  log: (message: string, extra?: Record<string, unknown>) => void,
): Promise<void> {
  const outcomes = await rollOverMonth(deps.pool, deps.now);
  log(
    "budget.rollover opened the month",
    Object.fromEntries(
      outcomes.map((outcome) => [
        outcome.engine,
        { created: outcome.created, allowanceUnits: outcome.allowanceUnits },
      ]),
    ),
  );
}

/**
 * `budget.balance` (daily): probe each configured provider's prepaid
 * balance and evaluate the alert thresholds with the reading. The ledger
 * stays the budget authority; the probe is the backstop that catches a
 * balance the ledger's remaining allowance does not cover.
 */
export async function budgetBalanceJob(
  deps: {
    pool: Pool;
    now: () => Date;
    adapters: ReadonlyMap<string, SerpAcquisitor>;
    /** The operator-mailbox delivery; absent skips it (the rows still stand). */
    mail?: MailTransport;
    /** The configured operator mailbox the alerts land in. */
    alertEmail?: string | null;
  },
  log: (message: string, extra?: Record<string, unknown>) => void,
): Promise<void> {
  const { pool, now, adapters } = deps;
  for (const [engine, adapter] of adapters) {
    const reading = await adapter.probeBalance();
    const balance =
      reading.outcome === "balance" ? { balanceMinor: reading.balanceMinor } : undefined;
    const fired = await evaluateBudgetAlerts(pool, {
      engine: engine as "google" | "yandex",
      now,
      balance,
    });
    log("budget.balance probed", {
      engine,
      outcome: reading.outcome,
      fired: fired.length,
    });
    // Mailbox delivery follows the evaluator's fire-once exactly: only the
    // rows this evaluation newly fired are emailed, so the database's
    // unique key — not the mailer — decides what a mailbox sees once. A
    // delivery failure is logged and left: the durable half stands, the
    // dashboard reads it, and the alert never re-fires to retry a send.
    if (deps.mail !== undefined && deps.alertEmail) {
      for (const alert of fired) {
        try {
          await deliverBudgetAlertEmail(deps.mail, {
            to: deps.alertEmail,
            alert: {
              engine: alert.engine,
              threshold: alert.threshold,
              bucket: alert.bucket,
              level: alert.level,
              percentUsed: alert.percentUsed,
              groupsNotScanned: alert.groupsNotScanned,
            },
          });
        } catch (error) {
          log("budget.balance could not deliver an alert email", {
            to: deps.alertEmail,
            engine: alert.engine,
            threshold: alert.threshold,
            err: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  }
}

/**
 * `retention.purge` (daily): one pass of the retention job — the three
 * windows, the legal-hold precedence, and the marker-before-bytes ordering
 * (evidence-capture.md "Retention"). The summary the log names is the
 * monitoring surface the operations runbook reads: `marked` rows whose
 * bytes are on their way out, `versionsDeleted` the deletes that landed,
 * and the gap between a row's purge marker and its completion marker is
 * the backlog a repeated failure would grow.
 */
export async function retentionPurgeJob(
  deps: {
    pool: Pool;
    now: () => Date;
    store: RetentionStore;
  },
  log: (message: string, extra?: Record<string, unknown>) => void,
): Promise<void> {
  const summary = await runRetentionPurge({ ...deps, log });
  if (summary.due > 0 || summary.versionsDeleted > 0 || summary.rawSerpKeysDeleted > 0) {
    log("retention.purge ran", { ...summary });
  }
}

/**
 * `route.probe` (hourly while an engine is disabled; the cron fires
 * hourly and the handler no-ops when every route stands): probe each
 * disabled engine and re-enable the ones that recovered, then wake their
 * queues so the waiting work starts.
 */
export async function routeProbeJob(
  deps: {
    pool: Pool;
    now: () => Date;
    adapters: ReadonlyMap<string, SerpAcquisitor>;
    dispatch: DispatchScanRun;
  },
  log: (message: string, extra?: Record<string, unknown>) => void,
): Promise<void> {
  const { pool, now, adapters, dispatch } = deps;
  const { reenabled, results } = await probeRoutes(pool, now, adapters);
  if (results.length > 0) {
    log("route.probe ran", { results });
  }
  for (const engine of reenabled) {
    if (engine === "google" || engine === "yandex") {
      log("route.probe re-enabled a route", { engine });
      await dispatch(engine);
    }
  }
}

/**
 * `scan.run.<engine>`: run the next scan on the engine's queue, in the
 * documented order. The job chains itself only when a scan actually ran,
 * so the queue drains without a hot loop; budget-exhausted work waits for
 * the next schedule tick.
 */
export async function scanRunJob(
  deps: ExecutorDeps & { dispatch: DispatchScanRun },
  engine: "google" | "yandex",
  log: (message: string, extra?: Record<string, unknown>) => void,
): Promise<void> {
  const outcome = await runNextScan(deps, engine);
  if (outcome.outcome === "ran") {
    log("scan.run finished a scan", { engine, state: outcome.state, scanId: outcome.scanId });
    await deps.dispatch(engine);
    return;
  }
  if (outcome.outcome === "budget_exhausted") {
    log("scan.run found no fitting plan; work stays queued", { engine });
    return;
  }
  if (outcome.outcome === "engine_disabled") {
    log("scan.run skipped a disabled route", { engine });
    return;
  }
  log("scan.run found nothing to run", { engine });
}
