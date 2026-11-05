import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ceremonyApp,
  signedInAdministrator,
  type CeremonyApp,
  type SignedInOperator,
} from "./ceremony.js";
import { seedGroup, seedTrackedTitle } from "./dashboard-helpers.js";
import { getValidator } from "../../src/plugins/validator.js";

/**
 * The tracked-titles metric (docs/design/dashboard-ui.md "Title chart"): a
 * step count of every tracked title not paused on that day, grouped by none
 * or title group. The clock is frozen at 2026-01-01T00:00:00Z, so today is
 * 2026-01-01 and the 7-day window is 2025-12-26..2026-01-01.
 *
 * Seeded catalogue: P (paused on 2025-12-29) and Q in group A; R and S (born
 * 2025-12-28) in group B; M, a duplicate merged away on creation. Every
 * title but S was born 2025-12-20, before the window.
 *
 * Hand-derived daily totals over the 7-day window:
 *   12-26: P,Q,R            = 3   (S unborn, M archived)
 *   12-27: P,Q,R            = 3
 *   12-28: P,Q,R,S          = 4
 *   12-29: Q,R,S            = 3   (P paused from its pause day on)
 *   12-30..01-01: Q,R,S     = 3
 */
describe("dashboard title chart: tracked titles", () => {
  let world: CeremonyApp;
  let admin: SignedInOperator;

  beforeAll(async () => {
    world = await ceremonyApp();
    admin = await signedInAdministrator(world, "admin@example.test");

    const groupA = await seedGroup(world.pool, "A group");
    const groupB = await seedGroup(world.pool, "B group");
    const born = "2025-12-20T00:00:00Z";
    const paused = await seedTrackedTitle(world.pool, admin.operatorId, {
      groupId: groupA,
      name: "Paused",
      createdAt: born,
      pausedAt: "2025-12-29T00:00:00Z",
    });
    await seedTrackedTitle(world.pool, admin.operatorId, {
      groupId: groupA,
      name: "Queued",
      createdAt: born,
    });
    await seedTrackedTitle(world.pool, admin.operatorId, {
      groupId: groupB,
      name: "Ready",
      createdAt: born,
    });
    await seedTrackedTitle(world.pool, admin.operatorId, {
      groupId: groupB,
      name: "Newcomer",
      createdAt: "2025-12-28T00:00:00Z",
    });
    const merged = await seedTrackedTitle(world.pool, admin.operatorId, {
      groupId: groupB,
      name: "Duplicate",
      createdAt: born,
    });
    // The merged duplicate is archived: never counted on any day.
    await world.pool.query(
      "update tracked_titles set merged_into_title_id = $2 where id = $1",
      [merged.titleId, paused.titleId],
    );
  });

  afterAll(async () => {
    await world.app.close();
    await world.pool.end();
  });

  it("plots the step count with no grouping over the requested window", async () => {
    const read = await world.app.inject({
      method: "GET",
      url: "/api/dashboard/title-chart",
      query: { metric: "tracked_titles", windowDays: "7" },
      headers: { cookie: admin.cookie },
    });
    expect(read.statusCode).toBe(200);
    const body = read.json();
    expect(getValidator("TrackedTitlesChart")(body)).toBe(true);
    // The union member is also a member of the response union the contract
    // declares for the operation.
    expect(getValidator("TitleChartResponse")(body)).toBe(true);
    expect(body.metric).toBe("tracked_titles");
    expect(body.windowDays).toBe(7);
    expect(body.requestedGrouping).toBe("none");
    expect(body.appliedGrouping).toBe("none");
    expect(body.groupingFallback).toBe(false);
    expect(body.days).toEqual([
      "2025-12-26",
      "2025-12-27",
      "2025-12-28",
      "2025-12-29",
      "2025-12-30",
      "2025-12-31",
      "2026-01-01",
    ]);
    expect(body.series).toHaveLength(1);
    expect(body.series[0].key).toBe("total");
    expect(body.series[0].values).toEqual([3, 3, 4, 3, 3, 3, 3]);
  });

  it("defaults to the 14-day window ending today", async () => {
    const read = await world.app.inject({
      method: "GET",
      url: "/api/dashboard/title-chart",
      query: { metric: "tracked_titles" },
      headers: { cookie: admin.cookie },
    });
    expect(read.statusCode).toBe(200);
    const body = read.json();
    expect(body.windowDays).toBe(14);
    expect(body.days).toHaveLength(14);
    expect(body.days[0]).toBe("2025-12-19");
    expect(body.days[13]).toBe("2026-01-01");
    // 12-19 precedes every birth; P, Q, R run from 12-20; S lifts 12-28 to
    // four; P's pause drops it back to three on 12-29.
    expect(body.series[0].values).toEqual([0, 3, 3, 3, 3, 3, 3, 3, 3, 4, 3, 3, 3, 3]);
  });

  it("covers the 30-day window back to its first day", async () => {
    const read = await world.app.inject({
      method: "GET",
      url: "/api/dashboard/title-chart",
      query: { metric: "tracked_titles", windowDays: "30" },
      headers: { cookie: admin.cookie },
    });
    expect(read.statusCode).toBe(200);
    const body = read.json();
    expect(body.windowDays).toBe(30);
    expect(body.days).toHaveLength(30);
    expect(body.days[0]).toBe("2025-12-03");
    expect(body.days[29]).toBe("2026-01-01");
    const values = body.series[0].values as number[];
    // Nothing existed before 2025-12-20; the merged duplicate never counts.
    expect(values.slice(0, 17)).toEqual(Array.from({ length: 17 }, () => 0));
    expect(values.slice(17, 25)).toEqual([3, 3, 3, 3, 3, 3, 3, 3]);
    expect(values.slice(25)).toEqual([4, 3, 3, 3, 3]);
  });

  it("splits one series per title group", async () => {
    const read = await world.app.inject({
      method: "GET",
      url: "/api/dashboard/title-chart",
      query: { metric: "tracked_titles", windowDays: "7", groupBy: "title_group" },
      headers: { cookie: admin.cookie },
    });
    expect(read.statusCode).toBe(200);
    const body = read.json();
    expect(getValidator("TrackedTitlesChart")(body)).toBe(true);
    expect(body.appliedGrouping).toBe("title_group");
    expect(body.groupingFallback).toBe(false);
    expect(body.series).toHaveLength(2);
    const byKey = new Map(
      (body.series as Array<{ key: string; label: string; values: number[] }>).map(
        (series) => [series.label, series.values],
      ),
    );
    // A group: P leaves on its pause day; B group: S arrives on 12-28.
    expect(byKey.get("A group")).toEqual([2, 2, 2, 1, 1, 1, 1]);
    expect(byKey.get("B group")).toEqual([1, 1, 2, 2, 2, 2, 2]);
  });

  it("falls back to the total for the inapplicable engine grouping", async () => {
    const read = await world.app.inject({
      method: "GET",
      url: "/api/dashboard/title-chart",
      query: { metric: "tracked_titles", windowDays: "7", groupBy: "engine" },
      headers: { cookie: admin.cookie },
    });
    expect(read.statusCode).toBe(200);
    const body = read.json();
    expect(getValidator("TrackedTitlesChart")(body)).toBe(true);
    expect(body.requestedGrouping).toBe("engine");
    expect(body.appliedGrouping).toBe("none");
    expect(body.groupingFallback).toBe(true);
    expect(body.series).toHaveLength(1);
    expect(body.series[0].key).toBe("total");
    expect(body.series[0].values).toEqual([3, 3, 4, 3, 3, 3, 3]);
  });

  it("renders the tracked-titles tiles", async () => {
    const read = await world.app.inject({
      method: "GET",
      url: "/api/dashboard/title-chart",
      query: { metric: "tracked_titles", windowDays: "7" },
      headers: { cookie: admin.cookie },
    });
    expect(read.statusCode).toBe(200);
    const body = read.json();
    // Today: Q, R, S run (3), P is paused (1), and two groups exist.
    expect(body.tiles).toEqual({
      currentCount: 3,
      pausedCount: 1,
      titleGroupCount: 2,
    });
    expect(getValidator("TrackedTitlesTiles")(body.tiles)).toBe(true);
  });

  it("refuses an unknown metric or window with 400", async () => {
    const badMetric = await world.app.inject({
      method: "GET",
      url: "/api/dashboard/title-chart",
      query: { metric: "nonsense" },
      headers: { cookie: admin.cookie },
    });
    expect(badMetric.statusCode).toBe(400);
    expect(badMetric.json().code).toBe("validation_failed");
    const badWindow = await world.app.inject({
      method: "GET",
      url: "/api/dashboard/title-chart",
      query: { metric: "tracked_titles", windowDays: "10" },
      headers: { cookie: admin.cookie },
    });
    expect(badWindow.statusCode).toBe(400);
    expect(badWindow.json().code).toBe("validation_failed");
  });

  it("keeps a resumed title's pause gap: paused days stay paused, later days return", async () => {
    // The pause history (0010) read through the chart: a paused-and-resumed
    // title must leave its paused days paused and return from its resume
    // day on — resuming never erases the interval. The period is seeded the
    // way the write path records it (catalogue-variants asserts that half);
    // the chart's day semantics are the object under test here.
    const groupC = await seedGroup(world.pool, "C group");
    await seedTrackedTitle(world.pool, admin.operatorId, {
      groupId: groupC,
      name: "Returning",
      createdAt: "2025-12-20T00:00:00Z",
      // Paused 2025-12-29, resumed 2025-12-31: the pause covers the days
      // [12-29, 12-30]; the resume day itself counts again.
      pausedAt: "2025-12-29T06:00:00Z",
      resumedAt: "2025-12-31T06:00:00Z",
    });

    const read = await world.app.inject({
      method: "GET",
      url: "/api/dashboard/title-chart",
      query: { metric: "tracked_titles", windowDays: "7", groupBy: "title_group" },
      headers: { cookie: admin.cookie },
    });
    expect(read.statusCode).toBe(200);
    const body = read.json();
    const series = (
      body.series as Array<{ key: string; label: string; values: number[] }>
    ).find((entry) => entry.label === "C group");
    expect(series?.values).toEqual([1, 1, 1, 0, 0, 1, 1]);
  });
});
