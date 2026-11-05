import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { buildApp, poolSchemaStamp, testConfig, controlledClock } from "../test-app.js";
import { getValidator } from "../../src/plugins/validator.js";
import { MemoryMailTransport } from "../../src/mail/transport.js";
import { recomputeProfilePause, runScheduledComposition, createPendingSubmissionIfSettled } from "@patrol/notices";
import {
  authHeaders,
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
 * The handoff half of slice 6b over HTTP: withdrawal and supersession with
 * their guards and reservation releases, the frozen pack's surface and its
 * capture flags, and the profile pause the rejection threshold drives —
 * scheduled drafting stops, on demand stays, an administrator's clearance
 * resumes.
 */

describe("withdrawal, supersession, the pack, and the profile pause (slice 6b)", () => {
  let world: CeremonyApp;
  let admin: SignedInOperator;
  let pool: Pool;
  let clock: ReturnType<typeof controlledClock>;
  let seeded: NoticeWorld;
  let store: FakePackStore;

  beforeEach(async () => {
    if (pool === undefined) {
      pool = testPool();
    }
    await truncateDomainTables(pool);
    clock = controlledClock(FROZEN_NOW);
    store = new FakePackStore();
    const mail = new MemoryMailTransport();
    world = {
      app: await buildApp({
        config: testConfig({ now: clock.now }),
        pool,
        mail,
        schemaStamp: poolSchemaStamp(pool),
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

  async function composeApproved(
    url: string,
    options: { observedAt?: string } = {},
  ): Promise<{ noticeId: string; templateVersion: string; violationId: string }> {
    const byRecipient = await profiles(pool);
    const violationId = await seedViolation(pool, seeded, {
      url,
      observedAt: options.observedAt,
    });
    const composed = await world.app.inject({
      method: "POST",
      url: "/api/notices",
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: {
        recipient: "google",
        recipientProfileId: byRecipient.get("google")!.id,
        violationIds: [violationId],
      },
    });
    expect(composed.statusCode).toBe(201);
    const detail = composed.json();
    const approval = await world.app.inject({
      method: "POST",
      url: `/api/notices/${detail.notice.id}/approval`,
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: {
        statementVersion: detail.template.version,
        attestation: {
          reviewedViolations: true,
          currentStatements: true,
          authorizedSignatory: true,
        },
      },
    });
    expect(approval.statusCode).toBe(200);
    return {
      noticeId: detail.notice.id,
      templateVersion: detail.template.version,
      violationId,
    };
  }

  const withdraw = (noticeId: string, reason?: string) =>
    world.app.inject({
      method: "POST",
      url: `/api/notices/${noticeId}/withdrawal`,
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: reason === undefined ? {} : { reason },
    });

  it("withdraws a draft and releases its reservation for a later draft", async () => {
    const byRecipient = await profiles(pool);
    const violationId = await seedViolation(pool, seeded, {
      url: "https://pirate.net/withdraw-draft",
    });
    const composed = await world.app.inject({
      method: "POST",
      url: "/api/notices",
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: {
        recipient: "google",
        recipientProfileId: byRecipient.get("google")!.id,
        violationIds: [violationId],
      },
    });
    const noticeId = composed.json().notice.id;

    const response = await withdraw(noticeId, "composed in error");
    expect(response.statusCode).toBe(200);
    expect(getValidator("Notice")(response.json())).toBe(true);
    expect(response.json().lifecycle).toMatchObject({
      state: "withdrawn",
      reason: "composed in error",
    });

    // The reservation is released: a second draft may cite the violation.
    const second = await world.app.inject({
      method: "POST",
      url: "/api/notices",
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: {
        recipient: "google",
        recipientProfileId: byRecipient.get("google")!.id,
        violationIds: [violationId],
      },
    });
    expect(second.statusCode).toBe(201);

    // A withdrawn notice cannot be withdrawn again.
    const again = await withdraw(noticeId);
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe("state_conflict");
    expect(again.json().currentState).toBe("withdrawn");
  });

  it("withdraws an approved notice while its submission is pending, cancelling the submission", async () => {
    const approved = await composeApproved("https://pirate.net/withdraw-approved");

    const submission = await pool.query<{ id: string; state: string }>(
      "select id, state from submissions where notice_id = $1",
      [approved.noticeId],
    );
    expect(submission.rows).toHaveLength(1);
    expect(submission.rows[0].state).toBe("pending");

    const response = await withdraw(approved.noticeId);
    expect(response.statusCode).toBe(200);
    expect(response.json().lifecycle.state).toBe("withdrawn");

    const cancelled = await pool.query<{ cancelled_at: Date | null }>(
      "select cancelled_at from submissions where notice_id = $1",
      [approved.noticeId],
    );
    expect(cancelled.rows[0].cancelled_at).not.toBeNull();

    // The release works: the violation composes into a fresh draft.
    const byRecipient = await profiles(pool);
    const recomposed = await world.app.inject({
      method: "POST",
      url: "/api/notices",
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: {
        recipient: "google",
        recipientProfileId: byRecipient.get("google")!.id,
        violationIds: [approved.violationId],
      },
    });
    expect(recomposed.statusCode).toBe(201);
  });

  it("refuses withdrawal after the submission was delivered", async () => {
    const approved = await composeApproved("https://pirate.net/withdraw-delivered");
    // Delivery itself is slice 7; the guard is seeded the way its write path
    // will leave the row.
    await pool.query(
      `update submissions set state = 'delivered', operator_id = $2, delivered_at = $3
        where notice_id = $1`,
      [approved.noticeId, admin.operatorId, FROZEN_NOW],
    );

    const response = await withdraw(approved.noticeId);
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("notice_not_withdrawable");
  });

  it("supersedes an approved notice: pending submission cancelled, replacement draft carries the corrected set, ids recorded", async () => {
    const byRecipient = await profiles(pool);
    const keep = await seedViolation(pool, seeded, { url: "https://pirate.net/keep-1" });
    const drop = await seedViolation(pool, seeded, {
      url: "https://pirate.net/drop-1",
      titleId: seeded.titleB,
      variantId: seeded.variantB,
    });
    const composed = await world.app.inject({
      method: "POST",
      url: "/api/notices",
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: {
        recipient: "google",
        recipientProfileId: byRecipient.get("google")!.id,
        violationIds: [keep, drop],
      },
    });
    const noticeId = composed.json().notice.id;
    const approval = await world.app.inject({
      method: "POST",
      url: `/api/notices/${noticeId}/approval`,
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: {
        statementVersion: composed.json().template.version,
        attestation: {
          reviewedViolations: true,
          currentStatements: true,
          authorizedSignatory: true,
        },
      },
    });
    expect(approval.statusCode).toBe(200);

    // An identical citation set is not a supersession.
    const identical = await world.app.inject({
      method: "POST",
      url: `/api/notices/${noticeId}/supersession`,
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: { citedViolationIds: [keep, drop] },
    });
    expect(identical.statusCode).toBe(400);
    expect(identical.json().code).toBe("validation_failed");
    expect(
      (identical.json().fieldErrors as Array<{ message: string }>)[0].message,
    ).toContain("must differ");

    // An empty replacement set is its own refusal, not an identical set:
    // dropping everything is a withdrawal's job.
    const empty = await world.app.inject({
      method: "POST",
      url: `/api/notices/${noticeId}/supersession`,
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: { citedViolationIds: [] },
    });
    expect(empty.statusCode).toBe(400);
    expect(empty.json().code).toBe("validation_failed");
    expect(
      (empty.json().fieldErrors as Array<{ message: string }>)[0].message,
    ).toContain("at least one");

    // Drop the dead URL: the corrected set is [keep].
    const supersession = await world.app.inject({
      method: "POST",
      url: `/api/notices/${noticeId}/supersession`,
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: { citedViolationIds: [keep] },
    });
    expect(supersession.statusCode).toBe(200);
    const result = supersession.json();
    expect(getValidator("SupersessionResult")(result)).toBe(true);

    expect(result.superseded.lifecycle).toMatchObject({
      state: "superseded",
      supersededBy: admin.operatorId,
      supersededByNoticeId: result.draft.notice.id,
    });
    expect(result.draft.status).toBe("draft");
    expect(result.draft.notice.content.citedViolations.map((c: { violationId: string }) => c.violationId)).toEqual([keep]);

    // The pending submission is cancelled.
    const cancelled = await pool.query<{ cancelled_at: Date | null }>(
      "select cancelled_at from submissions where notice_id = $1",
      [noticeId],
    );
    expect(cancelled.rows[0].cancelled_at).not.toBeNull();

    // The superseded notice's content is unchanged after the supersession.
    const after = await world.app.inject({
      method: "GET",
      url: `/api/notices/${noticeId}`,
      headers: { cookie: admin.cookie },
    });
    expect(
      after.json().notice.content.citedViolations.map((c: { violationId: string }) => c.violationId),
    ).toEqual([keep, drop]);

    // The dropped violation is released and citable again; the kept one is
    // reserved by the replacement draft.
    const reDrop = await world.app.inject({
      method: "POST",
      url: "/api/notices",
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: {
        recipient: "google",
        recipientProfileId: byRecipient.get("google")!.id,
        violationIds: [drop],
      },
    });
    expect(reDrop.statusCode).toBe(201);
    const reKeep = await world.app.inject({
      method: "POST",
      url: "/api/notices",
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: {
        recipient: "google",
        recipientProfileId: byRecipient.get("google")!.id,
        violationIds: [keep],
      },
    });
    expect(reKeep.statusCode).toBe(409);
    expect(reKeep.json().code).toBe("violation_reserved");

    // Only an approved notice can be superseded.
    const draftSupersession = await world.app.inject({
      method: "POST",
      url: `/api/notices/${result.draft.notice.id}/supersession`,
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: { citedViolationIds: [drop] },
    });
    expect(draftSupersession.statusCode).toBe(409);
    expect(draftSupersession.json().currentState).toBe("draft");
  });

  it("serves the frozen pack with signed artifact downloads and live capture flags", async () => {
    // A dead newest pre-handoff capture flags the URL and never drops it.
    const approved = await composeApproved("https://pirate.net/pack-1", {
      observedAt: "2025-12-20T00:00:00.000Z",
    });
    // Approval queued the pre-handoff capture; settle it with a DEAD outcome.
    const capture = await pool.query<{ id: string }>(
      `select id from captures where normalized_url = 'pirate.net/pack-1' and reason = 'pre_handoff'`,
    );
    expect(capture.rows).toHaveLength(1);
    const dead = await pool.query<{ id: string }>(
      `insert into evidence
         (capture_id, requested_url, normalized_url, final_url, host, host_source, reason,
          outcome, http_status, failure_reason, attempt_number, observed_at, capture_profile)
       values ($1, 'https://pirate.net/pack-1', 'pirate.net/pack-1', null, 'pirate.net', 'landing_page', 'pre_handoff',
          'dead', 404, 'http_404', 1, $2,
          '{"userAgent":"patrol","viewportWidth":1280,"viewportHeight":720,"locale":"en","timezone":"UTC",
            "javascriptEnabled":true,"blockedResourceKinds":[],"navigationPolicy":"load","extractorVersion":"1"}'::jsonb)
       returning id`,
      [capture.rows[0].id, FROZEN_NOW],
    );
    await pool.query(
      `update captures set state = 'done', finished_at = $2, evidence_id = $3 where id = $1`,
      [capture.rows[0].id, FROZEN_NOW, dead.rows[0].id],
    );

    // The worker's settle watcher turns the settled capture into the
    // pending submission ROW — no pack bytes (the API owns the store).
    const settled = await createPendingSubmissionIfSettled(
      { pool, now: clock.now },
      approved.noticeId,
    );
    expect(settled.created).toBe(true);
    expect(store.putKeys).toHaveLength(0);

    // Before the submission stands (and here, before the pack is read),
    // the pack read answers not found only for a notice with no submission;
    // with the row standing, the FIRST read builds and stores the pack.
    const pack = await world.app.inject({
      method: "GET",
      url: `/api/notices/${approved.noticeId}/pack`,
      headers: { cookie: admin.cookie },
    });
    expect(pack.statusCode).toBe(200);
    const body = pack.json();
    expect(getValidator("HandoffPack")(body)).toBe(true);

    // Four artifacts, each with a signed download reference.
    expect(body.artifacts.map((a: { kind: string }) => a.kind)).toEqual([
      "notice_html",
      "fields_json",
      "upload_file",
      "handoff_markdown",
    ]);
    for (const artifact of body.artifacts) {
      expect(artifact.downloadUrl).toMatch(/^https:\/\/signed\.test\/packs\//);
      expect(artifact.byteSize).toBeGreaterThan(0);
    }

    // The dead newest capture is flagged beside the earlier live capture —
    // the URL is still cited everywhere.
    expect(body.captureFlags).toHaveLength(1);
    expect(body.captureFlags[0]).toMatchObject({
      violationId: approved.violationId,
      url: "https://pirate.net/pack-1",
      newestOutcome: "dead",
    });
    expect(body.captureFlags[0].earlierLiveEvidenceId).toBeDefined();
    const upload = body.artifacts.find((a: { kind: string }) => a.kind === "upload_file");
    const uploadSha = (
      await pool.query<{ files: Array<{ name: string; sha256: string }> }>(
        "select files from handoff_packs where notice_id = $1",
        [approved.noticeId],
      )
    ).rows[0].files.find((file) => file.name === upload.fileName)!.sha256;
    expect(store.text(uploadSha)).toContain("https://pirate.net/pack-1");
    expect(body.packLanguage).toBe("en");
    expect(body.formUrl).toBeDefined();

    // A draft has no pack: the pack read answers not found.
    const byRecipient = await profiles(pool);
    const violationId = await seedViolation(pool, seeded, { url: "https://pirate.net/pack-2" });
    const draft = await world.app.inject({
      method: "POST",
      url: "/api/notices",
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: {
        recipient: "google",
        recipientProfileId: byRecipient.get("google")!.id,
        violationIds: [violationId],
      },
    });
    const missing = await world.app.inject({
      method: "GET",
      url: `/api/notices/${draft.json().notice.id}/pack`,
      headers: { cookie: admin.cookie },
    });
    expect(missing.statusCode).toBe(404);
  });

  it("builds the pack lazily and survives a store failure: bytes first, rows second, retry recovers", async () => {
    const approved = await composeApproved("https://pirate.net/pack-lazy");
    const failing = await buildApp({
      config: testConfig({ now: clock.now }),
      pool,
      mail: new MemoryMailTransport(),
      schemaStamp: poolSchemaStamp(pool),
      // The store fails its first put: the pack's bytes cannot land.
      noticeStore: {
        putArtifact: async () => {
          throw new Error("object store unavailable");
        },
        presignDownload: (request) => store.presignDownload(request),
      },
    });

    const failed = await failing.inject({
      method: "GET",
      url: `/api/notices/${approved.noticeId}/pack`,
      headers: { cookie: admin.cookie },
    });
    expect(failed.statusCode).toBe(500);

    // The submission row stands (the settle already wrote it), but NO pack
    // row and NO dangling reference: the bytes go first, so a failed store
    // leaves nothing half-written.
    const submissions = await pool.query<{ pack_ref: string | null }>(
      "select pack_ref from submissions where notice_id = $1",
      [approved.noticeId],
    );
    expect(submissions.rows).toHaveLength(1);
    expect(submissions.rows[0].pack_ref).toBeNull();
    const packs = await pool.query<{ count: string }>(
      "select count(*) as count from handoff_packs where notice_id = $1",
      [approved.noticeId],
    );
    expect(Number(packs.rows[0].count)).toBe(0);
    expect(store.putKeys).toHaveLength(0);

    // The store recovers; the retry builds the pack and fills the
    // reference — the submission row is never duplicated.
    const recovered = await world.app.inject({
      method: "GET",
      url: `/api/notices/${approved.noticeId}/pack`,
      headers: { cookie: admin.cookie },
    });
    expect(recovered.statusCode).toBe(200);
    const after = await pool.query<{ pack_ref: string | null; count: string }>(
      "select pack_ref, count(*) over () as count from submissions where notice_id = $1",
      [approved.noticeId],
    );
    expect(Number(after.rows[0].count)).toBe(1);
    expect(after.rows[0].pack_ref).toMatch(/^packs\//);

    // A second read rebuilds nothing.
    const putsAfterRecovery = store.putKeys.length;
    const again = await world.app.inject({
      method: "GET",
      url: `/api/notices/${approved.noticeId}/pack`,
      headers: { cookie: admin.cookie },
    });
    expect(again.statusCode).toBe(200);
    expect(store.putKeys.length).toBe(putsAfterRecovery);
  });

  it("never builds a pack for a withdrawn notice", async () => {
    const approved = await composeApproved("https://pirate.net/pack-withdrawn");
    const withdrawn = await withdraw(approved.noticeId, "composed in error");
    expect(withdrawn.statusCode).toBe(200);

    const pack = await world.app.inject({
      method: "GET",
      url: `/api/notices/${approved.noticeId}/pack`,
      headers: { cookie: admin.cookie },
    });
    expect(pack.statusCode).toBe(404);
    const packs = await pool.query<{ count: string }>(
      "select count(*) as count from handoff_packs where notice_id = $1",
      [approved.noticeId],
    );
    expect(Number(packs.rows[0].count)).toBe(0);
    expect(store.putKeys).toHaveLength(0);
  });

  it("filters the notice list by the derived statuses the cards render", async () => {
    const byRecipient = await profiles(pool);
    const googleId = byRecipient.get("google")!.id;
    const template = "google-search.en.v1@ed9f34155836";

    const seedNotice = async (input: {
      state: "draft" | "approved" | "withdrawn" | "superseded";
      submissionState?: "pending" | "delivered" | "acknowledged" | "rejected" | "failed";
      url: string;
    }): Promise<string> => {
      const violationId = await seedViolation(pool, seeded, { url: input.url });
      // Draft first, citation second, then the lifecycle moves — the same
      // order the real write paths take, so the freeze triggers allow it.
      const row = await pool.query<{ id: string }>(
        `insert into notices (recipient, recipient_profile_id, channel, template_version, language,
            composed_at, composed_by, trigger_kind)
         values ('google', $1, 'web_form', $2, 'en', $3, $4, 'on_demand')
         returning id`,
        [googleId, template, FROZEN_NOW, admin.operatorId],
      );
      await pool.query(
        `insert into notice_citations (notice_id, violation_id, recipient_profile_id, tracked_title_id,
            url, normalized_url, state, position, evidence)
         values ($1, $2, $3, $4, $5, $6, 'draft', 0, '[]'::jsonb)`,
        [
          row.rows[0].id,
          violationId,
          googleId,
          seeded.titleA,
          input.url,
          `${new URL(input.url).hostname}${new URL(input.url).pathname}`,
        ],
      );
      if (input.state !== "draft") {
        await pool.query(
          `update notices set state = 'approved', approved_by = $2, approved_at = $3,
              rights_holder_snapshot = '{}'::jsonb, signatory_snapshot = '{}'::jsonb,
              profile_snapshot = '{}'::jsonb
           where id = $1`,
          [row.rows[0].id, admin.operatorId, FROZEN_NOW],
        );
        await pool.query(
          "update notice_citations set state = 'approved' where notice_id = $1",
          [row.rows[0].id],
        );
      }
      if (input.state === "withdrawn") {
        // The lifecycle's own move, exactly the shape withdrawal writes.
        await pool.query(
          `update notices set state = 'withdrawn', withdrawn_by = $2, withdrawn_at = $3 where id = $1`,
          [row.rows[0].id, admin.operatorId, FROZEN_NOW],
        );
        await pool.query(
          "update notice_citations set state = 'withdrawn' where notice_id = $1",
          [row.rows[0].id],
        );
      }
      if (input.submissionState !== undefined) {
        const outcome = input.submissionState;
        await pool.query(
          `insert into submissions (notice_id, recipient_profile_id, channel, state, attempt_count,
              pack_language, operator_id, delivered_at, decided_at, failed_at)
           values ($1, $2, 'web_form', $3, 1, 'en',
              case when $3 <> 'pending' then $4::uuid end,
              case when $3 = 'delivered' then $5::timestamptz end,
              case when $3 in ('acknowledged', 'rejected') then $5::timestamptz end,
              case when $3 = 'failed' then $5::timestamptz end)`,
          [row.rows[0].id, googleId, outcome, admin.operatorId, FROZEN_NOW],
        );
      }
      return row.rows[0].id;
    };

    const draft = await seedNotice({ state: "draft", url: "https://pirate.net/filter-draft" });
    const pending = await seedNotice({
      state: "approved",
      submissionState: "pending",
      url: "https://pirate.net/filter-pending",
    });
    const delivered = await seedNotice({
      state: "approved",
      submissionState: "delivered",
      url: "https://pirate.net/filter-delivered",
    });
    const acknowledged = await seedNotice({
      state: "approved",
      submissionState: "acknowledged",
      url: "https://pirate.net/filter-acknowledged",
    });
    const rejected = await seedNotice({
      state: "approved",
      submissionState: "rejected",
      url: "https://pirate.net/filter-rejected",
    });
    const failed = await seedNotice({
      state: "approved",
      submissionState: "failed",
      url: "https://pirate.net/filter-failed",
    });
    const withdrawnId = await seedNotice({
      state: "withdrawn",
      url: "https://pirate.net/filter-withdrawn",
    });
    const supersededTarget = await seedNotice({
      state: "approved",
      submissionState: "pending",
      url: "https://pirate.net/filter-superseded",
    });
    const replacement = await pool.query<{ id: string }>(
      `insert into notices (recipient, recipient_profile_id, channel, template_version, language,
          composed_at, composed_by, trigger_kind)
       values ('google', $1, 'web_form', $2, 'en', $3, $4, 'on_demand') returning id`,
      [googleId, template, FROZEN_NOW, admin.operatorId],
    );
    const superseded = await pool.query<{ id: string }>(
      `update notices set state = 'superseded', superseded_at = $2, superseded_by_notice_id = $3
         where id = $1 returning id`,
      [supersededTarget, FROZEN_NOW, replacement.rows[0].id],
    );
    expect(superseded.rows).toHaveLength(1);

    const idsFor = async (state: string): Promise<string[]> => {
      const list = await world.app.inject({
        method: "GET",
        url: `/api/notices?state=${state}`,
        headers: { cookie: admin.cookie },
      });
      expect(list.statusCode).toBe(200);
      return (list.json().items as Array<{ id: string }>).map((item) => item.id).sort();
    };

    // Each derived status the card renders filters to exactly the notices
    // whose derived status is it (the supersession's replacement is itself
    // a draft, so it joins the draft filter).
    expect(await idsFor("draft")).toEqual([draft, replacement.rows[0].id].sort());
    expect(await idsFor("approved")).toEqual([pending].sort());
    expect(await idsFor("delivered")).toEqual([delivered].sort());
    expect(await idsFor("acknowledged")).toEqual([acknowledged].sort());
    expect(await idsFor("rejected")).toEqual([rejected].sort());
    expect(await idsFor("failed")).toEqual([failed].sort());
    expect(await idsFor("withdrawn")).toEqual([withdrawnId].sort());
    expect(await idsFor("superseded")).toEqual([superseded.rows[0].id].sort());
  });

  it("pauses scheduled drafting past the ten-percent threshold and resumes on clearance", async () => {
    const byRecipient = await profiles(pool);
    const googleId = byRecipient.get("google")!.id;

    // Twenty submissions for the profile: seventeen delivered, two
    // rejected, one failed — fifteen percent, past the threshold.
    for (let index = 0; index < 20; index += 1) {
      const violationId = await seedViolation(pool, seeded, {
        url: `https://pirate.net/pause-${index}`,
      });
      const notice = await pool.query<{ id: string }>(
        `insert into notices (recipient, recipient_profile_id, channel, template_version, language,
            composed_at, composed_by, trigger_kind)
         values ('google', $1, 'web_form', 'google-search.en.v1@ed9f34155836', 'en', $2, $3, 'on_demand')
         returning id`,
        [googleId, FROZEN_NOW, admin.operatorId],
      );
      const outcome =
        index < 17 ? "delivered" : index < 19 ? "rejected" : "failed";
      await pool.query(
        `insert into submissions (notice_id, recipient_profile_id, channel, state, attempt_count,
            pack_language, operator_id, delivered_at, decided_at, failed_at)
         values ($1, $2, 'web_form', $3, 1, 'en', $4, $5, $5, $5)`,
        [notice.rows[0].id, googleId, outcome, admin.operatorId, FROZEN_NOW],
      );
      void violationId;
    }

    await recomputeProfilePause(pool, clock.now, googleId);
    const paused = await pool.query<{
      paused: boolean;
      pause_reason: string | null;
      recent_window_size: number;
      recent_rejected: number;
      recent_failed: number;
    }>("select paused, pause_reason, recent_window_size, recent_rejected, recent_failed from recipient_profiles where id = $1", [googleId]);
    expect(paused.rows[0]).toMatchObject({
      paused: true,
      recent_window_size: 20,
      recent_rejected: 2,
      recent_failed: 1,
    });
    expect(paused.rows[0].pause_reason).toContain("10");

    // Scheduled drafting is paused; on demand stays available.
    const outcomes = await runScheduledComposition({ pool, now: clock.now });
    const google = outcomes.find((outcome) => outcome.recipientProfileId === googleId);
    expect(google?.skippedReason).toBe("paused");

    const onDemand = await world.app.inject({
      method: "POST",
      url: "/api/notices",
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: {
        recipient: "google",
        recipientProfileId: googleId,
        violationIds: [await seedViolation(pool, seeded, { url: "https://pirate.net/pause-fresh" })],
      },
    });
    expect(onDemand.statusCode).toBe(201);

    // The clearance cannot land while the window still exceeds the share.
    const refusedClearance = await world.app.inject({
      method: "POST",
      url: `/api/settings/recipient-profiles/${googleId}/clearance`,
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: { reason: "investigated" },
    });
    expect(refusedClearance.statusCode).toBe(409);

    // The outcomes improve; the pause STAYS (no automatic resume) but the
    // counters fall below the share, so the explicit clearance resets it.
    await pool.query(
      `update submissions set state = 'delivered', decided_at = null, failed_at = null
        where recipient_profile_id = $1 and state in ('rejected', 'failed')`,
      [googleId],
    );
    await recomputeProfilePause(pool, clock.now, googleId);
    const stillPaused = await pool.query<{ paused: boolean; recent_rejected: number; recent_failed: number }>(
      "select paused, recent_rejected, recent_failed from recipient_profiles where id = $1",
      [googleId],
    );
    expect(stillPaused.rows[0].paused).toBe(true);
    expect(stillPaused.rows[0].recent_rejected).toBe(0);

    const cleared = await world.app.inject({
      method: "POST",
      url: `/api/settings/recipient-profiles/${googleId}/clearance`,
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: { reason: "the rejections were a recipient outage" },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().paused).toBe(false);

    // Scheduled drafting runs again.
    await pool.query("delete from notice_composition_runs where recipient_profile_id = $1", [
      googleId,
    ]);
    const afterClearance = await runScheduledComposition({ pool, now: clock.now });
    expect(afterClearance.find((o) => o.recipientProfileId === googleId)?.skippedReason).toBeUndefined();
  });
});
