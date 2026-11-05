import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ceremonyApp,
  signedInAdministrator,
  type CeremonyApp,
  type SignedInOperator,
} from "./ceremony.js";
import { seedRightsHolderContact, profiles } from "./notices-helpers.js";
import { seedApprovedNotice, seedGroup, seedTrackedTitle, seedViolation } from "./dashboard-helpers.js";
import { getValidator } from "../../src/plugins/validator.js";

/**
 * The violations metrics of the title chart (docs/design/dashboard-ui.md
 * "Title chart"): titles with violations, where a title counts once per day
 * holding at least one violation open that day — open means detected on or
 * before the day and not resolved on or before it — and resolved violations,
 * which left the open state that day on one of two bases. Today is
 * 2026-01-01; the 7-day window is 2025-12-26..2026-01-01.
 *
 * Seeded lifecycles (title — detected → closed):
 *   V1 T1  12-27 12:00 → open              (engines google+yandex)
 *   V2 T2  12-20 00:00 → removed 12-30 06:00  (google)
 *   V3 T1  12-31 23:00 → closed  01-01 01:00  (yandex)
 *   V4 T3  12-28 05:00 → removed 12-28 20:00  (google; detected AND resolved
 *        the same day, so it counts in both series on 12-28)
 *   V5 T3  12-26 00:00 → open              (yandex)
 *   V6 T4  12-26 00:00.000 exactly → open  (yandex; the UTC midnight edge)
 *   V7 T5  12-25 23:59:59.999 → open       (google; the day before, so on
 *        12-25 it is already open)
 * V2 is cited by an approved Google notice and V3 by a Yandex one; V4 is
 * never cited.
 *
 * Hand-derived titles-with-violations totals over the 7-day window:
 *   12-26 {T2,T3,T4,T5}=4; 12-27 {T1..T5}=5; 12-28 5 (V4's same day);
 *   12-29 5 (V2 open through 12-29); 12-30 4 (V2 resolved);
 *   12-31 4 (V3 detected 12-31); 01-01 4 (V3 resolved ON 01-01 and detected
 *   12-31, so not open on 01-01 — T1 stays via V1).
 */
describe("dashboard title chart: violations metrics", () => {
  let world: CeremonyApp;
  let admin: SignedInOperator;

  beforeAll(async () => {
    world = await ceremonyApp();
    admin = await signedInAdministrator(world, "admin@example.test");

    await seedRightsHolderContact(world.pool);
    const profilesByRecipient = await profiles(world.pool);

    const first = await seedGroup(world.pool, "First group");
    const second = await seedGroup(world.pool, "Second group");
    const born = "2025-11-01T00:00:00Z";
    const t1 = await seedTrackedTitle(world.pool, admin.operatorId, {
      groupId: first,
      name: "T1",
      createdAt: born,
    });
    const t2 = await seedTrackedTitle(world.pool, admin.operatorId, {
      groupId: first,
      name: "T2",
      createdAt: born,
    });
    const t3 = await seedTrackedTitle(world.pool, admin.operatorId, {
      groupId: second,
      name: "T3",
      createdAt: born,
    });
    const t4 = await seedTrackedTitle(world.pool, admin.operatorId, {
      groupId: second,
      name: "T4",
      createdAt: born,
    });
    const t5 = await seedTrackedTitle(world.pool, admin.operatorId, {
      groupId: second,
      name: "T5",
      createdAt: born,
    });

    const v1 = await seedViolation(world.pool, admin.operatorId, {
      titleId: t1.titleId,
      variantId: t1.variantId,
      url: "https://v1.example.test/a",
      detectedAt: "2025-12-27T12:00:00Z",
      engines: ["google", "yandex"],
    });
    const v2 = await seedViolation(world.pool, admin.operatorId, {
      titleId: t2.titleId,
      variantId: t2.variantId,
      url: "https://v2.example.test/a",
      detectedAt: "2025-12-20T00:00:00Z",
      state: "removed",
      closedAt: "2025-12-30T06:00:00Z",
      engines: ["google"],
    });
    const v3 = await seedViolation(world.pool, admin.operatorId, {
      titleId: t1.titleId,
      variantId: t1.variantId,
      url: "https://v3.example.test/a",
      detectedAt: "2025-12-31T23:00:00Z",
      state: "closed",
      closedAt: "2026-01-01T01:00:00Z",
      engines: ["yandex"],
    });
    await seedViolation(world.pool, admin.operatorId, {
      titleId: t3.titleId,
      variantId: t3.variantId,
      url: "https://v4.example.test/a",
      detectedAt: "2025-12-28T05:00:00Z",
      state: "removed",
      closedAt: "2025-12-28T20:00:00Z",
      engines: ["google"],
    });
    await seedViolation(world.pool, admin.operatorId, {
      titleId: t3.titleId,
      variantId: t3.variantId,
      url: "https://v5.example.test/a",
      detectedAt: "2025-12-26T00:00:00Z",
      engines: ["yandex"],
    });
    await seedViolation(world.pool, admin.operatorId, {
      titleId: t4.titleId,
      variantId: t4.variantId,
      url: "https://v6.example.test/a",
      detectedAt: "2025-12-26T00:00:00.000Z",
      engines: ["yandex"],
    });
    await seedViolation(world.pool, admin.operatorId, {
      titleId: t5.titleId,
      variantId: t5.variantId,
      url: "https://v7.example.test/a",
      detectedAt: "2025-12-25T23:59:59.999Z",
      engines: ["google"],
    });

    // The recipient attribution: V2 through Google, V3 through Yandex.
    await seedApprovedNotice(world.pool, {
      recipient: "google",
      profileId: profilesByRecipient.get("google")!.id,
      operatorId: admin.operatorId,
      composedAt: "2025-12-25T00:00:00Z",
      approvedAt: "2025-12-25T01:00:00Z",
      citations: [{ violationId: v2.violationId, titleId: t2.titleId, url: "https://v2.example.test/a" }],
    });
    await seedApprovedNotice(world.pool, {
      recipient: "yandex",
      profileId: profilesByRecipient.get("yandex")!.id,
      operatorId: admin.operatorId,
      composedAt: "2025-12-31T00:00:00Z",
      approvedAt: "2025-12-31T01:00:00Z",
      citations: [{ violationId: v3.violationId, titleId: t1.titleId, url: "https://v3.example.test/a" }],
    });
  });

  afterAll(async () => {
    await world.app.close();
    await world.pool.end();
  });

  it("counts each title once per day with an open violation", async () => {
    const read = await world.app.inject({
      method: "GET",
      url: "/api/dashboard/title-chart",
      query: { metric: "titles_with_violations", windowDays: "7" },
      headers: { cookie: admin.cookie },
    });
    expect(read.statusCode).toBe(200);
    const body = read.json();
    expect(getValidator("TitlesWithViolationsChart")(body)).toBe(true);
    expect(body.metric).toBe("titles_with_violations");
    expect(body.windowDays).toBe(7);
    expect(body.appliedGrouping).toBe("none");
    expect(body.groupingFallback).toBe(false);
    expect(body.series).toHaveLength(1);
    expect(body.series[0].values).toEqual([4, 5, 5, 5, 4, 4, 4]);
  });

  it("keeps the UTC day boundaries across midnight", async () => {
    const read = await world.app.inject({
      method: "GET",
      url: "/api/dashboard/title-chart",
      query: { metric: "titles_with_violations", windowDays: "30" },
      headers: { cookie: admin.cookie },
    });
    expect(read.statusCode).toBe(200);
    const body = read.json();
    expect(body.days).toHaveLength(30);
    expect(body.days[0]).toBe("2025-12-03");
    expect(body.days[29]).toBe("2026-01-01");
    const values = body.series[0].values as number[];
    // V2's T2 opens the series on 12-20; V7's T5 (detected 23:59:59.999 on
    // 12-25) joins on 12-25; the 12-26 midnight instant of V6 counts ON
    // 12-26; the window peaks at five and settles at four after V2's
    // resolution on 12-30.
    expect(values[17]).toBe(1);
    expect(values[22]).toBe(2);
    expect(values[23]).toBe(4);
    expect(values.slice(24, 27)).toEqual([5, 5, 5]);
    expect(values.slice(27)).toEqual([4, 4, 4]);
    expect(values.slice(0, 17)).toEqual(Array.from({ length: 17 }, () => 0));
  });

  it("splits by title group", async () => {
    const read = await world.app.inject({
      method: "GET",
      url: "/api/dashboard/title-chart",
      query: { metric: "titles_with_violations", windowDays: "7", groupBy: "title_group" },
      headers: { cookie: admin.cookie },
    });
    expect(read.statusCode).toBe(200);
    const body = read.json();
    expect(body.appliedGrouping).toBe("title_group");
    const byLabel = new Map(
      (body.series as Array<{ label: string; values: number[] }>).map((series) => [
        series.label,
        series.values,
      ]),
    );
    // First group holds T1 and T2; second holds T3, T4, T5 throughout.
    expect(byLabel.get("First group")).toEqual([1, 2, 2, 2, 1, 1, 1]);
    expect(byLabel.get("Second group")).toEqual([3, 3, 3, 3, 3, 3, 3]);
  });

  it("counts a title once per engine, so series can sum above the total", async () => {
    const read = await world.app.inject({
      method: "GET",
      url: "/api/dashboard/title-chart",
      query: { metric: "titles_with_violations", windowDays: "7", groupBy: "engine" },
      headers: { cookie: admin.cookie },
    });
    expect(read.statusCode).toBe(200);
    const body = read.json();
    expect(getValidator("TitlesWithViolationsChart")(body)).toBe(true);
    expect(body.appliedGrouping).toBe("engine");
    expect(body.groupingFallback).toBe(false);
    const byKey = new Map(
      (body.series as Array<{ key: string; values: number[] }>).map((series) => [
        series.key,
        series.values,
      ]),
    );
    expect(byKey.get("google")).toEqual([2, 3, 4, 3, 2, 2, 2]);
    expect(byKey.get("yandex")).toEqual([2, 3, 3, 3, 3, 3, 3]);
    // On 12-28 the two series sum to seven against the total's five: V1's
    // title counts once per engine, and V4's same-day resolution keeps T3 in
    // Google's count while Yandex holds it via V5.
    expect(byKey.get("google")![2] + byKey.get("yandex")![2]).toBe(7);
  });

  it("falls back to the total for the recipient grouping", async () => {
    const read = await world.app.inject({
      method: "GET",
      url: "/api/dashboard/title-chart",
      query: { metric: "titles_with_violations", windowDays: "7", groupBy: "recipient" },
      headers: { cookie: admin.cookie },
    });
    expect(read.statusCode).toBe(200);
    const body = read.json();
    expect(body.requestedGrouping).toBe("recipient");
    expect(body.appliedGrouping).toBe("none");
    expect(body.groupingFallback).toBe(true);
    expect(body.series).toHaveLength(1);
    expect(body.series[0].values).toEqual([4, 5, 5, 5, 4, 4, 4]);
  });

  it("renders the titles-with-violations tiles", async () => {
    const read = await world.app.inject({
      method: "GET",
      url: "/api/dashboard/title-chart",
      query: { metric: "titles_with_violations", windowDays: "7" },
      headers: { cookie: admin.cookie },
    });
    expect(read.statusCode).toBe(200);
    const body = read.json();
    // Today: T1 (V1), T3 (V5), T4 (V6), T5 (V7) hold open violations across
    // both groups; the window peaked at five titles.
    expect(body.tiles).toEqual({
      countToday: 4,
      groupsAffectedToday: 2,
      peakInWindow: 5,
    });
    expect(getValidator("TitlesWithViolationsTiles")(body.tiles)).toBe(true);
  });

  it("resolves violations that left open that day on the removed+closed basis", async () => {
    const read = await world.app.inject({
      method: "GET",
      url: "/api/dashboard/title-chart",
      query: { metric: "resolved_violations", windowDays: "7" },
      headers: { cookie: admin.cookie },
    });
    expect(read.statusCode).toBe(200);
    const body = read.json();
    expect(getValidator("ResolvedViolationsChart")(body)).toBe(true);
    expect(getValidator("TitleChartResponse")(body)).toBe(true);
    expect(body.metric).toBe("resolved_violations");
    expect(body.resolvedBasis).toBe("removed_and_closed");
    // V4 on 12-28, V2 on 12-30, V3 on 01-01.
    expect(body.series[0].values).toEqual([0, 0, 1, 0, 1, 0, 1]);
    expect(body.tiles).toEqual({ totalInWindow: 3, removedCount: 2, closedCount: 1 });
    expect(getValidator("ResolvedViolationsTiles")(body.tiles)).toBe(true);
  });

  it("narrows the resolved metric to the closed-only basis", async () => {
    const read = await world.app.inject({
      method: "GET",
      url: "/api/dashboard/title-chart",
      query: { metric: "resolved_violations", windowDays: "7", basis: "closed_only" },
      headers: { cookie: admin.cookie },
    });
    expect(read.statusCode).toBe(200);
    const body = read.json();
    expect(body.resolvedBasis).toBe("closed_only");
    // Only V3 (operator-closed) remains; the tiles describe the counted set.
    expect(body.series[0].values).toEqual([0, 0, 0, 0, 0, 0, 1]);
    expect(body.tiles).toEqual({ totalInWindow: 1, removedCount: 0, closedCount: 1 });
  });

  it("groups resolutions by group and engine", async () => {
    const byGroup = await world.app.inject({
      method: "GET",
      url: "/api/dashboard/title-chart",
      query: { metric: "resolved_violations", windowDays: "7", groupBy: "title_group" },
      headers: { cookie: admin.cookie },
    });
    expect(byGroup.statusCode).toBe(200);
    const groupBody = byGroup.json();
    const byLabel = new Map(
      (groupBody.series as Array<{ label: string; values: number[] }>).map((series) => [
        series.label,
        series.values,
      ]),
    );
    // First group: V2 (12-30) and V3 (01-01); second: V4 (12-28).
    expect(byLabel.get("First group")).toEqual([0, 0, 0, 0, 1, 0, 1]);
    expect(byLabel.get("Second group")).toEqual([0, 0, 1, 0, 0, 0, 0]);

    const byEngine = await world.app.inject({
      method: "GET",
      url: "/api/dashboard/title-chart",
      query: { metric: "resolved_violations", windowDays: "7", groupBy: "engine" },
      headers: { cookie: admin.cookie },
    });
    expect(byEngine.statusCode).toBe(200);
    const byKey = new Map(
      (byEngine.json().series as Array<{ key: string; values: number[] }>).map((series) => [
        series.key,
        series.values,
      ]),
    );
    expect(byKey.get("google")).toEqual([0, 0, 1, 0, 1, 0, 0]);
    expect(byKey.get("yandex")).toEqual([0, 0, 0, 0, 0, 0, 1]);
  });

  it("attributes resolutions to the citing notice's recipient", async () => {
    const read = await world.app.inject({
      method: "GET",
      url: "/api/dashboard/title-chart",
      query: { metric: "resolved_violations", windowDays: "7", groupBy: "recipient" },
      headers: { cookie: admin.cookie },
    });
    expect(read.statusCode).toBe(200);
    const body = read.json();
    expect(getValidator("ResolvedViolationsChart")(body)).toBe(true);
    expect(body.appliedGrouping).toBe("recipient");
    expect(body.groupingFallback).toBe(false);
    const byKey = new Map(
      (body.series as Array<{ key: string; values: number[] }>).map((series) => [
        series.key,
        series.values,
      ]),
    );
    // V2 left through a Google notice on 12-30; V3 through a Yandex notice on
    // 01-01; V4 was never cited, so no recipient series carries it — the
    // series sum below the total exactly as the engine grouping can sum
    // above it.
    expect(byKey.get("google")).toEqual([0, 0, 0, 0, 1, 0, 0]);
    expect(byKey.get("yandex")).toEqual([0, 0, 0, 0, 0, 0, 1]);
    expect(body.tiles.totalInWindow).toBe(3);
  });

  it("keeps an engines value outside the fixed order as its own bucket", async () => {
    // candidates.engines is free text while the first-engine column is
    // enum-constrained, so an unknown value travels beside a known engine:
    // a value the display order does not know still counts — its own
    // series, keyed and labelled by the raw value after the known engines —
    // so titles are never silently dropped and the sums reconcile.
    const group = await seedGroup(world.pool, "Third group");
    const t6 = await seedTrackedTitle(world.pool, admin.operatorId, {
      groupId: group,
      name: "T6",
      createdAt: "2025-11-01T00:00:00Z",
    });
    await seedViolation(world.pool, admin.operatorId, {
      titleId: t6.titleId,
      variantId: t6.variantId,
      url: "https://v8.example.test/a",
      detectedAt: "2025-12-27T00:00:00Z",
      engines: ["google", "duckduckgo"],
    });
    await seedViolation(world.pool, admin.operatorId, {
      titleId: t6.titleId,
      variantId: t6.variantId,
      url: "https://v9.example.test/a",
      detectedAt: "2025-12-26T00:00:00Z",
      state: "removed",
      closedAt: "2025-12-29T00:00:00Z",
      engines: ["google", "duckduckgo"],
    });

    const open = await world.app.inject({
      method: "GET",
      url: "/api/dashboard/title-chart",
      query: { metric: "titles_with_violations", windowDays: "7", groupBy: "engine" },
      headers: { cookie: admin.cookie },
    });
    expect(open.statusCode).toBe(200);
    const openBody = open.json();
    // The known engines keep their order; the unknown value follows.
    expect(
      (openBody.series as Array<{ key: string }>).map((series) => series.key),
    ).toEqual(["google", "yandex", "duckduckgo"]);
    const openByKey = new Map(
      (openBody.series as Array<{ key: string; label: string; values: number[] }>).map(
        (series) => [series.key, series],
      ),
    );
    // T6 holds in both its engines' counts every day (V9 open 12-26..12-28,
    // V8 from 12-27 on); the raw value is the label because no catalogue
    // key exists for it.
    expect(openByKey.get("google")?.values).toEqual([3, 4, 5, 4, 3, 3, 3]);
    expect(openByKey.get("duckduckgo")?.label).toBe("duckduckgo");
    expect(openByKey.get("duckduckgo")?.values).toEqual([1, 1, 1, 1, 1, 1, 1]);

    const resolved = await world.app.inject({
      method: "GET",
      url: "/api/dashboard/title-chart",
      query: { metric: "resolved_violations", windowDays: "7", groupBy: "engine" },
      headers: { cookie: admin.cookie },
    });
    expect(resolved.statusCode).toBe(200);
    const resolvedByKey = new Map(
      (resolved.json().series as Array<{ key: string; label: string; values: number[] }>).map(
        (series) => [series.key, series],
      ),
    );
    // V9 resolved on 12-29 into BOTH its engines' buckets: DuckDuckGo's
    // beside Google's V4 (12-28), V9 (12-29), V2 (12-30) and Yandex's V3
    // (01-01).
    expect(resolvedByKey.get("duckduckgo")?.label).toBe("duckduckgo");
    expect(resolvedByKey.get("duckduckgo")?.values).toEqual([0, 0, 0, 1, 0, 0, 0]);
    expect(resolvedByKey.get("google")?.values).toEqual([0, 0, 1, 1, 1, 0, 0]);
  });
});
