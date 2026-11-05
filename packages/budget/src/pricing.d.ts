/**
 * The pricing primitives every budget path shares (docs/design/
 * budget-envelope.md; docs/design/query-strategy.md "Budget"). The prices
 * are the routes' list prices: DataForSEO's standard SERP queue at $0.60
 * per 1,000 and Yandex Search API v2 deferred at $0.25 per 1,000.
 */
/** The engines a cap can cover. */
export type EngineName = "google" | "bing" | "yandex";
/** The billable-unit price of an engine, in minor units per thousand. */
export declare const UNIT_PRICE_MINOR_PER_THOUSAND: Record<Exclude<EngineName, "bing">, number>;
/** One Google depth-20 query bills as two SERP units; a Yandex request is one. */
export declare const GOOGLE_UNITS_PER_QUERY = 2;
/** The billable units a monthly cap buys at the engine's price. */
export declare function allowanceUnits(engine: EngineName, monthlyCapMinor: number): number;
/** The queries an allowance of units issues. */
export declare function queriesForUnits(engine: EngineName, units: number): number;
