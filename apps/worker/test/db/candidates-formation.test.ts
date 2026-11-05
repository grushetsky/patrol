import { beforeEach, describe, expect, it } from "vitest";
import { QUERY_RETRY_DELAYS_MS } from "../../src/acquisition/port.js";
import { FakeSerpAcquisitor } from "../../src/acquisition/fake.js";
import { runNextScan, type ExecutorDeps } from "../../src/scans/executor.js";
import {
  formCandidatesForQuery,
  formManualCandidate,
  insertManualScans,
  readCandidate,
  rescoreCandidatesFromSidecar,
} from "@patrol/scans";
import {
  controlledClock,
  seedWorld,
  testPool,
  truncateDomainTables,
} from "./helpers.js";

/**
 * Seams 6 and 7 (docs/design/matching-and-classification-rules.md
 * "Candidate formation", "Score and bands"): a scan's stored results form
 * candidates — pairing each result URL with the tracked title the query
 * targeted, deduplicating across queries and engines on (normalized URL,
 * tracked title), recording the allowlist hit, and enqueuing the detection
 * capture only for a new pair without a hit. The capture's sidecar then
 * deepens the pending candidate's score: the exact page-title match, the
 * signals the page's facts fire, and reputation alongside a strong signal.
 */

const instantSleep = async () => {};

function executor(
  pool: ReturnType<typeof testPool>,
  clock: ReturnType<typeof controlledClock>,
  fake: FakeSerpAcquisitor,
  enqueueCapture?: (input: { url: string; reason: "detection" }) => Promise<unknown>,
): ExecutorDeps {
  return {
    pool,
    now: clock.now,
    adapters: new Map([[fake.engine, fake]]),
    retryDelaysMs: QUERY_RETRY_DELAYS_MS,
    sleep: instantSleep,
    ...(enqueueCapture === undefined ? {} : { enqueueCapture }),
  };
}

/** The stream URL every engine and query surfaces, so dedup is observable. */
const STREAM_URL = "https://stream.example.test/films/sunrise-2024-full-hd";
const STREAM_KEY = "stream.example.test/films/sunrise-2024-full-hd";

function googleFixtures(): FakeSerpAcquisitor {
  return new FakeSerpAcquisitor("google", {
    results: {
      Sunrise: [
        { url: STREAM_URL, title: "Watch Sunrise (2024)", snippet: "s", rank: 1 },
        { url: "https://other.example.test/watch/night-falls", title: "Other", snippet: "s", rank: 2 },
        { url: "https://licensed.example.test/watch/sunrise-hd", title: "L", snippet: "s", rank: 3 },
      ],
      "Sunrise watch online": [
        // The same URL from a second query of the same engine: one candidate.
        { url: `https://www.stream.example.test/films/sunrise-2024-full-hd#watch`, title: "Again", snippet: "s", rank: 4 },
      ],
      "Sunrise download": [],
    },
  });
}

async function seedCatalogue(
  pool: ReturnType<typeof testPool>,
): Promise<{
  operatorId: string;
  groupId: string;
  titleId: string;
}> {
  const world = await seedWorld(pool, { locales: ["en"] });
  await pool.query(
    "update tracked_titles set runtime_minutes = 100 where id = $1",
    [world.titleId],
  );
  return {
    operatorId: world.operatorId,
    groupId: world.groupId,
    titleId: world.titleId,
  };
}

/**
 * Confirms the stream pair directly, the way a review decision leaves it:
 * an immutable decision row, an open violation, and the candidate confirmed
 * with both named. Returns the ids the assertions need.
 */
async function confirmStreamPair(
  pool: ReturnType<typeof testPool>,
  world: { operatorId: string; titleId: string },
  input: { candidateId: string; at: Date },
): Promise<string> {
  const violationId = (
    await pool.query<{ id: string }>("select uuidv7()::text as id")
  ).rows[0].id;
  const decision = await pool.query<{ id: string }>(
    `insert into review_decisions (candidate_id, operator_id, action, decided_at, evidence_ids, violation_id)
     values ($1, $2, 'violation', $3, '{}'::uuid[], $4) returning id`,
    [input.candidateId, world.operatorId, input.at, violationId],
  );
  await pool.query(
    `insert into violations
       (id, tracked_title_id, candidate_id, review_decision_id, url, normalized_url, host,
        host_source, registrable_domain, detected_at, confirmed_at, confirmed_by, opened_at)
     values ($1, $2, $3, $4, $5, $6, 'stream.example.test', 'submitted_url', 'example.test',
        $7, $7, $8, $7)`,
    [
      violationId,
      world.titleId,
      input.candidateId,
      decision.rows[0].id,
      STREAM_URL,
      STREAM_KEY,
      input.at,
      world.operatorId,
    ],
  );
  await pool.query(
    `update candidates set state = 'confirmed', review_decision_id = $2,
        violation_id = $3, confirmed_at = $4 where id = $1`,
    [input.candidateId, decision.rows[0].id, violationId, input.at],
  );
  return violationId;
}

describe("candidate formation from a scan", () => {
  beforeEach(async () => {
    const pool = testPool();
    try {
      await truncateDomainTables(pool);
    } finally {
      await pool.end();
    }
  });

  it("forms, scores, and deduplicates pairs, records allowlist hits, and enqueues detection captures", async () => {
    const pool = testPool();
    const clock = controlledClock("2026-03-02T10:00:00.000Z");
    const world = await seedCatalogue(pool);

    // A neutral-source entry for the other host (rights-holder scope), and a
    // licensed destination for the licensed host scoped to this title in the
    // query's territory (US for an en locale).
    await pool.query(
      `insert into allowlist_entries (kind, match_kind, value, scope, origin, confirmed_by, confirmed_at)
       values ('neutral_source', 'host', 'other.example.test', 'rights_holder', 'operator', $1, $2)`,
      [world.operatorId, clock.now()],
    );
    await pool.query(
      `insert into allowlist_entries (kind, match_kind, value, scope, tracked_title_id, territory, origin, confirmed_by, confirmed_at)
       values ('licensed_destination', 'host', 'licensed.example.test', 'tracked_title', $1, 'US', 'operator', $2, $3)`,
      [world.titleId, world.operatorId, clock.now()],
    );

    const enqueued: string[] = [];
    const [scan] = await insertManualScans(pool, clock.now, {
      titleGroupId: world.groupId,
      engines: ["google"],
      trigger: "manual",
      createdBy: world.operatorId,
    });
    const outcome = await runNextScan(
      executor(
        pool,
        clock,
        googleFixtures(),
        async ({ url }) => {
          enqueued.push(url);
        },
      ),
      "google",
    );
    expect(outcome).toMatchObject({ outcome: "ran", state: "succeeded" });

    // Three pairs: the stream URL, the allowlisted neutral host, and the
    // licensed destination. The intent query's duplicate row collapsed onto
    // the stream pair (www and fragment normalize away).
    const candidates = await pool.query<{
      id: string;
      normalized_url: string;
      score: string;
      band: string;
      engines: string[];
      best_rank: number | null;
      query_text: string | null;
      matched_variant: Record<string, unknown>;
      score_components: { titleMatch: number; signals: unknown[]; reputation: number };
      reputation: Record<string, unknown>;
      allowlist_kind: string | null;
      state: string;
    }>(
      "select * from candidates order by normalized_url",
    );
    expect(candidates.rows).toHaveLength(3);

    const stream = candidates.rows.find((row) => row.normalized_url === STREAM_KEY)!;
    expect(Number(stream.score)).toBe(0.6);
    expect(stream.band).toBe("c");
    expect(stream.engines).toEqual(["google"]);
    expect(stream.best_rank).toBe(1);
    expect(stream.query_text).toBe("Sunrise");
    expect(stream.score_components.titleMatch).toBe(0.6);
    expect(stream.score_components.signals).toEqual([]);
    expect(stream.score_components.reputation).toBe(0);
    expect(stream.matched_variant).toMatchObject({
      text: "Sunrise",
      kind: "original",
      language: "en",
      script: "Latn",
    });
    expect(stream.state).toBe("pending");
    expect(stream.allowlist_kind).toBeNull();

    const neutral = candidates.rows.find(
      (row) => row.normalized_url === "other.example.test/watch/night-falls",
    )!;
    expect(neutral.allowlist_kind).toBe("neutral_source");
    expect(Number(neutral.score)).toBe(0);

    const licensed = candidates.rows.find(
      (row) => row.normalized_url === "licensed.example.test/watch/sunrise-hd",
    )!;
    expect(licensed.allowlist_kind).toBe("licensed_destination");
    expect(Number(licensed.score)).toBe(0.6);

    // Only the pair without an allowlist hit enqueued a detection capture.
    expect(enqueued).toEqual([STREAM_URL]);

    // Both result rows of the stream pair link to the one candidate.
    const linked = await pool.query<{ candidate_id: string | null }>(
      "select candidate_id from search_results where normalized_url = $1",
      [STREAM_KEY],
    );
    expect(linked.rows).toHaveLength(2);
    for (const row of linked.rows) {
      expect(row.candidate_id).toBe(stream.id);
    }

    // Provenance stays immutable beyond the pairing: a rank edit is refused.
    await expect(
      pool.query("update search_results set rank = 99 where normalized_url = $1", [STREAM_KEY]),
    ).rejects.toThrow(/never edited/i);
    await pool.end();
  });

  it("deduplicates the same pair across engines, folding the engines array", async () => {
    const pool = testPool();
    const clock = controlledClock("2026-03-02T10:00:00.000Z");
    const world = await seedCatalogue(pool);

    await insertManualScans(pool, clock.now, {
      titleGroupId: world.groupId,
      engines: ["google"],
      trigger: "manual",
      createdBy: world.operatorId,
    });
    await runNextScan(executor(pool, clock, googleFixtures()), "google");

    clock.advance(60_000);
    await insertManualScans(pool, clock.now, {
      titleGroupId: world.groupId,
      engines: ["yandex"],
      trigger: "manual",
      createdBy: world.operatorId,
    });
    const yandex = new FakeSerpAcquisitor("yandex", {
      results: {
        Sunrise: [
          { url: `http://${STREAM_KEY}?utm_source=yandex`, title: "Y", snippet: "s", rank: 2 },
        ],
        "Sunrise watch online": [],
        "Sunrise download": [],
      },
    });
    await runNextScan(executor(pool, clock, yandex), "yandex");

    const stream = await pool.query<{
      id: string;
      engines: string[];
      engine: string;
      best_rank: number;
      score: string;
      last_observed_at: Date;
    }>(
      "select id, engines, engine, best_rank, score, last_observed_at from candidates where normalized_url = $1",
      [STREAM_KEY],
    );
    // One candidate, seen by both engines; the first engine and the best
    // rank stand, the observation time advanced, and the score was never
    // clobbered by the second formation pass.
    const rows = await pool.query<{ count: string }>(
      "select count(*) as count from candidates where normalized_url = $1",
      [STREAM_KEY],
    );
    expect(Number(rows.rows[0].count)).toBe(1);
    expect(stream.rows[0].engines.sort()).toEqual(["google", "yandex"]);
    expect(stream.rows[0].engine).toBe("google");
    expect(stream.rows[0].best_rank).toBe(1);
    expect(Number(stream.rows[0].score)).toBe(0.6);
    expect(stream.rows[0].last_observed_at.toISOString()).toBe(clock.now().toISOString());
    await pool.end();
  });

  it("re-observing a manual pair by a scan records the observation without breaking the manual shape", async () => {
    const pool = testPool();
    const clock = controlledClock("2026-03-02T10:00:00.000Z");
    const world = await seedCatalogue(pool);

    // The operator's pair first: manual, no engine, no rank.
    const manual = await formManualCandidate(pool, clock.now, {
      url: STREAM_URL,
      trackedTitleId: world.titleId,
      operatorId: world.operatorId,
    });
    expect(manual.created).toBe(true);
    const manualId = manual.candidate.id;

    // The scan the same URL surfaces in: SERP formation meets the manual
    // pair on the upsert conflict, where the table's CHECKs tie
    // source = 'manual' to empty engines and a null rank.
    clock.advance(60_000);
    await insertManualScans(pool, clock.now, {
      titleGroupId: world.groupId,
      engines: ["google"],
      trigger: "manual",
      createdBy: world.operatorId,
    });
    const outcome = await runNextScan(executor(pool, clock, googleFixtures()), "google");
    expect(outcome).toMatchObject({ outcome: "ran", state: "succeeded" });

    // One row stands for the pair, still manual through and through: the
    // guarded conflict path touched only the observation times, never the
    // engines, the rank, or the provenance columns.
    const pair = await pool.query<{
      id: string;
      source: string;
      engine: string | null;
      engines: string[];
      best_rank: number | null;
      query_id: string | null;
      query_text: string | null;
      created_by: string | null;
      last_observed_at: Date;
    }>(
      "select id, source, engine, engines, best_rank, query_id, query_text, created_by, last_observed_at from candidates where normalized_url = $1",
      [STREAM_KEY],
    );
    expect(pair.rows).toHaveLength(1);
    const row = pair.rows[0];
    expect(row.id).toBe(manualId);
    expect(row.source).toBe("manual");
    expect(row.engine).toBeNull();
    expect(row.engines).toEqual([]);
    expect(row.best_rank).toBeNull();
    expect(row.query_id).toBeNull();
    expect(row.query_text).toBeNull();
    expect(row.created_by).toBe(world.operatorId);
    expect(row.last_observed_at.toISOString()).toBe(clock.now().toISOString());

    // The SERP observation is recorded through the pairing link instead:
    // both result rows of the scan point at the manual candidate.
    const linked = await pool.query<{ candidate_id: string | null }>(
      "select candidate_id from search_results where normalized_url = $1",
      [STREAM_KEY],
    );
    expect(linked.rows).toHaveLength(2);
    for (const result of linked.rows) {
      expect(result.candidate_id).toBe(manualId);
    }
    await pool.end();
  });

  it("skips formation when a query's scan provenance is gone, rather than guessing an engine", async () => {
    const pool = testPool();
    const clock = controlledClock("2026-03-02T10:00:00.000Z");
    const world = await seedCatalogue(pool);
    const originalVariantId = (
      await pool.query<{ id: string }>(
        "select original_variant_id as id from tracked_titles where id = $1",
        [world.titleId],
      )
    ).rows[0].id;

    // A standing scan, plan, query, and result — the normal chain — with no
    // candidates formed yet.
    const [scan] = await insertManualScans(pool, clock.now, {
      titleGroupId: world.groupId,
      engines: ["google"],
      trigger: "manual",
      createdBy: world.operatorId,
    });
    const plan = await pool.query<{ id: string }>(
      "insert into query_plans (scan_id, generated_at) values ($1, $2) returning id",
      [scan.id, clock.now()],
    );
    const query = await pool.query<{ id: string }>(
      `insert into search_queries
         (query_plan_id, tracked_title_id, locale, kind, text, normalized_text, variant_id, position, issued, issued_at)
       values ($1, $2, 'en', 'variant', 'Sunrise', 'sunrise', $3, 0, true, $4)
       returning id`,
      [plan.rows[0].id, world.titleId, originalVariantId, clock.now()],
    );
    await pool.query(
      `insert into search_results
         (scan_id, query_id, url, normalized_url, rank, title, snippet, locale, territory, observed_at, raw_payload_ref, host, registrable_domain)
       values ($1, $2, $3, $4, 1, 'Watch Sunrise', 's', 'en', 'US', $5, 's3://raw', 'stream.example.test', 'example.test')`,
      [scan.id, query.rows[0].id, STREAM_URL, STREAM_KEY, clock.now()],
    );

    // Break the provenance chain the way a future retention bug would: the
    // plan vanishes while its queries and results stand.
    const logs: string[] = [];
    const log = (message: string): void => {
      logs.push(message);
    };
    await pool.query(
      "alter table search_queries drop constraint search_queries_query_plan_id_fkey",
    );
    try {
      await pool.query("delete from query_plans");
      const outcomes = await formCandidatesForQuery(pool, clock.now, {
        queryId: query.rows[0].id,
        log,
      });
      expect(outcomes).toEqual([]);
      const candidates = await pool.query("select id from candidates");
      expect(candidates.rows).toHaveLength(0);
      expect(logs.join("\n")).toMatch(/without scan provenance/);
    } finally {
      // Restore the schema the suite's other files assume.
      await pool.query("delete from search_results");
      await pool.query("delete from search_queries");
      await pool.query(
        `alter table search_queries add constraint search_queries_query_plan_id_fkey
           foreign key (query_plan_id) references query_plans (id) on delete cascade`,
      );
    }
    await pool.end();
  });

  it("re-observing a pair whose violation stands open creates no pending row and enqueues no capture", async () => {
    const pool = testPool();
    const clock = controlledClock("2026-03-02T10:00:00.000Z");
    const world = await seedCatalogue(pool);

    const enqueued: string[] = [];
    const streamEnqueues = (): number => enqueued.filter((url) => url === STREAM_URL).length;
    await insertManualScans(pool, clock.now, {
      titleGroupId: world.groupId,
      engines: ["google"],
      trigger: "manual",
      createdBy: world.operatorId,
    });
    await runNextScan(
      executor(pool, clock, googleFixtures(), async ({ url }) => {
        enqueued.push(url);
      }),
      "google",
    );
    expect(streamEnqueues()).toBe(1);

    // The operator confirms the stream pair: an open violation stands and
    // the candidate row is its confirmed record.
    const firstScan = await pool.query<{ id: string; last_observed_at: Date }>(
      "select id, last_observed_at from candidates where normalized_url = $1",
      [STREAM_KEY],
    );
    const confirmedId = firstScan.rows[0].id;
    const observedAtScan1 = firstScan.rows[0].last_observed_at;
    await confirmStreamPair(pool, world, { candidateId: confirmedId, at: clock.now() });

    // The next day's scan surfaces the same URL again.
    clock.advance(24 * 60 * 60 * 1000);
    await insertManualScans(pool, clock.now, {
      titleGroupId: world.groupId,
      engines: ["google"],
      trigger: "manual",
      createdBy: world.operatorId,
    });
    const second = await runNextScan(
      executor(pool, clock, googleFixtures(), async ({ url }) => {
        enqueued.push(url);
      }),
      "google",
    );
    expect(second).toMatchObject({ outcome: "ran", state: "succeeded" });

    // No phantom pending row: the pair still answers its one confirmed row,
    // only its observation time advanced to the resurfacing.
    const rows = await pool.query<{
      id: string;
      state: string;
      last_observed_at: Date;
      score: string;
    }>(
      "select id, state, last_observed_at, score from candidates where normalized_url = $1",
      [STREAM_KEY],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].id).toBe(confirmedId);
    expect(rows.rows[0].state).toBe("confirmed");
    expect(rows.rows[0].last_observed_at.getTime()).toBeGreaterThan(
      observedAtScan1.getTime(),
    );
    // The re-observation refreshed nothing else: the decision-time score
    // stands (0.6, band c at formation), and no capture was enqueued for a
    // pair whose violation already stands open.
    expect(Number(rows.rows[0].score)).toBe(0.6);
    expect(streamEnqueues()).toBe(1);

    // The SERP observation is recorded through the pairing link instead:
    // both scans' result rows of the pair point at the confirmed candidate.
    const linked = await pool.query<{ candidate_id: string | null }>(
      "select candidate_id from search_results where normalized_url = $1",
      [STREAM_KEY],
    );
    expect(linked.rows).toHaveLength(4);
    for (const result of linked.rows) {
      expect(result.candidate_id).toBe(confirmedId);
    }
    await pool.end();
  });

  it("re-observing a pair whose violation ended terminally starts the reappearance row", async () => {
    const pool = testPool();
    const clock = controlledClock("2026-03-02T10:00:00.000Z");
    const world = await seedCatalogue(pool);

    const enqueued: string[] = [];
    await insertManualScans(pool, clock.now, {
      titleGroupId: world.groupId,
      engines: ["google"],
      trigger: "manual",
      createdBy: world.operatorId,
    });
    await runNextScan(
      executor(pool, clock, googleFixtures(), async ({ url }) => {
        enqueued.push(url);
      }),
      "google",
    );
    const firstScan = await pool.query<{ id: string }>(
      "select id from candidates where normalized_url = $1",
      [STREAM_KEY],
    );
    const confirmedId = firstScan.rows[0].id;
    const violationId = await confirmStreamPair(pool, world, {
      candidateId: confirmedId,
      at: clock.now(),
    });
    // The wave ends terminally: the URL was removed.
    await pool.query(
      `update violations set state = 'removed', closed_at = $2, closure_reason = 'url_removed',
          closure_evidence_id = null, closed_by = null
        where id = $1`,
      [violationId, clock.now()],
    );

    // The URL reappears on the next day's scan: a NEW pending row is
    // allowed — the reappearance the predecessor chain exists for — and its
    // capture is enqueued like any new pair's.
    clock.advance(24 * 60 * 60 * 1000);
    await insertManualScans(pool, clock.now, {
      titleGroupId: world.groupId,
      engines: ["google"],
      trigger: "manual",
      createdBy: world.operatorId,
    });
    await runNextScan(
      executor(pool, clock, googleFixtures(), async ({ url }) => {
        enqueued.push(url);
      }),
      "google",
    );

    const rows = await pool.query<{ id: string; state: string; violation_id: string | null }>(
      "select id, state, violation_id from candidates where normalized_url = $1 order by created_at",
      [STREAM_KEY],
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows[0]).toMatchObject({ id: confirmedId, state: "confirmed" });
    expect(rows.rows[1]).toMatchObject({ state: "pending", violation_id: null });
    expect(rows.rows[1].id).not.toBe(confirmedId);
    expect(enqueued.filter((url) => url === STREAM_URL)).toHaveLength(2);
    await pool.end();
  });

  it("deepens a pending candidate's score from the capture's sidecar", async () => {
    const pool = testPool();
    const clock = controlledClock("2026-03-02T10:00:00.000Z");
    const world = await seedCatalogue(pool);
    await insertManualScans(pool, clock.now, {
      titleGroupId: world.groupId,
      engines: ["google"],
      trigger: "manual",
      createdBy: world.operatorId,
    });
    await runNextScan(executor(pool, clock, googleFixtures()), "google");

    // Three violations at the stream domain's registrable domain
    // (example.test — subdomains share reputation), twelve months fresh.
    // One seeding serves both reads: the domain's own reputation (3–9
    // confirmed violations earn 0.05) and the player host's known-bad answer
    // (the iframe's host cdn.stream.example.test aggregates at example.test).
    // Since slice 5b the reputation aggregate reads the violations table the
    // review decision writes, so the seed stands a confirmed pair with its
    // decision and violation per count.
    const originalVariantId = (
      await pool.query<{ id: string }>(
        "select original_variant_id as id from tracked_titles where id = $1",
        [world.titleId],
      )
    ).rows[0].id;
    for (let index = 0; index < 3; index += 1) {
      const url = `https://cdn.stream.example.test/prev-${index}`;
      const candidate = await pool.query<{ id: string }>(
        `insert into candidates
           (tracked_title_id, url, normalized_url, host, registrable_domain, source,
            engine, engines, best_rank, matched_variant_id, matched_variant, score, band,
            score_components, reputation, first_seen_at, last_observed_at,
            state, review_decision_id, violation_id, confirmed_at)
         values ($1, $2, $3, 'cdn.stream.example.test', 'example.test', 'serp',
            'google', '{google}', 1, $4, '{}'::jsonb, 1, 'a', '{}'::jsonb, '{}'::jsonb, $5, $5,
            'confirmed', uuidv7(), uuidv7(), $5)
         returning id`,
        [
          world.titleId,
          url,
          `cdn.stream.example.test/prev-${index}`,
          originalVariantId,
          clock.now(),
        ],
      );
      const violationId = (
        await pool.query<{ id: string }>("select uuidv7()::text as id")
      ).rows[0].id;
      const decision = await pool.query<{ id: string }>(
        `insert into review_decisions (candidate_id, operator_id, action, decided_at, evidence_ids, violation_id)
         values ($1, $2, 'violation', $3, '{}'::uuid[], $4) returning id`,
        [candidate.rows[0].id, world.operatorId, clock.now(), violationId],
      );
      await pool.query(
        `insert into violations
           (id, tracked_title_id, candidate_id, review_decision_id, url, normalized_url, host,
            host_source, registrable_domain, detected_at, confirmed_at, confirmed_by, opened_at)
         values ($1, $2, $3, $4, $5, $6, 'cdn.stream.example.test', 'submitted_url', 'example.test',
            $7, $7, $8, $7)`,
        [
          violationId,
          world.titleId,
          candidate.rows[0].id,
          decision.rows[0].id,
          url,
          `cdn.stream.example.test/prev-${index}`,
          clock.now(),
          world.operatorId,
        ],
      );
    }

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
    const rescored = await rescoreCandidatesFromSidecar(pool, clock.now, {
      normalizedUrl: STREAM_KEY,
      sidecar,
    });
    expect(rescored).toHaveLength(1);

    const deepened = await readCandidate(pool, rescored[0].id);
    expect(deepened?.score).toBe(1);
    expect(deepened?.band).toBe("a");
    expect(deepened?.scoreComponents).toEqual({
      titleMatch: 0.7,
      signals: [
        { kind: "player", value: 0.25 },
        { kind: "download", value: 0.05 },
      ],
      reputation: 0.05,
    });
    expect(deepened?.reputation).toMatchObject({
      registrableDomain: "example.test",
      confirmedViolations: 3,
      bonus: 0.05,
      blocklisted: false,
    });
    // The score is deepened, the candidate stays pending: no score confirms
    // a violation.
    expect(deepened?.state).toBe("pending");
    await pool.end();
  });
});
