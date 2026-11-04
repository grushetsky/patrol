import type { Locale, MessageKey } from "@patrol/i18n";
import { t } from "@patrol/i18n";
import type { EngineName } from "../catalogue/capacity.js";

/**
 * Row types and JSON mappers for the budget read models. Every mapper
 * emits the contract's shape (Patrol.Domain.QuotaLedger,
 * Patrol.Http.BudgetAlert); omitted optionals stay absent rather than
 * null. The alert's message is composed here in the requesting operator's
 * language, the mail templates' interpolation pattern.
 */

export type BudgetEngine = EngineName;
export type BudgetBucketName = "scan" | "recheck";
export type ReservationStateName = "held" | "committed" | "released" | "expired";
export type AlertThresholdName = "warning" | "critical" | "exhausted" | "balance";
export type AlertLevelName = "warning" | "critical";

export interface QuotaLedgerRow {
  id: string;
  engine: BudgetEngine;
  monthStart: string;
  allowanceUnits: number;
  scanReserved: number;
  scanCommitted: number;
  recheckReserved: number;
  recheckCommitted: number;
}

export interface ReservationRow {
  id: string;
  scanId: string | null;
  engine: BudgetEngine;
  monthStart: string;
  bucket: BudgetBucketName;
  units: number;
  state: ReservationStateName;
  createdAt: Date;
  expiresAt: Date;
  settledAt: Date | null;
  committedUnits: number | null;
  releasedUnits: number | null;
}

export interface BudgetAlertRow {
  id: string;
  engine: BudgetEngine;
  monthStart: string;
  threshold: AlertThresholdName;
  bucket: BudgetBucketName | null;
  level: AlertLevelName;
  percentUsed: number;
  groupsNotScanned: number;
  firedAt: Date;
}

/** The contract's QuotaLedger shape. */
export function quotaLedgerJson(row: QuotaLedgerRow): Record<string, unknown> {
  return {
    id: row.id,
    engine: row.engine,
    monthStart: row.monthStart,
    allowanceUnits: row.allowanceUnits,
    scanReserved: row.scanReserved,
    scanCommitted: row.scanCommitted,
    recheckReserved: row.recheckReserved,
    recheckCommitted: row.recheckCommitted,
  };
}

/** Fills a catalogue template's `{param}` placeholders. */
function interpolate(
  template: string,
  values: Record<string, string>,
): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    values[key] ?? match,
  );
}

/** The catalogue key each threshold's message renders through. */
const ALERT_MESSAGE_KEYS: Record<AlertThresholdName, MessageKey> = {
  warning: "budget.alert.warning",
  critical: "budget.alert.critical",
  exhausted: "budget.alert.exhausted",
  balance: "budget.alert.balance",
};

/**
 * The contract's BudgetAlert shape. Engine-level thresholds (the monthly
 * warning and the provider-balance critical) carry no bucket of their own
 * and omit the field; the bucket thresholds (the ninety-percent critical
 * and the exhaustion) carry theirs. The percent is the share the alert
 * measured: of the monthly allowance for the warning, of the bucket for
 * its thresholds, and of the cap for the balance. The engine-level message
 * templates interpolate no bucket, so nothing is lost in the message.
 */
export function budgetAlertJson(
  row: BudgetAlertRow,
  locale: Locale,
): Record<string, unknown> {
  const percent = trimPercent(row.percentUsed);
  const message = interpolate(
    t(locale, ALERT_MESSAGE_KEYS[row.threshold]),
    {
      engine: row.engine,
      ...(row.bucket === null ? {} : { bucket: row.bucket }),
      percent,
    },
  );
  return {
    engine: row.engine,
    ...(row.bucket === null ? {} : { bucket: row.bucket }),
    level: row.level,
    percentUsed: row.percentUsed,
    message,
    groupsNotScanned: row.groupsNotScanned,
  };
}

/** A percentage rendered for a message: integral values lose the tail. */
function trimPercent(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
