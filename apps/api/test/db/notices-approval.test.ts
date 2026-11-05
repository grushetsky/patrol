import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { buildApp, poolSchemaStamp, testConfig, controlledClock } from "../test-app.js";
import { getValidator } from "../../src/plugins/validator.js";
import { MemoryMailTransport } from "../../src/mail/transport.js";
import { createPendingSubmissionIfSettled } from "@patrol/notices";
import {
  authHeaders,
  inviteAndEnroll,
  signedInAdministrator,
  FROZEN_NOW,
  type CeremonyApp,
  type SignedInOperator,
} from "./ceremony.js";
import { testPool, truncateDomainTables } from "./helpers.js";
import {
  FakePackStore,
  profiles,
  seedNoticeWorld,
  seedViolation,
  type NoticeWorld,
} from "./notices-helpers.js";

/**
 * The approval seam over HTTP (Patrol.Http Notices `approve`, slice 6b): the
 * three gates (ninety days, a newer revision, no verified template), the
 * three attestations, the content freeze from LIVE rights-holder, signatory,
 * and profile reads, the second-operator first-five control, the pre-handoff
 * queueing for stale captures, the submission once they settle, the frozen
 * pack language, and the database triggers that hold "an approved notice
 * cannot be mutated".
 */

describe("notice approval (slice 6b)", () => {
  let world: CeremonyApp;
  let admin: SignedInOperator;
  let pool: Pool;
  let clock: ReturnType<typeof controlledClock>;
  let seeded: NoticeWorld;
  let store: FakePackStore;
  let dispatched: string[];

  beforeEach(async () => {
    if (pool === undefined) {
      pool = testPool();
    }
    await truncateDomainTables(pool);
    // The registry is reference data the truncate keeps; restore the seeded
    // baseline so one test's verification stamp or synthetic revision never
    // gates the next test's approval.
    await pool.query(
      "delete from notice_templates where major > 1",
    );
    await pool.query(
      "update notice_templates set accessed_at = $1, verified_at = null, verified_by = null, active = true",
      ["2026-11-04T00:00:00Z"],
    );
    clock = controlledClock(FROZEN_NOW);
    store = new FakePackStore();
    dispatched = [];
    const mail = new MemoryMailTransport();
    world = {
      app: await buildApp({
        config: testConfig({ now: clock.now }),
        pool,
        mail,
        schemaStamp: poolSchemaStamp(pool),
        captureDispatch: async (captureId) => {
          dispatched.push(captureId);
        },
        noticeStore: store,
      }),
      pool,
      mail,
      clock,
    };
    admin = await (await import("./ceremony.js")).signedInAdministrator(world);
    seeded = await seedNoticeWorld(pool, admin.operatorId);
  });

  afterAll(async () => {
    if (pool !== undefined) {
      await pool.end();
    }
  });

  async function composeDraft(
    url: string,
    options: { observedAt?: string; recipient?: "google" | "bing" | "yandex" } = {},
  ): Promise<{ noticeId: string; templateVersion: string; violationId: string }> {
    const byRecipient = await profiles(pool);
    const recipient = options.recipient ?? "google";
    const violationId = await seedViolation(pool, seeded, {
      url,
      observedAt: options.observedAt,
    });
    const response = await world.app.inject({
      method: "POST",
      url: "/api/notices",
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: {
        recipient,
        recipientProfileId: byRecipient.get(recipient)!.id,
        violationIds: [violationId],
      },
    });
    expect(response.statusCode).toBe(201);
    const detail = response.json();
    return {
      noticeId: detail.notice.id,
      templateVersion: detail.template.version,
      violationId,
    };
  }

  function approve(noticeId: string, templateVersion: string, attestations?: Record<string, unknown>) {
    return world.app.inject({
      method: "POST",
      url: `/api/notices/${noticeId}/approval`,
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: {
        statementVersion: templateVersion,
        attestation: attestations ?? {
          reviewedViolations: true,
          currentStatements: true,
          authorizedSignatory: true,
        },
      },
    });
  }

  it("approves a draft: freezes LIVE snapshots, recomputes the resolved content, stamps the verification, and creates the pending submission with its pack", async () => {
    const draft = await composeDraft("https://pirate.net/approve-1");

    // The rights holder changes BETWEEN composition and approval: the frozen
    // snapshot and the recomputed fields must carry the NEW live values.
    await pool.query(
      `update rights_holder set legal_name = 'Renamed GmbH',
          signatory_full_legal_name = 'Bernd Neu',
          signatory_contact_email = 'bernd@example.test'
        where singleton`,
    );
    await pool.query(
      `update recipient_profiles set version = version + 1, account = 'updated@example.test'
        where recipient = 'google'`,
    );

    const response = await approve(draft.noticeId, draft.templateVersion);
    expect(response.statusCode).toBe(200);
    const result = response.json();
    expect(getValidator("ApprovalResult")(result)).toBe(true);

    // The approved lifecycle carries the three snapshots from LIVE reads.
    expect(result.notice.lifecycle.state).toBe("approved");
    expect(result.notice.lifecycle.approvedBy).toBe(admin.operatorId);
    expect(result.notice.lifecycle.rightsHolder).toMatchObject({
      legalName: "Renamed GmbH",
      country: "DE",
      roleMailbox: "legal@example.test",
    });
    expect(result.notice.lifecycle.signatory).toMatchObject({
      fullLegalName: "Bernd Neu",
      authorityBasis: "Copyright owner",
    });
    expect(result.notice.lifecycle.profile).toMatchObject({
      account: "updated@example.test",
      version: expect.any(Number),
      channel: "web_form",
    });

    // The captures were fresh: nothing queued, the submission stands pending.
    // The submission ROW is all the approval settles to — the pack's bytes
    // are the API's to build on the first pack read, so nothing is stored
    // yet and the detail reports no pack.
    expect(result.queuedCaptures).toBe(0);
    expect(result.submission.lifecycle.state).toBe("pending");
    expect(result.submission.packLanguage).toBe("en");
    expect(result.status).toBe("approved");
    expect(store.putKeys).toHaveLength(0);

    // The resolved field map was recomputed from the live reads.
    const detail = await world.app.inject({
      method: "GET",
      url: `/api/notices/${draft.noticeId}`,
      headers: { cookie: admin.cookie },
    });
    const fields = detail.json().notice.content.resolvedFields as Array<{
      name: string;
      value: string;
    }>;
    expect(fields.find((field) => field.name === "copyright_owner")?.value).toBe("Renamed GmbH");
    expect(fields.find((field) => field.name === "signature")?.value).toBe("Bernd Neu");
    // The detail exposes the submission; the pack is not built yet.
    expect(detail.json().submission.lifecycle.state).toBe("pending");
    expect(detail.json().packAvailable).toBe(false);
    expect(getValidator("NoticeDetail")(detail.json())).toBe(true);

    // The currentStatements attestation stamped the template verification.
    const template = await pool.query<{ verified_by: string | null; verified_at: Date | null }>(
      "select verified_by, verified_at from notice_templates where identifier = $1",
      [draft.templateVersion],
    );
    expect(template.rows[0].verified_by).toBe(admin.operatorId);
    expect(template.rows[0].verified_at).not.toBeNull();

    // The first pack read builds the pack once, content-addressed.
    const pack = await world.app.inject({
      method: "GET",
      url: `/api/notices/${draft.noticeId}/pack`,
      headers: { cookie: admin.cookie },
    });
    expect(pack.statusCode).toBe(200);
    const packs = await pool.query<{ hash: string; files: unknown[] }>(
      "select hash, files from handoff_packs where notice_id = $1",
      [draft.noticeId],
    );
    expect(packs.rows).toHaveLength(1);
    expect(packs.rows[0].files.length).toBeGreaterThan(2);
    expect(store.has(packs.rows[0].hash)).toBe(false); // the pack hash names the manifest, not one object
    expect(store.putKeys.length).toBe(packs.rows[0].files.length);
    // With the pack standing, the detail reports it.
    const after = await world.app.inject({
      method: "GET",
      url: `/api/notices/${draft.noticeId}`,
      headers: { cookie: admin.cookie },
    });
    expect(after.json().packAvailable).toBe(true);
  });

  it("freezes the citations: a capture pinned after approval never changes what the notice claims", async () => {
    const draft = await composeDraft("https://pirate.net/freeze-1");
    const before = await world.app.inject({
      method: "GET",
      url: `/api/notices/${draft.noticeId}`,
      headers: { cookie: admin.cookie },
    });
    const pinnedBefore = before.json().notice.content.citedViolations[0]
      .evidence as Array<{ evidenceId: string }>;

    const response = await approve(draft.noticeId, draft.templateVersion);
    expect(response.statusCode).toBe(200);

    // A later capture of the same URL, pinned to the violation after the
    // approval: the approved notice keeps citing the captures it froze with.
    const later = await pool.query<{ id: string }>(
      `insert into captures (requested_url, normalized_url, reason, point_key, state, requested_at, finished_at)
       values ('https://pirate.net/freeze-1', 'pirate.net/freeze-1', 'pre_handoff', 'seed@late', 'done', $1, $1)
       returning id`,
      [FROZEN_NOW],
    );
    const laterEvidence = await pool.query<{ id: string }>(
      `insert into evidence
         (capture_id, requested_url, normalized_url, final_url, host, host_source, reason,
          outcome, http_status, attempt_number, observed_at, capture_profile)
       values ($1, 'https://pirate.net/freeze-1', 'pirate.net/freeze-1', 'https://pirate.net/freeze-1',
          'pirate.net', 'landing_page', 'pre_handoff', 'captured', 200, 1, $2,
          '{"userAgent":"patrol","viewportWidth":1280,"viewportHeight":720,"locale":"en","timezone":"UTC",
            "javascriptEnabled":true,"blockedResourceKinds":[],"navigationPolicy":"load","extractorVersion":"1"}'::jsonb)
       returning id`,
      [later.rows[0].id, FROZEN_NOW],
    );
    await pool.query(
      `insert into violation_evidence (violation_id, evidence_id, role, cited_at, pinned_versions)
       values ($1, $2, 'pre_handoff', $3, '[]'::jsonb)`,
      [draft.violationId, laterEvidence.rows[0].id, FROZEN_NOW],
    );

    const after = await world.app.inject({
      method: "GET",
      url: `/api/notices/${draft.noticeId}`,
      headers: { cookie: admin.cookie },
    });
    const pinnedAfter = after.json().notice.content.citedViolations[0]
      .evidence as Array<{ evidenceId: string }>;
    expect(pinnedAfter).toEqual(pinnedBefore);
  });

  it("refuses approval under a stale template, a newer revision, and an unverified set", async () => {
    const draft = await composeDraft("https://pirate.net/gate-1");

    // Ninety days: the set's last read (no operator verification yet) is
    // older than ninety days against the request's clock.
    await pool.query(
      "update notice_templates set accessed_at = $1 where recipient = 'google'",
      ["2025-06-01T00:00:00Z"],
    );
    const stale = await approve(draft.noticeId, draft.templateVersion);
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe("state_conflict");
    await pool.query(
      "update notice_templates set accessed_at = $1 where recipient = 'google'",
      ["2026-11-04T00:00:00Z"],
    );

    // A newer major revision of the same recipient and language exists.
    await pool.query(
      `insert into notice_templates
         (identifier, recipient, language, major, hash12, statements, fields, source_urls, accessed_at)
       values ('google-search.en.v2@a1b2c3d4e5f6', 'google', 'en', 2, 'a1b2c3d4e5f6',
         '[{"key":"good_faith_belief","text":"The revised text."}]'::jsonb,
         '[{"name":"signature","label":"Signature","required":true}]'::jsonb,
         ARRAY['https://support.google.com/legal/answer/3463239?hl=en'],
         '2026-11-04T00:00:00Z')`,
    );
    const supersededTemplate = await approve(draft.noticeId, draft.templateVersion);
    expect(supersededTemplate.statusCode).toBe(409);
    expect(supersededTemplate.json().code).toBe("state_conflict");
    await pool.query("delete from notice_templates where major = 2");

    // No verified template: the active set is withdrawn, so the recipient
    // and language have none.
    await pool.query("update notice_templates set active = false where recipient = 'google'");
    const unverified = await approve(draft.noticeId, draft.templateVersion);
    expect(unverified.statusCode).toBe(409);
    expect(unverified.json().code).toBe("state_conflict");
    await pool.query("update notice_templates set active = true where recipient = 'google'");

    // The gates stood down: the same approval now succeeds, and a second
    // approval of the frozen notice is a state conflict.
    const pass = await approve(draft.noticeId, draft.templateVersion);
    expect(pass.statusCode).toBe(200);
    const again = await approve(draft.noticeId, draft.templateVersion);
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe("state_conflict");
    expect(again.json().currentState).toBe("approved");
  });

  it("refuses an attestation that is not the literal true", async () => {
    const draft = await composeDraft("https://pirate.net/attest-1");
    // The contract's ApprovalAttestation emits literal-true fields, so a
    // refusal fails SCHEMA validation — the client cannot submit one the
    // server would have to interpret.
    const refusal = await approve(draft.noticeId, draft.templateVersion, {
      reviewedViolations: true,
      currentStatements: false,
      authorizedSignatory: true,
    });
    expect(refusal.statusCode).toBe(400);
    expect(refusal.json().code).toBe("validation_failed");

    const missing = await world.app.inject({
      method: "POST",
      url: `/api/notices/${draft.noticeId}/approval`,
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: {
        statementVersion: draft.templateVersion,
        attestation: { reviewedViolations: true, authorizedSignatory: true },
      },
    });
    expect(missing.statusCode).toBe(400);

    // A statement version the notice does not carry is refused with the
    // offending field.
    const mismatched = await world.app.inject({
      method: "POST",
      url: `/api/notices/${draft.noticeId}/approval`,
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: {
        statementVersion: "google-search.en.v9@000000000000",
        attestation: {
          reviewedViolations: true,
          currentStatements: true,
          authorizedSignatory: true,
        },
      },
    });
    expect(mismatched.statusCode).toBe(400);
    expect(mismatched.json().code).toBe("validation_failed");
  });

  it("queues a pre-handoff capture for a stale URL and creates the submission once it settles", async () => {
    // The newest live capture is eight days old at the frozen clock.
    const draft = await composeDraft("https://pirate.net/stale-1", {
      observedAt: "2025-12-24T00:00:00.000Z",
    });

    const response = await approve(draft.noticeId, draft.templateVersion);
    expect(response.statusCode).toBe(200);
    expect(response.json().queuedCaptures).toBe(1);
    // No submission until the capture settles.
    expect(response.json().submission).toBeUndefined();

    const captures = await pool.query<{ id: string; reason: string; state: string }>(
      `select id, reason, state from captures
        where normalized_url = 'pirate.net/stale-1' and reason = 'pre_handoff'`,
    );
    expect(captures.rows).toHaveLength(1);
    expect(captures.rows[0].state).toBe("pending");
    expect(dispatched).toEqual([captures.rows[0].id]);
    // The linkage the settle watcher reads.
    const linkage = await pool.query<{ notice_id: string; capture_id: string }>(
      "select notice_id, capture_id from notice_pre_handoff_captures",
    );
    expect(linkage.rows).toEqual([
      { notice_id: draft.noticeId, capture_id: captures.rows[0].id },
    ]);

    // The capture settles: the worker appends evidence and the row goes
    // terminal. (The evidence row is what the pack's capture flags read.)
    const settled = await pool.query<{ id: string }>(
      `insert into evidence
         (capture_id, requested_url, normalized_url, final_url, host, host_source, reason,
          outcome, http_status, attempt_number, observed_at, capture_profile)
       values ($1, 'https://pirate.net/stale-1', 'pirate.net/stale-1', 'https://pirate.net/stale-1',
          'pirate.net', 'landing_page', 'pre_handoff', 'captured', 200, 1, $2,
          '{"userAgent":"patrol","viewportWidth":1280,"viewportHeight":720,"locale":"en","timezone":"UTC",
            "javascriptEnabled":true,"blockedResourceKinds":[],"navigationPolicy":"load","extractorVersion":"1"}'::jsonb)
       returning id`,
      [captures.rows[0].id, FROZEN_NOW],
    );
    await pool.query(
      `update captures set state = 'done', finished_at = $2, evidence_id = $3 where id = $1`,
      [captures.rows[0].id, FROZEN_NOW, settled.rows[0].id],
    );

    // The settle watcher's creation is idempotent, and it is a database
    // operation alone: the worker never writes the pack's bytes (the API
    // builds them lazily on the first pack read).
    const first = await createPendingSubmissionIfSettled(
      { pool, now: clock.now },
      draft.noticeId,
    );
    expect(first.created).toBe(true);
    expect(store.putKeys).toHaveLength(0);
    const second = await createPendingSubmissionIfSettled(
      { pool, now: clock.now },
      draft.noticeId,
    );
    expect(second.created).toBe(false);
    expect(second.submissionId).toBe(first.submissionId);
    // Nothing was rebuilt and no second row landed.
    expect(store.putKeys).toHaveLength(0);
    const rows = await pool.query<{ count: string }>(
      "select count(*) as count from submissions where notice_id = $1",
      [draft.noticeId],
    );
    expect(Number(rows.rows[0].count)).toBe(1);
    const packs = await pool.query<{ count: string }>(
      "select count(*) as count from handoff_packs where notice_id = $1",
      [draft.noticeId],
    );
    expect(Number(packs.rows[0].count)).toBe(0);
  });

  it("holds the second-operator first-five control and records it", async () => {
    // Branch one: a second operator exists and this is among the profile's
    // first five notices — the drafter cannot approve their own draft.
    const second = await inviteAndEnroll(world, admin, "second@example.test");
    const refused = await composeDraft("https://pirate.net/second-1").then((draft) =>
      approve(draft.noticeId, draft.templateVersion),
    );
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe("state_conflict");

    // The second operator's approval passes and is recorded as required.
    const draft = await composeDraft("https://pirate.net/second-2");
    const bySecond = await world.app.inject({
      method: "POST",
      url: `/api/notices/${draft.noticeId}/approval`,
      headers: { "content-type": "application/json", ...authHeaders(second) },
      payload: {
        statementVersion: draft.templateVersion,
        attestation: {
          reviewedViolations: true,
          currentStatements: true,
          authorizedSignatory: true,
        },
      },
    });
    expect(bySecond.statusCode).toBe(200);
    const recorded = await pool.query<{ second_operator_required: boolean }>(
      "select second_operator_required from notices where id = $1",
      [draft.noticeId],
    );
    expect(recorded.rows[0].second_operator_required).toBe(true);

    // Branch two: past the first five, the drafter may approve their own —
    // the control is an early-life check, not a permanent one.
    const byRecipient = await profiles(pool);
    for (let index = 0; index < 4; index += 1) {
      await pool.query(
        `insert into notices (recipient, recipient_profile_id, channel, template_version, language,
            composed_at, composed_by, trigger_kind)
         values ('google', $1, 'web_form', $2, 'en', $3, $4, 'on_demand')`,
        [
          byRecipient.get("google")!.id,
          draft.templateVersion,
          FROZEN_NOW,
          admin.operatorId,
        ],
      );
    }
    const sixth = await composeDraft("https://pirate.net/second-3");
    const own = await approve(sixth.noticeId, sixth.templateVersion);
    expect(own.statusCode).toBe(200);
    const relaxed = await pool.query<{ second_operator_required: boolean }>(
      "select second_operator_required from notices where id = $1",
      [sixth.noticeId],
    );
    expect(relaxed.rows[0].second_operator_required).toBe(false);
  });

  it("lets the only operator approve their own draft when no second operator exists", async () => {
    const draft = await composeDraft("https://pirate.net/solo-1");
    const response = await approve(draft.noticeId, draft.templateVersion);
    expect(response.statusCode).toBe(200);
    const recorded = await pool.query<{ second_operator_required: boolean | null }>(
      "select second_operator_required from notices where id = $1",
      [draft.noticeId],
    );
    expect(recorded.rows[0].second_operator_required).toBe(false);
  });

  it("freezes the pack language from the approving operator", async () => {
    const second = await inviteAndEnroll(world, admin, "ru-approver@example.test");
    const preferred = await world.app.inject({
      method: "PATCH",
      url: "/api/auth/preferences",
      headers: { "content-type": "application/json", ...authHeaders(second) },
      payload: { language: "ru" },
    });
    expect(preferred.statusCode).toBe(200);

    const draft = await composeDraft("https://pirate.net/lang-1");
    const response = await world.app.inject({
      method: "POST",
      url: `/api/notices/${draft.noticeId}/approval`,
      headers: { "content-type": "application/json", ...authHeaders(second) },
      payload: {
        statementVersion: draft.templateVersion,
        attestation: {
          reviewedViolations: true,
          currentStatements: true,
          authorizedSignatory: true,
        },
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().submission.packLanguage).toBe("ru");
    // The pack's bytes are NOT built yet — the language is frozen on the
    // notice's row, which is the only thing the pack can later read.
    expect(store.putKeys).toHaveLength(0);

    // The approver's preference moves to English AFTER approval.
    const reverted = await world.app.inject({
      method: "PATCH",
      url: "/api/auth/preferences",
      headers: { "content-type": "application/json", ...authHeaders(second) },
      payload: { language: "en" },
    });
    expect(reverted.statusCode).toBe(200);

    // The first pack read builds the pack — in the frozen language.
    const pack = await world.app.inject({
      method: "GET",
      url: `/api/notices/${draft.noticeId}/pack`,
      headers: { cookie: admin.cookie },
    });
    expect(pack.statusCode).toBe(200);
    expect(pack.json().packLanguage).toBe("ru");
    const manifest = await pool.query<{ files: Array<{ name: string; sha256: string }> }>(
      "select files from handoff_packs where notice_id = $1",
      [draft.noticeId],
    );
    const handoff = manifest.rows[0].files.find((file) => file.name === "handoff.md")!;
    expect(store.text(handoff.sha256)).toContain("Контрольный список");
    expect(store.text(handoff.sha256)).not.toContain("Handoff checklist");

    // The pack never rewrites: a second read changes nothing.
    const beforeHash = (
      await pool.query<{ hash: string }>("select hash from handoff_packs where notice_id = $1", [
        draft.noticeId,
      ])
    ).rows[0].hash;
    const putsBefore = store.putKeys.length;
    const again = await world.app.inject({
      method: "GET",
      url: `/api/notices/${draft.noticeId}/pack`,
      headers: { cookie: admin.cookie },
    });
    expect(again.statusCode).toBe(200);
    expect(again.json().packLanguage).toBe("ru");
    expect(again.json().packSha256).toBe(beforeHash);
    expect(store.putKeys.length).toBe(putsBefore);
  });

  it("holds the freeze in the database: approved children refuse mutation, the state mirror moves", async () => {
    const draft = await composeDraft("https://pirate.net/frozen-1");
    const response = await approve(draft.noticeId, draft.templateVersion);
    expect(response.statusCode).toBe(200);

    await expect(
      pool.query("update notice_resolved_fields set value = 'smuggled' where notice_id = $1", [
        draft.noticeId,
      ]),
    ).rejects.toThrow(/frozen/i);
    await expect(
      pool.query("update notice_statements set text = 'smuggled' where notice_id = $1", [
        draft.noticeId,
      ]),
    ).rejects.toThrow(/frozen/i);
    await expect(
      pool.query("update notice_work_identifications set display_title = 'smuggled' where notice_id = $1", [
        draft.noticeId,
      ]),
    ).rejects.toThrow(/frozen/i);
    await expect(
      pool.query("update notice_citations set evidence = '[]'::jsonb where notice_id = $1", [
        draft.noticeId,
      ]),
    ).rejects.toThrow(/frozen/i);
    await expect(
      pool.query("delete from notice_citations where notice_id = $1", [draft.noticeId]),
    ).rejects.toThrow(/frozen/i);

    // The denormalized state mirror is the one sanctioned write.
    await expect(
      pool.query("update notice_citations set state = 'withdrawn' where notice_id = $1", [
        draft.noticeId,
      ]),
    ).resolves.toBeTruthy();
  });

  it("freezes the notices row itself: content columns refuse mutation once the notice has left draft", async () => {
    const draft = await composeDraft("https://pirate.net/frozen-row-1");

    // While still a draft, the content columns are writable (the composer
    // and the approval's own freeze write them).
    await expect(
      pool.query("update notices set language = 'en' where id = $1", [draft.noticeId]),
    ).resolves.toBeTruthy();

    // The approval's own write lands the content freeze and the state flip
    // in one UPDATE — it must pass (the trigger judges the OLD state).
    const response = await approve(draft.noticeId, draft.templateVersion);
    expect(response.statusCode).toBe(200);
    expect(response.json().notice.lifecycle.rightsHolder).toMatchObject({
      legalName: "Example Rights GmbH",
    });

    // Every content column refuses mutation on the approved row.
    await expect(
      pool.query("update notices set template_version = 'bing.en.v1@e36eaf64fd3c' where id = $1", [
        draft.noticeId,
      ]),
    ).rejects.toThrow(/frozen/i);
    await expect(
      pool.query("update notices set language = 'ru' where id = $1", [draft.noticeId]),
    ).rejects.toThrow(/frozen/i);
    await expect(
      pool.query("update notices set recipient = 'bing' where id = $1", [draft.noticeId]),
    ).rejects.toThrow(/frozen/i);
    await expect(
      pool.query(
        "update notices set rights_holder_snapshot = '{}'::jsonb where id = $1",
        [draft.noticeId],
      ),
    ).rejects.toThrow(/frozen/i);
    await expect(
      pool.query("update notices set composed_at = $2 where id = $1", [
        draft.noticeId,
        "2025-01-01T00:00:00Z",
      ]),
    ).rejects.toThrow(/frozen/i);

    // The lifecycle columns stay writable — the state machine owns them.
    await expect(
      pool.query("update notices set updated_at = $2 where id = $1", [
        draft.noticeId,
        FROZEN_NOW,
      ]),
    ).resolves.toBeTruthy();
    await expect(
      pool.query(
        `update notices set state = 'withdrawn', withdrawn_by = $2, withdrawn_at = $3 where id = $1`,
        [draft.noticeId, admin.operatorId, FROZEN_NOW],
      ),
    ).resolves.toBeTruthy();
  });

  it("blocks a pre-handoff fetch an allowlist entry scoped to the cited title covers", async () => {
    // A title-group-scoped official_domain entry for the cited title's
    // group: the pre-handoff enqueue must see it (the citation's title
    // context rides the enqueue), record the skip, and leave nothing to
    // wait on — the submission settles immediately with no queued capture.
    const group = await pool.query<{ id: string }>(
      "select title_group_id as id from tracked_titles where id = $1",
      [seeded.titleA],
    );
    await pool.query(
      `insert into allowlist_entries (kind, match_kind, value, scope, title_group_id, origin, confirmed_by)
       values ('official_domain', 'host', 'pirate.net', 'title_group', $1, 'operator', $2)`,
      [group.rows[0].id, admin.operatorId],
    );

    const draft = await composeDraft("https://pirate.net/allowlist-1", {
      observedAt: "2025-12-24T00:00:00.000Z",
    });
    const response = await approve(draft.noticeId, draft.templateVersion);
    expect(response.statusCode).toBe(200);
    expect(response.json().queuedCaptures).toBe(0);

    const captures = await pool.query<{ state: string; skip_reason: string | null }>(
      `select state, skip_reason from captures
        where normalized_url = 'pirate.net/allowlist-1' and reason = 'pre_handoff'`,
    );
    expect(captures.rows).toHaveLength(1);
    expect(captures.rows[0].state).toBe("skipped");
    expect(captures.rows[0].skip_reason).toBe("allowlist");
    // Nothing to wait on: the submission stands.
    expect(response.json().submission.lifecycle.state).toBe("pending");
  });
});
