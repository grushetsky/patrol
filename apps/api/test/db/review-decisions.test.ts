import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { buildApp, poolSchemaStamp, testConfig, controlledClock } from "../test-app.js";
import { getValidator } from "../../src/plugins/validator.js";
import { MemoryMailTransport } from "../../src/mail/transport.js";
import { authHeaders, signedInAdministrator, FROZEN_NOW, type CeremonyApp, type SignedInOperator } from "./ceremony.js";
import { testPool, truncateDomainTables } from "./helpers.js";

/**
 * Seams 1, 2, 3, 4, and 6 over HTTP (Patrol.Http Candidates "decide"): the
 * confirm happy path with its violation and pinned citations; the guards
 * (allowlist hit, missing captured evidence, wrong work without a title);
 * the four dismissals with the pair-scoped Dismissal; the queue's
 * prior-decision flag; one confirm per pair — a second decision conflicts
 * and concurrent confirms leave exactly one winner; a multi-title page
 * yields one violation per title sharing one capture.
 */

const FROZEN = "2026-01-01T00:00:00.000Z";

/** The world the review decisions need: an operator, a group, titles. */
async function seedWorld(
  pool: Pool,
  options: { secondTitle?: boolean } = {},
): Promise<{
  operatorId: string;
  groupId: string;
  titleId: string;
  secondTitleId: string | null;
  originalVariantId: string;
  secondOriginalVariantId: string | null;
}> {
  await pool.query(
    `insert into rights_holder (singleton, legal_name, country)
     values (true, 'Example Rights GmbH', 'DE')
     on conflict (singleton) do nothing`,
  );
  const operator = await pool.query<{ id: string }>(
    `insert into operators (email, password_hash, role, state, created_at, updated_at)
     values ('review@example.test', 'x', 'operator', 'active', $1, $1)
     on conflict (email) do update set updated_at = excluded.updated_at
     returning id`,
    [FROZEN],
  );
  const operatorId = operator.rows[0].id;
  const group = await pool.query<{ id: string }>(
    `insert into title_groups (name, locales) values ('Films', '{en}') returning id`,
  );
  const groupId = group.rows[0].id;

  const seedTitle = async (text: string): Promise<{ titleId: string; variantId: string }> => {
    const title = await pool.query<{ id: string }>(
      `insert into tracked_titles
         (title_group_id, release_year, title_type, runtime_minutes, source, entered_by, entered_at, updated_by, created_at, updated_at)
       values ($1, 2024, 'film', 100, 'operator_knowledge', $2, $3, $2, $3, $3) returning id`,
      [groupId, operatorId, FROZEN],
    );
    const variant = await pool.query<{ id: string }>(
      `insert into title_variants
         (tracked_title_id, text, normalized_text, kind, language, script, source, added_by, added_at)
       values ($1, $2, lower($2), 'original', 'en', 'Latn', 'operator_knowledge', $3, $4) returning id`,
      [title.rows[0].id, text, operatorId, FROZEN],
    );
    await pool.query(
      "update tracked_titles set original_variant_id = $2 where id = $1",
      [title.rows[0].id, variant.rows[0].id],
    );
    return { titleId: title.rows[0].id, variantId: variant.rows[0].id };
  };

  const first = await seedTitle("Sunrise");
  const second = options.secondTitle === true ? await seedTitle("Sunset") : null;
  return {
    operatorId,
    groupId,
    titleId: first.titleId,
    originalVariantId: first.variantId,
    secondTitleId: second?.titleId ?? null,
    secondOriginalVariantId: second?.variantId ?? null,
  };
}

/** One candidate row seeded directly, pending unless told otherwise. */
async function seedCandidate(
  pool: Pool,
  world: Awaited<ReturnType<typeof seedWorld>>,
  input: {
    url: string;
    titleId?: string;
    variantId?: string;
    score?: number;
    allowlistEntryId?: string | null;
  },
): Promise<string> {
  const host = new URL(input.url).hostname;
  const result = await pool.query<{ id: string }>(
    `insert into candidates
       (tracked_title_id, url, normalized_url, host, registrable_domain, source, engine,
        engines, best_rank, matched_variant_id, matched_variant, score, band,
        score_components, reputation, allowlist_entry_id, allowlist_kind,
        first_seen_at, last_observed_at, created_at, updated_at)
     values ($1, $2, $3, $4, $5, 'serp', 'google', '{google}', 1, $6, $7::jsonb, $8, 'b',
        '{"titleMatch":0.6,"signals":[],"reputation":0}'::jsonb,
        '{"registrableDomain":"","confirmedViolations":0,"bonus":0,"blocklisted":false}'::jsonb,
        $9, null, $10, $10, $10, $10)
     returning id`,
    [
      input.titleId ?? world.titleId,
      input.url,
      `${host}${new URL(input.url).pathname}`,
      host,
      host.split(".").slice(-2).join("."),
      input.variantId ?? world.originalVariantId,
      JSON.stringify({
        id: input.variantId ?? world.originalVariantId,
        text: "Sunrise",
        kind: "original",
        language: "en",
        script: "Latn",
      }),
      input.score ?? 0.75,
      input.allowlistEntryId ?? null,
      FROZEN,
    ],
  );
  return result.rows[0].id;
}

/** One evidence row with a versioned artifact, as a capture leaves it. */
async function seedEvidence(
  pool: Pool,
  input: {
    url: string;
    outcome?: "captured" | "dead";
    observedAt?: string;
    host?: string | null;
    reason?: "detection" | "review" | "pre_handoff";
    objectVersion?: string | null;
  },
): Promise<string> {
  const host = new URL(input.url).hostname;
  const normalized = `${host}${new URL(input.url).pathname}`;
  const capture = await pool.query<{ id: string }>(
    `insert into captures (requested_url, normalized_url, reason, point_key, state, requested_at, finished_at)
     values ($1, $2, 'detection', $3, 'done', $4, $4) returning id`,
    [input.url, normalized, `seed@${Math.random().toString(36).slice(2)}`, input.observedAt ?? FROZEN],
  );
  const evidence = await pool.query<{ id: string }>(
    `insert into evidence
       (capture_id, requested_url, normalized_url, final_url, host, host_source, reason,
        outcome, http_status, failure_reason, attempt_number, observed_at, capture_profile)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 1, $11,
        '{"userAgent":"patrol","viewportWidth":1280,"viewportHeight":720,"locale":"en","timezone":"UTC",
          "javascriptEnabled":true,"blockedResourceKinds":[],"navigationPolicy":"load","extractorVersion":"1"}'::jsonb)
     returning id`,
    [
      capture.rows[0].id,
      input.url,
      normalized,
      input.outcome === "dead" ? null : `https://${input.host ?? host}/`,
      input.outcome === "dead" ? null : (input.host ?? host),
      input.outcome === "dead" ? null : "landing_page",
      input.reason ?? "detection",
      input.outcome ?? "captured",
      input.outcome === "dead" ? 404 : 200,
      input.outcome === "dead" ? "http_404" : null,
      input.observedAt ?? "2026-01-01T00:00:00.000Z",
    ],
  );
  const id = evidence.rows[0].id;
  await pool.query(
    `insert into evidence_artifacts (evidence_id, kind, sha256, size_bytes, content_type, object_version)
     values
       ($1, 'extraction_sidecar', $2, 100, 'application/json', $3),
       ($1, 'thumbnail', $4, 5000, 'image/jpeg', $3)`,
    [
      id,
      "a".repeat(64),
      input.objectVersion ?? "v-test-1",
      "b".repeat(64),
    ],
  );
  return id;
}

describe("review decisions", () => {
  let appWorld: CeremonyApp;
  let admin: SignedInOperator;
  let pool: Pool;

  beforeEach(async () => {
    if (pool === undefined) {
      pool = testPool();
    }
    await truncateDomainTables(pool);
    appWorld = {
      app: await buildApp({
        config: testConfig({ now: controlledClock(FROZEN_NOW).now }),
        pool,
        mail: new MemoryMailTransport(),
        schemaStamp: poolSchemaStamp(pool),
        captureDispatch: async () => undefined,
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

  it("confirms a pending candidate: a decision, an open violation, and a pinned citation", async () => {
    const world = await seedWorld(pool);
    const url = "https://mirror.example.test/films/sunrise";
    const candidateId = await seedCandidate(pool, world, { url });
    // The landing host a redirect recorded differs from the submitted host:
    // the violation's host is the landing page's.
    const evidenceId = await seedEvidence(pool, {
      url,
      host: "landing.stream.example.test",
      observedAt: FROZEN,
    });

    const response = await appWorld.app.inject({
      method: "POST",
      url: `/api/candidates/${candidateId}/review-decisions`,
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: { action: "violation", evidenceIds: [evidenceId] },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    const validator = getValidator("ReviewDecisionResult");
    if (!validator(body)) {
      console.error(JSON.stringify(validator.errors, null, 2));
    }
    expect(validator(body)).toBe(true);
    expect(body.decision).toMatchObject({
      candidateId,
      action: "violation",
      operatorId: admin.operatorId,
      evidenceIds: [evidenceId],
      violationId: body.violation.id,
    });
    expect(body.violation).toMatchObject({
      trackedTitleId: world.titleId,
      candidateId,
      url,
      host: "landing.stream.example.test",
      hostSource: "landing_page",
      registrableDomain: "example.test",
      lifecycle: { state: "open" },
    });
    expect(body.candidate.lifecycle).toMatchObject({
      state: "confirmed",
      violationId: body.violation.id,
    });

    // The citation: one row, pinned to the artifact versions at citation.
    const citation = await pool.query(
      `select evidence_id, role, pinned_versions from violation_evidence where violation_id = $1`,
      [body.violation.id],
    );
    expect(citation.rows).toHaveLength(1);
    expect(citation.rows[0].evidence_id).toBe(evidenceId);
    expect(citation.rows[0].role).toBe("detection");
    expect(citation.rows[0].pinned_versions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "extraction_sidecar", objectVersion: "v-test-1" }),
      ]),
    );
  });

  it("refuses what the guards refuse: allowlist hit, missing captured evidence, wrong work without a title", async () => {
    const world = await seedWorld(pool);
    const allowlisted = await pool.query<{ id: string }>(
      `insert into allowlist_entries (kind, match_kind, value, scope, origin, confirmed_by, confirmed_at)
       values ('neutral_source', 'host', 'mirror.example.test', 'rights_holder', 'operator', $1, $2)
       returning id`,
      [world.operatorId, FROZEN],
    );
    const hitUrl = "https://mirror.example.test/allowed";
    const hitCandidate = await seedCandidate(pool, world, {
      url: hitUrl,
      allowlistEntryId: allowlisted.rows[0].id,
    });
    const hit = await appWorld.app.inject({
      method: "POST",
      url: `/api/candidates/${hitCandidate}/review-decisions`,
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: { action: "violation", evidenceIds: [await seedEvidence(pool, { url: hitUrl })] },
    });
    expect(hit.statusCode).toBe(409);
    expect(hit.json().code).toBe("allowlist_hit");
    const noDecision = await pool.query(
      "select count(*) as count from review_decisions where candidate_id = $1",
      [hitCandidate],
    );
    expect(Number(noDecision.rows[0].count)).toBe(0);

    // No captured evidence of the URL: only a dead capture stands.
    const deadUrl = "https://dead.example.test/gone";
    const deadCandidate = await seedCandidate(pool, world, { url: deadUrl });
    const deadEvidence = await seedEvidence(pool, { url: deadUrl, outcome: "dead" });
    const noCaptured = await appWorld.app.inject({
      method: "POST",
      url: `/api/candidates/${deadCandidate}/review-decisions`,
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: { action: "violation", evidenceIds: [deadEvidence] },
    });
    expect(noCaptured.statusCode).toBe(422);
    expect(noCaptured.json().code).toBe("evidence_required");

    // No evidence cited at all.
    const empty = await appWorld.app.inject({
      method: "POST",
      url: `/api/candidates/${deadCandidate}/review-decisions`,
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: { action: "page_dead", note: "gone", evidenceIds: [] },
    });
    expect(empty.statusCode).toBe(422);
    expect(empty.json().code).toBe("evidence_required");

    // Wrong work without the title it re-matches to.
    const wrongWorkUrl = "https://mirror.example.test/other-film";
    const wrongWorkCandidate = await seedCandidate(pool, world, { url: wrongWorkUrl });
    const wrongWorkEvidence = await seedEvidence(pool, { url: wrongWorkUrl });
    const wrongWork = await appWorld.app.inject({
      method: "POST",
      url: `/api/candidates/${wrongWorkCandidate}/review-decisions`,
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: { action: "wrong_work", note: "this is another film", evidenceIds: [wrongWorkEvidence] },
    });
    expect(wrongWork.statusCode).toBe(422);
    expect(wrongWork.json().code).toBe("wrong_work_requires_title");
  });

  it("dismisses through the other four actions, each with the pair-scoped Dismissal", async () => {
    const world = await seedWorld(pool, { secondTitle: true });
    const cases: Array<{
      action: "not_a_violation" | "wrong_work" | "authorized_here" | "page_dead";
      url: string;
      extra: Record<string, unknown>;
    }> = [
      { action: "not_a_violation", url: "https://mirror.example.test/clean", extra: {} },
      {
        action: "wrong_work",
        url: "https://mirror.example.test/other-film",
        // The second title always exists in this test's world.
        extra: { rematchedTrackedTitleId: world.secondTitleId! },
      },
      {
        action: "authorized_here",
        url: "https://licensed.example.test/partner",
        extra: {
          allowlistEntry: {
            kind: "licensed_destination",
            matchKind: "host",
            value: "licensed.example.test",
            scope: "tracked_title",
            trackedTitleId: world.titleId,
            territory: "DE",
          },
        },
      },
      { action: "page_dead", url: "https://gone.example.test/dead", extra: {} },
    ];

    for (const entry of cases) {
      const candidateId = await seedCandidate(pool, world, { url: entry.url });
      const evidenceId = await seedEvidence(pool, {
        url: entry.url,
        outcome: entry.action === "page_dead" ? "dead" : "captured",
      });
      const response = await appWorld.app.inject({
        method: "POST",
        url: `/api/candidates/${candidateId}/review-decisions`,
        headers: { "content-type": "application/json", ...authHeaders(admin) },
        payload: {
          action: entry.action,
          note: "dismissal note",
          evidenceIds: [evidenceId],
          ...entry.extra,
        },
      });
      expect(response.statusCode, entry.action).toBe(201);
      const body = response.json();
      expect(body.candidate.lifecycle.state).toBe("dismissed");
      const dismissal = body.candidate.lifecycle.dismissal;
      expect(dismissal).toMatchObject({
        action: entry.action,
        operatorId: admin.operatorId,
        note: "dismissal note",
        evidenceIds: [evidenceId],
      });
      if (entry.action === "wrong_work") {
        expect(dismissal.rematchedTrackedTitleId).toBe(world.secondTitleId);
      }
      if (entry.action === "authorized_here") {
        expect(body.allowlistEntry).toMatchObject({
          kind: "licensed_destination",
          value: "licensed.example.test",
          origin: "review_decision",
          proposedByDecisionId: body.decision.id,
        });
        const entryRow = await pool.query(
          "select origin, proposed_by_decision_id from allowlist_entries where id = $1",
          [body.allowlistEntry.id],
        );
        expect(entryRow.rows[0]).toMatchObject({
          origin: "review_decision",
          proposed_by_decision_id: body.decision.id,
        });
      }
    }

    // A dismissal without a note is refused: the note is the record.
    const noteless = await seedCandidate(pool, world, { url: "https://mirror.example.test/noteless" });
    const notelessEvidence = await seedEvidence(pool, { url: "https://mirror.example.test/noteless" });
    const refused = await appWorld.app.inject({
      method: "POST",
      url: `/api/candidates/${noteless}/review-decisions`,
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: { action: "not_a_violation", evidenceIds: [notelessEvidence] },
    });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().code).toBe("note_required");

    // Pair-scoped: dismissing (URL, title A) leaves (URL, title B) pending.
    const sharedUrl = "https://shared.example.test/both-films";
    const sharedEvidence = await seedEvidence(pool, { url: sharedUrl });
    const titleA = await seedCandidate(pool, world, { url: sharedUrl });
    const titleB = await seedCandidate(pool, world, {
      url: sharedUrl,
      titleId: world.secondTitleId!,
      variantId: world.secondOriginalVariantId!,
    });
    const dismissA = await appWorld.app.inject({
      method: "POST",
      url: `/api/candidates/${titleA}/review-decisions`,
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: { action: "not_a_violation", note: "clean", evidenceIds: [sharedEvidence] },
    });
    expect(dismissA.statusCode).toBe(201);
    const queue = await appWorld.app.inject({
      method: "GET",
      url: "/api/candidates?state=pending",
      headers: { cookie: admin.cookie },
    });
    const pendingIds = queue.json().items.map((row: { id: string }) => row.id);
    expect(pendingIds).toContain(titleB);
    expect(pendingIds).not.toContain(titleA);
  });

  it("confirms once per pair: a second decision conflicts, concurrent confirms leave one winner", async () => {
    const world = await seedWorld(pool);
    const url = "https://race.example.test/film";
    const candidateId = await seedCandidate(pool, world, { url });
    const evidenceId = await seedEvidence(pool, { url });

    const [first, second] = await Promise.all([
      appWorld.app.inject({
        method: "POST",
        url: `/api/candidates/${candidateId}/review-decisions`,
        headers: { "content-type": "application/json", ...authHeaders(admin) },
        payload: { action: "violation", evidenceIds: [evidenceId] },
      }),
      appWorld.app.inject({
        method: "POST",
        url: `/api/candidates/${candidateId}/review-decisions`,
        headers: { "content-type": "application/json", ...authHeaders(admin) },
        payload: { action: "violation", evidenceIds: [evidenceId] },
      }),
    ]);
    const statuses = [first.statusCode, second.statusCode].sort();
    expect(statuses).toEqual([201, 409]);
    const violations = await pool.query("select id from violations");
    expect(violations.rows).toHaveLength(1);

    const again = await appWorld.app.inject({
      method: "POST",
      url: `/api/candidates/${candidateId}/review-decisions`,
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: { action: "not_a_violation", note: "late", evidenceIds: [evidenceId] },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe("state_conflict");
    expect(again.json().currentState).toBe("confirmed");
  });

  it("carries the pair's decision history across its reappearance surfaces", async () => {
    const world = await seedWorld(pool);
    const url = "https://returning.example.test/film";
    const firstWave = await seedCandidate(pool, world, { url });
    const evidenceId = await seedEvidence(pool, { url });
    const confirmed = await appWorld.app.inject({
      method: "POST",
      url: `/api/candidates/${firstWave}/review-decisions`,
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: { action: "violation", evidenceIds: [evidenceId] },
    });
    expect(confirmed.statusCode).toBe(201);
    const violationId = confirmed.json().violation.id;

    // The wave ends terminally, and the URL reappears: the SERP forms the
    // pair's new pending surface (seeded here directly — formation's own
    // guard is covered in the worker suite).
    const closed = await appWorld.app.inject({
      method: "POST",
      url: `/api/violations/${violationId}/closure`,
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: { reason: "operator_closed", note: "taken down" },
    });
    expect(closed.statusCode).toBe(200);
    const reappearance = await seedCandidate(pool, world, { url, score: 0.5 });

    // The reappearance row carries the pair's prior decision — the history
    // belongs to (normalized URL, tracked title), not to one candidate row.
    const queue = await appWorld.app.inject({
      method: "GET",
      url: "/api/candidates?state=pending",
      headers: { cookie: admin.cookie },
    });
    expect(queue.statusCode).toBe(200);
    const row = queue.json().items.find((item: { id: string }) => item.id === reappearance);
    expect(row).toBeDefined();
    expect(row.priorDecision).toMatchObject({
      action: "violation",
      operatorId: admin.operatorId,
    });

    // And the detail's decision history is the pair's as well.
    const detail = await appWorld.app.inject({
      method: "GET",
      url: `/api/candidates/${reappearance}`,
      headers: { cookie: admin.cookie },
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().candidate.priorDecisionIds).toHaveLength(1);
    expect(detail.json().decisions).toHaveLength(1);
    expect(detail.json().decisions[0].action).toBe("violation");
  });

  it("records the operator reopen with its reason as a security event", async () => {
    const world = await seedWorld(pool);
    const url = "https://reopened.example.test/film";
    const candidateId = await seedCandidate(pool, world, { url });
    const evidenceId = await seedEvidence(pool, { url });
    const dismissed = await appWorld.app.inject({
      method: "POST",
      url: `/api/candidates/${candidateId}/review-decisions`,
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: { action: "not_a_violation", note: "clean page", evidenceIds: [evidenceId] },
    });
    expect(dismissed.statusCode).toBe(201);

    const reopened = await appWorld.app.inject({
      method: "POST",
      url: `/api/candidates/${candidateId}/reopen`,
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: { note: "a new capture shows a player iframe" },
    });
    expect(reopened.statusCode).toBe(200);
    expect(reopened.json().lifecycle).toMatchObject({ state: "pending" });

    // The overturn is audited: who reopened which pair, and why.
    const event = await pool.query<{ kind: string; operator_id: string; detail: Record<string, unknown> }>(
      "select kind, operator_id, detail from security_events where kind = 'candidate_reopened'",
    );
    expect(event.rows).toHaveLength(1);
    expect(event.rows[0].operator_id).toBe(admin.operatorId);
    expect(event.rows[0].detail).toMatchObject({
      candidateId,
      note: "a new capture shows a player iframe",
    });

    // A reopen of a pair that is not dismissed conflicts, and audits nothing.
    const again = await appWorld.app.inject({
      method: "POST",
      url: `/api/candidates/${candidateId}/reopen`,
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: {},
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe("state_conflict");
    const still = await pool.query(
      "select count(*) as count from security_events where kind = 'candidate_reopened'",
    );
    expect(Number(still.rows[0].count)).toBe(1);
  });

  it("refuses an authorized-here entry whose target contradicts its scope", async () => {
    const world = await seedWorld(pool);
    const url = "https://conflicted.example.test/partner";
    const candidateId = await seedCandidate(pool, world, { url });
    const evidenceId = await seedEvidence(pool, { url });
    const refused = await appWorld.app.inject({
      method: "POST",
      url: `/api/candidates/${candidateId}/review-decisions`,
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: {
        action: "authorized_here",
        note: "the partner page",
        evidenceIds: [evidenceId],
        allowlistEntry: {
          kind: "licensed_destination",
          matchKind: "host",
          value: "conflicted.example.test",
          scope: "tracked_title",
          trackedTitleId: world.titleId,
          // A title-group target on a tracked-title entry: contradicted,
          // never silently nulled.
          titleGroupId: world.groupId,
          territory: "DE",
        },
      },
    });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().code).toBe("validation_failed");
    const noDecision = await pool.query(
      "select count(*) as count from review_decisions where candidate_id = $1",
      [candidateId],
    );
    expect(Number(noDecision.rows[0].count)).toBe(0);
    const noEntry = await pool.query("select count(*) as count from allowlist_entries");
    expect(Number(noEntry.rows[0].count)).toBe(0);
  });

  it("gives a multi-title page one violation per title over one shared capture", async () => {
    const world = await seedWorld(pool, { secondTitle: true });
    const sharedUrl = "https://portal.example.test/watch/both";
    const sharedEvidence = await seedEvidence(pool, { url: sharedUrl });
    const sunrise = await seedCandidate(pool, world, { url: sharedUrl });
    const sunset = await seedCandidate(pool, world, {
      url: sharedUrl,
      titleId: world.secondTitleId!,
      variantId: world.secondOriginalVariantId!,
    });

    for (const candidateId of [sunrise, sunset]) {
      const response = await appWorld.app.inject({
        method: "POST",
        url: `/api/candidates/${candidateId}/review-decisions`,
        headers: { "content-type": "application/json", ...authHeaders(admin) },
        payload: { action: "violation", evidenceIds: [sharedEvidence] },
      });
      expect(response.statusCode).toBe(201);
    }
    const violations = await pool.query(
      "select id, tracked_title_id from violations order by tracked_title_id",
    );
    expect(violations.rows).toHaveLength(2);
    const citations = await pool.query(
      "select violation_id, evidence_id from violation_evidence",
    );
    expect(citations.rows).toHaveLength(2);
    // One capture, cited by both violations.
    expect(new Set(citations.rows.map((row) => row.evidence_id))).toEqual(
      new Set([sharedEvidence]),
    );
    // And the queue now names the prior decision on any row that still shows.
    const queue = await appWorld.app.inject({
      method: "GET",
      url: "/api/candidates",
      headers: { cookie: admin.cookie },
    });
    expect(getValidator("CandidatePage")(queue.json())).toBe(true);
    const withPrior = queue
      .json()
      .items.filter((row: { priorDecision?: unknown }) => row.priorDecision !== undefined);
    expect(withPrior).toHaveLength(2);
    expect(withPrior[0].priorDecision).toMatchObject({
      action: "violation",
      operatorId: admin.operatorId,
    });
  });
});
