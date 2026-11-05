import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  bucketShares,
  monthStartOf,
} from "../src/domain/budget/ledger.js";
import { dueAlerts } from "../src/domain/budget/alerts.js";
import {
  balanceCriticalThresholdMinor,
  isBalanceCritical,
} from "../src/domain/budget/balance-probe.js";

/**
 * The budget core's pure seams (slice 3a): month arithmetic, the 70/30
 * bucket split, the alert thresholds with the design's concrete numbers
 * (docs/design/scan-scheduling.md "Alerts", docs/design/budget-envelope.md
 * "Alerts"), and the grep-able ledger-immutability assertion.
 */

// The worked example every threshold test derives from: a $0.60 Google cap
// buys 1,000 billable units, split 70/30 into 700 scan and 300 re-check.
const CAP_60_MINOR = 60;
const ALLOWANCE_1000 = 1_000;
const SHARES_700_300 = { scan: 700, recheck: 300 };

/**
 * The first day of the month after a month start. The production core has
 * no caller for this yet (the rollover reads the clock's own month), so it
 * lives here until one arrives; the year-boundary arithmetic stays pinned
 * either way.
 */
function nextMonthStart(monthStart: string): string {
  const year = Number.parseInt(monthStart.slice(0, 4), 10);
  const month = Number.parseInt(monthStart.slice(5, 7), 10);
  return month === 12
    ? `${year + 1}-01-01`
    : `${year}-${String(month + 1).padStart(2, "0")}-01`;
}

describe("month arithmetic", () => {
  it("reduces any instant to the first day of its UTC month", () => {
    expect(monthStartOf(new Date("2026-03-15T12:34:56.789Z"))).toBe("2026-03-01");
    expect(monthStartOf(new Date("2026-12-31T23:59:59.999Z"))).toBe("2026-12-01");
    expect(monthStartOf(new Date("2027-01-01T00:00:00.000Z"))).toBe("2027-01-01");
  });

  it("advances a month start across the year boundary", () => {
    expect(nextMonthStart("2026-03-01")).toBe("2026-04-01");
    expect(nextMonthStart("2026-12-01")).toBe("2027-01-01");
  });
});

describe("bucket split", () => {
  it("splits the design-point allowance 70/30", () => {
    expect(bucketShares(ALLOWANCE_1000, 30)).toEqual(SHARES_700_300);
  });

  it("leaves the remainder to the re-check share and sums to the allowance", () => {
    const shares = bucketShares(1_001, 30);
    expect(shares.scan).toBe(700);
    expect(shares.recheck).toBe(301);
    expect(shares.scan + shares.recheck).toBe(1_001);
  });

  it("honours a configured share other than thirty percent", () => {
    expect(bucketShares(ALLOWANCE_1000, 40)).toEqual({ scan: 600, recheck: 400 });
  });
});

describe("alert thresholds", () => {
  it("fires no warning below seventy-five percent of the monthly allowance", () => {
    const alerts = dueAlerts({
      engine: "google",
      monthlyCapMinor: CAP_60_MINOR,
      // 499 scan and 250 re-check total 749 of 1,000 while neither
      // bucket reaches its own threshold.
      snapshot: snapshot({ scanCommitted: 499, recheckCommitted: 250 }),
    });
    expect(alerts).toEqual([]);
  });

  it("fires the monthly warning at exactly seventy-five percent", () => {
    const alerts = dueAlerts({
      engine: "google",
      monthlyCapMinor: CAP_60_MINOR,
      // 500 scan and 250 re-check total 750; both buckets stay below
      // their ninety-percent lines.
      snapshot: snapshot({ scanCommitted: 500, recheckCommitted: 250 }),
    });
    expect(alerts).toEqual([
      {
        threshold: "warning",
        bucket: null,
        level: "warning",
        percentUsed: 75,
      },
    ]);
  });

  it("counts reserved and committed units together toward the allowance", () => {
    const alerts = dueAlerts({
      engine: "google",
      monthlyCapMinor: CAP_60_MINOR,
      snapshot: snapshot({
        scanCommitted: 300,
        scanReserved: 200,
        recheckReserved: 260,
      }),
    });
    expect(alerts.map((alert) => alert.threshold)).toEqual(["warning"]);
  });

  it("fires no bucket critical below ninety percent of the share", () => {
    expect(
      dueAlerts({
        engine: "google",
        monthlyCapMinor: CAP_60_MINOR,
        snapshot: snapshot({ scanCommitted: 629 }),
      }),
    ).toEqual([]);
  });

  it("fires a critical per bucket at ninety percent of that bucket's share", () => {
    const scanCritical = dueAlerts({
      engine: "google",
      monthlyCapMinor: CAP_60_MINOR,
      snapshot: snapshot({ scanCommitted: 630 }),
    });
    // 630 of 1,000 monthly stays below the 750 warning line.
    expect(scanCritical).toEqual([
      { threshold: "critical", bucket: "scan", level: "critical", percentUsed: 90 },
    ]);

    const recheckCritical = dueAlerts({
      engine: "google",
      monthlyCapMinor: CAP_60_MINOR,
      snapshot: snapshot({ recheckCommitted: 270 }),
    });
    expect(recheckCritical).toEqual([
      {
        threshold: "critical",
        bucket: "recheck",
        level: "critical",
        percentUsed: 90,
      },
    ]);
  });

  it("marks a bucket exhausted at one hundred percent of its share", () => {
    const alerts = dueAlerts({
      engine: "google",
      monthlyCapMinor: CAP_60_MINOR,
      snapshot: snapshot({ scanCommitted: 700 }),
    });
    expect(alerts).toEqual([
      { threshold: "critical", bucket: "scan", level: "critical", percentUsed: 100 },
      {
        threshold: "exhausted",
        bucket: "scan",
        level: "critical",
        percentUsed: 100,
      },
    ]);
  });

  it("fires every threshold the spend has crossed in one pass", () => {
    const alerts = dueAlerts({
      engine: "google",
      monthlyCapMinor: CAP_60_MINOR,
      snapshot: snapshot({ scanCommitted: 700, recheckCommitted: 300 }),
    });
    expect(alerts.map((alert) => [alert.threshold, alert.bucket])).toEqual([
      ["warning", null],
      ["critical", "scan"],
      ["exhausted", "scan"],
      ["critical", "recheck"],
      ["exhausted", "recheck"],
    ]);
  });

  it("treats spend past a lowered cap as exhausted even against a zero share", () => {
    // The cap was lowered after the spend: the live allowance is 100 units
    // (share 70) while 700 sit committed (docs/design/scan-scheduling.md
    // "Quota accounting", last paragraph).
    const alerts = dueAlerts({
      engine: "google",
      monthlyCapMinor: 6,
      snapshot: snapshot({
        allowanceUnits: 100,
        scanCommitted: 700,
      }),
    });
    expect(alerts.map((alert) => alert.threshold)).toContain("exhausted");
    expect(alerts.map((alert) => alert.threshold)).toContain("warning");
  });

  it("fires no threshold on an engine with no allowance", () => {
    expect(
      dueAlerts({
        engine: "bing",
        monthlyCapMinor: 0,
        snapshot: snapshot({ allowanceUnits: 0 }),
      }),
    ).toEqual([]);
  });
});

describe("provider balance thresholds", () => {
  it("reads critical below ten percent of the engine's monthly cap", () => {
    // $48 cap: ten percent is $4.80.
    const threshold = balanceCriticalThresholdMinor({
      engine: "google",
      monthlyCapMinor: 4_800,
      committedUnits: 0,
      daysElapsed: 1,
    });
    expect(threshold).toBe(480);
    expect(isBalanceCritical(479.9, threshold)).toBe(true);
    expect(isBalanceCritical(480, threshold)).toBe(false);
  });

  it("raises the threshold to one day's average burn where that is larger", () => {
    // 100,000 committed units at $0.60 per 1,000 is $60.00 over ten days:
    // $6.00 a day, far above the $0.60 ten-percent line of a $6 cap.
    const threshold = balanceCriticalThresholdMinor({
      engine: "google",
      monthlyCapMinor: 600,
      committedUnits: 100_000,
      daysElapsed: 10,
    });
    expect(threshold).toBe(600);
    // A balance of $5 covers ten percent of the cap but not one day's burn.
    expect(isBalanceCritical(500, threshold)).toBe(true);
    expect(isBalanceCritical(600, threshold)).toBe(false);
  });

  it("fires the balance alert through the threshold evaluator alone", () => {
    const alerts = dueAlerts({
      engine: "google",
      monthlyCapMinor: 600,
      // An allowance the spend barely dents, so only the balance rules.
      snapshot: snapshot({
        allowanceUnits: 10_000_000,
        scanCommitted: 100_000,
      }),
      balance: { balanceMinor: 500 },
      daysElapsed: 10,
    });
    expect(alerts).toEqual([
      {
        threshold: "balance",
        bucket: null,
        level: "critical",
        percentUsed: 83.3,
      },
    ]);
  });

  it("converts committed units to minor units at each engine's price", () => {
    const yandexThreshold = balanceCriticalThresholdMinor({
      engine: "yandex",
      monthlyCapMinor: 1_200,
      committedUnits: 0,
      daysElapsed: 1,
    });
    expect(yandexThreshold).toBe(120);
  });
});

describe("ledger immutability", () => {
  // The budget core moved behind @patrol/budget in slice 3b; the
  // API-local facades re-export it, so the grep covers the package's
  // sources plus every budget-bearing migration.
  const budgetDir = fileURLToPath(
    new URL("../../../packages/budget/src/", import.meta.url),
  );
  const migration = readFileSync(
    fileURLToPath(new URL("../../../packages/db/drizzle/0003_budget.sql", import.meta.url)),
    "utf8",
  );

  /** Every source file the budget core ships. */
  function budgetSources(): string[] {
    return readdirSync(budgetDir)
      .filter((name) => name.endsWith(".ts"))
      .map((name) => readFileSync(`${budgetDir}${name}`, "utf8"));
  }

  it("deletes no ledger row anywhere in the budget core", () => {
    for (const source of [...budgetSources(), migration]) {
      expect(source).not.toMatch(/delete\s+from\s+quota_ledger/i);
    }
  });

  it("decrements no committed counter and no allowance", () => {
    const forbidden = [
      // Plain SQL: a committed or allowance assignment whose right side
      // carries a minus — decrementing the column itself or another one.
      /scan_committed\s*=\s*[^;,]+-/,
      /recheck_committed\s*=\s*[^;,]+-/,
      /allowance_units\s*=\s*[^;,]+-/,
      /\bscan_committed\s*-(?!\s*0\b)/,
      /\brecheck_committed\s*-(?!\s*0\b)/,
      // Template SQL: whatever bucket `${column}` binds, a committed
      // assignment with a minus on its right side is a decrement in
      // disguise.
      /\$\{column\}_committed\s*=\s*[^;,]+-/,
    ];
    for (const source of [...budgetSources(), migration]) {
      for (const pattern of forbidden) {
        // A decrement of committed units would un-spend history; a decrement
        // of the allowance would rewrite a month that already opened.
        expect(source.match(pattern)?.[0] ?? "").toBe("");
      }
    }
  });

  it("writes the template columns only as a settlement may", () => {
    // The `${column}` family binds either bucket at runtime, so every
    // assignment it produces must be one the settlement rules allow: the
    // reserved counters' moves and the committed increment a commit makes.
    for (const source of [...budgetSources(), migration]) {
      for (const write of source.matchAll(/\$\{column\}_(\w+)\s*=/g)) {
        expect(["reserved", "committed"]).toContain(write[1]);
      }
    }
  });

  it("may still settle reservations by decrementing only the reserved counters", () => {
    const ledger = budgetSources().find((source) =>
      source.includes("scan_reserved"),
    );
    expect(ledger).toBeTruthy();
    expect(ledger).toMatch(
      /\$\{column\}_reserved\s*=\s*\$\{column\}_reserved\s*-/,
    );
  });
});

/** A snapshot with zeroed counters plus overrides. */
function snapshot(
  overrides: Partial<Parameters<typeof dueAlerts>[0]["snapshot"]> = {},
): Parameters<typeof dueAlerts>[0]["snapshot"] {
  return {
    allowanceUnits: ALLOWANCE_1000,
    recheckSharePercent: 30,
    scanReserved: 0,
    scanCommitted: 0,
    recheckReserved: 0,
    recheckCommitted: 0,
    ...overrides,
  };
}
