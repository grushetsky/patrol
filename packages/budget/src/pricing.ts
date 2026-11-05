/**
 * The pricing primitives every budget path shares (docs/design/
 * budget-envelope.md; docs/design/query-strategy.md "Budget"). The prices
 * are the routes' list prices: DataForSEO's standard SERP queue at $0.60
 * per 1,000 and Yandex Search API v2 deferred at $0.25 per 1,000.
 */

import { UNITS_PER_QUERY } from "@patrol/domain";

/** The engines a cap can cover. */
export type EngineName = "google" | "bing" | "yandex";

/** The billable-unit price of an engine, in minor units per thousand. */
export const UNIT_PRICE_MINOR_PER_THOUSAND: Record<
  Exclude<EngineName, "bing">,
  number
> = {
  // DataForSEO's standard SERP queue at $0.60 per 1,000; Yandex Search API
  // v2 deferred mode at $0.25 per 1,000. Priority, live, and synchronous
  // modes are not bought in v1.
  google: 60,
  yandex: 25,
};

/**
 * One Google depth-20 query bills as two SERP units. Single-sourced from
 * the planner's per-engine table (@patrol/domain `UNITS_PER_QUERY`) so the
 * plan a scan prices and the allowance a cap buys can never disagree.
 */
export const GOOGLE_UNITS_PER_QUERY = UNITS_PER_QUERY.google;

/** The billable units a monthly cap buys at the engine's price. */
export function allowanceUnits(engine: EngineName, monthlyCapMinor: number): number {
  if (engine === "bing") {
    // Bing is deferred and carries a zero cap until it is added; no route
    // is bought, so no allowance exists whatever the column says.
    return 0;
  }
  const price = UNIT_PRICE_MINOR_PER_THOUSAND[engine];
  return Math.floor((monthlyCapMinor * 1000) / price);
}

/** The queries an allowance of units issues. */
export function queriesForUnits(engine: EngineName, units: number): number {
  if (engine === "google") {
    return Math.floor(units / GOOGLE_UNITS_PER_QUERY);
  }
  // A Yandex request answers thirty results in one call and bills as one
  // unit; its count is not reduced by Google's depth-20 billing.
  return units;
}
