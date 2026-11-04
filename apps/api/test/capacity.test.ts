import { describe, expect, it } from "vitest";
import {
  DESIGN_POINT_BUDGET,
  projectCapacity,
  queriesPerTitlePerScan,
  rawSupportedTitles,
  scanCostMinor,
  scanShareQueries,
  supportedTitles,
  allowanceUnits,
} from "../src/domain/catalogue/capacity.js";

/**
 * The capacity projection's arithmetic transcribed from
 * docs/design/budget-envelope.md — every expected number below is quoted
 * from that document's tables, never recomputed the way the code does it.
 *
 * The cap table: Google $48.00 buys 80,000 SERP units at $0.60 per 1,000,
 * which is 40,000 depth-20 queries at two units each; Yandex $12.00 buys
 * 48,000 requests at $0.25 per 1,000; Bing $0 until added. The split:
 * 70% of an engine's allowance funds scans, 30% re-checks — Google's 40,000
 * queries leave 28,000 for new scans and 12,000 for re-checks.
 */
const GOOGLE_CAP_MINOR = 4_800;
const YANDEX_CAP_MINOR = 1_200;

describe("allowanceUnits", () => {
  it("derives the billable units from the cap at the documented prices", () => {
    expect(allowanceUnits("google", GOOGLE_CAP_MINOR)).toBe(80_000);
    expect(allowanceUnits("yandex", YANDEX_CAP_MINOR)).toBe(48_000);
    // Bing is deferred: no route is bought, so no allowance exists.
    expect(allowanceUnits("bing", 0)).toBe(0);
  });
});

describe("scanShareQueries", () => {
  it("splits the query allowance seventy thirty", () => {
    expect(
      scanShareQueries(allowanceUnits("google", GOOGLE_CAP_MINOR), 30),
    ).toBe(28_000);
  });
});

describe("queriesPerTitlePerScan", () => {
  it("issues six queries per title per scan in two locales", () => {
    // Two bare-variant queries (one per locale) and four intent queries
    // (two per locale); one locale issues three, a third adds three more.
    expect(queriesPerTitlePerScan(2)).toBe(6);
    expect(queriesPerTitlePerScan(1)).toBe(3);
    expect(queriesPerTitlePerScan(3)).toBe(9);
  });
});

describe("scanCostMinor", () => {
  it("prices one title's scan at $0.0072 on Google and $0.0015 on Yandex", () => {
    expect(scanCostMinor("google", 6)).toBeCloseTo(0.72, 10);
    expect(scanCostMinor("yandex", 6)).toBeCloseTo(0.15, 10);
  });

  it("prices a 50-title group scan at $0.36 and $0.075", () => {
    expect(scanCostMinor("google", 300)).toBeCloseTo(36, 10);
    expect(scanCostMinor("yandex", 300)).toBeCloseTo(7.5, 10);
  });

  it("prices 50 titles daily for 30 days at $10.80 and $2.25", () => {
    expect(scanCostMinor("google", 9_000)).toBe(1_080);
    expect(scanCostMinor("yandex", 9_000)).toBe(225);
  });

  it("prices 150 titles daily for 30 days at $32.40 and $6.75", () => {
    expect(scanCostMinor("google", 27_000)).toBe(3_240);
    expect(scanCostMinor("yandex", 27_000)).toBe(675);
  });

  it("ten thousand queries cost $12.00 on Google and $2.50 on Yandex", () => {
    expect(scanCostMinor("google", 10_000)).toBe(1_200);
    expect(scanCostMinor("yandex", 10_000)).toBe(250);
  });
});

describe("supportedTitles", () => {
  it("carries 150 titles daily and 300 every other day at the design cap", () => {
    // The capacity table: daily 150 titles spend 27,000 queries and use 96%
    // of the scan share; every other day doubles the count at 300; weekly
    // lands around a thousand.
    expect(
      supportedTitles({
        scanShareQueries: 28_000,
        localesPerTitle: 2,
        cadence: "daily",
      }),
    ).toBe(150);
    expect(
      supportedTitles({
        scanShareQueries: 28_000,
        localesPerTitle: 2,
        cadence: "every_other_day",
      }),
    ).toBe(300);
  });

  it("scales down as locales grow: a third locale roughly cuts daily capacity by a third", () => {
    // The open-risk note: a catalogue that needs three locales supports
    // only about 100 titles at the same cap.
    const threeLocales = supportedTitles({
      scanShareQueries: 28_000,
      localesPerTitle: 3,
      cadence: "daily",
    });
    expect(threeLocales).toBe(100);
  });
});

describe("rawSupportedTitles and the shortfall", () => {
  it("carries the unfloored capacity the planning figure rounds down from", () => {
    // The design point holds 155 titles at two locales daily before the
    // fifty-title planning granularity rounds the screen's figure to 150.
    expect(
      rawSupportedTitles({
        scanShareQueries: 28_000,
        localesPerTitle: 2,
        cadence: "daily",
      }),
    ).toBe(155);
  });

  it("measures the shortfall against the raw capacity, not the floored figure", () => {
    const at = projectCapacity({
      monthlyCapsMinor: DESIGN_POINT_BUDGET,
      recheckSharePercent: 30,
      localesPerTitle: 2,
      cadence: "daily",
      trackedTitles: 155,
    });
    // 155 tracked fit the real 155-title capacity: zero shortfall, even
    // though the planning figure beside it reads 150.
    expect(at.supportedTitles).toBe(150);
    expect(at.shortfallTitles).toBe(0);

    const over = projectCapacity({
      monthlyCapsMinor: DESIGN_POINT_BUDGET,
      recheckSharePercent: 30,
      localesPerTitle: 2,
      cadence: "daily",
      trackedTitles: 160,
    });
    expect(over.supportedTitles).toBe(150);
    expect(over.shortfallTitles).toBe(5);
  });
});

describe("DESIGN_POINT_BUDGET", () => {
  it("is the sixty-dollar envelope: forty-eight Google, twelve Yandex, zero Bing, thirty percent re-checks", () => {
    expect(DESIGN_POINT_BUDGET).toEqual({
      google: GOOGLE_CAP_MINOR,
      yandex: YANDEX_CAP_MINOR,
      bing: 0,
      recheckSharePercent: 30,
    });
  });
});
