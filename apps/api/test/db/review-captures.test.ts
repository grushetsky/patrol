import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { buildApp, poolSchemaStamp, testConfig, controlledClock } from "../test-app.js";
import { getValidator } from "../../src/plugins/validator.js";
import { MemoryMailTransport } from "../../src/mail/transport.js";
import { authHeaders, signedInAdministrator, FROZEN_NOW, type CeremonyApp, type SignedInOperator } from "./ceremony.js";
import { testPool, truncateDomainTables } from "./helpers.js";

/**
 * Seam 9 (the operator half of seam 5 lives here too) over HTTP: the
 * `review` capture point — an operator opening a pending pair whose newest
 * live capture is over 24 hours old queues a review capture; a fresh one
 * does not; a recorded decision queues one for the URL — and the on-demand
 * captures (POST /candidates/{id}/captures, POST /violations/{id}/captures)
 * answering 202, with the allowlist and objection refusals. The operator
 * reopen returns a dismissed pair to the queue.
 */

const FROZEN = "2026-01-01T00:00:00.000Z";

async function seedWorld(pool: Pool): Promise<{
  operatorId: string;
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
     values ('captures@example.test', 'x', 'operator', 'active', $1, $1)
     on conflict (email) do update set updated_at = excluded.updated_at
     returning id`,
    [FROZEN],
  );
  const group = await pool.query<{ id: string }>(
    `insert into title_groups (name, locales) values ('Films', '{en}') returning id`,
  );
  const title = await pool.query<{ id: string }>(
    `insert into tracked_titles
       (title_group_id, release_year, title_type, source, entered_by, entered_at, updated_by, created_at, updated_at)
     values ($1, 2024, 'film', 'operator_knowledge', $2, $3, $2, $3, $3) returning id`,
    [group.rows[0].id, operator.rows[0].id, FROZEN],
  );
  const variant = await pool.query<{ id: string }>(
    `insert into title_variants
       (tracked_title_id, text, normalized_text, kind, language, script, source, added_by, added_at)
     values ($1, 'Sunrise', 'sunrise', 'original', 'en', 'Latn', 'operator_knowledge', $2, $3) returning id`,
    [title.rows[0].id, operator.rows[0].id, FROZEN],
  );
  await pool.query(
    "update tracked_titles set original_variant_id = $2 where id = $1",
    [title.rows[0].id, variant.rows[0].id],
  );
  return { operatorId: operator.rows[0].id, titleId: title.rows[0].id, originalVariantId: variant.rows[0].id };
}

async function seedCandidate(
  pool: Pool,
  world: Awaited<ReturnType<typeof seedWorld>>,
  input: { url: string },
): Promise<string> {
  const host = new URL(input.url).hostname;
  const result = await pool.query<{ id: string }>(
    `insert into candidates
       (tracked_title_id, url, normalized_url, host, registrable_domain, source, engine,
        engines, best_rank, matched_variant_id, matched_variant, score, band,
        score_components, reputation, first_seen_at, last_observed_at, created_at, updated_at)
     values ($1, $2, $3, $4, $5, 'serp', 'google', '{google}', 1, $6,
        $7::jsonb,
        0.75, 'b', '{"titleMatch":0.6,"signals":[],"reputation":0}'::jsonb,
        '{"registrableDomain":"","confirmedViolations":0,"bonus":0,"blocklisted":false}'::jsonb,
        $8, $8, $8, $8)
     returning id`,
    [
      world.titleId,
      input.url,
      `${host}${new URL(input.url).pathname}`,
      host,
      host.split(".").slice(-2).join("."),
      world.originalVariantId,
      JSON.stringify({
        id: world.originalVariantId,
        text: "Sunrise",
        kind: "original",
        language: "en",
        script: "Latn",
      }),
      FROZEN,
    ],
  );
  return result.rows[0].id;
}

async function seedEvidence(
  pool: Pool,
  input: { url: string; observedAt?: string; outcome?: "captured" | "dead" },
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
     values ($1, $2, $3, $2, $4, 'landing_page', 'detection', $5, $6, $7, 1, $8,
        '{"userAgent":"patrol","viewportWidth":1280,"viewportHeight":720,"locale":"en","timezone":"UTC",
          "javascriptEnabled":true,"blockedResourceKinds":[],"navigationPolicy":"load","extractorVersion":"1"}'::jsonb)
     returning id`,
    [
      capture.rows[0].id,
      input.url,
      normalized,
      host,
      input.outcome ?? "captured",
      input.outcome === "dead" ? 404 : 200,
      input.outcome === "dead" ? "http_404" : null,
      input.observedAt ?? FROZEN,
    ],
  );
  return result.rows[0].id;
}

describe("review captures and the operator reopen", () => {
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

  it("queues a review capture when an operator opens a stale pending pair, not a fresh one", async () => {
    const world = await seedWorld(pool);
    const staleUrl = "https://stale.example.test/film";
    const staleCandidate = await seedCandidate(pool, world, { url: staleUrl });
    // Three days old at the frozen now: over the 24-hour review window.
    await seedEvidence(pool, { url: staleUrl, observedAt: "2025-12-29T00:00:00.000Z" });

    const detail = await appWorld.app.inject({
      method: "GET",
      url: `/api/candidates/${staleCandidate}`,
      headers: { cookie: admin.cookie },
    });
    expect(detail.statusCode).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const staleRows = await pool.query(
      "select reason, state from captures where requested_url = $1 and reason = 'review'",
      [staleUrl],
    );
    expect(staleRows.rows).toEqual([{ reason: "review", state: "pending" }]);
    expect(captureDispatches).toHaveLength(1);

    // Fresh: inside the window, the port's freshness answer stands.
    captureDispatches.length = 0;
    const freshUrl = "https://fresh.example.test/film";
    const freshCandidate = await seedCandidate(pool, world, { url: freshUrl });
    await seedEvidence(pool, { url: freshUrl, observedAt: FROZEN });
    const freshDetail = await appWorld.app.inject({
      method: "GET",
      url: `/api/candidates/${freshCandidate}`,
      headers: { cookie: admin.cookie },
    });
    expect(freshDetail.statusCode).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const freshRows = await pool.query(
      "select reason from captures where requested_url = $1 and reason = 'review'",
      [freshUrl],
    );
    expect(freshRows.rows).toEqual([]);
  });

  it("queues a review capture when a decision is recorded on a stale URL", async () => {
    const world = await seedWorld(pool);
    const url = "https://decide.example.test/film";
    const candidateId = await seedCandidate(pool, world, { url });
    const evidenceId = await seedEvidence(pool, {
      url,
      observedAt: "2025-12-29T00:00:00.000Z",
    });

    const response = await appWorld.app.inject({
      method: "POST",
      url: `/api/candidates/${candidateId}/review-decisions`,
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: { action: "violation", evidenceIds: [evidenceId] },
    });
    expect(response.statusCode).toBe(201);
    const rows = await pool.query(
      "select reason, state from captures where requested_url = $1 and reason = 'review'",
      [url],
    );
    expect(rows.rows).toEqual([{ reason: "review", state: "pending" }]);
  });

  it("answers 202 for on-demand captures of a candidate and a violation", async () => {
    const world = await seedWorld(pool);
    const url = "https://ondemand.example.test/film";
    const candidateId = await seedCandidate(pool, world, { url });
    const evidenceId = await seedEvidence(pool, {
      url,
      observedAt: "2025-12-01T00:00:00.000Z",
    });

    const candidateCapture = await appWorld.app.inject({
      method: "POST",
      url: `/api/candidates/${candidateId}/captures`,
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: { reason: "review" },
    });
    expect(candidateCapture.statusCode).toBe(202);
    expect(getValidator("CaptureQueued")(candidateCapture.json())).toBe(true);
    expect(candidateCapture.json()).toMatchObject({ reason: "review" });

    // A confirm creates the violation the second endpoint captures.
    const confirmed = await appWorld.app.inject({
      method: "POST",
      url: `/api/candidates/${candidateId}/review-decisions`,
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: { action: "violation", evidenceIds: [evidenceId] },
    });
    const violationId = confirmed.json().violation.id;
    const violationCapture = await appWorld.app.inject({
      method: "POST",
      url: `/api/violations/${violationId}/captures`,
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: { reason: "pre_handoff" },
    });
    expect(violationCapture.statusCode).toBe(202);
    expect(violationCapture.json()).toMatchObject({ reason: "pre_handoff" });

    const missing = await appWorld.app.inject({
      method: "POST",
      url: "/api/candidates/018f4c8e-1c2a-7c3e-9b1f-2b6d9f0a3c99/captures",
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: { reason: "review" },
    });
    expect(missing.statusCode).toBe(404);
  });

  it("refuses an allowlisted URL and an objected host for an on-demand capture", async () => {
    const world = await seedWorld(pool);
    const allowedUrl = "https://official.example.test/film";
    const allowlisted = await pool.query<{ id: string }>(
      `insert into allowlist_entries (kind, match_kind, value, scope, origin, confirmed_by, confirmed_at)
       values ('official_domain', 'host', 'official.example.test', 'rights_holder', 'operator', $1, $2)
       returning id`,
      [world.operatorId, FROZEN],
    );
    const allowCandidate = await seedCandidate(pool, world, { url: allowedUrl });
    await pool.query("update candidates set allowlist_entry_id = $2 where id = $1", [
      allowCandidate,
      allowlisted.rows[0].id,
    ]);
    const refused = await appWorld.app.inject({
      method: "POST",
      url: `/api/candidates/${allowCandidate}/captures`,
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: { reason: "review" },
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe("allowlist_hit");

    const objectedUrl = "https://objected.example.test/film";
    const objectCandidate = await seedCandidate(pool, world, { url: objectedUrl });
    const objection = await pool.query<{ id: string }>(
      `insert into host_objections (host, registrable_domain, source, reason, recorded_at, affected_candidate_count)
       values ('objected.example.test', 'example.test', 'operator', 'cease and desist', $1, 1)
       returning id`,
      [FROZEN],
    );
    const objected = await appWorld.app.inject({
      method: "POST",
      url: `/api/candidates/${objectCandidate}/captures`,
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: { reason: "review" },
    });
    expect(objected.statusCode).toBe(409);
    expect(objected.json()).toMatchObject({
      code: "host_objection",
      hostObjectionId: objection.rows[0].id,
    });
  });

  it("returns a dismissed pair to the queue on an operator reopen", async () => {
    const world = await seedWorld(pool);
    const url = "https://reopen.example.test/film";
    const candidateId = await seedCandidate(pool, world, { url });
    const evidenceId = await seedEvidence(pool, { url });

    const dismiss = await appWorld.app.inject({
      method: "POST",
      url: `/api/candidates/${candidateId}/review-decisions`,
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: { action: "not_a_violation", note: "licensed", evidenceIds: [evidenceId] },
    });
    expect(dismiss.statusCode).toBe(201);
    expect(dismiss.json().candidate.lifecycle.state).toBe("dismissed");

    const reopen = await appWorld.app.inject({
      method: "POST",
      url: `/api/candidates/${candidateId}/reopen`,
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: { note: "look again" },
    });
    expect(reopen.statusCode).toBe(200);
    expect(getValidator("Candidate")(reopen.json())).toBe(true);
    expect(reopen.json().lifecycle).toEqual({ state: "pending" });
    // The decision history stands: the pair's prior decisions name it.
    expect(reopen.json().priorDecisionIds).toEqual([dismiss.json().decision.id]);

    // A pending pair cannot be reopened again; a confirmed pair neither.
    const pendingAgain = await appWorld.app.inject({
      method: "POST",
      url: `/api/candidates/${candidateId}/reopen`,
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: {},
    });
    expect(pendingAgain.statusCode).toBe(409);

    const missing = await appWorld.app.inject({
      method: "POST",
      url: "/api/candidates/018f4c8e-1c2a-7c3e-9b1f-2b6d9f0a3c99/reopen",
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: {},
    });
    expect(missing.statusCode).toBe(404);
  });
});
