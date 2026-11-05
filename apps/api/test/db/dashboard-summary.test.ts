import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import {
  authHeaders,
  ceremonyApp,
  signedInAdministrator,
  type CeremonyApp,
  type SignedInOperator,
} from "./ceremony.js";
import { seedRightsHolderContact, profiles } from "./notices-helpers.js";
import {
  anyGroup,
  seedAcknowledgedSubmission,
  seedApprovedNotice,
  seedDecision,
  seedDraftNotice,
  seedFinishedScan,
  seedPendingCandidate,
  seedTrackedTitle,
  seedViolation,
} from "./dashboard-helpers.js";
import { getValidator } from "../../src/plugins/validator.js";
import { commitReservation, reserve } from "../../src/domain/budget/ledger.js";
import { evaluateBudgetAlerts } from "../../src/domain/budget/alerts.js";
import { t, TEST_LOCALE } from "@patrol/i18n";

/**
 * Slice 8's dashboard summary (docs/design/dashboard-ui.md "Dashboard"): the
 * four counters with the draft-notice badge, the engine quota row where one
 * exhausted engine never blocks another, and the five-entry activity feed
 * merged from the four event kinds. Every expected number below is
 * hand-derived from the seeded rows, never recomputed the way the read model
 * does.
 */
describe("dashboard summary", () => {
  let world: CeremonyApp;
  let admin: SignedInOperator;
  let pool: Pool;
  let googleProfile: string;
  let yandexProfile: string;

  let acknowledgedNotice: string;
  let acknowledgedSubmission: string;
  let decisionCandidate: string;
  let succeededScan: string;

  beforeAll(async () => {
    world = await ceremonyApp();
    admin = await signedInAdministrator(world, "admin@example.test");
    pool = world.pool;

    await seedRightsHolderContact(pool);
    const profilesByRecipient = await profiles(pool);
    googleProfile = profilesByRecipient.get("google")!.id;
    yandexProfile = profilesByRecipient.get("yandex")!.id;

    // A $0.60 Google cap buys 1,000 units (700 scan, 300 re-check); Yandex
    // $0.25 buys 1,000; Bing stays at zero.
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

    // Google's re-check share spent in full: 300 reserved, 300 committed.
    const hold = await reserve(pool, world.clock.now, {
      engine: "google",
      bucket: "recheck",
      units: 300,
    });
    if (hold.outcome !== "reserved") {
      throw new Error("recheck reserve failed");
    }
    await commitReservation(pool, world.clock.now, hold.reservation.id, 300);
    const fired = await evaluateBudgetAlerts(pool, {
      engine: "google",
      now: world.clock.now,
    });
    expect(fired.map((alert) => alert.threshold).sort()).toEqual([
      "critical",
      "exhausted",
    ]);
    // The route state disables Google after an authentication failure; the
    // row beside it must stay healthy and scanning.
    await pool.query(
      `insert into route_state (engine, disabled, disabled_reason, disabled_at, probe_next_at)
       values ('google', true, 'authentication', '2025-12-31T08:00:00Z', '2026-01-01T00:00:00Z')`,
    );

    // The catalogue: one group, three titles.
    const group = await anyGroup(pool);
    const a = await seedTrackedTitle(pool, admin.operatorId, {
      groupId: group,
      name: "Sunrise",
      createdAt: "2025-12-01T00:00:00Z",
    });
    const b = await seedTrackedTitle(pool, admin.operatorId, {
      groupId: group,
      name: "Moonlight",
      createdAt: "2025-12-01T00:00:00Z",
    });
    const c = await seedTrackedTitle(pool, admin.operatorId, {
      groupId: group,
      name: "Daybreak",
      createdAt: "2025-12-01T00:00:00Z",
    });

    // Five violations: three open, one removed, one operator-closed.
    const open1 = await seedViolation(pool, admin.operatorId, {
      titleId: a.titleId,
      variantId: a.variantId,
      url: "https://open1.example.test/a",
      detectedAt: "2025-12-15T00:00:00Z",
    });
    await seedViolation(pool, admin.operatorId, {
      titleId: a.titleId,
      variantId: a.variantId,
      url: "https://open2.example.test/a",
      detectedAt: "2025-12-16T00:00:00Z",
    });
    await seedViolation(pool, admin.operatorId, {
      titleId: b.titleId,
      variantId: b.variantId,
      url: "https://open3.example.test/b",
      detectedAt: "2025-12-17T00:00:00Z",
    });
    await seedViolation(pool, admin.operatorId, {
      titleId: b.titleId,
      variantId: b.variantId,
      url: "https://removed.example.test/b",
      detectedAt: "2025-12-18T00:00:00Z",
      state: "removed",
      closedAt: "2025-12-20T00:00:00Z",
    });
    await seedViolation(pool, admin.operatorId, {
      titleId: c.titleId,
      variantId: c.variantId,
      url: "https://closed.example.test/c",
      detectedAt: "2025-12-19T00:00:00Z",
      state: "closed",
      closedAt: "2025-12-21T00:00:00Z",
    });

    // Candidates: two pending in the queue, one suppressed into band C, and
    // the decided one whose decision the feed lists.
    decisionCandidate = await seedPendingCandidate(pool, admin.operatorId, {
      titleId: c.titleId,
      variantId: c.variantId,
      url: "https://pending1.example.test/c",
    });
    await seedPendingCandidate(pool, admin.operatorId, {
      titleId: c.titleId,
      variantId: c.variantId,
      url: "https://pending2.example.test/c",
    });
    await seedPendingCandidate(pool, admin.operatorId, {
      titleId: c.titleId,
      variantId: c.variantId,
      url: "https://suppressed.example.test/c",
      band: "c",
    });
    const decisionId = await seedDecision(pool, admin.operatorId, {
      candidateId: decisionCandidate,
      action: "not_a_violation",
      decidedAt: "2025-12-31T12:00:00Z",
    });
    await pool.query(
      `update candidates set state = 'dismissed', review_decision_id = $2,
         dismissed_at = '2025-12-31T12:00:00Z',
         dismissal = '{"reason":"not_a_violation"}'::jsonb where id = $1`,
      [decisionCandidate, decisionId],
    );

    // Notices: one draft, two approved (one acknowledged, one delivered),
    // one withdrawn, one superseded.
    await seedDraftNotice(pool, {
      recipient: "google",
      profileId: googleProfile,
      operatorId: admin.operatorId,
      composedAt: "2025-12-30T00:00:00Z",
    });
    acknowledgedNotice = await seedApprovedNotice(pool, {
      recipient: "google",
      profileId: googleProfile,
      operatorId: admin.operatorId,
      composedAt: "2025-12-30T00:00:00Z",
      approvedAt: "2025-12-31T14:00:00Z",
      citations: [
        { violationId: open1.violationId, titleId: a.titleId, url: "https://open1.example.test/a" },
      ],
    });
    acknowledgedSubmission = await seedAcknowledgedSubmission(pool, {
      noticeId: acknowledgedNotice,
      profileId: googleProfile,
      operatorId: admin.operatorId,
      acknowledgedAt: "2025-12-31T16:00:00Z",
      recipient: "google",
    });
    const delivered = await seedApprovedNotice(pool, {
      recipient: "yandex",
      profileId: yandexProfile,
      operatorId: admin.operatorId,
      composedAt: "2025-12-29T00:00:00Z",
      approvedAt: "2025-12-30T00:00:00Z",
      citations: [],
    });
    await pool.query(
      `insert into submissions
         (notice_id, recipient_profile_id, channel, state, attempt_count, pack_language,
          operator_id, delivered_at, attested_at, statement_version)
       values ($1, $2, 'web_form', 'delivered', 1, 'en', $3, '2025-12-30T12:00:00Z',
          '2025-12-30T12:00:00Z', 'yandex.en.v1@209722198e33')`,
      [delivered, yandexProfile, admin.operatorId],
    );
    const withdrawn = await seedApprovedNotice(pool, {
      recipient: "google",
      profileId: googleProfile,
      operatorId: admin.operatorId,
      composedAt: "2025-12-28T00:00:00Z",
      approvedAt: "2025-12-28T01:00:00Z",
      citations: [],
    });
    await pool.query(
      `update notices set state = 'withdrawn', withdrawn_by = $2, withdrawn_at = '2025-12-29T00:00:00Z',
         withdrawal_reason = 'seed' where id = $1`,
      [withdrawn, admin.operatorId],
    );
    await pool.query(
      `update notice_citations set state = 'withdrawn' where notice_id = $1`,
      [withdrawn],
    );
    const superseded = await seedDraftNotice(pool, {
      recipient: "google",
      profileId: googleProfile,
      operatorId: admin.operatorId,
      composedAt: "2025-12-27T00:00:00Z",
    });
    await pool.query(
      `update notices set state = 'superseded', superseded_at = '2025-12-28T00:00:00Z',
         superseded_by_notice_id = $2 where id = $1`,
      [superseded, acknowledgedNotice],
    );

    // Scans: one succeeded in the morning, one failed in the evening.
    succeededScan = await seedFinishedScan(pool, {
      groupId: group,
      engine: "google",
      state: "succeeded",
      finishedAt: "2025-12-31T10:00:00Z",
    });
    await seedFinishedScan(pool, {
      groupId: group,
      engine: "yandex",
      state: "failed",
      finishedAt: "2025-12-31T18:00:00Z",
    });
  });

  afterAll(async () => {
    await world.app.close();
    await world.pool.end();
  });

  it("counts the four counters and the draft badge", async () => {
    const read = await world.app.inject({
      method: "GET",
      url: "/api/dashboard/summary",
      headers: { cookie: admin.cookie },
    });
    expect(read.statusCode).toBe(200);
    const body = read.json();
    expect(getValidator("DashboardSummary")(body)).toBe(true);
    // Three open violations stand; the removed and closed ones do not count.
    // The queue holds one pending candidate (the band-C row is suppressed);
    // the dismissed row left. Notices on file run from draft onward: the
    // draft plus the two approved — the withdrawn and superseded are off
    // file. One submission is acknowledged.
    expect(body.counters).toEqual({
      openViolations: 3,
      candidatesToReview: 1,
      noticesOnFile: 3,
      draftNotices: 1,
      acknowledgedSubmissions: 1,
    });
  });

  it("shows the engine row with one exhausted engine beside a healthy one", async () => {
    const read = await world.app.inject({
      method: "GET",
      url: "/api/dashboard/summary",
      headers: { cookie: admin.cookie },
    });
    expect(read.statusCode).toBe(200);
    const body = read.json();
    // Google, Bing, Yandex order.
    expect(body.engines.map((engine: { engine: string }) => engine.engine)).toEqual([
      "google",
      "bing",
      "yandex",
    ]);
    const google = body.engines[0];
    expect(google).toEqual({
      engine: "google",
      allowanceUnits: 1_000,
      scanReserved: 0,
      scanCommitted: 0,
      recheckReserved: 0,
      recheckCommitted: 300,
      percentUsed: 30,
      alertLevel: "critical",
      exhausted: true,
      routeDisabled: true,
    });
    // The exhausted engine does not block its neighbour: Yandex is healthy,
    // unalerted, and its route stands.
    expect(body.engines[2]).toEqual({
      engine: "yandex",
      allowanceUnits: 1_000,
      scanReserved: 0,
      scanCommitted: 0,
      recheckReserved: 0,
      recheckCommitted: 0,
      percentUsed: 0,
      alertLevel: "normal",
      exhausted: false,
      routeDisabled: false,
    });
    expect(body.engines[1]).toMatchObject({
      engine: "bing",
      allowanceUnits: 0,
      exhausted: false,
    });
    expect(getValidator("EngineQuotaStatus")(google)).toBe(true);
  });

  it("lists the five most recent events across the four kinds, newest first", async () => {
    const read = await world.app.inject({
      method: "GET",
      url: "/api/dashboard/summary",
      headers: { cookie: admin.cookie },
    });
    expect(read.statusCode).toBe(200);
    const activity = read.json().activity;
    expect(activity).toHaveLength(5);
    expect(activity.map((entry: { kind: string }) => entry.kind)).toEqual([
      "scan_failed",
      "submission_acknowledged",
      "notice_approved",
      "review_decision",
      "scan_succeeded",
    ]);
    expect(activity.map((entry: { occurredAt: string }) => entry.occurredAt)).toEqual([
      "2025-12-31T18:00:00.000Z",
      "2025-12-31T16:00:00.000Z",
      "2025-12-31T14:00:00.000Z",
      "2025-12-31T12:00:00.000Z",
      "2025-12-31T10:00:00.000Z",
    ]);
    // The scans name their scan; the decision its candidate; the approval and
    // the acknowledgement their notice (the link to Notices).
    expect(activity[4].scanId).toBe(succeededScan);
    expect(activity[3].candidateId).toBe(decisionCandidate);
    expect(activity[2].noticeId).toBe(acknowledgedNotice);
    expect(activity[1].noticeId).toBe(acknowledgedNotice);
    expect(activity[1].submissionId).toBe(acknowledgedSubmission);
    // Summaries render in the requesting operator's language (English here).
    expect(activity[0].summary).toBe(
      t(TEST_LOCALE, "dashboard.activity.scan_failed"),
    );
    expect(activity[1].summary).toBe(
      t(TEST_LOCALE, "dashboard.activity.submission_acknowledged"),
    );
    expect(activity[2].summary).toBe(
      t(TEST_LOCALE, "dashboard.activity.notice_approved"),
    );
    expect(activity[3].summary).toBe(
      t(TEST_LOCALE, "dashboard.activity.review_decision"),
    );
    expect(activity[4].summary).toBe(
      t(TEST_LOCALE, "dashboard.activity.scan_succeeded"),
    );
    for (const entry of activity) {
      expect(getValidator("ActivityEntry")(entry)).toBe(true);
    }
  });

  it("renders the feed's summaries in Russian for a Russian operator", async () => {
    const read = await world.app.inject({
      method: "GET",
      url: "/api/dashboard/summary",
      headers: { cookie: admin.cookie, "accept-language": "ru" },
    });
    expect(read.statusCode).toBe(200);
    const activity = read.json().activity;
    expect(activity.length).toBeGreaterThan(0);
    for (const entry of activity) {
      expect(entry.summary).toMatch(/[Ѐ-ӿ]/);
    }
  });
});
