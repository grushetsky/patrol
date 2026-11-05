import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { REMINDER_DAYS } from "@patrol/notices";
import { submissionRemindJob } from "../../src/jobs.js";
import { controlledClock, seedWorld, testPool, truncateDomainTables, type SeededWorld } from "./helpers.js";

/**
 * `submission.remind` (daily): surfaces the Pending submissions older than
 * seven days to the operators (scan-scheduling.md "Jobs"). The reminder's
 * durable act is the deduped `submission_alerts` row it raises per backlog
 * submission (one row per submission, ever, until the submission leaves
 * pending — the budget alerts' fire-once pattern), which slice 8/9's
 * dashboard surfacing reads; the test asserts the query half, the dedup,
 * and the log line against a clock seam, plus the cron table's entry and
 * cadence.
 */

const AT = "2026-03-01T00:00:00.000Z";
const DAY_MS = 24 * 60 * 60 * 1000;

/** One pending submission created the given number of days before AT. */
async function seedPendingSubmission(
  pool: Pool,
  world: SeededWorld,
  profileId: string,
  input: {
    url: string;
    ageDays: number;
    state?: "pending" | "delivered" | "failed";
    cancelled?: boolean;
  },
): Promise<string> {
  const createdAt = new Date(new Date(AT).getTime() - input.ageDays * DAY_MS).toISOString();
  const notice = await pool.query<{ id: string }>(
    `insert into notices (recipient, recipient_profile_id, channel, template_version, language,
        composed_at, composed_by, trigger_kind)
     values ('google', $1, 'web_form', 'google-search.en.v1@ed9f34155836', 'en', $2, $3, 'on_demand')
     returning id`,
    [profileId, createdAt, world.operatorId],
  );
  const submission = await pool.query<{ id: string }>(
    `insert into submissions (notice_id, recipient_profile_id, channel, state, attempt_count,
        pack_language, created_at, cancelled_at, operator_id, delivered_at, attested_at,
        statement_version)
     values ($1, $2, 'web_form', $3, 0, 'en', $4, $5,
        case when $3 = 'delivered' then $6::uuid end,
        case when $3 = 'delivered' then $4::timestamptz end,
        case when $3 = 'delivered' then $4::timestamptz end,
        case when $3 = 'delivered' then 'google-search.en.v1@ed9f34155836' end)
     returning id`,
    [
      notice.rows[0].id,
      profileId,
      input.state ?? "pending",
      createdAt,
      input.cancelled === true ? createdAt : null,
      world.operatorId,
    ],
  );
  return submission.rows[0].id;
}

describe("the seven-day submission reminder", () => {
  let pool: Pool;
  let world: SeededWorld;
  let clock: ReturnType<typeof controlledClock>;
  let logged: Array<{ message: string; extra?: Record<string, unknown> }>;
  let profileId: string;

  beforeEach(async () => {
    if (pool === undefined) {
      pool = testPool();
    }
    await truncateDomainTables(pool);
    world = await seedWorld(pool);
    clock = controlledClock(AT);
    logged = [];
    const profile = await pool.query<{ id: string }>(
      `insert into recipient_profiles (recipient, window_time, account, updated_by)
       values ('google', '07:00:00', 'noticeops@example.test', $1) returning id`,
      [world.operatorId],
    );
    profileId = profile.rows[0].id;
  });

  afterAll(async () => {
    if (pool !== undefined) {
      await pool.end();
    }
  });

  it("reminds exactly the pending submissions older than seven days", async () => {
    const stale = await seedPendingSubmission(pool, world, profileId, {
      url: "https://pirate.net/stale",
      ageDays: 8,
    });
    // Exactly seven days old is NOT older than seven days.
    await seedPendingSubmission(pool, world, profileId, { url: "https://pirate.net/edge", ageDays: 7 });
    await seedPendingSubmission(pool, world, profileId, { url: "https://pirate.net/fresh", ageDays: 2 });
    // Delivered and cancelled rows never remind, however old.
    await seedPendingSubmission(pool, world, profileId, {
      url: "https://pirate.net/delivered",
      ageDays: 10,
      state: "delivered",
    });
    await seedPendingSubmission(pool, world, profileId, {
      url: "https://pirate.net/cancelled",
      ageDays: 10,
      cancelled: true,
    });

    await submissionRemindJob({ pool, now: clock.now }, (message, extra) =>
      logged.push({ message, extra }),
    );

    expect(logged).toHaveLength(1);
    expect(logged[0].extra).toMatchObject({ count: 1, raised: 1 });
    expect((logged[0].extra!.ids as string[]).sort()).toEqual([stale]);

    // The reminder's durable half: one alert row for the submission the
    // log named, and a second daily run inserts nothing over it.
    const alerts = await pool.query<{ submission_id: string }>(
      "select submission_id from submission_alerts",
    );
    expect(alerts.rows.map((row) => row.submission_id)).toEqual([stale]);

    await submissionRemindJob({ pool, now: clock.now }, (message, extra) =>
      logged.push({ message, extra }),
    );
    const still = await pool.query<{ count: string }>("select count(*) as count from submission_alerts");
    expect(Number(still.rows[0].count)).toBe(1);
    expect(logged[1].extra).toMatchObject({ count: 1, raised: 0 });
  });

  it("stays silent when nothing is overdue", async () => {
    await seedPendingSubmission(pool, world, profileId, { url: "https://pirate.net/ok", ageDays: 1 });
    await submissionRemindJob({ pool, now: clock.now }, (message, extra) =>
      logged.push({ message, extra }),
    );
    expect(logged).toHaveLength(0);
  });

  it("runs daily on the cron table", async () => {
    const { CRON_JOBS } = await import("../../src/jobs.js");
    expect(CRON_JOBS["submission.remind"]).toBeDefined();
    // Daily: exactly five fields, so once a day at the given time.
    expect(CRON_JOBS["submission.remind"]!.split(" ")).toHaveLength(5);
    expect(REMINDER_DAYS).toBe(7);
  });
});
