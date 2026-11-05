import { beforeEach, describe, expect, it } from "vitest";
import {
  onScanCompleted,
  readLadder,
  readReputationFacts,
  recordRemovalsForDeadCapture,
  reopenDismissedOnCapture,
  violationBackedLadderPredicates,
} from "@patrol/scans";
import { controlledClock, seedWorld, testPool, truncateDomainTables } from "./helpers.js";

/**
 * Seams 5 (the worker halves), 7 (the removal half), 10, and 12 at the
 * store level (docs/design/matching-and-classification-rules.md "Dismissal
 * and reopening"; implementation rules "Violations", "Re-check ladder",
 * "Reputation"): a captured outcome reopens a page_dead pair and a
 * materially changed pair while an unchanged one stays dismissed; a dead
 * capture records the terminal removal of every open violation of its URL;
 * the violations-backed ladder predicates start and continue on real
 * violations; and the reputation aggregate now counts violation rows.
 */

const FROZEN = "2026-03-02T10:00:00.000Z";

/** One candidate in the state a dismissal leaves, seeded directly. */
async function seedCandidate(
  pool: ReturnType<typeof testPool>,
  world: Awaited<ReturnType<typeof seedWorld>>,
  input: {
    url: string;
    state?: "pending" | "dismissed";
    dismissal?: Record<string, unknown> | null;
    materialSnapshot?: Record<string, unknown> | null;
    scoreComponents?: Record<string, unknown>;
  },
): Promise<string> {
  const host = new URL(input.url).hostname;
  const result = await pool.query<{ id: string }>(
    `insert into candidates
       (tracked_title_id, url, normalized_url, host, registrable_domain, source, engine, engines,
        best_rank, matched_variant_id, matched_variant, score, band, score_components, reputation,
        first_seen_at, last_observed_at, state, review_decision_id, dismissed_at, dismissal,
        material_snapshot, created_at, updated_at)
     values ($1, $2, $3, $4, $5, 'serp', 'google', '{google}', 1, $6,
        $7::jsonb, 0.6, 'b', $8::jsonb,
        '{"registrableDomain":"","confirmedViolations":0,"bonus":0,"blocklisted":false}'::jsonb,
        $9, $9, $10,
        case when $10 = 'dismissed' then uuidv7() else null end,
        case when $10 = 'dismissed' then $9::timestamptz else null end,
        $11::jsonb, $12::jsonb, $9, $9)
     returning id`,
    [
      world.titleId,
      input.url,
      `${host}${new URL(input.url).pathname}`,
      host,
      host.split(".").slice(-2).join("."),
      world.originalVariantId,
      JSON.stringify({ id: world.originalVariantId, text: "Sunrise", kind: "original", language: "en", script: "Latn" }),
      JSON.stringify(input.scoreComponents ?? { titleMatch: 0.6, signals: [], reputation: 0 }),
      FROZEN,
      input.state ?? "pending",
      input.dismissal === undefined || input.dismissal === null ? null : JSON.stringify(input.dismissal),
      input.materialSnapshot === undefined || input.materialSnapshot === null
        ? null
        : JSON.stringify(input.materialSnapshot),
    ],
  );
  return result.rows[0].id;
}

/** One evidence row, as a capture leaves it. */
async function seedEvidence(
  pool: ReturnType<typeof testPool>,
  input: { url: string; outcome: "captured" | "dead"; observedAt?: string },
): Promise<string> {
  const host = new URL(input.url).hostname;
  const normalized = `${host}${new URL(input.url).pathname}`;
  const capture = await pool.query<{ id: string }>(
    `insert into captures (requested_url, normalized_url, reason, point_key, state, requested_at, finished_at)
     values ($1, $2, 'detection', $3, 'done', $4, $4) returning id`,
    [input.url, normalized, `seed@${Math.random().toString(36).slice(2)}`, input.observedAt ?? FROZEN],
  );
  const result = await pool.query<{ id: string }>(
    `insert into evidence
       (capture_id, requested_url, normalized_url, final_url, host, host_source, reason,
        outcome, http_status, failure_reason, attempt_number, observed_at, capture_profile)
     values ($1, $2, $3, $4, $5, $6, 'detection', $7, $8, $9, 1, $10,
        '{"userAgent":"patrol","viewportWidth":1280,"viewportHeight":720,"locale":"en","timezone":"UTC",
          "javascriptEnabled":true,"blockedResourceKinds":[],"navigationPolicy":"load","extractorVersion":"1"}'::jsonb)
     returning id`,
    [
      capture.rows[0].id,
      input.url,
      normalized,
      input.outcome === "dead" ? null : input.url,
      input.outcome === "dead" ? null : host,
      input.outcome === "dead" ? null : "landing_page",
      input.outcome,
      input.outcome === "dead" ? 404 : 200,
      input.outcome === "dead" ? "http_404" : null,
      input.observedAt ?? FROZEN,
    ],
  );
  return result.rows[0].id;
}

/** Confirms a pair directly: decision, violation, confirmed candidate. */
async function confirmCandidate(
  pool: ReturnType<typeof testPool>,
  world: Awaited<ReturnType<typeof seedWorld>>,
  input: { url: string; at?: string },
): Promise<{ candidateId: string; violationId: string }> {
  const at = input.at ?? FROZEN;
  const candidateId = await seedCandidate(pool, world, { url: input.url });
  const evidenceId = await seedEvidence(pool, { url: input.url, outcome: "captured", observedAt: at });
  // The violation's id is generated first so the decision row can name it
  // (a violation action always carries its violation).
  const violationId = (await pool.query<{ id: string }>("select uuidv7()::text as id")).rows[0].id;
  const decision = await pool.query<{ id: string }>(
    `insert into review_decisions (candidate_id, operator_id, action, decided_at, evidence_ids, violation_id)
     values ($1, $2, 'violation', $3, $4::uuid[], $5) returning id`,
    [candidateId, world.operatorId, at, [evidenceId], violationId],
  );
  const violation = await pool.query<{ id: string }>(
    `insert into violations
       (id, tracked_title_id, candidate_id, review_decision_id, url, normalized_url, host,
        host_source, registrable_domain, detected_at, confirmed_at, confirmed_by, opened_at)
     values ($1, $2, $3, $4, $5, $6, $7, 'submitted_url', $8, $9, $9, $10, $9)
     returning id`,
    [
      violationId,
      world.titleId,
      candidateId,
      decision.rows[0].id,
      input.url,
      `${new URL(input.url).hostname}${new URL(input.url).pathname}`,
      new URL(input.url).hostname,
      new URL(input.url).hostname.split(".").slice(-2).join("."),
      at,
      world.operatorId,
    ],
  );
  await pool.query(
    `update candidates set state = 'confirmed', review_decision_id = $2, violation_id = $3, confirmed_at = $4
      where id = $1`,
    [candidateId, decision.rows[0].id, violationId, at],
  );
  return { candidateId, violationId };
}

describe("the capture outcome hooks", () => {
  let pool: ReturnType<typeof testPool>;
  const clock = controlledClock(FROZEN);

  beforeEach(async () => {
    pool = testPool();
    await truncateDomainTables(pool);
  });

  it("reopens a page_dead pair when a capture returns content", async () => {
    const world = await seedWorld(pool, { variant: { text: "Sunrise", language: "en" } });
    const candidateId = await seedCandidate(pool, world, {
      url: "https://revive.example.test/film",
      state: "dismissed",
      dismissal: { action: "page_dead", operatorId: world.operatorId, decidedAt: FROZEN, evidenceIds: [] },
      materialSnapshot: { signals: [], episodeCount: 0, landingRegistrableDomain: "example.test" },
    });

    const outcome = await reopenDismissedOnCapture(pool, clock.now, {
      normalizedUrl: "revive.example.test/film",
      sidecar: null,
      landingHost: "revive.example.test",
    });
    expect(outcome.reopenedCandidateIds).toEqual([candidateId]);
    expect(outcome.reasons).toEqual([
      { candidateId, rule: "page_dead_serves_content" },
    ]);
    const row = await pool.query("select state from candidates where id = $1", [candidateId]);
    expect(row.rows[0].state).toBe("pending");
  });

  it("reopens a pair on a material change and keeps an unchanged pair dismissed", async () => {
    const world = await seedWorld(pool, { variant: { text: "Sunrise", language: "en" } });
    // Dismissed with no signals and no episodes; the page now carries a
    // player iframe the dismissal never saw.
    const changedId = await seedCandidate(pool, world, {
      url: "https://changed.example.test/film",
      state: "dismissed",
      dismissal: { action: "not_a_violation", operatorId: world.operatorId, decidedAt: FROZEN, evidenceIds: [] },
      materialSnapshot: { signals: [], episodeCount: 0, landingRegistrableDomain: "example.test" },
    });
    // Unchanged: the page fires nothing the dismissal did not already see.
    const sameId = await seedCandidate(pool, world, {
      url: "https://same.example.test/film",
      state: "dismissed",
      dismissal: { action: "not_a_violation", operatorId: world.operatorId, decidedAt: FROZEN, evidenceIds: [] },
      materialSnapshot: { signals: ["download"], episodeCount: 0, landingRegistrableDomain: "example.test" },
    });

    const sidecar = JSON.stringify({
      title: "Sunrise (2024) — watch online free",
      h1: ["Sunrise full movie"],
      meta: {},
      jsonLd: [],
      iframes: ["https://cdn.stream.example.test/embed/1"],
      videos: [],
      downloadAffordances: ["magnet:?xt=urn:btih:abc"],
      episodeLinks: [],
      linkTexts: [],
    });
    const changed = await reopenDismissedOnCapture(pool, clock.now, {
      normalizedUrl: "changed.example.test/film",
      sidecar,
      landingHost: "changed.example.test",
    });
    expect(changed.reopenedCandidateIds).toEqual([changedId]);
    expect(changed.reasons[0].rule).toBe("material_change");

    const same = await reopenDismissedOnCapture(pool, clock.now, {
      normalizedUrl: "same.example.test/film",
      // No new signal, no episode growth, the same landing domain.
      sidecar: JSON.stringify({
        title: "Sunrise (2024) — watch online free",
        h1: ["Sunrise full movie"],
        meta: {},
        jsonLd: [],
        iframes: [],
        videos: [],
        downloadAffordances: ["magnet:?xt=urn:btih:def"],
        episodeLinks: [],
        linkTexts: [],
      }),
      landingHost: "same.example.test",
    });
    expect(same.reopenedCandidateIds).toEqual([]);
    const row = await pool.query("select state from candidates where id = $1", [sameId]);
    expect(row.rows[0].state).toBe("dismissed");
  });

  it("reopens a dismissed pair when a new capture carries a player on a known-bad host", async () => {
    const world = await seedWorld(pool, { variant: { text: "Sunrise", language: "en" } });
    // A confirmed violation at the registrable domain makes every host
    // under it a known-bad player host for the next twelve months.
    await confirmCandidate(pool, world, { url: "https://bad.example.test/film" });

    // Dismissed with no signals: the page had nothing behind the title.
    const candidateId = await seedCandidate(pool, world, {
      url: "https://player.example.test/film",
      state: "dismissed",
      dismissal: { action: "not_a_violation", operatorId: world.operatorId, decidedAt: FROZEN, evidenceIds: [] },
      materialSnapshot: { signals: [], episodeCount: 0, landingRegistrableDomain: "example.test" },
    });

    // The new capture's page embeds a player iframe whose host aggregates
    // at the known-bad registrable domain: the player signal fires, and a
    // signal the dismissal never saw is a material change.
    const sidecar = JSON.stringify({
      title: "Sunrise (2024) — watch online free",
      h1: ["Sunrise full movie"],
      meta: {},
      jsonLd: [],
      iframes: ["https://cdn.stream.example.test/embed/1"],
      videos: [],
      downloadAffordances: [],
      episodeLinks: [],
      linkTexts: [],
    });
    const outcome = await reopenDismissedOnCapture(pool, clock.now, {
      normalizedUrl: "player.example.test/film",
      sidecar,
      landingHost: "player.example.test",
    });
    expect(outcome.reopenedCandidateIds).toEqual([candidateId]);
    expect(outcome.reasons[0].rule).toBe("material_change");
    const row = await pool.query("select state from candidates where id = $1", [candidateId]);
    expect(row.rows[0].state).toBe("pending");
  });

  it("records the terminal removal of every open violation a dead capture's URL carries", async () => {
    const world = await seedWorld(pool, { variant: { text: "Sunrise", language: "en" } });
    const url = "https://removed.example.test/film";
    const { violationId } = await confirmCandidate(pool, world, { url });
    const deadEvidence = await seedEvidence(pool, { url, outcome: "dead" });

    const removed = await recordRemovalsForDeadCapture(pool, clock.now, {
      normalizedUrl: "removed.example.test/film",
      evidenceId: deadEvidence,
    });
    expect(removed).toHaveLength(1);
    expect(removed[0]).toMatchObject({
      id: violationId,
      state: "removed",
      closureReason: "url_removed",
      closureEvidenceId: deadEvidence,
      closedBy: null,
    });

    // Terminal: a second dead capture records nothing new.
    const again = await recordRemovalsForDeadCapture(pool, clock.now, {
      normalizedUrl: "removed.example.test/film",
      evidenceId: await seedEvidence(pool, { url, outcome: "dead" }),
    });
    expect(again).toEqual([]);
    const row = await pool.query("select state, closure_evidence_id from violations where id = $1", [violationId]);
    expect(row.rows[0].state).toBe("removed");
    expect(row.rows[0].closure_evidence_id).toBe(deadEvidence);
  });

  it("starts and continues the re-check ladder on real violations", async () => {
    const world = await seedWorld(pool, { variant: { text: "Sunrise", language: "en" } });
    const predicates = violationBackedLadderPredicates(pool);

    // No violation anywhere: nothing starts, nothing continues.
    expect(await predicates.shouldContinue({ titleGroupId: world.groupId, engine: "google" })).toBe(false);

    // A scan whose result traced into the confirmed pair's candidate.
    const scan = await pool.query<{ id: string }>(
      `insert into scans (title_group_id, engine, due_date, trigger_kind, scan_time, created_at,
                          state, started_at, finished_at)
       values ($1, 'google', '2026-03-01', 'scheduled', '02:30', '2026-03-01', 'succeeded',
               '2026-03-01T03:00:00.000Z', '2026-03-01T03:00:00.000Z')
       returning id`,
      [world.groupId],
    );
    const confirmed = await confirmCandidate(pool, world, { url: "https://ladder.example.test/film" });

    expect(
      await predicates.shouldStart({
        titleGroupId: world.groupId,
        engine: "google",
        scanId: scan.rows[0].id,
      }),
    ).toBe(false); // the violation does not trace to the scan's results yet

    const plan = await pool.query<{ id: string }>(
      `insert into query_plans (scan_id, generated_at) values ($1, $2) returning id`,
      [scan.rows[0].id, FROZEN],
    );
    const query = await pool.query<{ id: string }>(
      `insert into search_queries (query_plan_id, tracked_title_id, locale, kind, text, normalized_text, position, variant_id)
       values ($1, $2, 'en', 'variant', 'Sunrise watch', 'sunrise watch', 0, $3) returning id`,
      [plan.rows[0].id, world.titleId, world.originalVariantId],
    );
    await pool.query(
      `insert into search_results
         (scan_id, query_id, url, normalized_url, rank, title, snippet, locale,
          observed_at, raw_payload_ref, host, registrable_domain, candidate_id)
       values ($1, $2, $3, $4, 1, 't', 's', 'en', $5, 'ref', $6, 'example.test', $7)`,
      [
        scan.rows[0].id,
        query.rows[0].id,
        "https://ladder.example.test/film",
        "ladder.example.test/film",
        FROZEN,
        "ladder.example.test",
        confirmed.candidateId,
      ],
    );

    expect(
      await predicates.shouldStart({
        titleGroupId: world.groupId,
        engine: "google",
        scanId: scan.rows[0].id,
      }),
    ).toBe(true);
    expect(await predicates.shouldContinue({ titleGroupId: world.groupId, engine: "google" })).toBe(true);

    // The ladder walks on a real violation and stops once none is open.
    await onScanCompleted(pool, clock.now, predicates, {
      scanId: scan.rows[0].id,
      titleGroupId: world.groupId,
      engine: "google",
      trigger: "scheduled",
      finishedAt: new Date("2026-03-01T03:00:00.000Z"),
      dueDate: "2026-03-01",
    });
    let ladder = await readLadder(pool, { titleGroupId: world.groupId, engine: "google" });
    expect(ladder).toMatchObject({ rung: 1, active: true });

    await pool.query("update violations set state = 'closed', closed_at = $2, closure_reason = 'operator_closed', closure_note = 'x', closed_by = $3 where id = $1", [
      confirmed.violationId,
      FROZEN,
      world.operatorId,
    ]);
    expect(await predicates.shouldContinue({ titleGroupId: world.groupId, engine: "google" })).toBe(false);
    const rung1 = await pool.query<{ id: string }>(
      `insert into scans (title_group_id, engine, due_date, trigger_kind, scan_time, created_at,
                          state, started_at, finished_at)
       values ($1, 'google', '2026-03-04', 'recheck', '02:30', '2026-03-04', 'succeeded',
               '2026-03-04T03:00:00.000Z', '2026-03-04T03:00:00.000Z')
       returning id`,
      [world.groupId],
    );
    await onScanCompleted(pool, clock.now, predicates, {
      scanId: rung1.rows[0].id,
      titleGroupId: world.groupId,
      engine: "google",
      trigger: "recheck",
      finishedAt: new Date("2026-03-04T03:00:00.000Z"),
      dueDate: "2026-03-04",
    });
    ladder = await readLadder(pool, { titleGroupId: world.groupId, engine: "google" });
    expect(ladder).toMatchObject({ active: false });
  });

  it("counts violations over a registrable domain in the reputation window", async () => {
    const world = await seedWorld(pool, { variant: { text: "Sunrise", language: "en" } });
    const at = "2026-03-02T10:00:00.000Z";
    const fresh = async (url: string): Promise<void> => {
      await confirmCandidate(pool, world, { url, at });
    };
    await fresh("https://reputation.example.test/one");
    await fresh("https://reputation.example.test/two");
    // A third, older than the twelve-month window, does not count.
    await confirmCandidate(pool, world, { url: "https://reputation.example.test/old", at: "2024-01-01T00:00:00.000Z" });

    const facts = await readReputationFacts(pool, clock.now, "example.test");
    expect(facts).toEqual({ confirmedViolations: 2, blocklisted: false });
    const none = await readReputationFacts(pool, clock.now, "other.test");
    expect(none.confirmedViolations).toBe(0);
  });
});
