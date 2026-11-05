import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { buildApp, poolSchemaStamp, testConfig, controlledClock } from "../test-app.js";
import { getValidator } from "../../src/plugins/validator.js";
import { MemoryMailTransport } from "../../src/mail/transport.js";
import { authHeaders, signedInAdministrator, FROZEN_NOW, type CeremonyApp, type SignedInOperator } from "./ceremony.js";
import { testPool, truncateDomainTables } from "./helpers.js";

/**
 * Seams 6 and 8 over HTTP (Patrol.Http Candidates): a manual pair creation
 * answers 201 for a new pair and 200 for the pair the deduplication key
 * already names, its detection capture rides the enqueue port, and the
 * review queue orders by score descending, SERP rank ascending, and
 * observation time descending — the fixed order the design states.
 */

const FROZEN = "2026-05-01T10:00:00.000Z";

/** The world the candidates API needs: an operator, a group, a title. */
async function seedWorld(pool: Pool): Promise<{
  operatorId: string;
  groupId: string;
  titleId: string;
  originalVariantId: string;
}> {
  const at = FROZEN;
  await pool.query(
    `insert into rights_holder (singleton, legal_name, country)
     values (true, 'Example Rights GmbH', 'DE')
     on conflict (singleton) do nothing`,
  );
  const operator = await pool.query<{ id: string }>(
    `insert into operators (email, password_hash, role, state, created_at, updated_at)
     values ('catalogue@example.test', 'x', 'operator', 'active', $1, $1)
     on conflict (email) do update set updated_at = excluded.updated_at
     returning id`,
    [at],
  );
  const operatorId = operator.rows[0].id;
  const group = await pool.query<{ id: string }>(
    `insert into title_groups (name, locales) values ('Films', '{en}') returning id`,
  );
  const groupId = group.rows[0].id;
  const title = await pool.query<{ id: string }>(
    `insert into tracked_titles
       (title_group_id, release_year, title_type, runtime_minutes, source, entered_by, entered_at, updated_by, created_at, updated_at)
     values ($1, 2024, 'film', 100, 'operator_knowledge', $2, $3, $2, $3, $3) returning id`,
    [groupId, operatorId, at],
  );
  const titleId = title.rows[0].id;
  const variant = await pool.query<{ id: string }>(
    `insert into title_variants
       (tracked_title_id, text, normalized_text, kind, language, script, source, added_by, added_at)
     values ($1, 'Sunrise', 'sunrise', 'original', 'en', 'Latn', 'operator_knowledge', $2, $3) returning id`,
    [titleId, operatorId, at],
  );
  await pool.query(
    "update tracked_titles set original_variant_id = $2 where id = $1",
    [titleId, variant.rows[0].id],
  );
  return { operatorId, groupId, titleId, originalVariantId: variant.rows[0].id };
}

/** One candidate row seeded directly, for the read model's own assertions. */
async function seedCandidate(
  pool: Pool,
  world: Awaited<ReturnType<typeof seedWorld>>,
  input: {
    url: string;
    score: number;
    rank: number | null;
    observedAt: string;
    engine?: "google" | "yandex";
    source?: "serp" | "manual";
    band?: "a" | "b" | "c";
  },
): Promise<string> {
  const host = new URL(input.url).hostname;
  const result = await pool.query<{ id: string }>(
    `insert into candidates
       (tracked_title_id, url, normalized_url, host, registrable_domain, source, engine,
        engines, best_rank, matched_variant_id, matched_variant, score, band,
        score_components, reputation, first_seen_at, last_observed_at, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7,
             case when $7::text is null then '{}'::text[] else array[$7::text] end,
             $8, $9, $10::jsonb, $11, $12,
             '{"titleMatch":0.6,"signals":[],"reputation":0}'::jsonb,
             '{"registrableDomain":"","confirmedViolations":0,"bonus":0,"blocklisted":false}'::jsonb,
             $13, $13, $13, $13)
     returning id`,
    [
      world.titleId,
      input.url,
      `${host}${new URL(input.url).pathname}`,
      host,
      host.split(".").slice(-2).join("."),
      input.source ?? "serp",
      input.source === "manual" ? null : (input.engine ?? "google"),
      input.rank,
      world.originalVariantId,
      JSON.stringify({ id: world.originalVariantId, text: "Sunrise", kind: "original", language: "en", script: "Latn" }),
      input.score,
      input.band ?? (input.score >= 0.95 ? "a" : input.score >= 0.7 ? "b" : "c"),
      input.observedAt,
    ],
  );
  return result.rows[0].id;
}

describe("the candidates API", () => {
  let appWorld: CeremonyApp;
  let admin: SignedInOperator;
  let pool: Pool;
  const captureDispatches: string[] = [];

  beforeEach(async () => {
    if (pool === undefined) {
      pool = testPool();
    }
    await truncateDomainTables(pool);
    captureDispatches.length = 0;
    appWorld = {
      app: await buildApp({
        config: testConfig({ now: controlledClock(FROZEN_NOW).now }),
        pool,
        mail: new MemoryMailTransport(),
        schemaStamp: poolSchemaStamp(pool),
        captureDispatch: async (captureId) => {
          captureDispatches.push(captureId);
        },
      }),
      pool,
      mail: new MemoryMailTransport(),
      clock: controlledClock(FROZEN_NOW),
    };
    admin = await signedInAdministrator(appWorld);
  });

  afterAll(async () => {
    if (pool !== undefined) {
      await pool.end();
    }
  });

  it("pairs a manual URL with a title: 201 new, 200 existing, capture enqueued once", async () => {
    const world = await seedWorld(pool);
    const url = "https://manual.example.test/films/sunrise-2024";
    const first = await appWorld.app.inject({
      method: "POST",
      url: "/api/candidates",
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: { url, trackedTitleId: world.titleId },
    });
    expect(first.statusCode).toBe(201);
    const created = first.json();
    expect(getValidator("Candidate")(created)).toBe(true);
    expect(created).toMatchObject({
      trackedTitleId: world.titleId,
      url,
      normalizedUrl: "manual.example.test/films/sunrise-2024",
      host: "manual.example.test",
      score: 0.6,
      scoreComponents: { titleMatch: 0.6, signals: [], reputation: 0 },
      matchedVariant: { text: "Sunrise", kind: "original" },
      lifecycle: { state: "pending" },
      priorDecisionIds: [],
    });

    // The manual pair's detection capture rode the enqueue port and woke
    // the capture queue.
    const captures = await pool.query<{ requested_url: string; reason: string; state: string }>(
      "select requested_url, reason, state from captures",
    );
    expect(captures.rows).toEqual([
      { requested_url: url, reason: "detection", state: "pending" },
    ]);
    expect(captureDispatches).toHaveLength(1);

    // The same pair again: unchanged, 200, no second capture.
    const second = await appWorld.app.inject({
      method: "POST",
      url: "/api/candidates",
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: { url, trackedTitleId: world.titleId },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().id).toBe(created.id);
    const total = await pool.query<{ count: string }>("select count(*) as count from candidates");
    expect(Number(total.rows[0].count)).toBe(1);
    expect(captureDispatches).toHaveLength(1);

    // A duplicate under another spelling of the same key deduplicates too.
    const third = await appWorld.app.inject({
      method: "POST",
      url: "/api/candidates",
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: { url: "http://www.manual.example.test/films/sunrise-2024?utm_source=x#frag", trackedTitleId: world.titleId },
    });
    expect(third.statusCode).toBe(200);
    expect(third.json().id).toBe(created.id);
  });

  it("refuses an unparseable URL, a non-HTTP scheme, and an unknown title", async () => {
    const world = await seedWorld(pool);
    // A string that is not a URI at all fails the contract's own format.
    const badUrl = await appWorld.app.inject({
      method: "POST",
      url: "/api/candidates",
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: { url: "not a url", trackedTitleId: world.titleId },
    });
    expect(badUrl.statusCode).toBe(400);
    expect(badUrl.json().code).toBe("validation_failed");

    // A well-formed URI outside HTTP and HTTPS reaches the domain rule.
    const ftp = await appWorld.app.inject({
      method: "POST",
      url: "/api/candidates",
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: { url: "ftp://manual.example.test/file", trackedTitleId: world.titleId },
    });
    expect(ftp.statusCode).toBe(422);

    const unknownTitle = await appWorld.app.inject({
      method: "POST",
      url: "/api/candidates",
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: { url: "https://manual.example.test/x", trackedTitleId: "018f4c8e-1c2a-7c3e-9b1f-2b6d9f0a3c99" },
    });
    expect(unknownTitle.statusCode).toBe(422);
  });

  it("requires the CSRF pair and a session", async () => {
    const world = await seedWorld(pool);
    const noCsrf = await appWorld.app.inject({
      method: "POST",
      url: "/api/candidates",
      headers: { "content-type": "application/json", cookie: admin.cookie },
      payload: { url: "https://manual.example.test/x", trackedTitleId: world.titleId },
    });
    expect(noCsrf.statusCode).toBe(403);

    const anonymous = await appWorld.app.inject({
      method: "GET",
      url: "/api/candidates",
    });
    expect(anonymous.statusCode).toBe(401);
  });

  it("orders the queue by score, then rank, then observation time", async () => {
    const world = await seedWorld(pool);
    const top = await seedCandidate(pool, world, {
      url: "https://q.example.test/top",
      score: 0.95,
      rank: 3,
      observedAt: "2026-05-01T09:00:00.000Z",
    });
    const earlierSameRank = await seedCandidate(pool, world, {
      url: "https://q.example.test/earlier",
      score: 0.95,
      rank: 1,
      observedAt: "2026-05-01T08:00:00.000Z",
    });
    const laterSameRank = await seedCandidate(pool, world, {
      url: "https://q.example.test/later",
      score: 0.95,
      rank: 1,
      observedAt: "2026-05-01T09:30:00.000Z",
    });
    const midScore = await seedCandidate(pool, world, {
      url: "https://q.example.test/mid",
      score: 0.8,
      rank: 1,
      observedAt: "2026-05-01T09:59:00.000Z",
    });
    const manual = await seedCandidate(pool, world, {
      url: "https://q.example.test/manual",
      score: 0.95,
      rank: null,
      observedAt: "2026-05-01T09:00:00.000Z",
      source: "manual",
    });
    await seedCandidate(pool, world, {
      url: "https://q.example.test/low",
      score: 0.5,
      rank: 1,
      observedAt: "2026-05-01T09:59:00.000Z",
    });

    const list = await appWorld.app.inject({
      method: "GET",
      url: "/api/candidates",
      headers: { cookie: admin.cookie },
    });
    expect(list.statusCode).toBe(200);
    const page = list.json();
    expect(getValidator("CandidatePage")(page)).toBe(true);
    expect(page.total).toBe(5);
    // Band C never reaches the queue.
    expect(page.items.map((row: { id: string }) => row.id)).toEqual([
      laterSameRank,
      earlierSameRank,
      top,
      manual,
      midScore,
    ]);

    const bandA = await appWorld.app.inject({
      method: "GET",
      url: "/api/candidates?band=a",
      headers: { cookie: admin.cookie },
    });
    expect(bandA.json().total).toBe(4);

    const byBand = await appWorld.app.inject({
      method: "GET",
      url: "/api/candidates?band=b",
      headers: { cookie: admin.cookie },
    });
    expect(byBand.json().items.map((row: { id: string }) => row.id)).toEqual([midScore]);

    // The row carries the read model's fields.
    const row = page.items[0];
    expect(row).toMatchObject({
      trackedTitleId: world.titleId,
      displayTitle: "Sunrise",
      releaseYear: 2024,
      titleType: "film",
      source: "serp",
      engine: "google",
      rank: 1,
      score: 0.95,
      host: "q.example.test",
      registrableDomain: "example.test",
      lifecycle: { state: "pending" },
      matchedVariant: { text: "Sunrise", kind: "original" },
    });
  });

  it("serves one candidate with its provenance, evidence, and allowlist state", async () => {
    const world = await seedWorld(pool);
    const candidateId = await seedCandidate(pool, world, {
      url: "https://detail.example.test/films/sunrise-2024",
      score: 0.6,
      rank: 2,
      observedAt: FROZEN,
    });
    await pool.query(
      `insert into allowlist_entries (kind, match_kind, value, scope, origin, confirmed_by, confirmed_at)
       values ('neutral_source', 'host', 'detail.example.test', 'rights_holder', 'operator', $1, $2)`,
      [world.operatorId, FROZEN],
    );
    await pool.query(`update candidates set allowlist_entry_id = (
       select id from allowlist_entries where value = 'detail.example.test'
     ) where id = $1`, [candidateId]);

    const detail = await appWorld.app.inject({
      method: "GET",
      url: `/api/candidates/${candidateId}`,
      headers: { cookie: admin.cookie },
    });
    expect(detail.statusCode).toBe(200);
    const body = detail.json();
    expect(getValidator("CandidateDetail")(body)).toBe(true);
    expect(body.displayTitle).toBe("Sunrise");
    expect(body.candidate.id).toBe(candidateId);
    expect(body.candidate.allowlistEntryId).toBeDefined();
    expect(body.allowlistEntry).toMatchObject({
      kind: "neutral_source",
      value: "detail.example.test",
      scope: "rights_holder",
    });
    expect(body.observations).toEqual([]);
    expect(body.evidence).toEqual([]);
    expect(body.decisions).toEqual([]);

    const missing = await appWorld.app.inject({
      method: "GET",
      url: "/api/candidates/018f4c8e-1c2a-7c3e-9b1f-2b6d9f0a3c99",
      headers: { cookie: admin.cookie },
    });
    expect(missing.statusCode).toBe(404);
  });
});
