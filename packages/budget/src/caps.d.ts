import type { Pool, PoolClient } from "pg";
import type { EngineName } from "./pricing.js";
/**
 * The one reader of the budget settings columns (docs/design/
 * budget-envelope.md "Who decides, and what changes the numbers"). The caps
 * live on the rights holder row, and every budget path — the reservation
 * preflight, the monthly rollover, the alert thresholds — reads them the
 * same way: on the caller's connection (so a reserve sees them inside its
 * own transaction) and refusing with setup_required when bootstrap has not
 * run. The live cap is the spend authority; the ledger's allowance_units
 * snapshot is month history.
 */
/** The budget columns the rights holder row stores. */
export interface BudgetCapRow {
    budget_google_monthly_cap_minor: number;
    budget_yandex_monthly_cap_minor: number;
    budget_bing_monthly_cap_minor: number;
    budget_recheck_share_percent: number;
}
/**
 * The caps as the rights holder row stores them, read on the caller's
 * connection so a reserve sees them inside its own transaction.
 */
export declare function readCaps(client: Pool | PoolClient): Promise<BudgetCapRow>;
/** One engine's monthly cap, in minor units. */
export declare function capFor(row: BudgetCapRow, engine: EngineName): number;
