import type { Pool } from "pg";
import { allowanceUnits, type EngineName } from "../catalogue/capacity.js";
import { capFor, readCaps } from "./caps.js";
import { monthStartOf } from "./ledger.js";

/**
 * The monthly rollover (docs/design/scan-scheduling.md "Jobs",
 * `budget.rollover`): on the first at 00:00 UTC it opens the new month's
 * allowance from the settings caps as they then stand and closes the old
 * one. Nothing carries over — the allowance is monthly, with no
 * accumulation — and the old month's row is never rewritten: reservations
 * made before midnight stay in the month they were made, even if their
 * scans finish after it. The cron wiring arrives with slice 3b; the
 * function and its tests stand now.
 */

/** Every engine the ledger carries a month row for, Bing at zero included. */
const ENGINES: readonly EngineName[] = ["google", "bing", "yandex"];

/** One engine's month after a rollover run. */
export interface RolloverOutcome {
  engine: EngineName;
  monthStart: string;
  /** Whether this run opened the row; false when it already stood. */
  created: boolean;
  /** The allowance the settings cap bought when the row opened. */
  allowanceUnits: number;
}

/**
 * Opens the current month's rows from the current settings caps, in one
 * transaction. Idempotent: a row that already stands is left exactly as
 * it is and reported with created false, so a job restart or a duplicate
 * wake-up changes nothing. Reads the caps through the shared reader, so
 * an unbootstrapped database refuses with setup_required like every
 * other budget path.
 */
export async function rollOverMonth(
  pool: Pool,
  now: () => Date,
): Promise<RolloverOutcome[]> {
  const monthStart = monthStartOf(now());
  const client = await pool.connect();
  try {
    await client.query("begin");
    const caps = await readCaps(client);
    const outcomes: RolloverOutcome[] = [];
    for (const engine of ENGINES) {
      const allowance = allowanceUnits(engine, capFor(caps, engine));
      const inserted = await client.query(
        `insert into quota_ledger (engine, month_start, allowance_units)
         values ($1, $2, $3)
         on conflict (engine, month_start) do nothing
         returning allowance_units`,
        [engine, monthStart, allowance],
      );
      outcomes.push({
        engine,
        monthStart,
        created: inserted.rows.length > 0,
        allowanceUnits:
          inserted.rows.length > 0
            ? Number(inserted.rows[0].allowance_units)
            : allowance,
      });
    }
    await client.query("commit");
    return outcomes;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
