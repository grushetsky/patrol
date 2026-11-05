import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runScheduledComposition } from "@patrol/notices";
import { controlledClock, seedWorld, testPool, truncateDomainTables, type SeededWorld } from "./helpers.js";

/**
 * The scheduled composition window (seam 7's database half): the runner
 * composes, at each scheduled profile's own window, the violations
 * confirmed since the previous window — a CUT-OFF, not a rolling queue, so
 * a violation confirmed while the window stood open waits for the next
 * one. A window composes at most once whatever the cron does; an
 * ineligible profile's window is consumed with a recorded skip; a paused
 * profile composes nothing; an on-demand profile is not the runner's.
 */

const AT = "2026-03-01T00:00:00.000Z";

/** One open violation confirmed at the given instant. */
async function seedViolation(
  pool: Pool,
  world: SeededWorld,
  input: { url: string; confirmedAt: string },
): Promise<string> {
  const host = new URL(input.url).hostname;
  const normalized = `${host}${new URL(input.url).pathname}`;
  const candidate = await pool.query<{ id: string }>(
    `insert into candidates
       (tracked_title_id, url, normalized_url, host, registrable_domain, source, engine,
        engines, best_rank, matched_variant_id, matched_variant, score, band,
        score_components, reputation, first_seen_at, last_observed_at, state,
        review_decision_id, violation_id, confirmed_at, created_at, updated_at)
     values ($1, $2, $3, $4, $5, 'serp', 'google', '{google}', 1, $6,
        '{"id":"x","text":"Sunrise","kind":"original","language":"en","script":"Latn"}'::jsonb,
        0.75, 'b', '{"titleMatch":0.6,"signals":[],"reputation":0}'::jsonb,
        '{"registrableDomain":"","confirmedViolations":0,"bonus":0,"blocklisted":false}'::jsonb,
        $7, $7, 'pending', null, null, null, $7, $7)
     returning id`,
    [world.titleId, input.url, normalized, host, host.split(".").slice(-2).join("."), world.originalVariantId, input.confirmedAt],
  );
  const capture = await pool.query<{ id: string }>(
    `insert into captures (requested_url, normalized_url, reason, point_key, state, requested_at, finished_at)
     values ($1, $2, 'detection', $3, 'done', $4, $4) returning id`,
    [input.url, normalized, `seed@${Math.random().toString(36).slice(2)}`, input.confirmedAt],
  );
  const evidence = await pool.query<{ id: string }>(
    `insert into evidence
       (capture_id, requested_url, normalized_url, final_url, host, host_source, reason,
        outcome, http_status, attempt_number, observed_at, capture_profile)
     values ($1, $2, $3, $2, $4, 'landing_page', 'detection', 'captured', 200, 1, $5,
        '{"userAgent":"patrol","viewportWidth":1280,"viewportHeight":720,"locale":"en","timezone":"UTC",
          "javascriptEnabled":true,"blockedResourceKinds":[],"navigationPolicy":"load","extractorVersion":"1"}'::jsonb)
     returning id`,
    [capture.rows[0].id, input.url, normalized, host, input.confirmedAt],
  );
  // The decision and the violation reference each other, so both ids are
  // generated first — the same dance the confirm path performs.
  const ids = await pool.query<{ decision_id: string; violation_id: string }>(
    "select uuidv7()::text as decision_id, uuidv7()::text as violation_id",
  );
  const decisionId = ids.rows[0].decision_id;
  const violationId = ids.rows[0].violation_id;
  await pool.query(
    `insert into review_decisions (id, candidate_id, operator_id, action, decided_at, evidence_ids, violation_id)
     values ($1, $2, $3, 'violation', $4, $5, $6)`,
    [decisionId, candidate.rows[0].id, world.operatorId, input.confirmedAt, [evidence.rows[0].id], violationId],
  );
  await pool.query(
    `insert into violations
       (id, tracked_title_id, candidate_id, review_decision_id, url, normalized_url, host,
        host_source, registrable_domain, detected_at, confirmed_at, confirmed_by, state, opened_at, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, 'landing_page', $8, $9, $9, $10, 'open', $9, $9)`,
    [
      violationId,
      world.titleId,
      candidate.rows[0].id,
      decisionId,
      input.url,
      normalized,
      host,
      host.split(".").slice(-2).join("."),
      input.confirmedAt,
      world.operatorId,
    ],
  );
  await pool.query(
    `update candidates set state = 'confirmed', review_decision_id = $2, violation_id = $3,
        confirmed_at = $4 where id = $1`,
    [candidate.rows[0].id, decisionId, violationId, input.confirmedAt],
  );
  await pool.query(
    `insert into violation_evidence (violation_id, evidence_id, role, cited_at, pinned_versions)
     values ($1, $2, 'detection', $3, '[]'::jsonb)`,
    [violationId, evidence.rows[0].id, input.confirmedAt],
  );
  return violationId;
}

/** The scheduled profiles: google eligible, yandex ineligible for DE, bing on demand. */
async function seedProfiles(
  pool: Pool,
  operatorId: string,
): Promise<{ google: string; yandex: string; bing: string }> {
  const rows = (
    await pool.query<{ id: string; recipient: string }>(
      `insert into recipient_profiles (recipient, composition_trigger, window_time, account,
         contact_email, eligible_territories, updated_by)
       values
         ('google', 'scheduled', '07:00:00', 'noticeops@example.test', null, '{}', $1),
         ('yandex', 'scheduled', '07:00:00', '', null, '{US,FR,CH}', $1),
         ('bing', 'on_demand', '07:00:00', '', 'legal@example.test', '{}', $1)
       returning id, recipient`,
      [operatorId],
    )
  ).rows;
  const byRecipient = new Map(rows.map((row) => [row.recipient, row.id]));
  return {
    google: byRecipient.get("google")!,
    yandex: byRecipient.get("yandex")!,
    bing: byRecipient.get("bing")!,
  };
}

describe("the scheduled composition window", () => {
  let pool: Pool;
  let world: SeededWorld;
  let profileIds: { google: string; yandex: string; bing: string };
  const clock = controlledClock("2026-03-02T08:00:00.000Z");

  beforeEach(async () => {
    pool ??= testPool();
    // The clock is shared: a test that advances to the next window must
    // not drag the later tests' present along with it.
    clock.set("2026-03-02T08:00:00.000Z");
    await truncateDomainTables(pool);
    await pool.query(
      `insert into rights_holder (singleton, legal_name, country, role_mailbox, signatory_full_legal_name)
       values (true, 'Example Rights GmbH', 'DE', 'legal@example.test', 'Anna Beispiel')
       on conflict (singleton) do nothing`,
    );
    world = await seedWorld(pool);
    profileIds = await seedProfiles(pool, world.operatorId);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("composes violations confirmed since the previous window and holds the cut-off", async () => {
    // The run's window is 2026-03-02T07:00 (the most recent passed at
    // 08:00); the previous occurrence is 2026-03-01T07:00.
    const inside = await seedViolation(pool, world, {
      url: "https://pirate.net/w/inside",
      confirmedAt: "2026-03-01T12:00:00.000Z",
    });
    const atBoundary = await seedViolation(pool, world, {
      url: "https://pirate.net/w/boundary",
      confirmedAt: "2026-03-02T07:00:00.000Z",
    });
    const afterWindow = await seedViolation(pool, world, {
      url: "https://pirate.net/w/after",
      confirmedAt: "2026-03-02T07:30:00.000Z",
    });
    const beforePrevious = await seedViolation(pool, world, {
      url: "https://pirate.net/w/before",
      confirmedAt: "2026-03-01T06:00:00.000Z",
    });

    const outcomes = await runScheduledComposition({ pool, now: clock.now });
    const google = outcomes.find((outcome) => outcome.recipient === "google");
    expect(google?.windowAt.toISOString()).toBe("2026-03-02T07:00:00.000Z");
    expect(google?.composedNotices).toBe(1);

    const citations = await pool.query<{ violation_id: string }>(
      "select violation_id from notice_citations order by position",
    );
    expect(citations.rows.map((row) => row.violation_id).sort()).toEqual(
      [inside, atBoundary].sort(),
    );
    // The cut-off: confirmed after the window or before the previous
    // window — neither composed.
    expect(citations.rows.map((row) => row.violation_id)).not.toContain(afterWindow);
    expect(citations.rows.map((row) => row.violation_id)).not.toContain(beforePrevious);

    const notices = await pool.query<{ id: string; trigger_kind: string; template_version: string }>(
      "select id, trigger_kind, template_version from notices",
    );
    expect(notices.rows).toHaveLength(1);
    expect(notices.rows[0].trigger_kind).toBe("scheduled");
    expect(notices.rows[0].template_version).toBe("google-search.en.v1@ed9f34155836");
  });

  it("composes a window at most once, whatever the cron does", async () => {
    await seedViolation(pool, world, {
      url: "https://pirate.net/w/once",
      confirmedAt: "2026-03-01T12:00:00.000Z",
    });
    const first = await runScheduledComposition({ pool, now: clock.now });
    const second = await runScheduledComposition({ pool, now: clock.now });

    expect(first.find((o) => o.recipient === "google")?.composedNotices).toBe(1);
    expect(second).toEqual([]);
    const notices = await pool.query("select count(*)::int as count from notices");
    expect(notices.rows[0].count).toBe(1);
    const runs = await pool.query<{ window_at: Date; composed_notices: number }>(
      "select window_at, composed_notices from notice_composition_runs where recipient_profile_id = $1",
      [profileIds.google],
    );
    expect(runs.rows).toHaveLength(1);
  });

  it("waits for the next window for a violation confirmed after the cut-off", async () => {
    const late = await seedViolation(pool, world, {
      url: "https://pirate.net/w/late",
      confirmedAt: "2026-03-02T07:30:00.000Z",
    });
    await runScheduledComposition({ pool, now: clock.now });
    let notices = await pool.query("select count(*)::int as count from notices");
    expect(notices.rows[0].count).toBe(0);

    // The next day's 07:00 window has passed: the late violation composes.
    clock.set("2026-03-03T08:00:00.000Z");
    const outcomes = await runScheduledComposition({ pool, now: clock.now });
    expect(outcomes.find((o) => o.recipient === "google")?.composedNotices).toBe(1);
    notices = await pool.query("select count(*)::int as count from notices");
    expect(notices.rows[0].count).toBe(1);
    const cited = await pool.query<{ violation_id: string }>("select violation_id from notice_citations");
    expect(cited.rows[0].violation_id).toBe(late);
  });

  it("skips an ineligible profile's window and records why", async () => {
    // Only yandex stays scheduled: a scheduled google profile would reserve
    // the violation first and the yandex window would see nothing due.
    await pool.query(
      "update recipient_profiles set composition_trigger = 'on_demand' where recipient = 'google'",
    );
    await seedViolation(pool, world, {
      url: "https://pirate.net/w/yandex",
      confirmedAt: "2026-03-01T12:00:00.000Z",
    });
    const outcomes = await runScheduledComposition({ pool, now: clock.now });
    const yandex = outcomes.find((outcome) => outcome.recipient === "yandex");
    expect(yandex?.skippedReason).toBe("recipient_ineligible");
    expect(yandex?.composedNotices).toBe(0);

    const run = await pool.query<{ skipped_reason: string | null }>(
      "select skipped_reason from notice_composition_runs where recipient_profile_id = $1",
      [profileIds.yandex],
    );
    expect(run.rows[0].skipped_reason).toBe("recipient_ineligible");
    // The window is consumed: a same-day retry does not re-attempt it.
    const again = await runScheduledComposition({ pool, now: clock.now });
    expect(again.find((o) => o.recipient === "yandex")).toBeUndefined();
  });

  it("leaves on-demand profiles to the operator and records a paused skip", async () => {
    await pool.query("update recipient_profiles set paused = true where id = $1", [
      profileIds.google,
    ]);
    const outcomes = await runScheduledComposition({ pool, now: clock.now });
    expect(outcomes.find((outcome) => outcome.recipient === "google")?.skippedReason).toBe("paused");
    expect(outcomes.find((outcome) => outcome.recipient === "bing")).toBeUndefined();
    const notices = await pool.query("select count(*)::int as count from notices");
    expect(notices.rows[0].count).toBe(0);
  });

  it("composes the violations confirmed during a pause once drafting resumes", async () => {
    // A successful window first, so the cut-off has a real start to hold.
    const beforePause = await seedViolation(pool, world, {
      url: "https://pirate.net/w/before-pause",
      confirmedAt: "2026-03-01T12:00:00.000Z",
    });
    await runScheduledComposition({ pool, now: clock.now });
    let notices = await pool.query("select count(*)::int as count from notices");
    expect(notices.rows[0].count).toBe(1);

    // The rejection threshold pauses the profile; violations keep being
    // confirmed while scheduled drafting stands still.
    await pool.query("update recipient_profiles set paused = true where id = $1", [
      profileIds.google,
    ]);
    const duringPause = await seedViolation(pool, world, {
      url: "https://pirate.net/w/during-pause-1",
      confirmedAt: "2026-03-02T12:00:00.000Z",
    });
    const duringPauseLate = await seedViolation(pool, world, {
      url: "https://pirate.net/w/during-pause-2",
      confirmedAt: "2026-03-03T06:00:00.000Z",
    });
    clock.set("2026-03-03T08:00:00.000Z");
    const pausedRun = await runScheduledComposition({ pool, now: clock.now });
    expect(pausedRun.find((outcome) => outcome.recipient === "google")?.skippedReason).toBe(
      "paused",
    );

    // The pause clears. The next window's cut-off starts at the profile's
    // last UNSKIPPED window (2026-03-02T07:00), so everything confirmed
    // during the pause folds into it instead of falling out forever.
    await pool.query("update recipient_profiles set paused = false where id = $1", [
      profileIds.google,
    ]);
    clock.set("2026-03-04T08:00:00.000Z");
    const outcomes = await runScheduledComposition({ pool, now: clock.now });
    expect(outcomes.find((outcome) => outcome.recipient === "google")?.composedNotices).toBe(1);

    const cited = await pool.query<{ violation_id: string }>(
      "select violation_id from notice_citations",
    );
    const citedIds = cited.rows.map((row) => row.violation_id);
    expect(citedIds).toContain(duringPause);
    expect(citedIds).toContain(duringPauseLate);
    expect(citedIds).toContain(beforePause);
    notices = await pool.query("select count(*)::int as count from notices");
    expect(notices.rows[0].count).toBe(2);
  });

  it("catches up an ineligible profile's window once it is eligible again", async () => {
    // Only yandex stays scheduled, so nothing else reserves its violations.
    await pool.query(
      "update recipient_profiles set composition_trigger = 'on_demand' where recipient = 'google'",
    );
    // Eligible first (the empty list means Yandex's channel floor, which
    // the DE rights holder rides): a successful window establishes the
    // cut-off's start.
    await pool.query(
      "update recipient_profiles set eligible_territories = '{}' where id = $1",
      [profileIds.yandex],
    );
    await seedViolation(pool, world, {
      url: "https://pirate.net/w/y-eligible",
      confirmedAt: "2026-03-01T12:00:00.000Z",
    });
    await runScheduledComposition({ pool, now: clock.now });
    let notices = await pool.query("select count(*)::int as count from notices");
    expect(notices.rows[0].count).toBe(1);

    // The profile narrows its territories past the rights holder: every
    // window is skipped as ineligible while violations keep confirming.
    await pool.query(
      "update recipient_profiles set eligible_territories = '{US,FR,CH}' where id = $1",
      [profileIds.yandex],
    );
    const whileIneligible = await seedViolation(pool, world, {
      url: "https://pirate.net/w/y-ineligible-stretch",
      confirmedAt: "2026-03-02T12:00:00.000Z",
    });
    clock.set("2026-03-03T08:00:00.000Z");
    const skipped = await runScheduledComposition({ pool, now: clock.now });
    expect(skipped.find((outcome) => outcome.recipient === "yandex")?.skippedReason).toBe(
      "recipient_ineligible",
    );

    // Eligibility returns; the cut-off starts at the last UNSKIPPED window
    // (2026-03-02T07:00), so the violation confirmed inside the ineligible
    // stretch composes now.
    await pool.query(
      "update recipient_profiles set eligible_territories = '{}' where id = $1",
      [profileIds.yandex],
    );
    clock.set("2026-03-04T08:00:00.000Z");
    const outcomes = await runScheduledComposition({ pool, now: clock.now });
    expect(outcomes.find((outcome) => outcome.recipient === "yandex")?.composedNotices).toBe(1);
    const cited = await pool.query<{ violation_id: string }>(
      "select violation_id from notice_citations",
    );
    expect(cited.rows.map((row) => row.violation_id)).toContain(whileIneligible);
    notices = await pool.query("select count(*)::int as count from notices");
    expect(notices.rows[0].count).toBe(2);
  });

  it("splits a Google batch over the cap into several notices", async () => {
    // The seeded profile carries no discovered cap; the default 500 applies.
    // Six violations with a lowered discovered cap exercise the split.
    await pool.query(
      "update recipient_profiles set last_observed_max_urls_per_file = 3 where id = $1",
      [profileIds.google],
    );
    for (let index = 0; index < 5; index += 1) {
      await seedViolation(pool, world, {
        url: `https://pirate.net/w/split/${index}`,
        confirmedAt: "2026-03-01T12:00:00.000Z",
      });
    }
    const outcomes = await runScheduledComposition({ pool, now: clock.now });
    expect(outcomes.find((o) => o.recipient === "google")?.composedNotices).toBe(2);
    const counts = await pool.query<{ notice_id: string; count: number }>(
      "select notice_id, count(*)::int as count from notice_citations group by notice_id order by count desc",
    );
    expect(counts.rows.map((row) => row.count)).toEqual([3, 2]);
  });
});
