import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { ensureMonth } from "@patrol/budget";
import { MemoryMailTransport } from "@patrol/mail";
import { budgetBalanceJob, submissionRemindJob } from "../../src/jobs.js";
import { controlledClock, seedWorld, testPool, truncateDomainTables, type SeededWorld } from "./helpers.js";
import type { SerpAcquisitor } from "../../src/acquisition/port.js";

/**
 * Slice 9's alert-delivery acceptance over the jobs that fire the alerts:
 * "Alerts fire once, reach the operator mailbox, and name the engine,
 * bucket, spend, and uncovered groups." The durable half (the fire-once
 * rows) is tested beside the evaluators; this file asserts the mailbox
 * half — the jobs deliver through the injected transport to the
 * configured operator mailbox, and only what the run newly fired, so the
 * email follows the database's fire-once rather than re-deciding it.
 */

const AT = "2026-03-15T12:00:00.000Z";
const DAY_MS = 24 * 60 * 60 * 1000;
const MAILBOX = "patrol-alerts@example.test";

const pool = testPool();
let world: SeededWorld;
const clock = controlledClock(AT);

/** An adapter whose only job here is a healthy balance reading. */
function balanceAdapter(): ReadonlyMap<string, SerpAcquisitor> {
  const adapter = {
    engine: "google",
    async probeBalance() {
      return { outcome: "balance", balanceMinor: 500_00 };
    },
  } as unknown as SerpAcquisitor;
  return new Map([["google", adapter]]);
}

/** Seeds the Google month at the seventy-five percent warning line. */
async function seedHotMonth(): Promise<void> {
  await pool.query(
    `insert into rights_holder (singleton, legal_name, country)
     values (true, 'Alert Delivery GmbH', 'DE') on conflict (singleton) do nothing`,
  );
  await pool.query(
    "update rights_holder set budget_google_monthly_cap_minor = 60",
  );
  await pool.query("insert into title_groups (name, locales) values ('Alerted', '{en}')");
  await ensureMonth(pool, "google", "2026-03-01");
  await pool.query(
    `update quota_ledger set scan_committed = 500, recheck_committed = 250
       where engine = 'google' and month_start = '2026-03-01'`,
  );
}

/** One pending submission the given number of days overdue; returns its notice id. */
async function seedOverdueSubmission(ageDays: number): Promise<string> {
  const createdAt = new Date(new Date(AT).getTime() - ageDays * DAY_MS).toISOString();
  const profile = await pool.query<{ id: string }>(
    `insert into recipient_profiles (recipient, window_time, updated_by)
     values ('google', '07:00', $1) returning id`,
    [world.operatorId],
  );
  const notice = await pool.query<{ id: string }>(
    `insert into notices (recipient, recipient_profile_id, channel, template_version, language,
        composed_at, composed_by, trigger_kind)
     values ('google', $1, 'web_form', 'google-search.en.v1@ed9f34155836', 'en', $2, $3, 'on_demand')
     returning id`,
    [profile.rows[0].id, createdAt, world.operatorId],
  );
  await pool.query(
    `insert into submissions (notice_id, recipient_profile_id, channel, state, attempt_count,
        pack_language, created_at)
     values ($1, $2, 'web_form', 'pending', 0, 'en', $3)`,
    [notice.rows[0].id, profile.rows[0].id, createdAt],
  );
  return notice.rows[0].id;
}

beforeEach(async () => {
  await truncateDomainTables(pool);
  world = await seedWorld(pool);
  clock.set(AT);
});

afterAll(async () => {
  await pool.end();
});

describe("the budget alert reaches the operator mailbox", () => {
  it("delivers a newly fired alert naming engine, bucket, spend, and uncovered groups", async () => {
    await seedHotMonth();
    const mail = new MemoryMailTransport();
    const logged: Array<{ message: string; extra?: Record<string, unknown> }> = [];

    await budgetBalanceJob(
      { pool, now: clock.now, adapters: balanceAdapter(), mail, alertEmail: MAILBOX },
      (message, extra) => logged.push({ message, extra }),
    );

    expect(mail.sentTo(MAILBOX)).toHaveLength(1);
    const message = mail.sentTo(MAILBOX)[0]!;
    expect(message.subject).toContain("google");
    expect(message.body).toContain("google");
    expect(message.body).toContain("75");
    // Two groups stand (the seeded world's and this test's own) and neither
    // has a completed scan this month: the uncovered-groups count is 2.
    expect(message.body).toContain("this month: 2.");

    // Fire-once preserved: the second daily run fires nothing new and
    // delivers nothing, however many rows stand.
    await budgetBalanceJob(
      { pool, now: clock.now, adapters: balanceAdapter(), mail, alertEmail: MAILBOX },
      (message, extra) => logged.push({ message, extra }),
    );
    expect(mail.sentTo(MAILBOX)).toHaveLength(1);
  });

  it("skips delivery without a configured mailbox and still fires the rows", async () => {
    await seedHotMonth();
    const mail = new MemoryMailTransport();
    await budgetBalanceJob(
      { pool, now: clock.now, adapters: balanceAdapter(), mail, alertEmail: null },
      () => undefined,
    );
    expect(mail.messages).toHaveLength(0);
    const rows = await pool.query("select count(*)::int as count from budget_alerts");
    expect(rows.rows[0].count).toBeGreaterThanOrEqual(1);
  });
});

describe("the submission reminder reaches the operator mailbox", () => {
  it("delivers one digest for a run that raised new alert rows, once", async () => {
    const overdueNoticeId = await seedOverdueSubmission(9);
    const mail = new MemoryMailTransport();

    await submissionRemindJob({ pool, now: clock.now, mail, alertEmail: MAILBOX }, () => undefined);
    expect(mail.sentTo(MAILBOX)).toHaveLength(1);
    expect(mail.sentTo(MAILBOX)[0]!.body).toContain(overdueNoticeId);

    // The next daily run raises nothing new: no second email.
    await submissionRemindJob({ pool, now: clock.now, mail, alertEmail: MAILBOX }, () => undefined);
    expect(mail.sentTo(MAILBOX)).toHaveLength(1);
  });

  it("sends nothing when the run raised nothing", async () => {
    await seedOverdueSubmission(2);
    const mail = new MemoryMailTransport();
    await submissionRemindJob({ pool, now: clock.now, mail, alertEmail: MAILBOX }, () => undefined);
    expect(mail.messages).toHaveLength(0);
  });
});
