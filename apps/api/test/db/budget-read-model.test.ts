import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  authHeaders,
  ceremonyApp,
  signedInAdministrator,
  type CeremonyApp,
  type SignedInOperator,
} from "./ceremony.js";
import { getValidator } from "../../src/plugins/validator.js";
import { commitReservation, reserve } from "../../src/domain/budget/ledger.js";
import { evaluateBudgetAlerts } from "../../src/domain/budget/alerts.js";

/**
 * Seam 9 of the budget core (slice 3a): the budget overview read model
 * fills in what slice 2 left empty — the current month's ledger rows, the
 * used counters derived from them, and the alerts that have fired. The
 * ceremony's clock is frozen at 2026-01-01, so the month under read is
 * deterministically 2026-01.
 */
describe("budget overview read model", () => {
  let world: CeremonyApp;
  let admin: SignedInOperator;

  beforeAll(async () => {
    world = await ceremonyApp();
    admin = await signedInAdministrator(world, "admin@example.test");
  });

  afterAll(async () => {
    await world.app.close();
    await world.pool.end();
  });

  it("lists ledger rows, used counters, and fired alerts", async () => {
    // A $0.60 Google cap buys 1,000 units: 700 scan, 300 re-check.
    const set = await world.app.inject({
      method: "PUT",
      url: "/api/settings/budget",
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: {
        engineCaps: [
          { engine: "google", currency: "usd", monthlyCapMinor: 60 },
          { engine: "bing", currency: "usd", monthlyCapMinor: 0 },
          { engine: "yandex", currency: "usd", monthlyCapMinor: 25 },
        ],
        recheckSharePercent: 30,
      },
    });
    expect(set.statusCode).toBe(200);

    // One group exists through the real write path, so the alerts name a
    // group that has not scanned.
    const group = await world.app.inject({
      method: "POST",
      url: "/api/title-groups",
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: {
        name: "Read model group",
        locales: ["en"],
        scanTime: "02:20:00Z",
        priority: "normal",
      },
    });
    expect(group.statusCode).toBe(201);

    // Spend through the real ledger path: 450 scan units committed and the
    // re-check share fully spent, which totals 750 of the 1,000 allowance.
    const scanHold = await reserve(world.pool, world.clock.now, {
      engine: "google",
      bucket: "scan",
      units: 500,
    });
    if (scanHold.outcome !== "reserved") {
      throw new Error("scan reserve failed");
    }
    await commitReservation(world.pool, world.clock.now, scanHold.reservation.id, 450);
    const recheckHold = await reserve(world.pool, world.clock.now, {
      engine: "google",
      bucket: "recheck",
      units: 300,
    });
    if (recheckHold.outcome !== "reserved") {
      throw new Error("recheck reserve failed");
    }
    await commitReservation(
      world.pool,
      world.clock.now,
      recheckHold.reservation.id,
      300,
    );

    const fired = await evaluateBudgetAlerts(world.pool, {
      engine: "google",
      now: world.clock.now,
    });
    expect(fired.map((alert) => alert.threshold).sort()).toEqual([
      "critical",
      "exhausted",
      "warning",
    ]);

    const read = await world.app.inject({
      method: "GET",
      url: "/api/settings/budget",
      headers: { cookie: admin.cookie },
    });
    expect(read.statusCode).toBe(200);
    const body = read.json();
    // The filled overview stays exactly the contract's shape.
    expect(getValidator("BudgetOverview")(body)).toBe(true);

    // The ledger row for the frozen month, with its snapshot allowance.
    expect(body.ledger).toEqual([
      {
        id: expect.any(String),
        engine: "google",
        monthStart: "2026-01-01",
        allowanceUnits: 1_000,
        scanReserved: 0,
        scanCommitted: 450,
        recheckReserved: 0,
        recheckCommitted: 300,
      },
    ]);

    const google = body.engines.find(
      (engine: { engine: string }) => engine.engine === "google",
    );
    expect(google).toMatchObject({
      monthlyCapMinor: 60,
      allowanceUnits: 1_000,
      scanShareUnits: 700,
      recheckShareUnits: 300,
      scanUsedUnits: 450,
      recheckUsedUnits: 300,
      exhausted: true,
      routeDisabled: false,
    });

    // The alerts that fired this month: the monthly warning, the re-check
    // bucket's 90% critical, and its exhaustion. Each carries the engine,
    // the measured share, a rendered message, and the group shortfall
    // count; only the bucket thresholds carry a bucket.
    expect(body.alerts).toHaveLength(3);
    const byPercent = body.alerts
      .map((alert: { percentUsed: number }) => alert.percentUsed)
      .sort((a: number, b: number) => a - b);
    // The re-check bucket sits at 100% of its share, so both its critical
    // and its exhaustion read the full share.
    expect(byPercent).toEqual([75, 100, 100]);
    const levels = body.alerts.map((alert: { level: string }) => alert.level);
    expect(levels.sort()).toEqual(["critical", "critical", "warning"]);
    for (const alert of body.alerts) {
      expect(alert.engine).toBe("google");
      expect(alert.groupsNotScanned).toBe(1);
      expect(alert.message).toMatch(/google/i);
    }
    // Engine-level thresholds carry no bucket of their own and omit the
    // field; the bucket thresholds carry theirs.
    const warning = body.alerts.find(
      (alert: { percentUsed: number }) => alert.percentUsed === 75,
    );
    expect(warning.level).toBe("warning");
    expect(warning.bucket).toBeUndefined();
    expect(warning.message).toContain("75%");
    const exhausted = body.alerts.find((alert: { message: string }) =>
      alert.message.includes("budget_exhausted"),
    );
    expect(exhausted).toBeTruthy();
    expect(exhausted.bucket).toBe("recheck");
    expect(exhausted.percentUsed).toBe(100);
  });

  it("shows an engine with no spend as healthy and unlisted in the ledger", async () => {
    const read = await world.app.inject({
      method: "GET",
      url: "/api/settings/budget",
      headers: {
        cookie: admin.cookie,
        "accept-language": "ru",
      },
    });
    expect(read.statusCode).toBe(200);
    const body = read.json();
    const yandex = body.engines.find(
      (engine: { engine: string }) => engine.engine === "yandex",
    );
    expect(yandex).toMatchObject({
      allowanceUnits: 1_000,
      scanUsedUnits: 0,
      recheckUsedUnits: 0,
      exhausted: false,
    });
    const bing = body.engines.find(
      (engine: { engine: string }) => engine.engine === "bing",
    );
    expect(bing).toMatchObject({ allowanceUnits: 0, exhausted: false });
    // Only engines that spent hold ledger rows.
    expect(
      body.ledger.map((row: { engine: string }) => row.engine),
    ).toEqual(["google"]);
    // Alert messages render in the requesting operator's language; the
    // same rows read in English above render English here in Russian.
    expect(body.alerts.length).toBeGreaterThan(0);
    for (const alert of body.alerts) {
      expect(alert.message).toMatch(/[Ѐ-ӿ]/);
    }
  });
});
