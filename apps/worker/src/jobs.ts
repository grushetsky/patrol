import type { Pool } from "pg";
import {
  RESERVATION_TTL_MS,
  evaluateBudgetAlerts,
  expireReservations,
  rollOverMonth,
} from "@patrol/budget";
import { ENGINE_QUEUE_NAMES } from "@patrol/domain";
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

/**
 * The pg-boss wiring (docs/design/scan-scheduling.md "Jobs"; ADR 0005:
 * one PostgreSQL for jobs). One queue per engine holds concurrency at one
 * so a provider never sees a burst from Patrol, and the cron jobs drive
 * the schedule, the re-checks, the rollover, the balance probe, and the
 * route probe. Submission drafting and retention purging arrive with
 * their slices and are deliberately absent.
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
  "budget.rollover": "0 0 1 * *",
  "budget.balance": "0 6 * * *",
  "route.probe": "0 * * * *",
} as const;

export type CronJobName = keyof typeof CRON_JOBS;

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
