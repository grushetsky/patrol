import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { buildApp, poolSchemaStamp, testConfig, controlledClock } from "../test-app.js";
import { getValidator } from "../../src/plugins/validator.js";
import { MemoryMailTransport } from "../../src/mail/transport.js";
import { authHeaders, signedInAdministrator, FROZEN_NOW, type CeremonyApp, type SignedInOperator } from "./ceremony.js";
import { testPool, truncateDomainTables } from "./helpers.js";

/**
 * Seams 7 (closure half), 8, and 13 over HTTP (Patrol.Http Violations): an
 * operator closes an open violation with a note — terminal, refused twice —
 * or records the removal itself with the capture that showed it; a
 * reappearing pair surfaces a new candidate whose confirm is a NEW
 * violation linked to its predecessor, the closed record untouched; and the
 * list filters and the detail shape hold their contract.
 */

const FROZEN = "2026-01-01T00:00:00.000Z";

async function seedWorld(pool: Pool): Promise<{
  operatorId: string;
  groupId: string;
  titleId: string;
  originalVariantId: string;
}> {
  await pool.query(
    `insert into rights_holder (singleton, legal_name, country)
     values (true, 'Example Rights GmbH', 'DE')
     on conflict (singleton) do nothing`,
  );
  const operator = await pool.query<{ id: string }>(
    `insert into operators (email, password_hash, role, state, created_at, updated_at)
     values ('violations@example.test', 'x', 'operator', 'active', $1, $1)
     on conflict (email) do update set updated_at = excluded.updated_at
     returning id`,
    [FROZEN],
  );
  const operatorId = operator.rows[0].id;
  const group = await pool.query<{ id: string }>(
    `insert into title_groups (name, locales) values ('Films', '{en}') returning id`,
  );
  const title = await pool.query<{ id: string }>(
    `insert into tracked_titles
       (title_group_id, release_year, title_type, runtime_minutes, source, entered_by, entered_at, updated_by, created_at, updated_at)
     values ($1, 2024, 'film', 100, 'operator_knowledge', $2, $3, $2, $3, $3) returning id`,
    [group.rows[0].id, operatorId, FROZEN],
  );
  const variant = await pool.query<{ id: string }>(
    `insert into title_variants
       (tracked_title_id, text, normalized_text, kind, language, script, source, added_by, added_at)
     values ($1, 'Sunrise', 'sunrise', 'original', 'en', 'Latn', 'operator_knowledge', $2, $3) returning id`,
    [title.rows[0].id, operatorId, FROZEN],
  );
  await pool.query(
    "update tracked_titles set original_variant_id = $2 where id = $1",
    [title.rows[0].id, variant.rows[0].id],
  );
  return {
    operatorId,
    groupId: group.rows[0].id,
    titleId: title.rows[0].id,
    originalVariantId: variant.rows[0].id,
  };
}

async function seedCandidate(
  pool: Pool,
  world: Awaited<ReturnType<typeof seedWorld>>,
  input: { url: string; titleId?: string },
): Promise<string> {
  const host = new URL(input.url).hostname;
  const result = await pool.query<{ id: string }>(
    `insert into candidates
       (tracked_title_id, url, normalized_url, host, registrable_domain, source, engine,
        engines, best_rank, matched_variant_id, matched_variant, score, band,
        score_components, reputation, first_seen_at, last_observed_at, created_at, updated_at)
     values ($1, $2, $3, $4, $5, 'serp', 'google', '{google}', 1, $6,
        '{"id":"x","text":"Sunrise","kind":"original","language":"en","script":"Latn"}'::jsonb,
        0.75, 'b', '{"titleMatch":0.6,"signals":[],"reputation":0}'::jsonb,
        '{"registrableDomain":"","confirmedViolations":0,"bonus":0,"blocklisted":false}'::jsonb,
        $7, $7, $7, $7)
     returning id`,
    [
      input.titleId ?? world.titleId,
      input.url,
      `${host}${new URL(input.url).pathname}`,
      host,
      host.split(".").slice(-2).join("."),
      world.originalVariantId,
      FROZEN,
    ],
  );
  return result.rows[0].id;
}

async function seedEvidence(
  pool: Pool,
  input: { url: string; outcome?: "captured" | "dead"; observedAt?: string },
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
      input.outcome ?? "captured",
      input.outcome === "dead" ? 404 : 200,
      input.outcome === "dead" ? "http_404" : null,
      input.observedAt ?? FROZEN,
    ],
  );
  await pool.query(
    `insert into evidence_artifacts (evidence_id, kind, sha256, size_bytes, content_type, object_version)
     values ($1, 'thumbnail', $2, 5000, 'image/jpeg', 'v-test-1')`,
    [result.rows[0].id, "b".repeat(64)],
  );
  return result.rows[0].id;
}

describe("the violations surface", () => {
  let appWorld: CeremonyApp;
  let admin: SignedInOperator;
  let pool: Pool;
  let clock: ReturnType<typeof controlledClock>;

  beforeEach(async () => {
    if (pool === undefined) {
      pool = testPool();
    }
    await truncateDomainTables(pool);
    clock = controlledClock(FROZEN_NOW);
    appWorld = {
      app: await buildApp({
        config: testConfig({ now: clock.now }),
        pool,
        mail: new MemoryMailTransport(),
        schemaStamp: poolSchemaStamp(pool),
        captureDispatch: async () => undefined,
      }),
      pool,
      mail: new MemoryMailTransport(),
      clock,
    };
    admin = await signedInAdministrator(appWorld);
  });

  afterAll(async () => {
    if (pool !== undefined) {
      await pool.end();
    }
  });

  /** Confirms one candidate over HTTP and returns the created violation. */
  async function confirm(
    world: Awaited<ReturnType<typeof seedWorld>>,
    url: string,
    evidenceId?: string,
  ): Promise<{ violationId: string; candidateId: string }> {
    const candidateId = await seedCandidate(pool, world, { url });
    const evidence =
      evidenceId ?? (await seedEvidence(pool, { url, observedAt: FROZEN }));
    const response = await appWorld.app.inject({
      method: "POST",
      url: `/api/candidates/${candidateId}/review-decisions`,
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: { action: "violation", evidenceIds: [evidence] },
    });
    expect(response.statusCode).toBe(201);
    return { violationId: response.json().violation.id, candidateId };
  }

  it("closes an open violation with a note; the closure is terminal", async () => {
    const world = await seedWorld(pool);
    const { violationId } = await confirm(world, "https://close.example.test/film");

    const missingNote = await appWorld.app.inject({
      method: "POST",
      url: `/api/violations/${violationId}/closure`,
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: { reason: "operator_closed" },
    });
    expect(missingNote.statusCode).toBe(422);
    expect(missingNote.json().code).toBe("note_required");

    const closed = await appWorld.app.inject({
      method: "POST",
      url: `/api/violations/${violationId}/closure`,
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: { reason: "operator_closed", note: "re-checked; the page is licensed now" },
    });
    expect(closed.statusCode).toBe(200);
    expect(getValidator("Violation")(closed.json())).toBe(true);
    expect(closed.json().lifecycle).toMatchObject({
      state: "closed",
      reason: "operator_closed",
      closedBy: admin.operatorId,
      note: "re-checked; the page is licensed now",
    });

    const again = await appWorld.app.inject({
      method: "POST",
      url: `/api/violations/${violationId}/closure`,
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: { reason: "operator_closed", note: "twice" },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe("state_conflict");
    expect(again.json().currentState).toBe("closed");
  });

  it("records a removal the operator filed, with the capture that showed it", async () => {
    const world = await seedWorld(pool);
    const url = "https://removed.example.test/film";
    const evidenceId = await seedEvidence(pool, { url });
    const { violationId } = await confirm(world, url, evidenceId);
    // A later capture shows the URL gone.
    const deadEvidence = await seedEvidence(pool, { url, outcome: "dead" });

    const removed = await appWorld.app.inject({
      method: "POST",
      url: `/api/violations/${violationId}/closure`,
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: { reason: "url_removed", evidenceId: deadEvidence },
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json().lifecycle).toMatchObject({
      state: "removed",
      reason: "url_removed",
      closureEvidenceId: deadEvidence,
      closedBy: admin.operatorId,
    });
  });

  it("starts a new violation for a reappearing pair, linked to its predecessor", async () => {
    const world = await seedWorld(pool);
    const url = "https://reappear.example.test/film";
    const first = await confirm(world, url);
    // The first violation closes; the URL later reappears.
    const closed = await appWorld.app.inject({
      method: "POST",
      url: `/api/violations/${first.violationId}/closure`,
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: { reason: "operator_closed", note: "resolved" },
    });
    expect(closed.statusCode).toBe(200);

    // The same pair surfaces again: a NEW candidate row for the pair.
    const secondCandidate = await seedCandidate(pool, world, { url });
    expect(secondCandidate).not.toBe(first.candidateId);
    const evidenceId = await seedEvidence(pool, { url, observedAt: FROZEN });
    const response = await appWorld.app.inject({
      method: "POST",
      url: `/api/candidates/${secondCandidate}/review-decisions`,
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: { action: "violation", evidenceIds: [evidenceId] },
    });
    expect(response.statusCode).toBe(201);
    const second = response.json().violation;
    expect(second.lifecycle).toMatchObject({ state: "open" });
    expect(second.predecessorViolationId).toBe(first.violationId);

    // The closed record is untouched: still closed, never reopened.
    const pair = await pool.query(
      "select id, state from violations where normalized_url = $1 order by created_at",
      ["reappear.example.test/film"],
    );
    expect(pair.rows.map((row) => row.state)).toEqual(["closed", "open"]);
  });

  it("serves the list with its filters and the detail with its citations", async () => {
    const world = await seedWorld(pool);
    const first = await confirm(world, "https://list.example.test/one");
    // The clock advances a second so "newest first" has two distinct times.
    clock.advance(1_000);
    const second = await confirm(world, "https://list.example.test/two");
    // The newest capture of the second URL is dead: the detail flags it.
    await seedEvidence(pool, { url: "https://list.example.test/two", outcome: "dead" });
    await appWorld.app.inject({
      method: "POST",
      url: `/api/violations/${second.violationId}/closure`,
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: { reason: "operator_closed", note: "done" },
    });

    const list = await appWorld.app.inject({
      method: "GET",
      url: "/api/violations",
      headers: { cookie: admin.cookie },
    });
    expect(list.statusCode).toBe(200);
    expect(getValidator("ViolationPage")(list.json())).toBe(true);
    expect(list.json().total).toBe(2);
    // Newest first: the closed second confirmation leads.
    expect(list.json().items.map((row: { violation: { id: string } }) => row.violation.id)).toEqual([
      second.violationId,
      first.violationId,
    ]);
    expect(list.json().items[0]).toMatchObject({
      displayTitle: "Sunrise",
      releaseYear: 2024,
      titleType: "film",
    });

    const openOnly = await appWorld.app.inject({
      method: "GET",
      url: "/api/violations?state=open",
      headers: { cookie: admin.cookie },
    });
    expect(openOnly.json().items.map((row: { violation: { id: string } }) => row.violation.id)).toEqual([
      first.violationId,
    ]);

    const byTitle = await appWorld.app.inject({
      method: "GET",
      url: `/api/violations?trackedTitleId=${world.titleId}`,
      headers: { cookie: admin.cookie },
    });
    expect(byTitle.json().total).toBe(2);

    // The notice filter: empty until the notices slice exists.
    const byNotice = await appWorld.app.inject({
      method: "GET",
      url: "/api/violations?noticeId=018f4c8e-1c2a-7c3e-9b1f-2b6d9f0a3c99",
      headers: { cookie: admin.cookie },
    });
    expect(byNotice.json()).toMatchObject({ items: [], total: 0 });

    const detail = await appWorld.app.inject({
      method: "GET",
      url: `/api/violations/${first.violationId}`,
      headers: { cookie: admin.cookie },
    });
    expect(detail.statusCode).toBe(200);
    const detailBody = detail.json();
    expect(getValidator("ViolationDetail")(detailBody)).toBe(true);
    expect(detailBody.displayTitle).toBe("Sunrise");
    expect(detailBody.decision).toMatchObject({ action: "violation" });
    expect(detailBody.evidence).toHaveLength(1);
    expect(detailBody.evidence[0]).toMatchObject({ role: "detection" });
    expect(detailBody.evidence[0].evidence).toMatchObject({ outcome: "captured" });

    const missing = await appWorld.app.inject({
      method: "GET",
      url: "/api/violations/018f4c8e-1c2a-7c3e-9b1f-2b6d9f0a3c99",
      headers: { cookie: admin.cookie },
    });
    expect(missing.statusCode).toBe(404);
  });
});
