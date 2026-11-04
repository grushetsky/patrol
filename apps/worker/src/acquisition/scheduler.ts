import { v7 as uuidv7 } from "uuid";
import type { Connectable, Queryable } from "../db.js";
import { updateLadderAfterScan } from "./ladder.js";
import {
  currentShare,
  ensureLedger,
  expireReservations,
  monthStart,
  UNIT_PRICE_PER_THOUSAND_MINOR,
} from "./budget.js";
import type { ScanRunner } from "./runner.js";
import { AdapterError, type Engine, type SearchAdapter } from "./types.js";

const ENGINES: Engine[] = ["google", "yandex"];

export async function createDueScans(
  db: Connectable,
  now: Date,
): Promise<number> {
  const hhmmss = `${String(now.getUTCHours()).padStart(2, "0")}:${String(
    now.getUTCMinutes(),
  ).padStart(2, "0")}:${String(now.getUTCSeconds()).padStart(2, "0")}`;
  const dueDate = today(now);
  const groups = (
    await db.query(
      "SELECT id FROM title_group WHERE scan_time <= $1 ORDER BY scan_time ASC",
      [hhmmss],
    )
  ).rows;
  let created = 0;
  for (const group of groups) {
    for (const engine of ENGINES) {
      const existing = (
        await db.query(
          "SELECT id FROM scan WHERE title_group_id = $1 AND engine = $2 AND due_date = $3",
          [String(group.id), engine, dueDate],
        )
      ).rows[0];
      if (existing) {
        continue;
      }
      const ladderDue = (
        await db.query(
          `SELECT id FROM recheck_schedule
            WHERE title_group_id = $1 AND engine = $2
              AND active = true AND next_due_at <= $3`,
          [String(group.id), engine, now],
        )
      ).rows[0];
      if (ladderDue) {
        continue;
      }
      try {
        await db.query(
          `INSERT INTO scan
            (id, title_group_id, engine, trigger, due_date, requested_by,
             tracked_title_id, planned_queries, query_plan, state, queued_at,
             queued_reason, started_at, finished_at, issued_queries,
             failure_reason, failures, created_at)
           VALUES ($1, $2, $3, 'scheduled', $4, NULL, NULL, 0, NULL, 'queued',
                   $5, NULL, NULL, NULL, NULL, NULL, NULL, $5)`,
          [uuidv7(), String(group.id), engine, dueDate, now],
        );
        created += 1;
      } catch {
        // The unique key already holds the day's scan.
      }
    }
  }
  return created;
}

export async function createDueRechecks(
  db: Connectable,
  now: Date,
): Promise<number> {
  const dueDate = today(now);
  const ladders = (
    await db.query(
      "SELECT * FROM recheck_schedule WHERE active = true AND next_due_at <= $1",
      [now],
    )
  ).rows;
  let created = 0;
  for (const ladder of ladders) {
    const existing = (
      await db.query(
        "SELECT * FROM scan WHERE title_group_id = $1 AND engine = $2 AND due_date = $3",
        [String(ladder.title_group_id), String(ladder.engine), dueDate],
      )
    ).rows[0];
    if (existing) {
      if (existing.state === "queued" && existing.trigger === "scheduled") {
        await db.query("UPDATE scan SET trigger = 'recheck' WHERE id = $1", [
          String(existing.id),
        ]);
      } else if (
        (existing.state === "succeeded" || existing.state === "partial") &&
        existing.trigger === "scheduled" &&
        existing.finished_at
      ) {
        await updateLadderAfterScan(db, {
          titleGroupId: String(ladder.title_group_id),
          engine: String(ladder.engine),
          trigger: "recheck",
          scanId: String(existing.id),
          finishedAt: new Date(String(existing.finished_at)),
        });
      }
      continue;
    }
    try {
      await db.query(
        `INSERT INTO scan
          (id, title_group_id, engine, trigger, due_date, requested_by,
           tracked_title_id, planned_queries, query_plan, state, queued_at,
           queued_reason, started_at, finished_at, issued_queries,
           failure_reason, failures, created_at)
         VALUES ($1, $2, $3, 'recheck', $4, NULL, NULL, 0, NULL, 'queued',
                 $5, NULL, NULL, NULL, NULL, NULL, NULL, $5)`,
        [
          uuidv7(),
          String(ladder.title_group_id),
          String(ladder.engine),
          dueDate,
          now,
        ],
      );
      created += 1;
    } catch {
      // The unique key already holds the day's scan.
    }
  }
  return created;
}

export async function nextQueuedScan(
  db: Queryable,
  engine: Engine,
  options: {
    now?: Date;
    allowLowPriority?: boolean;
    exclude?: string[];
  } = {},
): Promise<Record<string, unknown> | undefined> {
  const now = options.now ?? new Date();
  const lowPriorityFilter =
    options.allowLowPriority === false
      ? "AND NOT (s.trigger = 'scheduled' AND g.priority = 'low')"
      : "";
  const exclude = options.exclude ?? [];
  const exclusionFilter =
    exclude.length > 0
      ? `AND s.id NOT IN (${exclude.map((_, index) => `$${index + 3}`).join(", ")})`
      : "";
  return (
    await db.query(
      `SELECT s.*
         FROM scan s
         JOIN title_group g ON g.id = s.title_group_id
         LEFT JOIN (
           SELECT title_group_id, max(finished_at) AS last_scan_at
             FROM scan
            WHERE engine = $1 AND finished_at IS NOT NULL
            GROUP BY title_group_id
         ) recent ON recent.title_group_id = s.title_group_id
        WHERE s.engine = $1
          AND (
            s.state = 'queued'
            OR (
              s.state = 'running'
              AND s.id NOT IN (
                SELECT scan_id FROM budget_reservation
                 WHERE state = 'held' AND expires_at > $2
              )
            )
          )
          ${lowPriorityFilter}
          ${exclusionFilter}
        ORDER BY
          CASE s.trigger
            WHEN 'manual' THEN 0
            WHEN 'manual_recheck' THEN 1
            WHEN 'recheck' THEN 2
            ELSE 3
          END,
          CASE
            WHEN s.trigger IN ('manual', 'manual_recheck') THEN 0
            ELSE CASE g.priority
              WHEN 'high' THEN 0
              WHEN 'normal' THEN 1
              ELSE 2
            END
          END,
          CASE
            WHEN s.trigger IN ('manual', 'manual_recheck') THEN s.created_at
            ELSE recent.last_scan_at
          END ASC,
          s.created_at ASC
        LIMIT 1`,
      [engine, now, ...exclude],
    )
  ).rows[0];
}

export async function runNext(
  db: Queryable,
  runner: ScanRunner,
  engine: Engine,
  options: { now?: Date; exclude?: string[] } = {},
) {
  const now = options.now ?? new Date();
  const share = await currentShare(db, engine, "scan", now);
  const allowLowPriority = !share || share.percent < 90;
  const row = await nextQueuedScan(db, engine, {
    now,
    allowLowPriority,
    exclude: options.exclude,
  });
  if (!row) {
    return undefined;
  }
  return runner.run(String(row.id));
}

export async function rollover(db: Connectable, now: Date): Promise<void> {
  await ensureLedger(db, now);
}

export async function expireReservationsJob(
  db: Connectable,
  now: Date,
): Promise<number> {
  return expireReservations(db, now);
}

export async function probeRoutes(
  db: Queryable,
  adapters: Partial<Record<Engine, SearchAdapter>>,
  now: Date,
): Promise<void> {
  const disabled = (
    await db.query("SELECT engine FROM engine_route WHERE disabled_at IS NOT NULL")
  ).rows;
  for (const row of disabled) {
    const engine = String(row.engine) as Engine;
    const adapter = adapters[engine];
    if (!adapter) {
      continue;
    }
    try {
      await adapter.probe();
      await db.query(
        `UPDATE engine_route
            SET disabled_at = NULL, disabled_reason = NULL,
                last_probe_at = $2, updated_at = $2
          WHERE engine = $1`,
        [engine, now],
      );
    } catch (error) {
      if (!(error instanceof AdapterError) || error.kind !== "retryable") {
        continue;
      }
      await db.query(
        "UPDATE engine_route SET last_probe_at = $2, updated_at = $2 WHERE engine = $1",
        [engine, now],
      );
    }
  }
}

export async function probeBalances(
  db: Queryable,
  runner: ScanRunner,
  adapters: Partial<Record<Engine, SearchAdapter>>,
  now: Date,
): Promise<void> {
  for (const engine of ENGINES) {
    const adapter = adapters[engine];
    if (!adapter?.balanceMinor) {
      continue;
    }
    let balance: number | undefined;
    try {
      balance = await adapter.balanceMinor();
    } catch {
      continue;
    }
    if (balance === undefined) {
      continue;
    }
    const cap = (
      await db.query(
        "SELECT monthly_cap_minor FROM acquisition_budget WHERE engine = $1",
        [engine],
      )
    ).rows[0];
    const capMinor = Number(cap?.monthly_cap_minor ?? 0);
    if (capMinor === 0) {
      continue;
    }
    const spent = (
      await db.query(
        "SELECT scan_committed, recheck_committed FROM quota_ledger WHERE engine = $1 AND month_start = $2",
        [engine, monthStart(now)],
      )
    ).rows[0];
    const committed =
      Number(spent?.scan_committed ?? 0) + Number(spent?.recheck_committed ?? 0);
    const unitPrice = UNIT_PRICE_PER_THOUSAND_MINOR[engine] ?? 0;
    const dailyBurn = Math.round(
      (committed * unitPrice) /
        1_000 /
        Math.max(1, now.getUTCDate()),
    );
    const threshold = Math.max(Math.round(capMinor / 10), dailyBurn);
    if (balance < threshold) {
      const existing = (
        await db.query(
          "SELECT id FROM budget_alert WHERE engine = $1 AND bucket = 'scan' AND threshold = 'balance' AND month_start = $2",
          [engine, monthStart(now)],
        )
      ).rows[0];
      if (!existing) {
        await db.query(
          `INSERT INTO budget_alert
            (id, engine, bucket, threshold, level, percent_used, message,
             groups_not_scanned, month_start, created_at)
           VALUES ($1, $2, 'scan', 'balance', 'critical', 0, $3, 0, $4, $5)`,
          [
            uuidv7(),
            engine,
            `The ${engine} provider balance is below the top-up threshold.`,
            monthStart(now),
            now,
          ],
        );
      }
    }
    if (balance <= 0) {
      await runner.disableRoute(engine, "provider balance exhausted", now);
    }
  }
}

function today(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(now.getUTCDate()).padStart(2, "0")}`;
}
