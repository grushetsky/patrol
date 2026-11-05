import type { Pool, PoolClient } from "pg";
import { allowanceUnits, type EngineName } from "./pricing.js";
import type { BudgetAlertRow } from "./rows.js";
import {
  balanceCriticalThresholdMinor,
  isBalanceCritical,
} from "./balance-probe.js";
import { capFor, readCaps } from "./caps.js";
import { bucketShares, monthStartOf, readLedgerRow } from "./ledger.js";

/**
 * The alert evaluator (docs/design/scan-scheduling.md "Alerts",
 * docs/design/budget-envelope.md "Alerts"). Thresholds apply per engine
 * and per bucket, and each fires once per threshold per engine per month:
 * the database's unique key enforces the fire-once rule, so a spent
 * bucket does not produce a message a minute.
 *
 * The thresholds read the LIVE settings cap, not the month's snapshot:
 * an operator who lowers the cap below what is already committed cannot
 * un-spend it — the month is over its new cap and alerting treats it as
 * exhausted until the next month or a raised allowance. Alert delivery to
 * the operator mailbox arrives with slice 9; the rows are written now.
 */

/** The thresholds an alert row can carry. */
export type AlertThreshold = BudgetAlertRow["threshold"];

/** One threshold the spend has crossed, before fire-once deduplication. */
export interface DueAlert {
  threshold: AlertThreshold;
  /** The bucket that reached the threshold; null for engine-level rules. */
  bucket: BudgetAlertRow["bucket"];
  level: BudgetAlertRow["level"];
  /** The share the alert measured, as a percentage. */
  percentUsed: number;
}

/** A month's counters and the settings the thresholds read. */
export interface SpendSnapshot {
  /** The allowance the live settings cap buys. */
  allowanceUnits: number;
  /** The settings' re-check share, in percent. */
  recheckSharePercent: number;
  scanReserved: number;
  scanCommitted: number;
  recheckReserved: number;
  recheckCommitted: number;
}

/** A share as a percentage, rounded to one decimal. */
function percent(used: number, of: number): number {
  if (of <= 0) {
    // A zero base with spend past it (a lowered cap) reads as its own
    // overshoot percentage; with nothing spent it reads as zero.
    return used > 0 ? 100 : 0;
  }
  return Math.round((used * 1000) / of) / 10;
}

/**
 * The pure threshold evaluation: which alerts the spend and balance have
 * crossed, in a fixed order (warning, scan critical, recheck critical,
 * scan exhaustion, recheck exhaustion, balance). Integer-safe comparisons
 * keep boundary spends exact: 749 of 1,000 fires nothing, 750 fires.
 */
export function dueAlerts(input: {
  engine: EngineName;
  monthlyCapMinor: number;
  snapshot: SpendSnapshot;
  /** The provider balance reading, when the daily probe has one. */
  balance?: { balanceMinor: number };
  /** Month-to-date days of burn behind the one-day-average rule. */
  daysElapsed?: number;
}): DueAlert[] {
  const snapshot = input.snapshot;
  const shares = bucketShares(snapshot.allowanceUnits, snapshot.recheckSharePercent);
  const scanUsed = snapshot.scanReserved + snapshot.scanCommitted;
  const recheckUsed = snapshot.recheckReserved + snapshot.recheckCommitted;
  const totalUsed = scanUsed + recheckUsed;
  const alerts: DueAlert[] = [];

  // 75% of the monthly allowance is a warning.
  if (
    snapshot.allowanceUnits > 0 &&
    totalUsed * 100 >= snapshot.allowanceUnits * 75
  ) {
    alerts.push({
      threshold: "warning",
      bucket: null,
      level: "warning",
      percentUsed: percent(totalUsed, snapshot.allowanceUnits),
    });
  }

  const buckets = [
    { bucket: "scan" as const, used: scanUsed, share: shares.scan },
    { bucket: "recheck" as const, used: recheckUsed, share: shares.recheck },
  ];
  for (const { bucket, used, share } of buckets) {
    if (share > 0 && used * 100 >= share * 90) {
      alerts.push({
        threshold: "critical",
        bucket,
        level: "critical",
        percentUsed: percent(used, share),
      });
    }
    // 100% of a bucket queues new work: exhausted, and critical with it.
    if ((share > 0 && used >= share) || (share <= 0 && used > 0)) {
      alerts.push({
        threshold: "exhausted",
        bucket,
        level: "critical",
        percentUsed: percent(used, share),
      });
    }
  }

  if (input.balance !== undefined) {
    const threshold = balanceCriticalThresholdMinor({
      engine: input.engine,
      monthlyCapMinor: input.monthlyCapMinor,
      committedUnits: snapshot.scanCommitted + snapshot.recheckCommitted,
      daysElapsed: input.daysElapsed ?? 1,
    });
    if (isBalanceCritical(input.balance.balanceMinor, threshold)) {
      alerts.push({
        threshold: "balance",
        bucket: null,
        level: "critical",
        percentUsed: percent(
          input.balance.balanceMinor,
          input.monthlyCapMinor,
        ),
      });
    }
  }
  return alerts;
}

const ALERT_COLUMNS = `id, engine, month_start::text as month_start, threshold, bucket, level, percent_used, groups_not_scanned, fired_at`;

function mapAlertRow(row: Record<string, unknown>): BudgetAlertRow {
  return {
    id: String(row.id),
    engine: row.engine as EngineName,
    monthStart: String(row.month_start),
    threshold: row.threshold as BudgetAlertRow["threshold"],
    bucket: row.bucket === null ? null : (row.bucket as BudgetAlertRow["bucket"]),
    level: row.level as BudgetAlertRow["level"],
    percentUsed: Number(row.percent_used),
    groupsNotScanned: Number(row.groups_not_scanned),
    firedAt: new Date(row.fired_at as string),
  };
}

/**
 * How many groups have not completed a scan on this engine inside the
 * month: a group counts as scanned once any of its scans on the engine
 * reached `succeeded` or `partial`.
 */
async function countGroupsNotScanned(
  client: PoolClient,
  engine: EngineName,
  monthStart: string,
): Promise<number> {
  const result = await client.query<{ count: string }>(
    `select count(*) as count from title_groups groups
      where not exists (
        select 1 from scans scan
         where scan.title_group_id = groups.id
           and scan.engine = $1
           and scan.due_date >= $2::date
           and scan.state in ('succeeded', 'partial')
      )`,
    [engine, monthStart],
  );
  return Number(result.rows[0].count);
}

/** The month-to-date days behind the one-day-average burn rule. */
function daysElapsedSince(monthStart: string, now: Date): number {
  const elapsed = Math.floor(
    (now.getTime() - Date.parse(`${monthStart}T00:00:00.000Z`)) / 86_400_000,
  );
  return Math.min(31, Math.max(1, elapsed + 1));
}

/**
 * Evaluates one engine's month against the thresholds and fires what has
 * not fired yet. Reads the live caps and the month's counters (a month
 * that has not opened reads as unspent — alerting never opens one),
 * computes the due thresholds, and inserts each with fire-once: a
 * threshold whose row already exists inserts nothing. Returns only the
 * alerts this call fired.
 */
export async function evaluateBudgetAlerts(
  pool: Pool,
  input: {
    engine: EngineName;
    now: () => Date;
    /** Defaults to the month the clock reads. */
    monthStart?: string;
    /** The provider balance reading, when a probe accompanies the run. */
    balance?: { balanceMinor: number };
  },
): Promise<BudgetAlertRow[]> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const now = input.now();
    const monthStart = input.monthStart ?? monthStartOf(now);
    const caps = await readCaps(client);
    const monthlyCapMinor = capFor(caps, input.engine);
    const row = await readLedgerRow(client, input.engine, monthStart);
    const snapshot: SpendSnapshot = {
      allowanceUnits: allowanceUnits(input.engine, monthlyCapMinor),
      recheckSharePercent: caps.budget_recheck_share_percent,
      scanReserved: row?.scanReserved ?? 0,
      scanCommitted: row?.scanCommitted ?? 0,
      recheckReserved: row?.recheckReserved ?? 0,
      recheckCommitted: row?.recheckCommitted ?? 0,
    };
    const groupsNotScanned = await countGroupsNotScanned(client, input.engine, monthStart);
    const due = dueAlerts({
      engine: input.engine,
      monthlyCapMinor,
      snapshot,
      balance: input.balance,
      daysElapsed: daysElapsedSince(monthStart, now),
    });

    const fired: BudgetAlertRow[] = [];
    for (const alert of due) {
      const inserted = await client.query(
        `insert into budget_alerts
           (engine, month_start, threshold, bucket, level, percent_used, groups_not_scanned, fired_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8)
         on conflict (engine, month_start, threshold, bucket) do nothing
         returning ${ALERT_COLUMNS}`,
        [
          input.engine,
          monthStart,
          alert.threshold,
          alert.bucket,
          alert.level,
          alert.percentUsed,
          groupsNotScanned,
          now.toISOString(),
        ],
      );
      if (inserted.rows.length > 0) {
        fired.push(mapAlertRow(inserted.rows[0]));
      }
    }
    await client.query("commit");
    return fired;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** The alerts that have fired for one month, oldest first. */
export async function listMonthAlerts(
  pool: Pool | PoolClient,
  monthStart: string,
): Promise<BudgetAlertRow[]> {
  const result = await pool.query(
    `select ${ALERT_COLUMNS} from budget_alerts where month_start = $1 order by fired_at, id`,
    [monthStart],
  );
  return result.rows.map(mapAlertRow);
}
