import { beforeEach, describe, expect, it } from "vitest";
import {
  bootstrapAdmin,
  harness,
  read,
  type Harness,
} from "./support/harness.js";

const NOW = new Date("2026-11-04T12:00:00Z");
const MONTH = "2026-11-01";
const SUMMARY_IDS = {
  candidateReviewed: "01900000-0000-7000-8000-000000009001",
  scanSucceeded: "01900000-0000-7000-8000-000000009002",
  scanPartial: "01900000-0000-7000-8000-000000009003",
  scanFailed: "01900000-0000-7000-8000-000000009004",
  noticeApproved: "01900000-0000-7000-8000-000000009005",
  noticeAcknowledged: "01900000-0000-7000-8000-000000009006",
  submissionAcknowledged: "01900000-0000-7000-8000-000000009007",
};

function day(offset: number): string {
  const date = new Date(NOW);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

function at(offsetHours: number): Date {
  return new Date(NOW.getTime() + offsetHours * 60 * 60 * 1000);
}

let h: Harness;
let session: string;
let adminId: string;

beforeEach(async () => {
  h = await harness(undefined, undefined, () => NOW);
  const admin = await bootstrapAdmin(h);
  session = admin.session;
  adminId = admin.operator.id;
});

function expectValid(name: string, value: unknown) {
  const result = h.contract.validate(name, value);
  expect(result).toEqual({ valid: true, issues: [] });
}

async function seedGroup(id: string, name: string) {
  const now = NOW.toISOString();
  await h.db.query(
    `INSERT INTO title_group
      (id, name, locales, scan_time, priority, created_at, updated_at)
     VALUES ($1, $2, '["en-US"]', '02:00:00', 'normal', $3, $3)`,
    [id, name, now],
  );
}

async function seedTitle(
  id: string,
  groupId: string,
  paused = false,
  variantId = `${id}-variant`,
) {
  const now = NOW.toISOString();
  await h.db.query(
    `INSERT INTO tracked_title
      (id, title_group_id, release_year, title_type, runtime_minutes,
       original_variant_id, paused, merged_into_title_id, source, entered_by,
       entered_at, updated_by, created_at, updated_at)
     VALUES ($1, $2, 2026, 'film', 90, $3, $4, NULL, 'operator_knowledge',
             'seed', $5, 'seed', $5, $5)`,
    [id, groupId, variantId, paused, now],
  );
}

async function seedViolation(options: {
  id: string;
  titleId: string;
  groupId: string;
  engine: string;
  state?: string;
  detectedAt: Date;
  closedAt?: Date;
}) {
  const detected = options.detectedAt.toISOString();
  await h.db.query(
    `INSERT INTO violation
      (id, tracked_title_id, state, candidate_id, review_decision_id, url,
       normalized_url, host, host_source, registrable_domain, detected_at,
       confirmed_at, confirmed_by, engine, title_group_id, closed_at,
       closure_reason, closed_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'example.test', 'landing_page',
             'example.test', $8, $8, $9, $10, $11, $12, $13, $14)`,
    [
      options.id,
      options.titleId,
      options.state ?? "open",
      `candidate-${options.id}`,
      `decision-${options.id}`,
      `https://example.test/${options.id}`,
      `example.test/${options.id}`,
      detected,
      adminId,
      options.engine,
      options.groupId,
      options.closedAt?.toISOString() ?? null,
      options.closedAt ? "url_removed" : null,
      options.closedAt ? adminId : null,
    ],
  );
}

async function seedNotice(options: {
  id: string;
  recipient: string;
  state: string;
  createdAt: Date;
  approvedAt?: Date;
}) {
  await h.db.query(
    `INSERT INTO notice
      (id, recipient, recipient_profile_id, channel, state, template_version,
       created_by, created_at, updated_at, approved_at)
     VALUES ($1, $2, $3, 'web_form', $4, 'google.en.v1@hash', $5, $6, $6, $7)`,
    [
      options.id,
      options.recipient,
      `profile-${options.recipient}`,
      options.state,
      adminId,
      options.createdAt,
      options.approvedAt ?? null,
    ],
  );
}

async function seedCitation(noticeId: string, violationId: string) {
  await h.db.query(
    `INSERT INTO notice_citation
      (notice_id, violation_id, evidence_ids, cited_at)
     VALUES ($1, $2, '[]', $3)`,
    [noticeId, violationId, NOW],
  );
}

async function seedSubmission(options: {
  id: string;
  noticeId: string;
  recipient: string;
  state: string;
  createdAt: Date;
  updatedAt: Date;
}) {
  await h.db.query(
    `INSERT INTO submission
      (id, recipient_profile_id, state, notice_id, channel, pack_language,
       attempt_count, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'web_form', 'en', 1, $5, $6)`,
    [
      options.id,
      `profile-${options.recipient}`,
      options.state,
      options.noticeId,
      options.createdAt,
      options.updatedAt,
    ],
  );
}

describe("dashboard summary", () => {
  beforeEach(async () => {
    await seedGroup("group-a", "Group A");
    await seedTitle("title-1", "group-a");
    await seedTitle("title-2", "group-a");
    await seedViolation({
      id: "violation-open-1",
      titleId: "title-1",
      groupId: "group-a",
      engine: "google",
      detectedAt: at(-48),
    });
    await seedViolation({
      id: "violation-open-2",
      titleId: "title-2",
      groupId: "group-a",
      engine: "yandex",
      detectedAt: at(-24),
    });
    for (const [index, state] of ["pending", "pending", "pending", "confirmed"].entries()) {
      await h.db.query(
        `INSERT INTO candidate (id, tracked_title_id, state, created_at)
         VALUES ($1, 'title-1', $2, $3)`,
        [
          index === 0 ? SUMMARY_IDS.candidateReviewed : `candidate-${index}`,
          state,
          at(-48),
        ],
      );
    }

    await seedNotice({
      id: "notice-draft",
      recipient: "bing",
      state: "draft",
      createdAt: at(-12),
    });
    await seedNotice({
      id: "notice-withdrawn",
      recipient: "google",
      state: "withdrawn",
      createdAt: at(-10),
    });
    await seedNotice({
      id: SUMMARY_IDS.noticeApproved,
      recipient: "google",
      state: "approved",
      createdAt: at(-6),
      approvedAt: at(-2),
    });
    await seedNotice({
      id: SUMMARY_IDS.noticeAcknowledged,
      recipient: "yandex",
      state: "approved",
      createdAt: at(-8),
      approvedAt: at(-6),
    });
    await seedSubmission({
      id: SUMMARY_IDS.submissionAcknowledged,
      noticeId: SUMMARY_IDS.noticeAcknowledged,
      recipient: "yandex",
      state: "acknowledged",
      createdAt: at(-8),
      updatedAt: at(-1),
    });

    await h.db.query(
      `INSERT INTO scan
        (id, title_group_id, engine, trigger, due_date, requested_by,
         tracked_title_id, planned_queries, query_plan, state, queued_at,
         queued_reason, started_at, finished_at, issued_queries,
         failure_reason, failures, created_at)
       VALUES ($1, 'group-a', 'google', 'scheduled', $2, NULL,
               NULL, 1, NULL, 'succeeded', $3, NULL, $3, $4, 1, NULL, NULL, $3)`,
      [SUMMARY_IDS.scanSucceeded, day(0), at(-8), at(-6)],
    );
    await h.db.query(
      `INSERT INTO scan
        (id, title_group_id, engine, trigger, due_date, requested_by,
         tracked_title_id, planned_queries, query_plan, state, queued_at,
         queued_reason, started_at, finished_at, issued_queries,
         failure_reason, failures, created_at)
       VALUES ($1, 'group-a', 'yandex', 'scheduled', $2, NULL,
               NULL, 1, NULL, 'partial', $3, NULL, $3, $4, 1, NULL, NULL, $3)`,
      [SUMMARY_IDS.scanPartial, day(0), at(-7), at(-5)],
    );
    await h.db.query(
      `INSERT INTO scan
        (id, title_group_id, engine, trigger, due_date, requested_by,
         tracked_title_id, planned_queries, query_plan, state, queued_at,
         queued_reason, started_at, finished_at, issued_queries,
         failure_reason, failures, created_at)
       VALUES ($1, 'group-a', 'google', 'manual', $2, $3, NULL, 1,
               NULL, 'failed', $4, NULL, $4, $5, 0, 'route_unavailable', NULL, $4)`,
      [SUMMARY_IDS.scanFailed, day(-1), adminId, at(-6), at(-4)],
    );
    await h.db.query(
      `INSERT INTO review_decision
        (id, candidate_id, action, operator_id, decided_at, note, evidence_ids)
       VALUES ('decision-1', $1, 'violation', $2, $3, NULL, '[]')`,
      [SUMMARY_IDS.candidateReviewed, adminId, at(-3)],
    );

    for (const [engine, allowance, scanReserved, scanCommitted, recheckCommitted] of [
      ["google", 100, 80, 0, 21],
      ["bing", 0, 0, 0, 0],
      ["yandex", 100, 0, 10, 0],
    ] as const) {
      await h.db.query(
        `INSERT INTO quota_ledger
          (id, engine, month_start, allowance_units, scan_reserved,
           scan_committed, recheck_reserved, recheck_committed)
         VALUES ($1, $2, $3, $4, $5, $6, 0, $7)`,
        [
          `ledger-${engine}`,
          engine,
          MONTH,
          allowance,
          scanReserved,
          scanCommitted,
          recheckCommitted,
        ],
      );
    }
    await h.db.query(
      `INSERT INTO engine_route
        (engine, disabled_at, disabled_reason, last_probe_at, updated_at)
       VALUES ('yandex', $1, 'Authentication failed.', $1, $1)`,
      [at(-2)],
    );
    for (const [engine, level] of [
      ["google", "critical"],
      ["yandex", "warning"],
    ] as const) {
      await h.db.query(
        `INSERT INTO budget_alert
          (id, engine, bucket, threshold, level, percent_used, message,
           groups_not_scanned, month_start, created_at)
         VALUES ($1, $2, 'scan', $3, $4, 100, 'Alert.', 0, $5, $6)`,
        [`alert-${engine}`, engine, level === "critical" ? "100" : "75", level, MONTH, at(-2)],
      );
    }
  });

  it("counts the four counters and the notices badge", async () => {
    const response = await read(h.app, session, "/api/dashboard/summary");
    expect(response.statusCode).toBe(200);
    expectValid("DashboardSummary", response.json());
    expect(response.json().counters).toEqual({
      openViolations: 2,
      candidatesToReview: 3,
      noticesOnFile: 4,
      draftNotices: 1,
      acknowledgedSubmissions: 1,
    });
  });

  it("reports each engine independently with its own quota badge and route state", async () => {
    const response = await read(h.app, session, "/api/dashboard/summary");
    const engines = response.json().engines as Array<Record<string, unknown>>;
    expect(engines.map((engine) => engine.engine)).toEqual([
      "google",
      "bing",
      "yandex",
    ]);
    expect(engines[0]).toMatchObject({
      allowanceUnits: 100,
      scanReserved: 80,
      scanCommitted: 0,
      recheckReserved: 0,
      recheckCommitted: 21,
      percentUsed: 101,
      alertLevel: "critical",
      exhausted: true,
      routeDisabled: false,
    });
    expect(engines[1]).toMatchObject({
      allowanceUnits: 0,
      percentUsed: 0,
      alertLevel: "normal",
      exhausted: false,
      routeDisabled: false,
    });
    expect(engines[2]).toMatchObject({
      percentUsed: 10,
      alertLevel: "warning",
      exhausted: false,
      routeDisabled: true,
    });
  });

  it("lists the five most recent events newest first", async () => {
    const response = await read(h.app, session, "/api/dashboard/summary");
    const activity = response.json().activity as Array<Record<string, unknown>>;
    expect(activity).toHaveLength(5);
    expect(activity.map((entry) => entry.kind)).toEqual([
      "submission_acknowledged",
      "notice_approved",
      "review_decision",
      "scan_failed",
      "scan_partial",
    ]);
    expect(activity[0].submissionId).toBe(SUMMARY_IDS.submissionAcknowledged);
    expect(activity[1].noticeId).toBe(SUMMARY_IDS.noticeApproved);
    expect(activity[2].candidateId).toBe(SUMMARY_IDS.candidateReviewed);
    expect(activity[3].scanId).toBe(SUMMARY_IDS.scanFailed);
    expect(activity[4].scanId).toBe(SUMMARY_IDS.scanPartial);
    expect(
      activity.every(
        (entry) => typeof entry.summary === "string" && entry.summary.length > 0,
      ),
    ).toBe(true);
  });
});

describe("tracked titles chart", () => {
  beforeEach(async () => {
    await seedGroup("group-a", "Group A");
    await seedGroup("group-b", "Group B");
    await seedTitle("title-a1", "group-a");
    await seedTitle("title-a2", "group-a", true);
    await seedTitle("title-b1", "group-b");
  });

  it("plots a step count by title group and returns the tiles", async () => {
    const response = await read(
      h.app,
      session,
      "/api/dashboard/title-chart?metric=tracked_titles&windowDays=7&groupBy=title_group",
    );
    expect(response.statusCode).toBe(200);
    const chart = response.json();
    expectValid("TitleChartResponse", chart);
    expect(chart.metric).toBe("tracked_titles");
    expect(chart.windowDays).toBe(7);
    expect(chart.days).toEqual(Array.from({ length: 7 }, (_, index) => day(index - 6)));
    expect(chart.requestedGrouping).toBe("title_group");
    expect(chart.appliedGrouping).toBe("title_group");
    expect(chart.groupingFallback).toBe(false);
    expect(chart.series).toEqual([
      { key: "group-a", label: "Group A", values: Array(7).fill(1) },
      { key: "group-b", label: "Group B", values: Array(7).fill(1) },
    ]);
    expect(chart.tiles).toEqual({
      currentCount: 2,
      pausedCount: 1,
      titleGroupCount: 2,
    });
  });

  it("falls back to the total for an inapplicable grouping", async () => {
    const response = await read(
      h.app,
      session,
      "/api/dashboard/title-chart?metric=tracked_titles&windowDays=7&groupBy=engine",
    );
    const chart = response.json();
    expect(chart.requestedGrouping).toBe("engine");
    expect(chart.appliedGrouping).toBe("none");
    expect(chart.groupingFallback).toBe(true);
    expect(chart.series).toEqual([
      { key: "total", label: "All tracked titles", values: Array(7).fill(2) },
    ]);
  });

  it("defaults the window to fourteen days", async () => {
    const response = await read(
      h.app,
      session,
      "/api/dashboard/title-chart?metric=tracked_titles",
    );
    const chart = response.json();
    expect(chart.windowDays).toBe(14);
    expect(chart.days).toHaveLength(14);
    expect(chart.days[0]).toBe(day(-13));
    expect(chart.days[13]).toBe(day(0));
  });
});

describe("titles with violations chart", () => {
  beforeEach(async () => {
    await seedGroup("group-a", "Group A");
    await seedGroup("group-b", "Group B");
    await seedTitle("title-1", "group-a");
    await seedTitle("title-2", "group-b");
    await seedViolation({
      id: "violation-1",
      titleId: "title-1",
      groupId: "group-a",
      engine: "google",
      detectedAt: new Date(`${day(-5)}T09:00:00Z`),
    });
    await seedViolation({
      id: "violation-2",
      titleId: "title-2",
      groupId: "group-b",
      engine: "yandex",
      detectedAt: new Date(`${day(-2)}T09:00:00Z`),
    });
  });

  it("counts each title once per day and returns the tiles", async () => {
    const response = await read(
      h.app,
      session,
      "/api/dashboard/title-chart?metric=titles_with_violations&windowDays=7",
    );
    const chart = response.json();
    expectValid("TitleChartResponse", chart);
    expect(chart.metric).toBe("titles_with_violations");
    expect(chart.appliedGrouping).toBe("none");
    expect(chart.series).toEqual([
      {
        key: "total",
        label: "All titles",
        values: [0, 1, 1, 1, 2, 2, 2],
      },
    ]);
    expect(chart.tiles).toEqual({
      countToday: 2,
      groupsAffectedToday: 2,
      peakInWindow: 2,
    });
  });

  it("counts a title once per engine when grouped by engine", async () => {
    const response = await read(
      h.app,
      session,
      "/api/dashboard/title-chart?metric=titles_with_violations&windowDays=7&groupBy=engine",
    );
    const chart = response.json();
    expect(chart.appliedGrouping).toBe("engine");
    expect(chart.series).toEqual([
      {
        key: "google",
        label: "Google",
        values: [0, 1, 1, 1, 1, 1, 1],
      },
      {
        key: "yandex",
        label: "Yandex",
        values: [0, 0, 0, 0, 1, 1, 1],
      },
    ]);
  });

  it("groups by title group", async () => {
    const response = await read(
      h.app,
      session,
      "/api/dashboard/title-chart?metric=titles_with_violations&windowDays=7&groupBy=title_group",
    );
    const chart = response.json();
    expect(chart.series).toEqual([
      {
        key: "group-a",
        label: "Group A",
        values: [0, 1, 1, 1, 1, 1, 1],
      },
      {
        key: "group-b",
        label: "Group B",
        values: [0, 0, 0, 0, 1, 1, 1],
      },
    ]);
  });

  it("falls back from recipient grouping to the total", async () => {
    const response = await read(
      h.app,
      session,
      "/api/dashboard/title-chart?metric=titles_with_violations&windowDays=7&groupBy=recipient",
    );
    const chart = response.json();
    expect(chart.requestedGrouping).toBe("recipient");
    expect(chart.appliedGrouping).toBe("none");
    expect(chart.groupingFallback).toBe(true);
    expect(chart.series[0].key).toBe("total");
  });
});

describe("resolved violations chart", () => {
  beforeEach(async () => {
    await seedGroup("group-a", "Group A");
    await seedGroup("group-b", "Group B");
    await seedTitle("title-1", "group-a");
    await seedTitle("title-2", "group-b");
    await seedViolation({
      id: "resolved-removed",
      titleId: "title-1",
      groupId: "group-a",
      engine: "google",
      state: "removed",
      detectedAt: new Date(`${day(-20)}T09:00:00Z`),
      closedAt: new Date(`${day(-3)}T09:00:00Z`),
    });
    await seedViolation({
      id: "resolved-closed",
      titleId: "title-2",
      groupId: "group-b",
      engine: "yandex",
      state: "closed",
      detectedAt: new Date(`${day(-20)}T09:00:00Z`),
      closedAt: new Date(`${day(-1)}T09:00:00Z`),
    });
    await seedViolation({
      id: "resolved-outside",
      titleId: "title-1",
      groupId: "group-a",
      engine: "google",
      state: "removed",
      detectedAt: new Date(`${day(-40)}T09:00:00Z`),
      closedAt: new Date(`${day(-20)}T09:00:00Z`),
    });
    await seedNotice({
      id: "notice-google",
      recipient: "google",
      state: "approved",
      createdAt: at(-24),
      approvedAt: at(-24),
    });
    await seedNotice({
      id: "notice-bing",
      recipient: "bing",
      state: "approved",
      createdAt: at(-24),
      approvedAt: at(-24),
    });
    await seedCitation("notice-google", "resolved-removed");
    await seedCitation("notice-bing", "resolved-closed");
  });

  it("counts removed plus closed by default and returns the tiles", async () => {
    const response = await read(
      h.app,
      session,
      "/api/dashboard/title-chart?metric=resolved_violations&windowDays=7",
    );
    const chart = response.json();
    expectValid("TitleChartResponse", chart);
    expect(chart.metric).toBe("resolved_violations");
    expect(chart.resolvedBasis).toBe("removed_and_closed");
    expect(chart.series).toEqual([
      {
        key: "total",
        label: "All resolved violations",
        values: [0, 0, 0, 1, 0, 1, 0],
      },
    ]);
    expect(chart.tiles).toEqual({
      totalInWindow: 2,
      removedCount: 1,
      closedCount: 1,
    });
  });

  it("counts only operator closures under the closed-only basis", async () => {
    const response = await read(
      h.app,
      session,
      "/api/dashboard/title-chart?metric=resolved_violations&windowDays=7&basis=closed_only",
    );
    const chart = response.json();
    expect(chart.resolvedBasis).toBe("closed_only");
    expect(chart.series[0].values).toEqual([0, 0, 0, 0, 0, 1, 0]);
    expect(chart.tiles).toEqual({
      totalInWindow: 1,
      removedCount: 0,
      closedCount: 1,
    });
  });

  it("groups resolved violations by the recipient of the citing notice", async () => {
    const response = await read(
      h.app,
      session,
      "/api/dashboard/title-chart?metric=resolved_violations&windowDays=7&groupBy=recipient",
    );
    const chart = response.json();
    expect(chart.appliedGrouping).toBe("recipient");
    expect(chart.groupingFallback).toBe(false);
    expect(chart.series).toEqual([
      {
        key: "google",
        label: "Google",
        values: [0, 0, 0, 1, 0, 0, 0],
      },
      {
        key: "bing",
        label: "Bing",
        values: [0, 0, 0, 0, 0, 1, 0],
      },
    ]);
  });

  it("groups resolved violations by engine and title group", async () => {
    const byEngine = await read(
      h.app,
      session,
      "/api/dashboard/title-chart?metric=resolved_violations&windowDays=7&groupBy=engine",
    );
    expect(byEngine.json().series).toEqual([
      {
        key: "google",
        label: "Google",
        values: [0, 0, 0, 1, 0, 0, 0],
      },
      {
        key: "yandex",
        label: "Yandex",
        values: [0, 0, 0, 0, 0, 1, 0],
      },
    ]);

    const byGroup = await read(
      h.app,
      session,
      "/api/dashboard/title-chart?metric=resolved_violations&windowDays=7&groupBy=title_group",
    );
    expect(byGroup.json().series).toEqual([
      {
        key: "group-a",
        label: "Group A",
        values: [0, 0, 0, 1, 0, 0, 0],
      },
      {
        key: "group-b",
        label: "Group B",
        values: [0, 0, 0, 0, 0, 1, 0],
      },
    ]);
  });

  it("keeps closure day boundaries in UTC", async () => {
    await seedViolation({
      id: "resolved-late-utc",
      titleId: "title-1",
      groupId: "group-a",
      engine: "google",
      state: "closed",
      detectedAt: new Date(`${day(-20)}T09:00:00Z`),
      closedAt: new Date(`${day(0)}T23:59:00Z`),
    });
    await seedViolation({
      id: "resolved-next-day",
      titleId: "title-1",
      groupId: "group-a",
      engine: "google",
      state: "closed",
      detectedAt: new Date(`${day(-20)}T09:00:00Z`),
      closedAt: new Date(`${day(1)}T00:01:00Z`),
    });
    const response = await read(
      h.app,
      session,
      "/api/dashboard/title-chart?metric=resolved_violations&windowDays=7",
    );
    const chart = response.json();
    expect(chart.series[0].values[6]).toBe(1);
    expect(chart.tiles.totalInWindow).toBe(3);
  });
});

describe("same-day boundaries", () => {
  it("counts a violation detected and resolved on the same UTC day in both series", async () => {
    await seedGroup("group-a", "Group A");
    await seedTitle("title-1", "group-a");
    await seedViolation({
      id: "same-day",
      titleId: "title-1",
      groupId: "group-a",
      engine: "google",
      state: "closed",
      detectedAt: new Date(`${day(-2)}T09:00:00Z`),
      closedAt: new Date(`${day(-2)}T17:00:00Z`),
    });

    const open = await read(
      h.app,
      session,
      "/api/dashboard/title-chart?metric=titles_with_violations&windowDays=7",
    );
    expect(open.json().series[0].values).toEqual([0, 0, 0, 0, 1, 0, 0]);

    const resolved = await read(
      h.app,
      session,
      "/api/dashboard/title-chart?metric=resolved_violations&windowDays=7",
    );
    expect(resolved.json().series[0].values).toEqual([0, 0, 0, 0, 1, 0, 0]);
  });
});

describe("chart parameters", () => {
  it("refuses an undeclared metric or window", async () => {
    const badMetric = await read(
      h.app,
      session,
      "/api/dashboard/title-chart?metric=unknown",
    );
    expect(badMetric.statusCode).toBe(400);
    expect(badMetric.json().code).toBe("validation_failed");

    const badWindow = await read(
      h.app,
      session,
      "/api/dashboard/title-chart?metric=tracked_titles&windowDays=10",
    );
    expect(badWindow.statusCode).toBe(400);
  });
});
