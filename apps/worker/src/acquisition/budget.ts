import { v7 as uuidv7 } from "uuid";
import type { Connectable, Queryable } from "../db.js";
import type { BudgetBucket, Engine } from "./types.js";

export const UNIT_PRICE_PER_THOUSAND_MINOR: Record<string, number> = {
  google: 60,
  yandex: 25,
  bing: 0,
};

export interface LedgerRow {
  id: string;
  engine: string;
  month_start: string;
  allowance_units: number;
  scan_reserved: number;
  scan_committed: number;
  recheck_reserved: number;
  recheck_committed: number;
}

export interface ReservationRow {
  id: string;
  scan_id: string;
  engine: string;
  bucket: BudgetBucket;
  units: number;
  month_start: string;
  state: string;
  created_at: unknown;
  expires_at: unknown;
}

export function monthStart(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

export function bucketFor(trigger: string): BudgetBucket {
  return trigger === "recheck" || trigger === "manual_recheck"
    ? "recheck"
    : "scan";
}

export function sharesFor(
  allowanceUnits: number,
  recheckSharePercent: number,
): { scanShareUnits: number; recheckShareUnits: number } {
  const recheckShareUnits = Math.floor(
    (allowanceUnits * recheckSharePercent) / 100,
  );
  return {
    scanShareUnits: allowanceUnits - recheckShareUnits,
    recheckShareUnits,
  };
}

/** The month's ledger row for every configured engine, created when absent. */
export async function ensureLedger(
  db: Queryable,
  now: Date,
): Promise<LedgerRow[]> {
  const caps = (await db.query("SELECT * FROM acquisition_budget")).rows;
  const month = monthStart(now);
  const rows: LedgerRow[] = [];
  for (const cap of caps) {
    const engine = String(cap.engine);
    const existing = (
      await db.query(
        "SELECT * FROM quota_ledger WHERE engine = $1 AND month_start = $2",
        [engine, month],
      )
    ).rows[0];
    if (existing) {
      rows.push(toLedger(existing));
      continue;
    }
    const price = UNIT_PRICE_PER_THOUSAND_MINOR[engine] ?? 0;
    const allowance = price === 0
      ? 0
      : Math.floor((Number(cap.monthly_cap_minor) * 1_000) / price);
    try {
      await db.query(
        `INSERT INTO quota_ledger
          (id, engine, month_start, allowance_units, scan_reserved,
           scan_committed, recheck_reserved, recheck_committed)
         VALUES ($1, $2, $3, $4, 0, 0, 0, 0)`,
        [uuidv7(), engine, month, allowance],
      );
    } catch {
      // Another worker opened the month first; read its row below.
    }
    const created = (
      await db.query(
        "SELECT * FROM quota_ledger WHERE engine = $1 AND month_start = $2",
        [engine, month],
      )
    ).rows[0];
    rows.push(toLedger(created));
  }
  return rows;
}

export async function currentShare(
  db: Queryable,
  engine: Engine,
  bucket: BudgetBucket,
  now: Date,
): Promise<
  | {
      remaining: number;
      shareUnits: number;
      ledger: LedgerRow;
      percent: number;
    }
  | undefined
> {
  await ensureLedger(db, now);
  const row = (
    await db.query(
      "SELECT * FROM quota_ledger WHERE engine = $1 AND month_start = $2",
      [engine, monthStart(now)],
    )
  ).rows[0];
  if (!row) {
    return undefined;
  }
  const setting = (
    await db.query(
      "SELECT value FROM application_setting WHERE key = 'recheck_share_percent'",
    )
  ).rows[0];
  const ledger = toLedger(row);
  const shares = sharesFor(ledger.allowance_units, Number(setting?.value ?? 30));
  const used =
    bucket === "scan"
      ? ledger.scan_reserved + ledger.scan_committed
      : ledger.recheck_reserved + ledger.recheck_committed;
  const share =
    bucket === "scan" ? shares.scanShareUnits : shares.recheckShareUnits;
  return {
    remaining: share - used,
    shareUnits: share,
    ledger,
    percent: share === 0 ? 100 : (used / share) * 100,
  };
}

/**
 * Hold units in one conditional update, so two scans cannot spend the last of
 * a bucket. Returns the reservation, or undefined when the plan does not fit.
 */
export async function reserve(
  db: Connectable,
  input: {
    scanId: string;
    engine: Engine;
    bucket: BudgetBucket;
    units: number;
    now: Date;
  },
): Promise<ReservationRow | undefined> {
  const share = await currentShare(db, input.engine, input.bucket, input.now);
  if (!share || input.units > share.remaining) {
    return undefined;
  }
  const column =
    input.bucket === "scan" ? "scan_reserved" : "recheck_reserved";
  const committedColumn =
    input.bucket === "scan" ? "scan_committed" : "recheck_committed";
  const month = monthStart(input.now);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const updated = await client.query(
      `UPDATE quota_ledger
          SET ${column} = ${column} + $3
        WHERE engine = $1 AND month_start = $2
          AND ${column} + ${committedColumn} + $3 <= $4
        RETURNING id`,
      [input.engine, month, input.units, share.shareUnits],
    );
    if (updated.rows.length === 0) {
      await client.query("ROLLBACK");
      return undefined;
    }
    const id = uuidv7();
    const expiresAt = new Date(input.now.getTime() + 60 * 60 * 1000);
    await client.query(
      `INSERT INTO budget_reservation
        (id, scan_id, engine, bucket, units, month_start, state, created_at,
         expires_at, settled_at, committed_units, released_units)
       VALUES ($1, $2, $3, $4, $5, $6, 'held', $7, $8, NULL, NULL, NULL)`,
      [
        id,
        input.scanId,
        input.engine,
        input.bucket,
        input.units,
        month,
        input.now,
        expiresAt,
      ],
    );
    await client.query("COMMIT");
    return {
      id,
      scan_id: input.scanId,
      engine: input.engine,
      bucket: input.bucket,
      units: input.units,
      month_start: month,
      state: "held",
      created_at: input.now,
      expires_at: expiresAt,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Convert a reservation into committed units and release the remainder. */
export async function settle(
  db: Connectable,
  input: {
    reservation: ReservationRow;
    committedUnits: number;
    now: Date;
  },
): Promise<void> {
  const committed = Math.max(
    0,
    Math.min(input.committedUnits, input.reservation.units),
  );
  const released = input.reservation.units - committed;
  const column =
    input.reservation.bucket === "scan" ? "scan" : "recheck";
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const settled = await client.query(
      `UPDATE budget_reservation
          SET state = $2, settled_at = $3, committed_units = $4,
              released_units = $5
        WHERE id = $1 AND state = 'held'
        RETURNING id`,
      [
        input.reservation.id,
        committed > 0 ? "committed" : "released",
        input.now,
        committed,
        released,
      ],
    );
    if (settled.rows.length > 0) {
      await client.query(
        `UPDATE quota_ledger
            SET ${column}_reserved = ${column}_reserved - $3,
                ${column}_committed = ${column}_committed + $4
          WHERE engine = $1 AND month_start = $2`,
        [
          input.reservation.engine,
          input.reservation.month_start,
          input.reservation.units,
          committed,
        ],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Release unstarted holds and stale holds left by a crashed worker. */
export async function expireReservations(
  db: Connectable,
  now: Date,
): Promise<number> {
  const expired = (
    await db.query(
      `SELECT r.*, s.state AS scan_state, s.last_heartbeat_at
         FROM budget_reservation r
         JOIN scan s ON s.id = r.scan_id
        WHERE r.state = 'held' AND r.expires_at <= $1`,
      [now],
    )
  ).rows;
  let released = 0;
  for (const row of expired) {
    const scanState = String(row.scan_state ?? "");
    const heartbeat = row.last_heartbeat_at
      ? new Date(String(row.last_heartbeat_at))
      : undefined;
    const stale =
      scanState === "running" &&
      (!heartbeat || now.getTime() - heartbeat.getTime() >= 60 * 60 * 1000);
    if (scanState !== "queued" && !stale) {
      continue;
    }
    await settle(db, {
      reservation: toReservation(row),
      committedUnits: 0,
      now,
    });
    await db.query(
      "UPDATE budget_reservation SET state = 'expired' WHERE id = $1",
      [String(row.id)],
    );
    if (stale) {
      await db.query(
        `UPDATE scan
            SET state = 'queued', started_at = NULL, last_heartbeat_at = NULL,
                finished_at = NULL, issued_queries = NULL, failure_reason = NULL,
                failures = NULL
          WHERE id = $1`,
        [String(row.scan_id)],
      );
    }
    released += 1;
  }
  return released;
}

export async function evaluateAlerts(
  db: Queryable,
  engine: string,
  now: Date,
): Promise<void> {
  const row = (
    await db.query(
      "SELECT * FROM quota_ledger WHERE engine = $1 AND month_start = $2",
      [engine, monthStart(now)],
    )
  ).rows[0];
  if (!row) {
    return;
  }
  const setting = (
    await db.query(
      "SELECT value FROM application_setting WHERE key = 'recheck_share_percent'",
    )
  ).rows[0];
  const ledger = toLedger(row);
  const shares = sharesFor(ledger.allowance_units, Number(setting?.value ?? 30));
  const groupsNotScanned = await countGroupsNotScanned(db, engine, now);
  const alerts: Array<{
    bucket: BudgetBucket;
    threshold: string;
    level: "warning" | "critical";
    percent: number;
    message: string;
  }> = [];
  if (ledger.allowance_units > 0) {
    const overall =
      ((ledger.scan_reserved +
        ledger.scan_committed +
        ledger.recheck_reserved +
        ledger.recheck_committed) /
        ledger.allowance_units) *
      100;
    if (overall >= 75) {
      alerts.push({
        bucket: "scan",
        threshold: "75",
        level: "warning",
        percent: overall,
        message: `${engine} has used ${Math.round(overall)}% of its monthly allowance.`,
      });
    }
  }
  for (const bucket of ["scan", "recheck"] as const) {
    const share =
      bucket === "scan" ? shares.scanShareUnits : shares.recheckShareUnits;
    if (share <= 0) {
      continue;
    }
    const used =
      bucket === "scan"
        ? ledger.scan_reserved + ledger.scan_committed
        : ledger.recheck_reserved + ledger.recheck_committed;
    const percent = (used / share) * 100;
    if (percent >= 90) {
      alerts.push({
        bucket,
        threshold: "90",
        level: "critical",
        percent,
        message: `${engine} ${bucket} share is at ${Math.round(percent)}%.`,
      });
    }
    if (percent >= 100) {
      alerts.push({
        bucket,
        threshold: "100",
        level: "critical",
        percent,
        message: `${engine} ${bucket} share is spent; new ${bucket} work queues.`,
      });
    }
  }
  for (const alert of alerts) {
    const existing = (
      await db.query(
        "SELECT id FROM budget_alert WHERE engine = $1 AND bucket = $2 AND threshold = $3 AND month_start = $4",
        [engine, alert.bucket, alert.threshold, monthStart(now)],
      )
    ).rows[0];
    if (existing) {
      continue;
    }
    try {
      await db.query(
        `INSERT INTO budget_alert
          (id, engine, bucket, threshold, level, percent_used, message,
           groups_not_scanned, month_start, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          uuidv7(),
          engine,
          alert.bucket,
          alert.threshold,
          alert.level,
          alert.percent,
          alert.message,
          groupsNotScanned,
          monthStart(now),
          now,
        ],
      );
    } catch {
      // A concurrent scan fired the same threshold first.
    }
  }
}

async function countGroupsNotScanned(
  db: Queryable,
  engine: string,
  now: Date,
): Promise<number> {
  const month = monthStart(now);
  const result = (
    await db.query(
      `SELECT count(*) AS count FROM title_group
        WHERE id NOT IN (
          SELECT title_group_id FROM scan
           WHERE engine = $1 AND created_at >= $2
        )`,
      [engine, `${month}T00:00:00.000Z`],
    )
  ).rows[0];
  return Number(result?.count ?? 0);
}

function toLedger(row: Record<string, unknown>): LedgerRow {
  return {
    id: String(row.id),
    engine: String(row.engine),
    month_start: String(row.month_start),
    allowance_units: Number(row.allowance_units),
    scan_reserved: Number(row.scan_reserved),
    scan_committed: Number(row.scan_committed),
    recheck_reserved: Number(row.recheck_reserved),
    recheck_committed: Number(row.recheck_committed),
  };
}

export function toReservation(row: Record<string, unknown>): ReservationRow {
  return {
    id: String(row.id),
    scan_id: String(row.scan_id),
    engine: String(row.engine),
    bucket: String(row.bucket) as BudgetBucket,
    units: Number(row.units),
    month_start: String(row.month_start),
    state: String(row.state),
    created_at: row.created_at,
    expires_at: row.expires_at,
  };
}
