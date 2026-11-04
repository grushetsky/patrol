import type { Pool, PoolClient } from "pg";
import { ApiError } from "../../errors.js";
import type { EngineName } from "../catalogue/capacity.js";

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
export async function readCaps(
  client: Pool | PoolClient,
): Promise<BudgetCapRow> {
  const result = await client.query<BudgetCapRow>(
    "select budget_google_monthly_cap_minor, budget_yandex_monthly_cap_minor, budget_bing_monthly_cap_minor, budget_recheck_share_percent from rights_holder limit 1",
  );
  if (result.rows.length === 0) {
    throw new ApiError(503, "setup_required");
  }
  return result.rows[0];
}

/** One engine's monthly cap, in minor units. */
export function capFor(row: BudgetCapRow, engine: EngineName): number {
  switch (engine) {
    case "google":
      return row.budget_google_monthly_cap_minor;
    case "yandex":
      return row.budget_yandex_monthly_cap_minor;
    case "bing":
      return row.budget_bing_monthly_cap_minor;
  }
}
