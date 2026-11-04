import {
  UNIT_PRICE_MINOR_PER_THOUSAND,
  type EngineName,
} from "../catalogue/capacity.js";

/**
 * The provider balance probe's port and thresholds (slice 3a). The daily
 * `budget.balance` job probes each provider's prepaid balance and alerts
 * when it will not cover what the ledger still allows. The balance is a
 * backstop, never the budget authority: Patrol's ledger decides what may
 * be spent (docs/design/scan-scheduling.md "Alerts").
 *
 * The adapters that actually call DataForSEO and Yandex arrive with slice
 * 3b; this file fixes only the port they implement and the threshold
 * arithmetic both sides share.
 */

/** One probe's reading, in the provider currency's minor units. */
export type ProviderBalanceResult =
  | { outcome: "balance"; balanceMinor: number }
  | { outcome: "unavailable"; reason: string };

/**
 * The port a provider adapter implements: one probe per engine, returning
 * the account's prepaid balance in minor units or an explicit
 * unavailability a probe run records rather than smoothing away.
 */
export interface ProviderBalanceProbe {
  /** The engine whose provider account is probed. */
  readonly engine: EngineName;
  /** Reads the provider's prepaid balance once. */
  probe(): Promise<ProviderBalanceResult>;
}

/** The billable units an engine has committed, in minor units. */
export function committedUnitsToMinor(
  engine: EngineName,
  committedUnits: number,
): number {
  if (engine === "bing") {
    // Bing is deferred: no route is bought, so nothing bills.
    return 0;
  }
  return (committedUnits * UNIT_PRICE_MINOR_PER_THOUSAND[engine]) / 1000;
}

/**
 * The critical balance threshold: ten percent of the engine's monthly cap,
 * or one day's average burn where that is larger. A prepaid balance below
 * this will not cover what the ledger's remaining allowance implies, so
 * the probe prompts a top-up before a scan fails mid-route.
 */
export function balanceCriticalThresholdMinor(input: {
  engine: EngineName;
  monthlyCapMinor: number;
  committedUnits: number;
  daysElapsed: number;
}): number {
  const tenPercentOfCap = input.monthlyCapMinor / 10;
  const days = Math.max(1, input.daysElapsed);
  const oneDayBurn = committedUnitsToMinor(
    input.engine,
    input.committedUnits,
  ) / days;
  return Math.max(tenPercentOfCap, oneDayBurn);
}

/** True when a provider balance sits below the critical threshold. */
export function isBalanceCritical(
  balanceMinor: number,
  thresholdMinor: number,
): boolean {
  return balanceMinor < thresholdMinor;
}
