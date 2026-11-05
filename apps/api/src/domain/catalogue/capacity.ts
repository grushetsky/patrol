/**
 * The capacity projection (docs/design/budget-envelope.md). Every constant
 * below is quoted from that document; the projection is derived, never
 * stored — the settings screen recomputes titles, locales, and cadence
 * against the current cap and shows the shortfall when the plan exceeds it.
 *
 * The pricing primitives moved behind `@patrol/budget` in slice 3b (the
 * worker prices plans with them); they are re-exported here so the API's
 * callers keep one import path.
 */

/** The engines a cap can cover. */
export type { EngineName } from "@patrol/budget";

export {
  GOOGLE_UNITS_PER_QUERY,
  UNIT_PRICE_MINOR_PER_THOUSAND,
  allowanceUnits,
  queriesForUnits,
} from "@patrol/budget";

import {
  GOOGLE_UNITS_PER_QUERY,
  UNIT_PRICE_MINOR_PER_THOUSAND,
  allowanceUnits,
  queriesForUnits,
} from "@patrol/budget";
import type { EngineName } from "@patrol/budget";

/** The scanning cadence a projection assumes (contract Patrol.Http.Cadence). */
export type Cadence = "daily" | "every_other_day" | "weekly";

/** The design-point $60 envelope: $48 Google, $12 Yandex, $0 deferred Bing, 30% re-checks. */
export const DESIGN_POINT_BUDGET: {
  google: number;
  yandex: number;
  bing: number;
  recheckSharePercent: number;
} = { google: 4_800, yandex: 1_200, bing: 0, recheckSharePercent: 30 };

/** The month the envelope is built around, in days. */
const MONTH_DAYS = 30;

/** The planning granularity a projection rounds down to, in titles. */
const PLANNING_GRANULARITY_TITLES = 50;

/** The queries left for scheduled scans once the re-check share is reserved. */
export function scanShareQueries(units: number, recheckSharePercent: number): number {
  return Math.floor((queriesForUnits("google", units) * (100 - recheckSharePercent)) / 100);
}

/**
 * The queries one title issues in one scan at a locale count: one
 * bare-variant query plus two intent queries per locale.
 */
export function queriesPerTitlePerScan(localesPerTitle: number): number {
  return 3 * localesPerTitle;
}

/** The cost of a query count, in minor units (cents). */
export function scanCostMinor(engine: EngineName, queries: number): number {
  if (engine === "bing") {
    return 0;
  }
  const units = engine === "google" ? queries * GOOGLE_UNITS_PER_QUERY : queries;
  return (units * UNIT_PRICE_MINOR_PER_THOUSAND[engine]) / 1000;
}

/** Scans a cadence fits into the envelope's thirty-day month. */
function scansPerMonth(cadence: Cadence): { num: number; den: number } {
  switch (cadence) {
    case "daily":
      return { num: MONTH_DAYS, den: 1 };
    case "every_other_day":
      return { num: MONTH_DAYS, den: 2 };
    case "weekly":
      // Thirty days holds four and two sevenths weeks; the fraction is
      // carried exactly rather than rounded, so a weekly plan is not
      // overpriced by a rounding of its own cadence.
      return { num: MONTH_DAYS, den: 7 };
  }
}

/**
 * How many titles the scan share supports at a locale count and cadence,
 * before the planning rounding: floor(scanShareQueries /
 * queriesPerTitlePerMonth). The shortfall reads this figure, so the
 * presentational rounding below never invents a shortfall the real
 * capacity does not have.
 */
export function rawSupportedTitles(input: {
  scanShareQueries: number;
  localesPerTitle: number;
  cadence: Cadence;
}): number {
  const { num, den } = scansPerMonth(input.cadence);
  const perTitlePerScan = queriesPerTitlePerScan(input.localesPerTitle);
  return Math.floor((input.scanShareQueries * den) / (perTitlePerScan * num));
}

/**
 * The floored planning figure the capacity endpoint reports: the raw count
 * rounded down to a multiple of fifty — the planning granularity the
 * design's own capacity table works in (its daily and every-other-day rows
 * read 150 and 300), and the group-size recommendation ("25 to 50 titles")
 * is the unit a plan actually moves in. The contract's CapacityProjection
 * carries this figure alone, so the raw count stays off the wire.
 */
export function supportedTitles(input: {
  scanShareQueries: number;
  localesPerTitle: number;
  cadence: Cadence;
}): number {
  return (
    Math.floor(rawSupportedTitles(input) / PLANNING_GRANULARITY_TITLES) *
    PLANNING_GRANULARITY_TITLES
  );
}

/** The projection the capacity endpoint answers with. */
export interface CapacityProjectionResult {
  localesPerTitle: number;
  cadence: Cadence;
  queriesPerTitlePerScan: number;
  supportedTitles: number;
  trackedTitles: number;
  shortfallTitles: number;
}

/** Derives the projection from the budget and the catalogue's current size. */
export function projectCapacity(input: {
  monthlyCapsMinor: Record<EngineName, number>;
  recheckSharePercent: number;
  localesPerTitle: number;
  cadence: Cadence;
  trackedTitles: number;
}): CapacityProjectionResult {
  const googleUnits = allowanceUnits("google", input.monthlyCapsMinor.google);
  const share = scanShareQueries(googleUnits, input.recheckSharePercent);
  const shape = {
    scanShareQueries: share,
    localesPerTitle: input.localesPerTitle,
    cadence: input.cadence,
  };
  return {
    localesPerTitle: input.localesPerTitle,
    cadence: input.cadence,
    queriesPerTitlePerScan: queriesPerTitlePerScan(input.localesPerTitle),
    // The floored planning figure the screen shows...
    supportedTitles: supportedTitles(shape),
    trackedTitles: input.trackedTitles,
    // ...and the shortfall measured against the raw capacity, so a
    // catalogue that fits inside the real allowance reports zero even when
    // the planning rounding reports a smaller figure beside it.
    shortfallTitles: Math.max(0, input.trackedTitles - rawSupportedTitles(shape)),
  };
}
