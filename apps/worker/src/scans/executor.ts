import type { Pool } from "pg";
import {
  allowanceUnits,
  bucketShares,
  capFor,
  evaluateBudgetAlerts,
  commitReservation,
  monthStartOf,
  readCaps,
  readLedgerRow,
  releaseReservation,
  reserve,
} from "@patrol/budget";
import {
  UNITS_PER_QUERY,
  buildPlan,
  degradationPolicy,
  localeRequestParams,
  pricePlan,
  type QueueEntry,
} from "@patrol/domain";
import type { SerpAcquisitor } from "../acquisition/port.js";
import { noViolationsPredicates, onScanCompleted, type LadderPredicates } from "./ladder.js";
import { disableRoute, readRouteState } from "./route-state.js";
import {
  attachReservation,
  claimScan,
  finishScan,
  formCandidatesForQuery,
  heldReservationFor,
  loadPlanInputs,
  loadScanFailures,
  loadScanQueries,
  queuedScanOrder,
  readScan,
  requeueScan,
  storePlan,
  storeQueryFailure,
  storeResults,
  type EnqueueDetectionCapture,
} from "./store.js";

/**
 * The scan executor (docs/design/scan-scheduling.md "Quota accounting";
 * docs/design/query-strategy.md "Preflight"): price the plan, reserve in
 * one transaction, issue the queries serially through the engine's
 * adapter, store the results as provenance, and settle the units the scan
 * actually issued. A plan that does not fit its bucket stays queued with
 * `budget_exhausted` and is never truncated; a route failure disables the
 * engine and fails the scan with `route_unavailable`; the ladder advances
 * or resets on completion.
 */

/**
 * The bucket an entry's work kind draws on: scheduled and manual scans
 * draw the scan share, plain re-checks and manual re-checks the re-check
 * share. The work kind, not the trigger identity, decides — a manual
 * re-check is operator-requested work whose purpose is a re-check, and
 * letting it borrow the scan share would break the unborrowable 30%
 * (docs/design/scan-scheduling.md "The re-check ladder", Budget).
 */
function bucketOf(trigger: QueueEntry["trigger"]): "scan" | "recheck" {
  return trigger === "recheck" || trigger === "manual_recheck"
    ? "recheck"
    : "scan";
}

export interface ExecutorDeps {
  pool: Pool;
  now: () => Date;
  /** The adapters the boot registered, one per configured route. */
  adapters: ReadonlyMap<string, SerpAcquisitor>;
  /** The query retry schedule handed to the adapters. */
  retryDelaysMs: readonly number[];
  /** The sleep the adapters wait with between retries. */
  sleep: (ms: number) => Promise<void>;
  /** The ladder's violation predicates; defaults see none until slice 5. */
  predicates?: LadderPredicates;
  /**
   * The detection-capture enqueue port for newly formed candidates. Absent
   * in tests that assert formation without captures; production wires the
   * evidence package's enqueue with the capture queue's dispatcher.
   */
  enqueueCapture?: EnqueueDetectionCapture;
  /** The structured log; absent means silent (tests), never a thrown log. */
  log?: (message: string, extra?: Record<string, unknown>) => void;
}

/** The silent log a test's executor runs with. */
const noopLog = (): void => undefined;

/** What one picker round on an engine's queue produced. */
export type PickerOutcome =
  | { outcome: "ran"; state: "succeeded" | "partial" | "failed"; scanId: string }
  | { outcome: "engine_disabled" }
  | { outcome: "nothing_to_run" }
  | { outcome: "budget_exhausted" }
  | { outcome: "route_unavailable" };

/** One bucket's current standing against the live cap. */
export async function bucketUsage(
  pool: Pool,
  engine: "google" | "yandex",
  now: () => Date,
  bucket: "scan" | "recheck",
): Promise<{ shareUnits: number; usedUnits: number }> {
  const caps = await readCaps(pool);
  const authority = allowanceUnits(engine, capFor(caps, engine));
  const shares = bucketShares(authority, caps.budget_recheck_share_percent);
  const row = await readLedgerRow(pool, engine, monthStartOf(now()));
  return bucket === "scan"
    ? {
        shareUnits: shares.scan,
        usedUnits: (row?.scanReserved ?? 0) + (row?.scanCommitted ?? 0),
      }
    : {
        shareUnits: shares.recheck,
        usedUnits: (row?.recheckReserved ?? 0) + (row?.recheckCommitted ?? 0),
      };
}

/**
 * Runs the next scan on one engine's queue, in the documented order:
 * manual work by request order, then re-checks, then scheduled work by
 * priority and least-recently-scanned. The degradation order applies per
 * work kind before the attempts (docs/design/budget-envelope.md
 * "Degradation order"): re-checks starve first through their own
 * unborrowable share and queue when it is spent, at ninety percent of the
 * scan share low-priority groups stop, at one hundred percent every
 * scheduled scan queues — while manual scans are never skipped by the
 * policy; they always preflight their own bucket and queue rather than
 * skip, so an operator sees that the check is waiting for budget. A
 * refused plan never truncates: the scan stays queued, and the picker
 * walks on to the next candidate so a group that leaves its share unused
 * lets another borrow it the same day.
 */
export async function runNextScan(
  deps: ExecutorDeps,
  engine: "google" | "yandex",
): Promise<PickerOutcome> {
  const { pool, now } = deps;
  const route = await readRouteState(pool, engine);
  if (route.disabled) {
    return { outcome: "engine_disabled" };
  }
  const adapter = deps.adapters.get(engine);
  if (adapter === undefined) {
    return { outcome: "engine_disabled" };
  }

  const scanUsage = await bucketUsage(pool, engine, now, "scan");
  const scanPolicy = degradationPolicy({
    scanShareUnits: scanUsage.shareUnits,
    scanUsedUnits: scanUsage.usedUnits,
  });
  const recheckUsage = await bucketUsage(pool, engine, now, "recheck");
  // The re-check bucket's only degradation is its own exhaustion at one
  // hundred percent: re-checks carry no group priority to stop early, and
  // a spent scan share must never queue them.
  const queueRechecks = degradationPolicy({
    scanShareUnits: recheckUsage.shareUnits,
    scanUsedUnits: recheckUsage.usedUnits,
  }).queueScheduledScans;

  const entries = await queuedScanOrder(pool, engine);
  let sawQueuedWork = false;
  for (const entry of entries) {
    // Degradation by work kind: scheduled work follows the scan share's
    // policy, re-check work queues when the re-check share is spent, and
    // manual work — a manual scan or a manual re-check — is never
    // short-cut here; its preflight decides, so it queues through the
    // reservation refusal instead of a picker shortcut.
    const degraded =
      entry.trigger === "scheduled"
        ? scanPolicy.queueScheduledScans ||
          (scanPolicy.stopLowPriorityGroups && entry.priority === "low")
        : entry.trigger === "recheck"
          ? queueRechecks
          : false;
    if (degraded) {
      // Waiting for budget is a queued reason, recorded once.
      await pool.query(
        `update scans set failure_reason = 'budget_exhausted'
          where id = $1 and state = 'queued' and failure_reason is null`,
        [entry.scanId],
      );
      sawQueuedWork = true;
      continue;
    }
    const attempted = await attemptScan(deps, engine, entry);
    if (attempted.outcome === "ran" || attempted.outcome === "route_unavailable") {
      return attempted;
    }
    if (attempted.outcome === "budget_exhausted") {
      sawQueuedWork = true;
      continue;
    }
    // claimed-away: another picker holds it; walk on.
  }
  return sawQueuedWork
    ? { outcome: "budget_exhausted" }
    : { outcome: "nothing_to_run" };
}

/** One scan's whole run, from claim to settlement. */
async function attemptScan(
  deps: ExecutorDeps,
  engine: "google" | "yandex",
  entry: QueueEntry,
): Promise<
  | { outcome: "ran"; state: "succeeded" | "partial" | "failed"; scanId: string }
  | { outcome: "route_unavailable" }
  | { outcome: "budget_exhausted" }
  | { outcome: "claimed_away" }
> {
  const { pool, now } = deps;
  const adapter = deps.adapters.get(engine)!;
  const claimed = await claimScan(pool, now, entry.scanId);
  if (claimed === null) {
    return { outcome: "claimed_away" };
  }

  // The plan is derived at scan start and kept for the scan's life; a
  // retried run continues the standing plan.
  const standing = await loadScanQueries(pool, entry.scanId);
  if (standing.length === 0) {
    const inputs = await loadPlanInputs(
      pool,
      {
        titleGroupId: claimed.titleGroupId,
        trackedTitleId: claimed.trackedTitleId,
      },
      now,
    );
    const plan = buildPlan({
      locales: inputs.locales,
      titles: inputs.titles,
      engine,
      intentPhrases: inputs.intentPhrases,
    });
    await storePlan(pool, now, { scanId: entry.scanId, queries: plan.queries });
  }
  const queries = await loadScanQueries(pool, entry.scanId);
  const remaining = queries.filter((query) => !query.issued);

  // Preflight: hold the units the plan still costs, from the bucket its
  // work kind draws on — a manual re-check holds from the re-check share,
  // a manual scan from the scan share. A held reservation from an
  // interrupted attempt keeps its hold; an expired one re-prices the
  // remainder.
  let reservation = await heldReservationFor(pool, entry.scanId);
  if (reservation === null && remaining.length > 0) {
    const units = pricePlan(engine, { queries: remaining });
    const held = await reserve(pool, now, {
      engine,
      bucket: bucketOf(entry.trigger),
      units,
      scanId: entry.scanId,
    });
    if (held.outcome === "budget_exhausted") {
      // The plan does not fit: back to the queue with its reason, never
      // truncated, never silently dropped.
      await requeueScan(pool, entry.scanId, "budget_exhausted");
      return { outcome: "budget_exhausted" };
    }
    reservation = { id: held.reservation.id, units: held.reservation.units };
    await attachReservation(pool, entry.scanId, reservation);
  }

  let issuedAnswered = 0;
  for (const query of remaining) {
    const result = await adapter.acquire(
      { queryId: query.id, text: query.text, locale: query.locale },
      { retryDelaysMs: deps.retryDelaysMs, sleep: deps.sleep, now },
    );
    if (result.outcome === "route_failed") {
      await disableRoute(pool, now, engine, result.reason);
      await settle(
        pool,
        now,
        entry.scanId,
        reservation,
        engine,
        "failed",
        "route_unavailable",
      );
      return { outcome: "route_unavailable" };
    }
    if (result.outcome === "query_failed") {
      await storeQueryFailure(pool, now, {
        scanId: entry.scanId,
        queryId: query.id,
        reason: result.reason,
        attempts: result.attempts,
        attemptLog: result.attemptLog,
      });
      continue;
    }
    issuedAnswered += 1;
    await storeResults(pool, {
      scanId: entry.scanId,
      engine,
      queryId: query.id,
      locale: query.locale,
      territory: localeRequestParams(query.locale).territory,
      observedAt: result.observedAt,
      rawPayloadRef: result.rawPayloadRef,
      rows: result.rows,
    });
  }

  // Candidate formation (docs/design/matching-and-classification-rules.md
  // "Candidate formation"): every query's stored results pair their URLs
  // with the tracked title the query targeted, deduplicating across queries
  // and engines on the upsert. Formation runs at completion over every
  // query of the scan — not only the ones this attempt issued — so a scan
  // resumed after a crash forms the pairs its earlier attempt already
  // stored; the upsert makes the pass idempotent either way. A newly formed
  // candidate without an allowlist hit enqueues its detection capture
  // through the injected port, which re-checks the allowlist before any
  // fetch. One query's formation failing — a database refusal mid-pairing,
  // a refused enqueue — is logged and never fails the scan or its other
  // queries, mirroring the capture runner: the scan answered its queries,
  // and the next scan of the title forms what this pass could not.
  const log = deps.log ?? noopLog;
  for (const query of queries) {
    try {
      await formCandidatesForQuery(pool, now, {
        queryId: query.id,
        log,
        ...(deps.enqueueCapture === undefined
          ? {}
          : { enqueueCapture: deps.enqueueCapture }),
      });
    } catch (error) {
      log("scan.run failed forming candidates for one query; walking on", {
        scanId: entry.scanId,
        queryId: query.id,
        err: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // The terminal state: every query answered, some answered and some
  // failed, or none answered at all.
  const scan = await readScan(pool, entry.scanId);
  const failures = await loadScanFailures(pool, entry.scanId);
  const issued = scan?.issuedQueries ?? 0;
  const answered = issued - failures.length;
  const state: "succeeded" | "partial" | "failed" =
    failures.length === 0
      ? "succeeded"
      : answered > 0
        ? "partial"
        : "failed";
  await settle(
    pool,
    now,
    entry.scanId,
    reservation,
    engine,
    state,
    state === "failed" ? "provider_error" : undefined,
  );

  // The alerts re-evaluate on every settlement, and the ladder reacts to
  // the completion. A failed scan advances nothing: it did not observe.
  await evaluateBudgetAlerts(pool, { engine, now });
  if (state !== "failed") {
    await onScanCompleted(pool, now, deps.predicates ?? noViolationsPredicates, {
      scanId: entry.scanId,
      titleGroupId: claimed.titleGroupId,
      engine,
      trigger: claimed.triggerKind,
      finishedAt: now(),
      dueDate: claimed.dueDate,
    });
  }
  return { outcome: "ran", state, scanId: entry.scanId };
}

/**
 * Commits the units the scan issued and closes the row. A partial scan
 * commits what it issued and releases the rest with the same call; a scan
 * that issued nothing releases everything it held.
 */
async function settle(
  pool: Pool,
  now: () => Date,
  scanId: string,
  reservation: { id: string; units: number } | null,
  engine: "google" | "yandex",
  state: "succeeded" | "partial" | "failed",
  failureReason?: string,
): Promise<void> {
  const scan = await readScan(pool, scanId);
  const issued = scan?.issuedQueries ?? 0;
  const committed = issued * UNITS_PER_QUERY[engine];
  if (reservation !== null) {
    if (committed === 0) {
      // A scan that issued nothing released everything it held — a failed
      // or expired reservation spends none of its units.
      await releaseReservation(pool, now, reservation.id).catch(() => undefined);
    } else {
      await commitReservation(pool, now, reservation.id, committed).catch(
        async () => {
          // The hold expired under a long run: the units are no longer this
          // scan's to spend, and the row settles without them.
          await releaseReservation(pool, now, reservation.id).catch(
            () => undefined,
          );
        },
      );
    }
  }
  await finishScan(pool, now, {
    scanId,
    state,
    failureReason,
    reservationId: reservation?.id ?? null,
    reservedUnits: reservation?.units ?? null,
    committedUnits: reservation === null ? null : committed,
  });
}
