import type { Pool, PoolClient } from "pg";
import { type EngineName } from "./pricing.js";
import type { BudgetAlertRow } from "./rows.js";
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
/**
 * A bucket reads as spent once its usage reaches its share, or once spend
 * stands past a share a lowered cap has shrunk into nothing: the one
 * exhaustion rule the alert evaluator, the settings overview, and the
 * dashboard's engine row all answer from. Integer-safe comparisons keep
 * boundary spends exact: 749 of 1,000 is not spent, 750 is.
 */
export declare function isBucketExhausted(used: number, share: number): boolean;
/**
 * The pure threshold evaluation: which alerts the spend and balance have
 * crossed, in a fixed order (warning, scan critical, recheck critical,
 * scan exhaustion, recheck exhaustion, balance). Integer-safe comparisons
 * keep boundary spends exact: 749 of 1,000 fires nothing, 750 fires.
 */
export declare function dueAlerts(input: {
    engine: EngineName;
    monthlyCapMinor: number;
    snapshot: SpendSnapshot;
    /** The provider balance reading, when the daily probe has one. */
    balance?: {
        balanceMinor: number;
    };
    /** Month-to-date days of burn behind the one-day-average rule. */
    daysElapsed?: number;
}): DueAlert[];
/**
 * Evaluates one engine's month against the thresholds and fires what has
 * not fired yet. Reads the live caps and the month's counters (a month
 * that has not opened reads as unspent — alerting never opens one),
 * computes the due thresholds, and inserts each with fire-once: a
 * threshold whose row already exists inserts nothing. Returns only the
 * alerts this call fired.
 */
export declare function evaluateBudgetAlerts(pool: Pool, input: {
    engine: EngineName;
    now: () => Date;
    /** Defaults to the month the clock reads. */
    monthStart?: string;
    /** The provider balance reading, when a probe accompanies the run. */
    balance?: {
        balanceMinor: number;
    };
}): Promise<BudgetAlertRow[]>;
/** The alerts that have fired for one month, oldest first. */
export declare function listMonthAlerts(pool: Pool | PoolClient, monthStart: string): Promise<BudgetAlertRow[]>;
