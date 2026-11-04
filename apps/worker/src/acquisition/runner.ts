import { setTimeout as sleepTimer } from "node:timers/promises";
import { v7 as uuidv7 } from "uuid";
import type { Connectable, Queryable } from "../db.js";
import {
  bucketFor,
  evaluateAlerts,
  monthStart,
  reserve,
  settle,
  toReservation,
  type ReservationRow,
} from "./budget.js";
import { updateLadderAfterScan } from "./ladder.js";
import {
  buildQueryPlan,
  loadPlanInput,
  territoryForLocale,
  UNITS_PER_QUERY,
} from "./planner.js";
import {
  hostOf,
  normalizeUrl,
  registrableDomainOf,
} from "./normalize.js";
import {
  AdapterError,
  type Engine,
  type PlannedQuery,
  type QueryPlan,
  type SearchAdapter,
} from "./types.js";

export interface ScanRow {
  id: string;
  title_group_id: string;
  engine: Engine;
  trigger: string;
  due_date: string;
  tracked_title_id: string | null;
  state: string;
  issued_queries: number | null;
  started_at: unknown;
  finished_at: unknown;
}

export interface RunnerOptions {
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
  retryDelaysMs?: number[];
}

const DEFAULT_RETRY_DELAYS = [60_000, 300_000, 900_000];

/** Runs one queued scan: plan, reserve, issue, store, settle, and alert. */
export class ScanRunner {
  private readonly now: () => Date;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly retryDelaysMs: number[];

  constructor(
    private readonly db: Connectable,
    private readonly adapters: Partial<Record<Engine, SearchAdapter>>,
    options: RunnerOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.sleep =
      options.sleep ?? ((milliseconds) => sleepTimer(milliseconds));
    this.retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS;
  }

  async run(scanId: string): Promise<ScanRow> {
    const scan = await this.loadScan(scanId);
    if (!scan) {
      throw new Error("The scan does not exist.");
    }
    if (["succeeded", "partial", "failed"].includes(scan.state)) {
      return scan;
    }
    const engine = scan.engine;
    if (await this.routeDisabled(engine)) {
      return this.fail(scan, "route_unavailable", [], this.now());
    }
    const adapter = this.adapters[engine];
    if (!adapter) {
      return this.fail(scan, "provider_error", [], this.now());
    }
    const now = this.now();
    const plan = await this.planForScan(scan, now);
    const units = plan.queries.length * UNITS_PER_QUERY[engine];
    await this.db.query(
      "UPDATE scan SET planned_queries = $2 WHERE id = $1",
      [scan.id, plan.queries.length],
    );

    const bucket = bucketFor(scan.trigger);
    let reservation = await this.heldReservation(scanId, now);
    if (!reservation) {
      reservation = await reserve(this.db, {
        scanId,
        engine,
        bucket,
        units,
        now,
      });
    }
    if (!reservation) {
      await this.db.query(
        "UPDATE scan SET state = 'queued', queued_reason = 'budget_exhausted' WHERE id = $1",
        [scanId],
      );
      return (await this.loadScan(scanId))!;
    }

    await this.persistPlan(scanId, plan);
    const startedAt = this.now();
    await this.db.query(
      "UPDATE scan SET state = 'running', started_at = $2, queued_reason = NULL WHERE id = $1",
      [scanId, startedAt],
    );
    await this.touch(scanId, reservation.id, startedAt);

    let answered = 0;
    const failures: Array<{ queryId: string; reason: string; attempts: number }> =
      [];
    let routeFailure = false;
    for (const query of plan.queries) {
      try {
        const batch = await this.issue(adapter, query);
        answered += 1;
        await this.storeResults(scanId, engine, query, batch.rows, batch.rawBody);
      } catch (error) {
        if (
          error instanceof AdapterError &&
          (error.kind === "auth" || error.kind === "balance")
        ) {
          await this.disableRoute(engine, error.message, this.now());
          routeFailure = true;
          break;
        }
        failures.push({
          queryId: query.id,
          reason: error instanceof Error ? error.message : "provider_error",
          attempts: this.retryDelaysMs.length + 1,
        });
      }
      await this.touch(scanId, reservation.id, this.now());
    }

    const finishedAt = this.now();
    const committed = answered * UNITS_PER_QUERY[engine];
    await settle(this.db, { reservation, committedUnits: committed, now: finishedAt });

    let state: string;
    let failureReason: string | null = null;
    if (routeFailure) {
      state = "failed";
      failureReason = "route_unavailable";
    } else if (failures.length === 0 && answered === plan.queries.length) {
      state = "succeeded";
    } else if (answered > 0) {
      state = "partial";
    } else {
      state = "failed";
      failureReason = "provider_error";
    }
    await this.db.query(
      `UPDATE scan
          SET state = $2, finished_at = $3, issued_queries = $4,
              failure_reason = $5, failures = $6
        WHERE id = $1`,
      [
        scanId,
        state,
        finishedAt,
        answered,
        failureReason,
        failures.length > 0 ? JSON.stringify(failures) : null,
      ],
    );
    await updateLadderAfterScan(this.db, {
      titleGroupId: scan.title_group_id,
      engine,
      trigger: scan.trigger,
      scanId: scan.id,
      finishedAt,
    });
    if (state === "partial") {
      await this.raiseAlert(
        engine,
        "partial",
        "warning",
        `A ${engine} scan finished partially; some queries failed.`,
        finishedAt,
      );
    }
    await evaluateAlerts(this.db, engine, finishedAt);
    return (await this.loadScan(scanId))!;
  }

  private async planForScan(
    scan: ScanRow,
    now: Date,
  ): Promise<QueryPlan> {
    if (scan.trigger === "recheck" || scan.trigger === "manual_recheck") {
      const ladder = (
        await this.db.query(
          "SELECT started_by_scan_id FROM recheck_schedule WHERE title_group_id = $1 AND engine = $2",
          [scan.title_group_id, scan.engine],
        )
      ).rows[0];
      const originalId = ladder ? String(ladder.started_by_scan_id ?? "") : "";
      if (originalId) {
        const original = (
          await this.db.query("SELECT query_plan FROM scan WHERE id = $1", [
            originalId,
          ])
        ).rows[0];
        if (original?.query_plan) {
          const stored = JSON.parse(String(original.query_plan)) as QueryPlan;
          if (Array.isArray(stored.queries)) {
            return {
              generatedAt: now.toISOString(),
              queries: stored.queries.map((query) => ({
                ...query,
                id: uuidv7(),
              })),
            };
          }
        }
      }
    }
    const input = await loadPlanInput(
      this.db,
      scan.title_group_id,
      scan.engine,
      scan.tracked_title_id ?? undefined,
      now,
    );
    return buildQueryPlan(input);
  }

  private async issue(
    adapter: SearchAdapter,
    query: PlannedQuery,
  ) {
    const territory = territoryForLocale(query.locale);
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.retryDelaysMs.length; attempt += 1) {
      try {
        return await adapter.search(query, {
          engine: adapter.engine,
          locale: query.locale,
          territory,
          limit: adapter.engine === "google" ? 20 : 30,
        });
      } catch (error) {
        lastError = error;
        if (error instanceof AdapterError && error.kind !== "retryable") {
          throw error;
        }
        const delay = this.retryDelaysMs[attempt];
        if (delay === undefined) {
          break;
        }
        await this.sleep(delay);
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error("provider_error");
  }

  private async storeResults(
    scanId: string,
    engine: Engine,
    query: PlannedQuery,
    rows: Array<{
      url: string;
      title: string;
      snippet: string;
      host: string;
      position: number;
      retrievedAt: string;
    }>,
    rawBody: string,
  ): Promise<void> {
    const payloadId = uuidv7();
    await this.db.query(
      `INSERT INTO serp_payload (id, scan_id, engine, body, created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [payloadId, scanId, engine, rawBody, this.now()],
    );
    for (const row of rows) {
      const host = row.host || hostOf(row.url);
      await this.db.query(
        `INSERT INTO search_result
          (id, scan_id, query_id, engine, url, normalized_url, rank, title,
           snippet, locale, territory, observed_at, raw_payload_ref, host,
           registrable_domain, candidate_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
                 $14, $15, NULL)`,
        [
          uuidv7(),
          scanId,
          query.id,
          engine,
          row.url,
          normalizeUrl(row.url),
          row.position,
          row.title,
          row.snippet,
          query.locale,
          territoryForLocale(query.locale) ?? null,
          row.retrievedAt,
          payloadId,
          host,
          registrableDomainOf(row.url),
        ],
      );
    }
  }

  private async persistPlan(scanId: string, plan: QueryPlan): Promise<void> {
    await this.db.query("DELETE FROM scan_query WHERE scan_id = $1", [scanId]);
    await this.db.query("DELETE FROM search_result WHERE scan_id = $1", [scanId]);
    await this.db.query("DELETE FROM serp_payload WHERE scan_id = $1", [scanId]);
    for (const [ordinal, query] of plan.queries.entries()) {
      await this.db.query(
        `INSERT INTO scan_query
          (id, scan_id, tracked_title_id, locale, kind, text, variant_id,
           intent_phrase_text, intent_phrase_version, ordinal)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          query.id,
          scanId,
          query.trackedTitleId,
          query.locale,
          query.kind,
          query.text,
          query.variantId ?? null,
          query.intentPhrase?.text ?? null,
          query.intentPhrase?.version ?? null,
          ordinal,
        ],
      );
    }
    await this.db.query(
      "UPDATE scan SET query_plan = $2, planned_queries = $3 WHERE id = $1",
      [scanId, JSON.stringify(plan), plan.queries.length],
    );
  }

  private async touch(
    scanId: string,
    reservationId: string,
    now: Date,
  ): Promise<void> {
    const renewed = new Date(now.getTime() + 60 * 60 * 1000);
    await this.db.query(
      "UPDATE scan SET last_heartbeat_at = $2 WHERE id = $1",
      [scanId, now],
    );
    await this.db.query(
      "UPDATE budget_reservation SET expires_at = $2 WHERE id = $1 AND state = 'held'",
      [reservationId, renewed],
    );
  }

  private async heldReservation(
    scanId: string,
    now: Date,
  ): Promise<ReservationRow | undefined> {
    const row = (
      await this.db.query(
        "SELECT * FROM budget_reservation WHERE scan_id = $1 AND state = 'held' ORDER BY created_at DESC LIMIT 1",
        [scanId],
      )
    ).rows[0];
    if (!row) {
      return undefined;
    }
    if (new Date(String(row.expires_at)) <= now) {
      await settle(this.db, {
        reservation: toReservation(row),
        committedUnits: 0,
        now,
      });
      await this.db.query(
        "UPDATE budget_reservation SET state = 'expired' WHERE id = $1",
        [String(row.id)],
      );
      return undefined;
    }
    return toReservation(row);
  }

  private async routeDisabled(engine: string): Promise<boolean> {
    return (
      (
        await this.db.query(
          "SELECT engine FROM engine_route WHERE engine = $1 AND disabled_at IS NOT NULL",
          [engine],
        )
      ).rows.length > 0
    );
  }

  async disableRoute(
    engine: string,
    reason: string,
    now: Date = this.now(),
  ): Promise<void> {
    const existing = (
      await this.db.query("SELECT engine FROM engine_route WHERE engine = $1", [
        engine,
      ])
    ).rows[0];
    if (existing) {
      await this.db.query(
        "UPDATE engine_route SET disabled_at = $2, disabled_reason = $3, updated_at = $2 WHERE engine = $1",
        [engine, now, reason],
      );
    } else {
      await this.db.query(
        `INSERT INTO engine_route
          (engine, disabled_at, disabled_reason, last_probe_at, updated_at)
         VALUES ($1, $2, $3, NULL, $2)`,
        [engine, now, reason],
      );
    }
    await this.raiseAlert(
      engine,
      "route",
      "critical",
      `The ${engine} route is disabled: ${reason}`,
      now,
    );
  }

  private async raiseAlert(
    engine: string,
    threshold: string,
    level: "warning" | "critical",
    message: string,
    now: Date,
  ): Promise<void> {
    const existing = (
      await this.db.query(
        "SELECT id FROM budget_alert WHERE engine = $1 AND bucket = 'scan' AND threshold = $2 AND month_start = $3",
        [engine, threshold, monthStart(now)],
      )
    ).rows[0];
    if (existing) {
      return;
    }
    try {
      await this.db.query(
        `INSERT INTO budget_alert
          (id, engine, bucket, threshold, level, percent_used, message,
           groups_not_scanned, month_start, created_at)
         VALUES ($1, $2, 'scan', $3, $4, 0, $5, 0, $6, $7)`,
        [
          uuidv7(),
          engine,
          threshold,
          level,
          message,
          monthStart(now),
          now,
        ],
      );
    } catch {
      // A concurrent scan raised the same alert first.
    }
  }

  private async fail(
    scan: ScanRow,
    reason: string,
    failures: Array<{ queryId: string; reason: string; attempts: number }>,
    now: Date,
  ): Promise<ScanRow> {
    await this.db.query(
      `UPDATE scan
          SET state = 'failed', started_at = $2, finished_at = $2,
              issued_queries = 0, failure_reason = $3, failures = $4
        WHERE id = $1`,
      [scan.id, now, reason, failures.length > 0 ? JSON.stringify(failures) : null],
    );
    return (await this.loadScan(scan.id))!;
  }

  async loadScan(scanId: string): Promise<ScanRow | undefined> {
    const row = (
      await this.db.query("SELECT * FROM scan WHERE id = $1", [scanId])
    ).rows[0];
    if (!row) {
      return undefined;
    }
    return {
      id: String(row.id),
      title_group_id: String(row.title_group_id),
      engine: String(row.engine) as Engine,
      trigger: String(row.trigger),
      due_date: String(row.due_date),
      tracked_title_id: (row.tracked_title_id as string | null) ?? null,
      state: String(row.state),
      issued_queries:
        row.issued_queries === null || row.issued_queries === undefined
          ? null
          : Number(row.issued_queries),
      started_at: row.started_at,
      finished_at: row.finished_at,
    };
  }
}
