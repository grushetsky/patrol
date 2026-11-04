import type { Pool, PoolClient } from "pg";
import { ApiError } from "../../errors.js";
import {
  allowanceUnits,
  type EngineName,
} from "../catalogue/capacity.js";
import { capFor, readCaps, type BudgetCapRow } from "./caps.js";
import type {
  BudgetBucketName,
  QuotaLedgerRow,
  ReservationRow,
} from "./serialize.js";

/**
 * The quota ledger (docs/design/scan-scheduling.md "Quota accounting",
 * ADR 0023). The ledger, not the provider, is the budget authority: one
 * row per engine and UTC calendar month, buckets split seventy-thirty by
 * the settings' re-check share, and a reservation taken in one
 * conditional transaction so two concurrent scans cannot both spend the
 * last of a bucket.
 *
 * Immutability: nothing deletes a ledger row and nothing decrements a
 * committed counter. The spend authority is the LIVE settings cap: a
 * raised cap lets queued work run in the opened month (budget-envelope
 * "Degradation order", step 3), while a lowered one refuses new
 * reservations without un-spending — the month over its new cap reads as
 * exhausted until the next month or a raise, and the row's
 * allowance_units snapshot stays as month history, never rewritten
 * (scan-scheduling, "Quota accounting", last paragraph).
 */

/** How long an unstarted reservation is held: one hour. */
export const RESERVATION_TTL_MS = 3_600_000;

/** The first day of the UTC month an instant belongs to. */
export function monthStartOf(at: Date): string {
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

/**
 * Splits an allowance into its buckets: the scan share is floored and the
 * remainder funds re-checks, so the two always sum to the allowance. The
 * re-check share is not borrowable by scans.
 */
export function bucketShares(
  allowanceUnits: number,
  recheckSharePercent: number,
): { scan: number; recheck: number } {
  const scan = Math.floor((allowanceUnits * (100 - recheckSharePercent)) / 100);
  return { scan, recheck: allowanceUnits - scan };
}

const LEDGER_COLUMNS = `id, engine, month_start::text as month_start, allowance_units, scan_reserved, scan_committed, recheck_reserved, recheck_committed`;

function mapLedgerRow(row: Record<string, unknown>): QuotaLedgerRow {
  return {
    id: String(row.id),
    engine: row.engine as EngineName,
    monthStart: String(row.month_start),
    allowanceUnits: Number(row.allowance_units),
    scanReserved: Number(row.scan_reserved),
    scanCommitted: Number(row.scan_committed),
    recheckReserved: Number(row.recheck_reserved),
    recheckCommitted: Number(row.recheck_committed),
  };
}

/**
 * Opens the month row for an engine if it is not open yet, with the
 * allowance the settings cap then buys. Idempotent: an existing row is
 * returned untouched, whatever the settings now say — the snapshot never
 * moves after the month opened. The caps arrive from the caller, so a
 * reserve reads them exactly once in its own transaction.
 */
async function ensureMonthRow(
  client: PoolClient,
  engine: EngineName,
  monthStart: string,
  caps: BudgetCapRow,
): Promise<QuotaLedgerRow> {
  const inserted = await client.query(
    `insert into quota_ledger (engine, month_start, allowance_units)
     values ($1, $2, $3)
     on conflict (engine, month_start) do nothing
     returning ${LEDGER_COLUMNS}`,
    [engine, monthStart, allowanceUnits(engine, capFor(caps, engine))],
  );
  if (inserted.rows.length > 0) {
    return mapLedgerRow(inserted.rows[0]);
  }
  const existing = await client.query(
    `select ${LEDGER_COLUMNS} from quota_ledger where engine = $1 and month_start = $2`,
    [engine, monthStart],
  );
  return mapLedgerRow(existing.rows[0]);
}

/** Opens (or returns) an engine's month row in its own transaction. */
export async function ensureMonth(
  pool: Pool,
  engine: EngineName,
  monthStart: string,
): Promise<QuotaLedgerRow> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const row = await ensureMonthRow(client, engine, monthStart, await readCaps(client));
    await client.query("commit");
    return row;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** The engine's month row, or null when the month has not opened. */
export async function readLedgerRow(
  pool: Pool | PoolClient,
  engine: EngineName,
  monthStart: string,
): Promise<QuotaLedgerRow | null> {
  const result = await pool.query(
    `select ${LEDGER_COLUMNS} from quota_ledger where engine = $1 and month_start = $2`,
    [engine, monthStart],
  );
  return result.rows.length === 0 ? null : mapLedgerRow(result.rows[0]);
}

/** Every engine's rows for one month, ordered by engine. */
export async function readMonthLedgerRows(
  pool: Pool | PoolClient,
  monthStart: string,
): Promise<QuotaLedgerRow[]> {
  const result = await pool.query(
    `select ${LEDGER_COLUMNS} from quota_ledger where month_start = $1 order by engine`,
    [monthStart],
  );
  return result.rows.map(mapLedgerRow);
}

const RESERVATION_COLUMNS = `id, scan_id, engine, month_start::text as month_start, bucket, units, state, created_at, expires_at, settled_at, committed_units, released_units`;

function mapReservationRow(row: Record<string, unknown>): ReservationRow {
  return {
    id: String(row.id),
    scanId: row.scan_id === null ? null : String(row.scan_id),
    engine: row.engine as EngineName,
    monthStart: String(row.month_start),
    bucket: row.bucket as BudgetBucketName,
    units: Number(row.units),
    state: row.state as ReservationRow["state"],
    createdAt: new Date(row.created_at as string),
    expiresAt: new Date(row.expires_at as string),
    settledAt:
      row.settled_at === null ? null : new Date(row.settled_at as string),
    committedUnits:
      row.committed_units === null ? null : Number(row.committed_units),
    releasedUnits:
      row.released_units === null ? null : Number(row.released_units),
  };
}

/** What a reserve call produced: a hold, or the bucket's refusal. */
export type ReserveResult =
  | { outcome: "reserved"; reservation: ReservationRow }
  | {
      outcome: "budget_exhausted";
      engine: EngineName;
      bucket: BudgetBucketName;
      shareUnits: number;
      usedUnits: number;
      remainingUnits: number;
    };

/**
 * Reserves billable units against a bucket in one transaction. The
 * conditional update is the arbitration: its WHERE clause admits the
 * increment only while reserved plus committed plus the request fits the
 * share, so of two concurrent transactions competing for a bucket's last
 * units exactly one lands (the other re-evaluates against the committed
 * row and is refused). A refused plan spends nothing — the caller keeps
 * its work queued with `budget_exhausted` rather than truncating it.
 */
export async function reserve(
  pool: Pool,
  now: () => Date,
  input: {
    engine: EngineName;
    bucket: BudgetBucketName;
    units: number;
    /** The scan holding the reservation; wired when scans exist (3b). */
    scanId?: string;
  },
): Promise<ReserveResult> {
  if (!Number.isInteger(input.units) || input.units <= 0) {
    throw new ApiError(422, "unprocessable", {
      fieldErrors: [
        { path: "/units", message: "a reservation holds a positive whole number of units" },
      ],
    });
  }
  const client = await pool.connect();
  try {
    await client.query("begin");
    const monthStart = monthStartOf(now());
    const caps = await readCaps(client);
    const row = await ensureMonthRow(client, input.engine, monthStart, caps);

    // The spend authority is the LIVE cap, never the month's snapshot:
    // raising the cap lets queued work run in the opened month, while
    // lowering it refuses new reservations without un-spending what the
    // conditional update has already admitted.
    const authority = allowanceUnits(input.engine, capFor(caps, input.engine));
    const shares = bucketShares(authority, caps.budget_recheck_share_percent);
    const share = input.bucket === "scan" ? shares.scan : shares.recheck;
    const column = input.bucket === "scan" ? "scan" : "recheck";

    const admitted = await client.query(
      `update quota_ledger
          set ${column}_reserved = ${column}_reserved + $1
        where id = $2
          and ${column}_reserved + ${column}_committed + $1 <= $3
        returning ${column}_reserved + ${column}_committed as used`,
      [input.units, row.id, share],
    );
    if (admitted.rowCount === 0) {
      const fresh = await client.query<{ used: number }>(
        `select ${column}_reserved + ${column}_committed as used from quota_ledger where id = $1`,
        [row.id],
      );
      const used = Number(fresh.rows[0].used);
      await client.query("rollback");
      return {
        outcome: "budget_exhausted",
        engine: input.engine,
        bucket: input.bucket,
        shareUnits: share,
        usedUnits: used,
        remainingUnits: Math.max(0, share - used),
      };
    }

    const createdAt = now();
    const inserted = await client.query(
      `insert into budget_reservations
         (scan_id, engine, month_start, bucket, units, state, created_at, expires_at)
       values ($1, $2, $3, $4, $5, 'held', $6, $7)
       returning ${RESERVATION_COLUMNS}`,
      [
        input.scanId ?? null,
        input.engine,
        monthStart,
        input.bucket,
        input.units,
        createdAt.toISOString(),
        new Date(createdAt.getTime() + RESERVATION_TTL_MS).toISOString(),
      ],
    );
    await client.query("commit");
    return { outcome: "reserved", reservation: mapReservationRow(inserted.rows[0]) };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Loads one reservation row for update, inside the caller's transaction. */
async function lockReservation(
  client: PoolClient,
  reservationId: string,
): Promise<Record<string, unknown>> {
  const result = await client.query(
    `select ${RESERVATION_COLUMNS} from budget_reservations where id = $1 for update`,
    [reservationId],
  );
  if (result.rows.length === 0) {
    throw new ApiError(404, "not_found");
  }
  return result.rows[0];
}

/**
 * Commits a reservation: the bucket's reserved counter falls by the whole
 * hold, committed rises by the units the scan actually issued, and a
 * partial scan's unissued remainder is released with it. The settlement
 * lands in the reservation's own month, so a scan that finishes after
 * midnight commits into the month it reserved. Committing a reservation
 * that is no longer held — expired, released, or already committed — is a
 * state conflict: the units are no longer this scan's to spend.
 */
export async function commitReservation(
  pool: Pool,
  now: () => Date,
  reservationId: string,
  actualUnits: number,
): Promise<ReservationRow> {
  if (!Number.isInteger(actualUnits) || actualUnits < 0) {
    throw new ApiError(422, "unprocessable", {
      fieldErrors: [
        { path: "/actualUnits", message: "a commit is a non-negative whole number of units" },
      ],
    });
  }
  const client = await pool.connect();
  try {
    await client.query("begin");
    const held = await lockReservation(client, reservationId);
    if (held.state !== "held") {
      throw new ApiError(409, "state_conflict");
    }
    const units = Number(held.units);
    if (actualUnits > units) {
      throw new ApiError(422, "unprocessable", {
        fieldErrors: [
          { path: "/actualUnits", message: "a scan cannot commit more units than it reserved" },
        ],
      });
    }
    const column = held.bucket === "scan" ? "scan" : "recheck";
    await client.query(
      `update quota_ledger
          set ${column}_reserved = ${column}_reserved - $1,
              ${column}_committed = ${column}_committed + $2
        where engine = $3 and month_start = $4`,
      [units, actualUnits, held.engine, held.month_start],
    );
    const settled = await client.query(
      `update budget_reservations
          set state = 'committed', settled_at = $2, committed_units = $3, released_units = $4
        where id = $1 and state = 'held'
        returning ${RESERVATION_COLUMNS}`,
      [reservationId, now().toISOString(), actualUnits, units - actualUnits],
    );
    await client.query("commit");
    return mapReservationRow(settled.rows[0]);
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Releases a hold: the reserved units return to their bucket and the
 * reservation records its release. Only a held reservation can be
 * released — a double release, or the release of an expired or committed
 * reservation, is a state conflict.
 */
export async function releaseReservation(
  pool: Pool,
  now: () => Date,
  reservationId: string,
): Promise<ReservationRow> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const held = await lockReservation(client, reservationId);
    if (held.state !== "held") {
      throw new ApiError(409, "state_conflict");
    }
    const column = held.bucket === "scan" ? "scan" : "recheck";
    await client.query(
      `update quota_ledger
          set ${column}_reserved = ${column}_reserved - $1
        where engine = $2 and month_start = $3`,
      [Number(held.units), held.engine, held.month_start],
    );
    const released = await client.query(
      `update budget_reservations
          set state = 'released', settled_at = $2, released_units = $3
        where id = $1 and state = 'held'
        returning ${RESERVATION_COLUMNS}`,
      [reservationId, now().toISOString(), Number(held.units)],
    );
    await client.query("commit");
    return mapReservationRow(released.rows[0]);
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Expires the holds whose hour ran out: each becomes expired with its
 * units released, and the reserved counters return the units to their
 * buckets. Committed units are never touched. One statement settles every
 * expired hold and adjusts every affected month row atomically; the job
 * wiring (the hourly sweep alongside pg-boss) arrives with slice 3b.
 * Returns how many holds expired.
 */
export async function expireReservations(
  pool: Pool,
  now: () => Date,
): Promise<number> {
  const result = await pool.query<{ expired_count: string }>(
    `with expired as (
       update budget_reservations
          set state = 'expired', settled_at = $1, released_units = units
        where state = 'held' and expires_at <= $1
       returning engine, month_start, bucket, units
     ), totals as (
       select engine, month_start,
              sum(units) filter (where bucket = 'scan') as scan_units,
              sum(units) filter (where bucket = 'recheck') as recheck_units
         from expired
        group by engine, month_start
     ), settled as (
       update quota_ledger ledger
          set scan_reserved = ledger.scan_reserved - coalesce(totals.scan_units, 0),
              recheck_reserved = ledger.recheck_reserved - coalesce(totals.recheck_units, 0)
         from totals
        where ledger.engine = totals.engine and ledger.month_start = totals.month_start
       returning 1
     )
     select count(*) as expired_count from expired`,
    [now().toISOString()],
  );
  return Number(result.rows[0].expired_count);
}
