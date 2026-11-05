import { type EngineName } from "./pricing.js";
/**
 * The provider balance probe's port and thresholds (slice 3a). The daily
 * `budget.balance` job probes each provider's prepaid balance and alerts
 * when it will not cover what the ledger still allows. The balance is a
 * backstop, never the budget authority: Patrol's ledger decides what may
 * be spent (docs/design/scan-scheduling.md "Alerts").
 *
 * The adapters that actually call DataForSEO and Yandex implement the
 * probe through the acquisition port (slice 3b); this file fixes the
 * threshold arithmetic both sides share.
 */
/** One probe's reading, in the provider currency's minor units. */
export type ProviderBalanceResult = {
    outcome: "balance";
    balanceMinor: number;
} | {
    outcome: "unavailable";
    reason: string;
};
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
export declare function committedUnitsToMinor(engine: EngineName, committedUnits: number): number;
/**
 * The critical balance threshold: ten percent of the engine's monthly cap,
 * or one day's average burn where that is larger. A prepaid balance below
 * this will not cover what the ledger's remaining allowance implies, so
 * the probe prompts a top-up before a scan fails mid-route.
 */
export declare function balanceCriticalThresholdMinor(input: {
    engine: EngineName;
    monthlyCapMinor: number;
    committedUnits: number;
    daysElapsed: number;
}): number;
/** True when a provider balance sits below the critical threshold. */
export declare function isBalanceCritical(balanceMinor: number, thresholdMinor: number): boolean;
