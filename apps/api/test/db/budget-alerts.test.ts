import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { controlledClock } from "../test-app.js";
import { testPool } from "./helpers.js";
import { ensureMonth } from "../../src/domain/budget/ledger.js";
import {
  evaluateBudgetAlerts,
  listMonthAlerts,
} from "../../src/domain/budget/alerts.js";

/**
 * Seam 7 of the budget core (slice 3a): the alert evaluator against the
 * design's thresholds (docs/design/scan-scheduling.md "Alerts") with the
 * fire-once rule per threshold per engine per month, the per-bucket
 * criticals, the exhaustion a lowered cap produces, and the provider
 * balance rules. The counters are seeded directly so every threshold is
 * pinned to the doc's concrete numbers: a $0.60 Google cap buys 1,000
 * units, split 700/300. Because an alert never fires twice for one
 * engine and month, each scenario works on its own engine and month.
 */
describe("budget alerts", () => {
  const pool: Pool = testPool();
  const clock = controlledClock("2026-03-15T12:00:00.000Z");

  beforeAll(async () => {
    await pool.query(
      "insert into rights_holder (legal_name, country) values ('Alert Test GmbH', 'DE')",
    );
    await pool.query(
      "update rights_holder set budget_google_monthly_cap_minor = 60",
    );
    await pool.query(
      "insert into title_groups (name, locales) values ('Alerted Group', '{en}')",
    );
  });

  afterAll(async () => {
    await pool.end();
  });

  /** Seeds an engine's month counters directly. */
  async function seed(
    engine: string,
    monthStart: string,
    counters: {
      scanCommitted?: number;
      recheckCommitted?: number;
      scanReserved?: number;
      recheckReserved?: number;
    },
  ): Promise<void> {
    await pool.query(
      `update quota_ledger set
         scan_committed = $1,
         recheck_committed = $2,
         scan_reserved = $3,
         recheck_reserved = $4
       where engine = $5 and month_start = $6`,
      [
        counters.scanCommitted ?? 0,
        counters.recheckCommitted ?? 0,
        counters.scanReserved ?? 0,
        counters.recheckReserved ?? 0,
        engine,
        monthStart,
      ],
    );
  }

  // -----------------------------------------------------------------
  // The 75% monthly warning.

  it("fires nothing below the thresholds", async () => {
    await ensureMonth(pool, "google", "2026-03-01");
    await seed("google", "2026-03-01", { scanCommitted: 499, recheckCommitted: 250 });
    expect(
      await evaluateBudgetAlerts(pool, { engine: "google", now: clock.now }),
    ).toEqual([]);
  });

  it("fires the monthly warning at seventy-five percent, once", async () => {
    // 500 scan and 250 re-check total 750 of the 1,000 allowance while
    // neither bucket reaches its own ninety-percent line.
    await seed("google", "2026-03-01", { scanCommitted: 500, recheckCommitted: 250 });
    const fired = await evaluateBudgetAlerts(pool, {
      engine: "google",
      now: clock.now,
    });
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({
      engine: "google",
      monthStart: "2026-03-01",
      threshold: "warning",
      bucket: null,
      level: "warning",
      percentUsed: 75,
      groupsNotScanned: 1,
    });

    // The second evaluation of the same month does not duplicate it.
    const again = await evaluateBudgetAlerts(pool, {
      engine: "google",
      now: clock.now,
    });
    expect(again).toEqual([]);
    expect(await listMonthAlerts(pool, "2026-03-01")).toHaveLength(1);
  });

  // -----------------------------------------------------------------
  // The 90% bucket criticals and the 100% exhaustion.

  it("fires a critical once per bucket at ninety percent of that bucket", async () => {
    await seed("google", "2026-03-01", { scanCommitted: 630, recheckCommitted: 0 });
    const scan = await evaluateBudgetAlerts(pool, {
      engine: "google",
      now: clock.now,
    });
    expect(scan).toHaveLength(1);
    expect(scan[0]).toMatchObject({
      threshold: "critical",
      bucket: "scan",
      level: "critical",
      percentUsed: 90,
    });

    await seed("google", "2026-03-01", { scanCommitted: 0, recheckCommitted: 270 });
    const recheck = await evaluateBudgetAlerts(pool, {
      engine: "google",
      now: clock.now,
    });
    expect(recheck).toHaveLength(1);
    expect(recheck[0]).toMatchObject({
      threshold: "critical",
      bucket: "recheck",
      percentUsed: 90,
    });

    // Both buckets having fired, a repeat fires nothing new — not even
    // the monthly warning this combined spend has since crossed.
    await seed("google", "2026-03-01", { scanCommitted: 630, recheckCommitted: 270 });
    expect(
      await evaluateBudgetAlerts(pool, { engine: "google", now: clock.now }),
    ).toEqual([]);
  });

  it("marks a bucket exhausted at one hundred percent of its share", async () => {
    // 700 of 1,000 monthly stays below the warning line; the scan
    // bucket's critical already fired above, so this crossing adds the
    // exhaustion alone.
    await seed("google", "2026-03-01", { scanCommitted: 700 });
    const fired = await evaluateBudgetAlerts(pool, {
      engine: "google",
      now: clock.now,
    });
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({
      threshold: "exhausted",
      bucket: "scan",
      level: "critical",
      percentUsed: 100,
    });
  });

  it("treats spend past a lowered cap as exhausted until the cap rises", async () => {
    // A fresh engine and bucket state: $3.00 of Yandex buys 12,000 units
    // (shares 8,400/3,600), and 9,000 already sit committed.
    await pool.query(
      "update rights_holder set budget_yandex_monthly_cap_minor = 300",
    );
    await ensureMonth(pool, "yandex", "2026-03-01");
    await seed("yandex", "2026-03-01", { scanCommitted: 9_000 });
    await pool.query(
      "update rights_holder set budget_yandex_monthly_cap_minor = 3",
    );
    const fired = await evaluateBudgetAlerts(pool, {
      engine: "yandex",
      now: clock.now,
    });
    expect(fired.map((alert) => alert.threshold).sort()).toEqual([
      "critical",
      "exhausted",
      "warning",
    ]);

    // The ledger row's allowance snapshot is untouched by the cap change.
    const row = await pool.query(
      "select allowance_units from quota_ledger where engine = 'yandex' and month_start = '2026-03-01'",
    );
    expect(row.rows[0].allowance_units).toBe(12_000);

    // Raising the cap back stops the live exhaustion reading; the fired
    // alerts stay fired, exactly once each.
    await pool.query(
      "update rights_holder set budget_yandex_monthly_cap_minor = 300",
    );
    expect(
      await evaluateBudgetAlerts(pool, { engine: "yandex", now: clock.now }),
    ).toEqual([]);
  });

  // -----------------------------------------------------------------
  // The provider balance probe thresholds, on April's fresh keys.

  it("fires the balance critical below ten percent of the engine cap, once", async () => {
    clock.set("2026-04-10T12:00:00.000Z");
    await pool.query(
      "update rights_holder set budget_google_monthly_cap_minor = 600",
    );
    await ensureMonth(pool, "google", "2026-04-01");
    await seed("google", "2026-04-01", {});
    const fired = await evaluateBudgetAlerts(pool, {
      engine: "google",
      now: clock.now,
      balance: { balanceMinor: 59.9 },
    });
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({
      threshold: "balance",
      bucket: null,
      level: "critical",
    });

    // A balance at exactly the threshold holds; the fired alert never
    // repeats either way.
    const none = await evaluateBudgetAlerts(pool, {
      engine: "google",
      now: clock.now,
      balance: { balanceMinor: 600 },
    });
    expect(none).toEqual([]);
  });

  it("uses one day's average burn as the threshold where it is larger", async () => {
    // $12.00 of Yandex buys 48,000 units (shares 33,600/14,400); 20,000
    // committed units cost $5.00, and over two elapsed days that is $2.50
    // a day — above the $1.20 ten-percent line.
    clock.set("2026-04-02T12:00:00.000Z");
    await pool.query(
      "update rights_holder set budget_yandex_monthly_cap_minor = 1200",
    );
    await ensureMonth(pool, "yandex", "2026-04-01");
    await seed("yandex", "2026-04-01", { scanCommitted: 20_000 });
    const fired = await evaluateBudgetAlerts(pool, {
      engine: "yandex",
      now: clock.now,
      // $2.00 covers the ten-percent line but not the $2.50 daily burn.
      balance: { balanceMinor: 200 },
    });
    expect(fired.map((alert) => alert.threshold)).toEqual(["balance"]);
    expect(fired[0].percentUsed).toBeCloseTo(200 / 12, 1);
  });

  it("evaluates an engine with no month row as unspent and opens nothing", async () => {
    const fired = await evaluateBudgetAlerts(pool, {
      engine: "bing",
      now: clock.now,
    });
    expect(fired).toEqual([]);
    const row = await pool.query(
      "select count(*) as count from quota_ledger where engine = 'bing'",
    );
    // Reading for alerting never opens a month.
    expect(Number(row.rows[0].count)).toBe(0);
  });
});
