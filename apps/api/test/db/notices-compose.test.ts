import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { buildApp, poolSchemaStamp, testConfig, controlledClock } from "../test-app.js";
import { getValidator } from "../../src/plugins/validator.js";
import { MemoryMailTransport } from "../../src/mail/transport.js";
import {
  authHeaders,
  signedInAdministrator,
  FROZEN_NOW,
  type CeremonyApp,
  type SignedInOperator,
} from "./ceremony.js";
import { testPool, truncateDomainTables } from "./helpers.js";

/**
 * The notices surface over HTTP (Patrol.Http Notices, slice 6a): the draft
 * composer's seams — reservation, deduplication, the on-demand grouping
 * refusal, the scheduled window through the shared runner, statement and
 * template versioning, and the read models' shapes.
 */

const FROZEN = "2026-01-01T00:00:00.000Z";

interface World {
  operatorId: string;
  titleA: string;
  titleB: string;
  variantA: string;
  variantB: string;
}

async function seedTitle(
  pool: Pool,
  operatorId: string,
  name: string,
  year: number,
): Promise<{ titleId: string; variantId: string }> {
  const group = await pool.query<{ id: string }>(
    `insert into title_groups (name, locales) values ($1, '{en}') returning id`,
    [name],
  );
  const title = await pool.query<{ id: string }>(
    `insert into tracked_titles
       (title_group_id, release_year, title_type, runtime_minutes, source, entered_by, entered_at, updated_by, created_at, updated_at)
     values ($1, $2, 'film', 100, 'operator_knowledge', $3, $4, $3, $4, $4) returning id`,
    [group.rows[0].id, year, operatorId, FROZEN],
  );
  const variant = await pool.query<{ id: string }>(
    `insert into title_variants
       (tracked_title_id, text, normalized_text, kind, language, script, source, added_by, added_at)
     values ($1, $2, lower($2), 'original', 'en', 'Latn', 'operator_knowledge', $3, $4) returning id`,
    [title.rows[0].id, name, operatorId, FROZEN],
  );
  await pool.query("update tracked_titles set original_variant_id = $2 where id = $1", [
    title.rows[0].id,
    variant.rows[0].id,
  ]);
  return { titleId: title.rows[0].id, variantId: variant.rows[0].id };
}

/**
 * Seeds one OPEN violation: a confirmed candidate, the confirming decision,
 * the violation row, and one pinned evidence citation.
 */
async function seedViolation(
  pool: Pool,
  world: World,
  input: {
    url: string;
    titleId?: string;
    variantId?: string;
    confirmedAt?: string;
  },
): Promise<string> {
  const host = new URL(input.url).hostname;
  const normalized = `${host}${new URL(input.url).pathname}`;
  const confirmedAt = input.confirmedAt ?? FROZEN;
  const candidate = await pool.query<{ id: string }>(
    `insert into candidates
       (tracked_title_id, url, normalized_url, host, registrable_domain, source, engine,
        engines, best_rank, matched_variant_id, matched_variant, score, band,
        score_components, reputation, first_seen_at, last_observed_at, state,
        review_decision_id, violation_id, confirmed_at, created_at, updated_at)
     values ($1, $2, $3, $4, $5, 'serp', 'google', '{google}', 1, $6,
        '{"id":"x","text":"v","kind":"original","language":"en","script":"Latn"}'::jsonb,
        0.75, 'b', '{"titleMatch":0.6,"signals":[],"reputation":0}'::jsonb,
        '{"registrableDomain":"","confirmedViolations":0,"bonus":0,"blocklisted":false}'::jsonb,
        $7, $7, 'pending', null, null, null, $7, $7)
     returning id`,
    [
      input.titleId ?? world.titleA,
      input.url,
      normalized,
      host,
      host.split(".").slice(-2).join("."),
      input.variantId ?? world.variantA,
      confirmedAt,
    ],
  );
  const capture = await pool.query<{ id: string }>(
    `insert into captures (requested_url, normalized_url, reason, point_key, state, requested_at, finished_at)
     values ($1, $2, 'detection', $3, 'done', $4, $4) returning id`,
    [input.url, normalized, `seed@${Math.random().toString(36).slice(2)}`, confirmedAt],
  );
  const evidence = await pool.query<{ id: string }>(
    `insert into evidence
       (capture_id, requested_url, normalized_url, final_url, host, host_source, reason,
        outcome, http_status, attempt_number, observed_at, capture_profile)
     values ($1, $2, $3, $2, $4, 'landing_page', 'detection', 'captured', 200, 1, $5,
        '{"userAgent":"patrol","viewportWidth":1280,"viewportHeight":720,"locale":"en","timezone":"UTC",
          "javascriptEnabled":true,"blockedResourceKinds":[],"navigationPolicy":"load","extractorVersion":"1"}'::jsonb)
     returning id`,
    [capture.rows[0].id, input.url, normalized, host, confirmedAt],
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
    [decisionId, candidate.rows[0].id, world.operatorId, confirmedAt, [evidence.rows[0].id], violationId],
  );
  await pool.query(
    `insert into violations
       (id, tracked_title_id, candidate_id, review_decision_id, url, normalized_url, host,
        host_source, registrable_domain, detected_at, confirmed_at, confirmed_by, state, opened_at,
        created_at)
     values ($1, $2, $3, $4, $5, $6, $7, 'landing_page', $8, $9, $9, $10, 'open', $9, $9)`,
    [
      violationId,
      input.titleId ?? world.titleA,
      candidate.rows[0].id,
      decisionId,
      input.url,
      normalized,
      host,
      host.split(".").slice(-2).join("."),
      confirmedAt,
      world.operatorId,
    ],
  );
  await pool.query(
    `update candidates set state = 'confirmed', review_decision_id = $2, violation_id = $3,
        confirmed_at = $4 where id = $1`,
    [candidate.rows[0].id, decisionId, violationId, confirmedAt],
  );
  await pool.query(
    `insert into violation_evidence (violation_id, evidence_id, role, cited_at, pinned_versions)
     values ($1, $2, 'detection', $3, '[]'::jsonb)`,
    [violationId, evidence.rows[0].id, confirmedAt],
  );
  return violationId;
}

async function seedWorld(pool: Pool): Promise<World> {
  // The bootstrap ceremony already created the singleton rights holder;
  // complete its contact and signatory profile in place.
  await pool.query(
    `insert into rights_holder (singleton, legal_name, country, address_line1, address_city,
        address_postal_code, role_mailbox, signatory_full_legal_name, signatory_authority_basis,
        signatory_contact_email)
     values (true, 'Example Rights GmbH', 'DE', '1 Example Street', 'Exampleville', '10001',
        'legal@example.test', 'Anna Beispiel', 'Copyright owner', 'signatory@example.test')
     on conflict (singleton) do update set
        address_line1 = excluded.address_line1,
        address_city = excluded.address_city,
        address_postal_code = excluded.address_postal_code,
        role_mailbox = excluded.role_mailbox,
        signatory_full_legal_name = excluded.signatory_full_legal_name,
        signatory_authority_basis = excluded.signatory_authority_basis,
        signatory_contact_email = excluded.signatory_contact_email`,
  );
  const operator = await pool.query<{ id: string }>(
    `insert into operators (email, password_hash, role, state, created_at, updated_at)
     values ('notices@example.test', 'x', 'operator', 'active', $1, $1)
     on conflict (email) do update set updated_at = excluded.updated_at
     returning id`,
    [FROZEN],
  );
  const operatorId = operator.rows[0].id;
  const a = await seedTitle(pool, operatorId, "Sunrise", 2024);
  const b = await seedTitle(pool, operatorId, "Moonlight", 2023);
  return { operatorId, titleA: a.titleId, titleB: b.titleId, variantA: a.variantId, variantB: b.variantId };
}

/** The three seeded profiles, keyed by recipient, with their eligibility facts set. */
async function profiles(
  pool: Pool,
): Promise<Map<"google" | "bing" | "yandex", { id: string }>> {
  const admin = await pool.query<{ id: string }>(
    `select id from operators where role = 'administrator' order by created_at asc limit 1`,
  );
  const updatedBy = admin.rows[0].id;
  const rows = (
    await pool.query<{ id: string; recipient: string }>(
      `insert into recipient_profiles (recipient, window_time, account, contact_email, eligible_territories, updated_by)
       values
         ('google', '07:00:00', 'noticeops@example.test', null, '{}', $1),
         ('bing', '07:00:00', '', 'legal@example.test', '{}', $1),
         ('yandex', '07:00:00', '', null, '{US,FR,CH}', $1)
       on conflict (recipient) do update set account = excluded.account, contact_email = excluded.contact_email,
         eligible_territories = excluded.eligible_territories
       returning id, recipient`,
      [updatedBy],
    )
  ).rows;
  return new Map(
    rows.map((row) => [row.recipient as "google" | "bing" | "yandex", { id: row.id }]),
  );
}

describe("the notices surface (slice 6a)", () => {
  let world: CeremonyApp;
  let admin: SignedInOperator;
  let pool: Pool;
  let clock: ReturnType<typeof controlledClock>;
  let seeded: World;

  beforeEach(async () => {
    if (pool === undefined) {
      pool = testPool();
    }
    await truncateDomainTables(pool);
    // The registry is reference data the truncate keeps; restore the seeded
    // baseline (as the approval suite does) so another file's verification
    // stamp or synthetic revision never leaks into this file's staleness
    // assertions — the suites share one database and run in a size-based
    // order, not a guaranteed one.
    await pool.query("delete from notice_templates where major > 1");
    await pool.query(
      "update notice_templates set accessed_at = $1, verified_at = null, verified_by = null, active = true",
      ["2026-11-04T00:00:00Z"],
    );
    clock = controlledClock(FROZEN_NOW);
    world = {
      app: await buildApp({
        config: testConfig({ now: clock.now }),
        pool,
        mail: new MemoryMailTransport(),
        schemaStamp: poolSchemaStamp(pool),
      }),
      pool,
      mail: new MemoryMailTransport(),
      clock,
    };
    admin = await (await import("./ceremony.js")).signedInAdministrator(world);
    seeded = await seedWorld(pool);
  });

  afterAll(async () => {
    if (pool !== undefined) {
      await pool.end();
    }
  });

  async function composeNotice(body: Record<string, unknown>) {
    return world.app.inject({
      method: "POST",
      url: "/api/notices",
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: body,
    });
  }

  it("composes an on-demand draft: content, statements, resolved fields, work identification", async () => {
    const byRecipient = await profiles(pool);
    const violation = await seedViolation(pool, seeded, { url: "https://pirate.net/sunrise-1" });
    const response = await composeNotice({
      recipient: "google",
      recipientProfileId: byRecipient.get("google")!.id,
      violationIds: [violation],
    });

    expect(response.statusCode).toBe(201);
    const detail = response.json();
    // The response validates against the emitted NoticeDetail schema.
    expect(getValidator("NoticeDetail")(detail)).toBe(true);

    expect(detail.notice.content.recipient).toBe("google");
    expect(detail.notice.content.citedViolations).toHaveLength(1);
    expect(detail.notice.content.citedViolations[0].violationId).toBe(violation);
    expect(detail.notice.content.citedViolations[0].evidence).toHaveLength(1);
    expect(detail.notice.content.workIdentifications).toEqual([
      {
        trackedTitleId: seeded.titleA,
        displayTitle: "Sunrise",
        releaseYear: 2024,
        titleType: "film",
      },
    ]);
    // Every statement carries the notice's template version (seam 8).
    expect(detail.notice.content.templateVersion).toBe("google-search.en.v1@ed9f34155836");
    for (const statement of detail.notice.content.statements) {
      expect(statement.templateVersion).toBe("google-search.en.v1@ed9f34155836");
    }
    expect(detail.notice.content.statements.map((s: { key: string }) => s.key)).toEqual([
      "good_faith_belief",
      "accuracy_perjury_authority",
    ]);
    // The resolved field map renders the rights holder and the signatory.
    const fields = detail.notice.content.resolvedFields as Array<{
      name: string;
      value: string;
    }>;
    expect(fields.find((field) => field.name === "copyright_owner")?.value).toBe(
      "Example Rights GmbH",
    );
    expect(fields.find((field) => field.name === "signature")?.value).toBe("Anna Beispiel");
    expect(detail.status).toBe("draft");
    expect(detail.packAvailable).toBe(false);
    expect(detail.template.version).toBe("google-search.en.v1@ed9f34155836");
    expect(detail.template.sourceUrls.length).toBeGreaterThan(0);
    expect(detail.template.accessedAt).toBe("2026-11-04T00:00:00.000Z");
    expect(detail.notice.lifecycle.state).toBe("draft");
    expect(detail.notice.createdBy).toBe(admin.operatorId);
  });

  it("refuses a draft with no violations and one citing a non-open violation", async () => {
    const byRecipient = await profiles(pool);
    const empty = await composeNotice({
      recipient: "google",
      recipientProfileId: byRecipient.get("google")!.id,
      violationIds: [],
    });
    expect(empty.statusCode).toBe(400);

    const violation = await seedViolation(pool, seeded, { url: "https://pirate.net/sunrise-2" });
    // The terminal state and its closure quartet move in one update — the
    // state CHECK refuses a half-closed row.
    await pool.query(
      `update violations set state = 'closed', closed_at = $2, closure_reason = 'operator_closed',
        closure_note = 'done', closed_by = $3 where id = $1`,
      [violation, FROZEN, seeded.operatorId],
    );
    const closed = await composeNotice({
      recipient: "google",
      recipientProfileId: byRecipient.get("google")!.id,
      violationIds: [violation],
    });
    expect(closed.statusCode).toBe(409);
    expect(closed.json().code).toBe("state_conflict");
    expect(closed.json().currentState).toBe("closed");
  });

  it("refuses an over-cap and a wrong-cardinality on-demand batch (grouping_limit_exceeded)", async () => {
    const byRecipient = await profiles(pool);
    // Google: 501 distinct URLs at the default cap of 500.
    const googleIds: string[] = [];
    for (let index = 0; index < 501; index += 1) {
      googleIds.push(
        await seedViolation(pool, seeded, { url: `https://pirate.net/g/${index}` }),
      );
    }
    const overCap = await composeNotice({
      recipient: "google",
      recipientProfileId: byRecipient.get("google")!.id,
      violationIds: googleIds,
    });
    expect(overCap.statusCode).toBe(422);
    expect(overCap.json().code).toBe("grouping_limit_exceeded");

    // Bing: two titles in one request is a wrong cardinality, not a split.
    const bingA = await seedViolation(pool, seeded, {
      url: "https://pirate.net/b/a",
      titleId: seeded.titleA,
      variantId: seeded.variantA,
    });
    const bingB = await seedViolation(pool, seeded, {
      url: "https://pirate.net/b/b",
      titleId: seeded.titleB,
      variantId: seeded.variantB,
    });
    const bing = await composeNotice({
      recipient: "bing",
      recipientProfileId: byRecipient.get("bing")!.id,
      violationIds: [bingA, bingB],
    });
    expect(bing.statusCode).toBe(422);
    expect(bing.json().code).toBe("grouping_limit_exceeded");

    // Yandex: one violation per notice (an eligible profile — the
    // territory gate has its own test below).
    await pool.query(
      "update recipient_profiles set eligible_territories = '{}' where recipient = 'yandex'",
    );
    const y1 = await seedViolation(pool, seeded, { url: "https://pirate.net/y/1" });
    const y2 = await seedViolation(pool, seeded, { url: "https://pirate.net/y/2" });
    const yandex = await composeNotice({
      recipient: "yandex",
      recipientProfileId: byRecipient.get("yandex")!.id,
      violationIds: [y1, y2],
    });
    expect(yandex.statusCode).toBe(422);
    expect(yandex.json().code).toBe("grouping_limit_exceeded");
  });

  it("reserves violations: a second draft citing them is refused with the conflict's evidence", async () => {
    const byRecipient = await profiles(pool);
    const violation = await seedViolation(pool, seeded, { url: "https://pirate.net/reserved-1" });
    const first = await composeNotice({
      recipient: "google",
      recipientProfileId: byRecipient.get("google")!.id,
      violationIds: [violation],
    });
    expect(first.statusCode).toBe(201);
    const existingNoticeId = first.json().notice.id;

    // Another profile, same recipient-side violation: reserved regardless
    // (the bing profile is eligible; the reservation crosses profiles).
    const second = await composeNotice({
      recipient: "bing",
      recipientProfileId: byRecipient.get("bing")!.id,
      violationIds: [violation],
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().code).toBe("violation_reserved");
    expect(second.json().conflictingViolationIds).toEqual([violation]);
    expect(second.json().existingNoticeId).toBe(existingNoticeId);
  });

  it("deduplicates: the same profile, URL, and title refuse until the first notice is out of the way", async () => {
    const byRecipient = await profiles(pool);
    const violation = await seedViolation(pool, seeded, { url: "https://pirate.net/dup-1" });
    const first = await composeNotice({
      recipient: "google",
      recipientProfileId: byRecipient.get("google")!.id,
      violationIds: [violation],
    });
    expect(first.statusCode).toBe(201);

    // The same VIOLATION simply answers violation_reserved (the reservation
    // is the first refusal); the pair-level dedup fires for a DIFFERENT
    // violation of the same (profile, URL, title) — a reappearance after
    // the first notice's violation closed while the notice still stands.
    const reservedAgain = await composeNotice({
      recipient: "google",
      recipientProfileId: byRecipient.get("google")!.id,
      violationIds: [violation],
    });
    expect(reservedAgain.statusCode).toBe(409);
    expect(reservedAgain.json().code).toBe("violation_reserved");

    await pool.query(
      `update violations set state = 'removed', closed_at = $2, closure_reason = 'url_removed',
        closure_evidence_id = null where id = $1`,
      [violation, FROZEN],
    );
    const reappearance = await seedViolation(pool, seeded, {
      url: "https://pirate.net/dup-1",
    });
    const duplicate = await composeNotice({
      recipient: "google",
      recipientProfileId: byRecipient.get("google")!.id,
      violationIds: [reappearance],
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().code).toBe("duplicate_entity");
    expect(duplicate.json().existingNoticeId).toBe(first.json().notice.id);

    // Withdraw the first notice (6b's endpoint; the state change is the
    // release) and the pair composes again.
    await pool.query(
      `update notices set state = 'withdrawn', withdrawn_by = $2, withdrawn_at = $3 where id = $1`,
      [first.json().notice.id, admin.operatorId, FROZEN],
    );
    await pool.query(
      `update notice_citations set state = 'withdrawn' where notice_id = $1`,
      [first.json().notice.id],
    );
    const again = await composeNotice({
      recipient: "google",
      recipientProfileId: byRecipient.get("google")!.id,
      violationIds: [reappearance],
    });
    expect(again.statusCode).toBe(201);
  });

  it("refuses an ineligible recipient and a mismatched profile", async () => {
    const byRecipient = await profiles(pool);
    // The rights holder is DE; the seeded Yandex profile allows US/FR/CH.
    const violation = await seedViolation(pool, seeded, { url: "https://pirate.net/y-ineligible" });
    const ineligible = await composeNotice({
      recipient: "yandex",
      recipientProfileId: byRecipient.get("yandex")!.id,
      violationIds: [violation],
    });
    expect(ineligible.statusCode).toBe(422);
    expect(ineligible.json().code).toBe("recipient_ineligible");

    // The google profile for a bing request is a mismatch: the request's
    // two fields disagree with each other, so validation answers.
    const mismatch = await composeNotice({
      recipient: "bing",
      recipientProfileId: byRecipient.get("google")!.id,
      violationIds: [violation],
    });
    expect(mismatch.statusCode).toBe(400);
    expect(mismatch.json().code).toBe("validation_failed");

    const absent = await composeNotice({
      recipient: "google",
      recipientProfileId: "00000000-0000-7000-8000-000000000000",
      violationIds: [violation],
    });
    expect(absent.statusCode).toBe(404);
  });

  it("respects the profile's lowered Google cap (seam 10)", async () => {
    const byRecipient = await profiles(pool);
    await pool.query(
      "update recipient_profiles set last_observed_max_urls_per_file = 3 where recipient = 'google'",
    );
    const ids: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      ids.push(await seedViolation(pool, seeded, { url: `https://pirate.net/cap/${index}` }));
    }
    const response = await composeNotice({
      recipient: "google",
      recipientProfileId: byRecipient.get("google")!.id,
      violationIds: ids,
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().code).toBe("grouping_limit_exceeded");

    // Three fit the discovered cap.
    const fits = await composeNotice({
      recipient: "google",
      recipientProfileId: byRecipient.get("google")!.id,
      violationIds: ids.slice(0, 3),
    });
    expect(fits.statusCode).toBe(201);
  });

  it("refuses a per-statement template version that differs from the notice's", async () => {
    const byRecipient = await profiles(pool);
    const violation = await seedViolation(pool, seeded, { url: "https://pirate.net/version-1" });
    const composed = await composeNotice({
      recipient: "google",
      recipientProfileId: byRecipient.get("google")!.id,
      violationIds: [violation],
    });
    const noticeId = composed.json().notice.id;
    await expect(
      pool.query(
        `insert into notice_statements (notice_id, position, key, text, template_version)
         values ($1, 99, 'smuggled', 'text', 'bing.en.v1@e36eaf64fd3c')`,
        [noticeId],
      ),
    ).rejects.toThrow(/template version/i);
  });

  it("lists notices with filters and reads one by id (the read models)", async () => {
    const byRecipient = await profiles(pool);
    const violation = await seedViolation(pool, seeded, { url: "https://pirate.net/list-1" });
    const composed = await composeNotice({
      recipient: "google",
      recipientProfileId: byRecipient.get("google")!.id,
      violationIds: [violation],
    });
    const noticeId = composed.json().notice.id;

    const list = await world.app.inject({
      method: "GET",
      url: "/api/notices",
      headers: { cookie: admin.cookie },
    });
    expect(list.statusCode).toBe(200);
    const page = list.json();
    expect(getValidator("NoticePage")(page)).toBe(true);
    expect(page.total).toBe(1);
    expect(page.items[0]).toMatchObject({
      id: noticeId,
      recipient: "google",
      violationCount: 1,
      status: "draft",
      packAvailable: false,
    });
    expect(page.items[0].signatoryName).toBeUndefined();

    const filtered = await world.app.inject({
      method: "GET",
      url: "/api/notices?recipient=yandex",
      headers: { cookie: admin.cookie },
    });
    expect(filtered.json().total).toBe(0);

    const stateFiltered = await world.app.inject({
      method: "GET",
      url: "/api/notices?state=draft",
      headers: { cookie: admin.cookie },
    });
    expect(stateFiltered.json().total).toBe(1);

    const detail = await world.app.inject({
      method: "GET",
      url: `/api/notices/${noticeId}`,
      headers: { cookie: admin.cookie },
    });
    expect(detail.statusCode).toBe(200);
    expect(getValidator("NoticeDetail")(detail.json())).toBe(true);

    const missing = await world.app.inject({
      method: "GET",
      url: "/api/notices/00000000-0000-7000-8000-000000000000",
      headers: { cookie: admin.cookie },
    });
    expect(missing.statusCode).toBe(404);
  });

  it("flags a stale template: a newer major revision, and a ninety-day-old access", async () => {
    const byRecipient = await profiles(pool);
    const violation = await seedViolation(pool, seeded, { url: "https://pirate.net/stale-1" });
    const composed = await composeNotice({
      recipient: "google",
      recipientProfileId: byRecipient.get("google")!.id,
      violationIds: [violation],
    });
    const noticeId = composed.json().notice.id;

    // The baseline: the seeded set was accessed 2026-11-04 and the clock
    // stands at 2026-01-01 — the ninety-day window has not passed and no
    // newer revision exists, so the summary is fresh.
    const fresh = await world.app.inject({
      method: "GET",
      url: `/api/notices/${noticeId}`,
      headers: { cookie: admin.cookie },
    });
    expect(fresh.json().template.stale).toBe(false);

    // Branch one: a newer major revision of the same recipient and
    // language exists — the composed-under set is stale even though its
    // own access is recent.
    await pool.query(
      `insert into notice_templates
         (identifier, recipient, language, major, hash12, statements, fields, source_urls, accessed_at)
       values ('google-search.en.v2@a1b2c3d4e5f6', 'google', 'en', 2, 'a1b2c3d4e5f6',
         '[{"key":"good_faith_belief","text":"The revised text."}]'::jsonb,
         '[{"name":"signature","label":"Signature","required":true}]'::jsonb,
         ARRAY['https://support.google.com/legal/answer/3463239?hl=en'],
         '2026-11-04T00:00:00Z')`,
    );
    const newerMajor = await world.app.inject({
      method: "GET",
      url: `/api/notices/${noticeId}`,
      headers: { cookie: admin.cookie },
    });
    expect(newerMajor.json().template.stale).toBe(true);

    // Branch two: no newer revision, but the set's last read is older than
    // ninety days against the request's clock.
    await pool.query("delete from notice_templates where major = 2");
    await pool.query(
      "update notice_templates set accessed_at = $1 where major = 1 and recipient = 'google'",
      ["2025-06-01T00:00:00Z"],
    );
    const aged = await world.app.inject({
      method: "GET",
      url: `/api/notices/${noticeId}`,
      headers: { cookie: admin.cookie },
    });
    expect(aged.json().template.stale).toBe(true);

    // The registry is reference data the suites never truncate — restore
    // the seeded access date so later files see the migrated baseline.
    await pool.query(
      "update notice_templates set accessed_at = $1 where major = 1",
      ["2026-11-04T00:00:00Z"],
    );
  });
});
