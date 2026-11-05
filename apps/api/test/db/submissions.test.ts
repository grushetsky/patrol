import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { buildApp, poolSchemaStamp, testConfig, controlledClock } from "../test-app.js";
import { getValidator } from "../../src/plugins/validator.js";
import { MemoryMailTransport } from "../../src/mail/transport.js";
import {
  flaggedSubmissions,
  pendingSubmissionBacklog,
  raiseSubmissionAlerts,
  recordAcknowledgement,
  REMINDER_DAYS,
  runScheduledComposition,
} from "@patrol/notices";
import {
  authHeaders,
  signedInAdministrator,
  inviteAndEnroll,
  FROZEN_NOW,
  type CeremonyApp,
  type SignedInOperator,
} from "./ceremony.js";
import { testPool, truncateDomainTables } from "./helpers.js";
import {
  profiles,
  seedNoticeWorld,
  seedViolation,
  type NoticeWorld,
} from "./notices-helpers.js";

/**
 * Slice 7 over HTTP: the submission state machine an operator drives —
 * pending → delivered on the operator's attestation, → acknowledged on the
 * recipient's per-recipient identifier, → rejected or failed on a reason
 * and note — the retry that keeps one row and raises the attempt count,
 * the three-attempt flag, the seven-day backlog filter, the cancelled
 * guard, the profile pause a rejection tips over, and the derived
 * NoticeStatus the notices surfaces render. No scheduler ever retries a
 * submission: the operator re-files the same row.
 */

const GOOGLE_TEMPLATE = "google-search.en.v1@ed9f34155836";

describe("the submission state machine (slice 7)", () => {
  let world: CeremonyApp;
  let admin: SignedInOperator;
  let pool: Pool;
  let clock: ReturnType<typeof controlledClock>;
  let seeded: NoticeWorld;
  let byRecipient: Awaited<ReturnType<typeof profiles>>;

  beforeEach(async () => {
    if (pool === undefined) {
      pool = testPool();
    }
    await truncateDomainTables(pool);
    clock = controlledClock(FROZEN_NOW);
    const mail = new MemoryMailTransport();
    world = {
      app: await buildApp({
        config: testConfig({ now: clock.now }),
        pool,
        mail,
        schemaStamp: poolSchemaStamp(pool),
      }),
      pool,
      mail,
      clock,
    };
    // One operator only: the second-operator approval check applies to the
    // first five notices a profile produces once two operators exist, and
    // these tests are the submission machine's, not that check's.
    admin = await (await import("./ceremony.js")).signedInAdministrator(world);
    seeded = await seedNoticeWorld(pool, admin.operatorId);
    byRecipient = await profiles(pool);
  });

  afterAll(async () => {
    if (pool !== undefined) {
      await pool.end();
    }
  });

  /** One approved notice whose captures already settled: a pending submission. */
  async function pendingSubmission(
    url: string | string[],
    recipient: "google" | "bing" | "yandex" = "google",
  ): Promise<{
    noticeId: string;
    violationId: string;
    violationIds: string[];
    submissionId: string;
  }> {
    const urls = Array.isArray(url) ? url : [url];
    const violationIds = await Promise.all(
      urls.map(async (one) => await seedViolation(pool, seeded, { url: one })),
    );
    const composed = await world.app.inject({
      method: "POST",
      url: "/api/notices",
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: {
        recipient,
        recipientProfileId: byRecipient.get(recipient)!.id,
        violationIds,
      },
    });
    expect(composed.statusCode).toBe(201);
    const noticeId = composed.json().notice.id as string;
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
    const submission = await pool.query<{ id: string }>(
      "select id from submissions where notice_id = $1",
      [noticeId],
    );
    expect(submission.rows).toHaveLength(1);
    return {
      noticeId,
      violationId: violationIds[0],
      violationIds,
      submissionId: submission.rows[0].id,
    };
  }

  const post = async (
    path: string,
    payload: Record<string, unknown> = {},
    who: SignedInOperator = admin,
  ) =>
    await world.app.inject({
      method: "POST",
      url: `/api/submissions/${path}`,
      headers: { "content-type": "application/json", ...authHeaders(who) },
      payload,
    });

  const attestation = { filedAsPresented: true as const, statementVersion: GOOGLE_TEMPLATE };

  // ---------------------------------------------------------------- seam 1
  it("records delivery from pending with the operator's attestation, and only from pending", async () => {
    const target = await pendingSubmission("https://pirate.net/deliver-1");

    const delivered = await post(`${target.submissionId}/delivery`, { attestation });
    expect(delivered.statusCode).toBe(200);
    expect(getValidator("Submission")(delivered.json())).toBe(true);
    expect(delivered.json().lifecycle).toMatchObject({
      state: "delivered",
      operatorId: admin.operatorId,
      attestation: { statementVersion: GOOGLE_TEMPLATE },
    });

    const row = await pool.query<{
      state: string;
      operator_id: string;
      delivered_at: Date;
      attested_at: Date;
      statement_version: string;
    }>(
      "select state, operator_id, delivered_at, attested_at, statement_version from submissions where id = $1",
      [target.submissionId],
    );
    expect(row.rows[0]).toMatchObject({
      state: "delivered",
      operator_id: admin.operatorId,
      statement_version: GOOGLE_TEMPLATE,
    });
    expect(row.rows[0].delivered_at).toEqual(new Date(FROZEN_NOW));
    expect(row.rows[0].attested_at).toEqual(new Date(FROZEN_NOW));

    // A second delivery is a state conflict: the row is no longer pending.
    const again = await post(`${target.submissionId}/delivery`, { attestation });
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe("submission_not_pending");
    expect(again.json().currentState).toBe("delivered");
  });

  // ---------------------------------------------------------------- seam 2
  it("acknowledges a delivered submission with Google's reference number and dashboard URL", async () => {
    const target = await pendingSubmission("https://pirate.net/ack-google");
    await post(`${target.submissionId}/delivery`, { attestation });

    const acknowledged = await post(`${target.submissionId}/acknowledgement`, {
      attestation,
      acknowledgement: {
        recipient: "google",
        referenceNumber: "dmc-3b8a42f1-9c2d",
        dashboardUrl: "https://support.google.com/legal/removals/dashboard",
      },
    });
    expect(acknowledged.statusCode).toBe(200);
    expect(getValidator("Submission")(acknowledged.json())).toBe(true);
    expect(acknowledged.json().lifecycle.state).toBe("acknowledged");
    expect(acknowledged.json().lifecycle.acknowledgement).toMatchObject({
      recipient: "google",
      referenceNumber: "dmc-3b8a42f1-9c2d",
      dashboardUrl: "https://support.google.com/legal/removals/dashboard",
    });

    const row = await pool.query<{ acknowledgement: Record<string, unknown> }>(
      "select acknowledgement from submissions where id = $1",
      [target.submissionId],
    );
    expect(row.rows[0].acknowledgement).toMatchObject({
      recipient: "google",
      referenceNumber: "dmc-3b8a42f1-9c2d",
    });

    // Acknowledged is the end of the line: no further transition applies.
    const redeliver = await post(`${target.submissionId}/delivery`, { attestation });
    expect(redeliver.statusCode).toBe(409);
    expect(redeliver.json().code).toBe("submission_not_pending");
  });

  it("records the acknowledgement directly from pending when the operator files and confirms in one act", async () => {
    const target = await pendingSubmission("https://pirate.net/ack-direct");
    const acknowledged = await post(`${target.submissionId}/acknowledgement`, {
      attestation,
      acknowledgement: {
        recipient: "google",
        referenceNumber: "dmc-aaaa-bbbb-cccc",
        dashboardUrl: "https://support.google.com/legal/removals/dashboard",
      },
    });
    expect(acknowledged.statusCode).toBe(200);
    expect(acknowledged.json().lifecycle.state).toBe("acknowledged");
    expect(acknowledged.json().lifecycle.operatorId).toBe(admin.operatorId);
  });

  it("refuses an acknowledgement shaped for another recipient", async () => {
    const target = await pendingSubmission("https://pirate.net/ack-wrong");
    await post(`${target.submissionId}/delivery`, { attestation });

    // A Bing body against a Google submission: the variant must match the
    // notice's recipient.
    const wrong = await post(`${target.submissionId}/acknowledgement`, {
      attestation,
      acknowledgement: {
        recipient: "bing",
        ticketId: "170123456789012345",
        ticketDetailsUrl: "https://www.bing.com/content/removal?tid=170123456789012345",
      },
    });
    expect(wrong.statusCode).toBe(422);
    expect(wrong.json().code).toBe("unprocessable");

    // A reference number under the four-character floor breaks the
    // contract's own schema, so the envelope validation refuses it first.
    const short = await post(`${target.submissionId}/acknowledgement`, {
      attestation,
      acknowledgement: {
        recipient: "google",
        referenceNumber: "abc",
        dashboardUrl: "https://support.google.com/legal/removals/dashboard",
      },
    });
    expect(short.statusCode).toBe(400);
    expect(short.json().code).toBe("validation_failed");

    // The domain guard refuses the same shape when it reaches it (the
    // per-recipient branch validation runs on every path in).
    const refused = await recordAcknowledgement(
      { pool, now: clock.now },
      {
        submissionId: target.submissionId,
        operatorId: admin.operatorId,
        attestation,
        acknowledgement: {
          recipient: "google",
          referenceNumber: "abc",
          dashboardUrl: "https://support.google.com/legal/removals/dashboard",
        },
      },
    );
    expect(refused).toMatchObject({
      status: "refused",
      refusal: { status: "acknowledgement_shape", field: "referenceNumber" },
    });
  });

  it("acknowledges Yandex submissions with the reply Message-ID and date", async () => {
    // The seeded Yandex profile narrows to US/FR/CH while the seeded rights
    // holder is German; eligibility needs the profile's list to cover it.
    // An empty list means the channel floor (US, CH, and the EU member
    // states), which the German rights holder is inside.
    await pool.query(
      "update recipient_profiles set eligible_territories = '{}' where recipient = 'yandex'",
    );
    const target = await pendingSubmission("https://pirate.net/ack-yandex", "yandex");
    const acknowledged = await post(`${target.submissionId}/acknowledgement`, {
      attestation: { filedAsPresented: true, statementVersion: GOOGLE_TEMPLATE },
      acknowledgement: {
        recipient: "yandex",
        messageId: "<CAF0123456789@mail.yandex.ru>",
        replyDate: "2026-01-04",
      },
    });
    expect(acknowledged.statusCode).toBe(200);
    expect(acknowledged.json().lifecycle.acknowledgement).toMatchObject({
      recipient: "yandex",
      messageId: "<CAF0123456789@mail.yandex.ru>",
      replyDate: "2026-01-04",
    });
  });

  // ---------------------------------------------------------------- seam 3
  it("refuses a rejection without a cause note and blocks the offending violation from new drafts until a review decision", async () => {
    const byRecipient = await profiles(pool);
    const target = await pendingSubmission("https://pirate.net/reject-1");

    const noNote = await post(`${target.submissionId}/failure`, {
      reason: "recipient_rejection",
      note: "   ",
    });
    expect(noNote.statusCode).toBe(422);
    expect(noNote.json().code).toBe("note_required");

    const rejected = await post(`${target.submissionId}/failure`, {
      reason: "recipient_rejection",
      note: "Google refused the notice: the signature did not match the account name",
    });
    expect(rejected.statusCode).toBe(200);
    expect(getValidator("Submission")(rejected.json())).toBe(true);
    expect(rejected.json().lifecycle).toMatchObject({
      state: "rejected",
      failure: {
        reason: "recipient_rejection",
        note: "Google refused the notice: the signature did not match the account name",
      },
    });

    // The reservation ends with the rejection... but the offending
    // violation may not be cited again until a review decision names it —
    // its own code, so the remedy (a review decision) is legible.
    const reblock = await world.app.inject({
      method: "POST",
      url: "/api/notices",
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: {
        recipient: "google",
        recipientProfileId: byRecipient.get("google")!.id,
        violationIds: [target.violationId],
      },
    });
    expect(reblock.statusCode).toBe(409);
    expect(reblock.json().code).toBe("violation_needs_review");
    expect(reblock.json().conflictingViolationIds).toEqual([target.violationId]);
    expect(reblock.json().existingNoticeId).toBe(target.noticeId);

    // A review decision on the pair after the rejection frees it.
    const candidate = await pool.query<{ candidate_id: string }>(
      "select candidate_id from violations where id = $1",
      [target.violationId],
    );
    await pool.query(
      `insert into review_decisions (id, candidate_id, operator_id, action, decided_at, evidence_ids)
       values (uuidv7(), $1, $2, 'not_a_violation', $3, '{}')`,
      [candidate.rows[0].candidate_id, admin.operatorId, "2026-01-02T00:00:00.000Z"],
    );
    const recomposed = await world.app.inject({
      method: "POST",
      url: "/api/notices",
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: {
        recipient: "google",
        recipientProfileId: byRecipient.get("google")!.id,
        violationIds: [target.violationId],
      },
    });
    expect(recomposed.statusCode).toBe(201);

    // A rejected submission is never retried unchanged: supersession is
    // the correction route.
    const retry = await post(`${target.submissionId}/retry`);
    expect(retry.statusCode).toBe(409);
  });

  it("keeps a superseded rejection's violations blocked from new drafts until the review decision", async () => {
    // The block keys on the SUBMISSION's rejection, not on the citations'
    // state mirror: a supersession of the rejected notice moves the mirror
    // to 'superseded', and the unexamined refusal must still bar the
    // offending violation from a later draft.
    const target = await pendingSubmission([
      "https://pirate.net/reject-superseded-1",
      "https://pirate.net/reject-superseded-2",
    ]);
    const rejected = await post(`${target.submissionId}/failure`, {
      reason: "recipient_rejection",
      note: "Google refused the notice: a cited URL was already in flight",
    });
    expect(rejected.statusCode).toBe(200);

    // The correction route still runs: the replacement carries a set the
    // rejection does not touch (a fresh violation), because every citation
    // of the rejected notice stays blocked — the model has no per-violation
    // "offending" marker, so the block covers the whole cited set and only
    // a review decision frees a citation.
    const fresh = await seedViolation(pool, seeded, {
      url: "https://pirate.net/reject-superseded-fresh",
    });
    const supersession = await world.app.inject({
      method: "POST",
      url: `/api/notices/${target.noticeId}/supersession`,
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: { citedViolationIds: [fresh] },
    });
    expect(supersession.statusCode).toBe(200);

    // The citations' mirror left 'rejected' with the supersession, but the
    // submission still stands rejected — the offending violation is barred.
    const draft = await world.app.inject({
      method: "POST",
      url: "/api/notices",
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: {
        recipient: "google",
        recipientProfileId: byRecipient.get("google")!.id,
        violationIds: [target.violationId],
      },
    });
    expect(draft.statusCode).toBe(409);
    expect(draft.json().code).toBe("violation_needs_review");
    expect(draft.json().existingNoticeId).toBe(target.noticeId);

    // A later review decision on the pair is what frees it.
    const candidate = await pool.query<{ candidate_id: string }>(
      "select candidate_id from violations where id = $1",
      [target.violationId],
    );
    await pool.query(
      `insert into review_decisions (id, candidate_id, operator_id, action, decided_at, evidence_ids)
       values (uuidv7(), $1, $2, 'not_a_violation', $3, '{}')`,
      [candidate.rows[0].candidate_id, admin.operatorId, "2026-01-02T00:00:00.000Z"],
    );
    const freed = await world.app.inject({
      method: "POST",
      url: "/api/notices",
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: {
        recipient: "google",
        recipientProfileId: byRecipient.get("google")!.id,
        violationIds: [target.violationId],
      },
    });
    expect(freed.statusCode).toBe(201);
  });

  it("keeps the filing operator of record when another operator records the acknowledgement", async () => {
    const target = await pendingSubmission("https://pirate.net/ack-filer");
    await post(`${target.submissionId}/delivery`, { attestation });

    const colleague = await inviteAndEnroll(world, admin, "ackfiler@example.test", "operator");
    const acknowledged = await post(
      `${target.submissionId}/acknowledgement`,
      {
        attestation,
        acknowledgement: {
          recipient: "google",
          referenceNumber: "dmc-filer-0001",
          dashboardUrl: "https://support.google.com/legal/removals/dashboard",
        },
      },
      colleague,
    );
    expect(acknowledged.statusCode).toBe(200);
    // The acknowledger records what the recipient returned; the operator
    // who FILED the notice stays the delivery's operator of record.
    expect(acknowledged.json().lifecycle.state).toBe("acknowledged");
    expect(acknowledged.json().lifecycle.operatorId).toBe(admin.operatorId);
  });

  // ---------------------------------------------------------------- seam 4
  it("fails a submission, retries the same row with a raised attempt count, and delivers on the retry", async () => {
    const target = await pendingSubmission("https://pirate.net/fail-1");

    const failed = await post(`${target.submissionId}/failure`, {
      reason: "recipient_error",
      note: "Google's form returned a 500 on submit",
    });
    expect(failed.statusCode).toBe(200);
    expect(failed.json().lifecycle).toMatchObject({
      state: "failed",
      failure: { reason: "recipient_error" },
    });

    const retry = await post(`${target.submissionId}/retry`);
    expect(retry.statusCode).toBe(200);
    expect(retry.json().lifecycle.state).toBe("pending");
    expect(retry.json().attemptCount).toBe(1);

    // One row, ever: the retry reused it.
    const rows = await pool.query<{ count: string; state: string; attempt_count: number }>(
      "select count(*) over () as count, state, attempt_count from submissions where notice_id = $1",
      [target.noticeId],
    );
    expect(Number(rows.rows[0].count)).toBe(1);
    expect(rows.rows[0]).toMatchObject({ state: "pending", attempt_count: 1 });

    // The second delivery works on the retried row.
    const delivered = await post(`${target.submissionId}/delivery`, { attestation });
    expect(delivered.statusCode).toBe(200);
    expect(delivered.json().lifecycle.state).toBe("delivered");

    // A pending submission cannot be retried: only a failed one can.
    const pendingRetry = await post(`${target.submissionId}/retry`);
    expect(pendingRetry.statusCode).toBe(409);
  });

  it("restores the citation reservation a failure ended when the row is re-filed", async () => {
    const target = await pendingSubmission("https://pirate.net/retry-reserve-1");

    // The failure lowers the citations' state mirror out of the active
    // set, ending the reservation and the recipient-level dedup...
    await post(`${target.submissionId}/failure`, {
      reason: "recipient_error",
      note: "form outage",
    });
    const lowered = await pool.query<{ state: string }>(
      "select state from notice_citations where notice_id = $1",
      [target.noticeId],
    );
    expect(lowered.rows[0].state).toBe("failed");

    // ...and the retry raises it back inside the same transaction, so the
    // partial unique indexes hold the re-filed set again.
    const retry = await post(`${target.submissionId}/retry`);
    expect(retry.statusCode).toBe(200);
    const restored = await pool.query<{ state: string }>(
      "select state from notice_citations where notice_id = $1",
      [target.noticeId],
    );
    expect(restored.rows[0].state).toBe("approved");

    const secondDraft = await world.app.inject({
      method: "POST",
      url: "/api/notices",
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: {
        recipient: "google",
        recipientProfileId: byRecipient.get("google")!.id,
        violationIds: [target.violationId],
      },
    });
    expect(secondDraft.statusCode).toBe(409);
    expect(secondDraft.json().code).toBe("violation_reserved");
    expect(secondDraft.json().existingNoticeId).toBe(target.noticeId);

    // The protection survives the delivery the retry lands on: the
    // reservation belongs to the standing attempt, not the wait before it.
    await post(`${target.submissionId}/delivery`, { attestation });
    const afterDelivery = await world.app.inject({
      method: "POST",
      url: "/api/notices",
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: {
        recipient: "google",
        recipientProfileId: byRecipient.get("google")!.id,
        violationIds: [target.violationId],
      },
    });
    expect(afterDelivery.statusCode).toBe(409);
    expect(afterDelivery.json().code).toBe("violation_reserved");
  });

  // ---------------------------------------------------------------- seam 5
  it("flags a submission for administrators after three failed attempts", async () => {
    const target = await pendingSubmission("https://pirate.net/flag-1");

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      await post(`${target.submissionId}/failure`, {
        reason: "recipient_error",
        note: `attempt ${attempt} failed`,
      });
      const retry = await post(`${target.submissionId}/retry`);
      expect(retry.statusCode).toBe(200);
      expect(retry.json().attemptCount).toBe(attempt);
      expect((await flaggedSubmissions(pool)).items).toHaveLength(0);
    }

    // The third failure raises the flag; the row stays failed and nothing
    // is cancelled automatically.
    const third = await post(`${target.submissionId}/failure`, {
      reason: "recipient_error",
      note: "attempt 3 failed",
    });
    expect(third.statusCode).toBe(200);
    const row = await pool.query<{ flagged_at: Date | null; attempt_count: number }>(
      "select flagged_at, attempt_count from submissions where id = $1",
      [target.submissionId],
    );
    expect(row.rows[0].flagged_at).toEqual(new Date(FROZEN_NOW));
    expect(row.rows[0].attempt_count).toBe(2);

    const flagged = await flaggedSubmissions(pool);
    expect(flagged.items.map((item) => item.submissionId)).toEqual([target.submissionId]);
    expect(flagged.items[0]).toMatchObject({
      noticeId: target.noticeId,
      attemptCount: 2,
      flaggedAt: FROZEN_NOW,
    });

    // The flag survives a retry: an administrator decides, not the counter.
    const retry = await post(`${target.submissionId}/retry`);
    expect(retry.statusCode).toBe(200);
    const still = await pool.query<{ flagged_at: Date | null }>(
      "select flagged_at from submissions where id = $1",
      [target.submissionId],
    );
    expect(still.rows[0].flagged_at).not.toBeNull();
  });

  // ---------------------------------------------------------------- seam 6
  it("surfaces pending submissions older than seven days in the backlog filter and the reminder read", async () => {
    const old = await pendingSubmission("https://pirate.net/old-1");
    const fresh = await pendingSubmission("https://pirate.net/fresh-1");
    await pool.query("update submissions set created_at = $2 where id = $1", [
      old.submissionId,
      "2025-12-20T00:00:00.000Z",
    ]);

    const backlog = await world.app.inject({
      method: "GET",
      url: `/api/submissions?olderThanDays=${REMINDER_DAYS}`,
      headers: { cookie: admin.cookie },
    });
    expect(backlog.statusCode).toBe(200);
    expect(getValidator("SubmissionPage")(backlog.json())).toBe(true);
    const ids = (backlog.json().items as Array<{ submission: { id: string } }>).map(
      (item) => item.submission.id,
    );
    expect(ids).toContain(old.submissionId);
    expect(ids).not.toContain(fresh.submissionId);

    // The same predicate the daily remind job runs.
    const reminded = await pendingSubmissionBacklog(pool, clock.now, REMINDER_DAYS);
    expect(reminded.map((item) => item.submissionId)).toEqual([old.submissionId]);

    // An explicit state filter composes with the age window.
    const pendingOnly = await world.app.inject({
      method: "GET",
      url: `/api/submissions?state=pending&olderThanDays=${REMINDER_DAYS}`,
      headers: { cookie: admin.cookie },
    });
    expect(
      (pendingOnly.json().items as Array<{ submission: { id: string } }>).map(
        (item) => item.submission.id,
      ),
    ).toEqual([old.submissionId]);

    // The detail read model carries the notice reference and the flag.
    const detail = await world.app.inject({
      method: "GET",
      url: `/api/submissions/${old.submissionId}`,
      headers: { cookie: admin.cookie },
    });
    expect(detail.statusCode).toBe(200);
    expect(getValidator("SubmissionDetail")(detail.json())).toBe(true);
    expect(detail.json().notice).toMatchObject({ id: old.noticeId, recipient: "google" });
    expect(detail.json().packAvailable).toBe(false);

    const missing = await world.app.inject({
      method: "GET",
      url: "/api/submissions/00000000-0000-0000-0000-000000000000",
      headers: { cookie: admin.cookie },
    });
    expect(missing.statusCode).toBe(404);
  });

  it("raises the reminder's alert row once per overdue submission and clears it when the backlog stint ends", async () => {
    const overdue = await pendingSubmission("https://pirate.net/alert-1");
    const withdrawn = await pendingSubmission("https://pirate.net/alert-2");
    await pool.query("update submissions set created_at = $2 where id = $1", [
      overdue.submissionId,
      "2025-12-20T00:00:00.000Z",
    ]);
    await pool.query("update submissions set created_at = $2 where id = $1", [
      withdrawn.submissionId,
      "2025-12-20T00:00:00.000Z",
    ]);

    const alertCount = async (submissionId: string): Promise<number> =>
      Number(
        (
          await pool.query<{ count: string }>(
            "select count(*) as count from submission_alerts where submission_id = $1",
            [submissionId],
          )
        ).rows[0].count,
      );

    // The reminder's write half: one deduped row per backlog submission.
    const first = await raiseSubmissionAlerts(pool, clock.now, REMINDER_DAYS);
    expect(first.backlog.map((item) => item.submissionId).sort()).toEqual(
      [overdue.submissionId, withdrawn.submissionId].sort(),
    );
    expect(first.raised).toHaveLength(2);
    expect(await alertCount(overdue.submissionId)).toBe(1);

    // The second daily run names the same backlog but inserts nothing.
    const second = await raiseSubmissionAlerts(pool, clock.now, REMINDER_DAYS);
    expect(second.raised).toHaveLength(0);
    expect(await alertCount(overdue.submissionId)).toBe(1);

    // Delivery ends the stint: the alert dies with the pending wait.
    await post(`${overdue.submissionId}/delivery`, { attestation });
    expect(await alertCount(overdue.submissionId)).toBe(0);

    // So does the cancellation a withdrawal writes.
    const withdrawal = await world.app.inject({
      method: "POST",
      url: `/api/notices/${withdrawn.noticeId}/withdrawal`,
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: { reason: "filed elsewhere" },
    });
    expect(withdrawal.statusCode).toBe(200);
    expect(await alertCount(withdrawn.submissionId)).toBe(0);
  });

  it("lists submissions by state and notice", async () => {
    const first = await pendingSubmission("https://pirate.net/list-1");
    const second = await pendingSubmission("https://pirate.net/list-2");
    await post(`${first.submissionId}/delivery`, { attestation });

    const byState = await world.app.inject({
      method: "GET",
      url: "/api/submissions?state=delivered",
      headers: { cookie: admin.cookie },
    });
    expect(
      (byState.json().items as Array<{ submission: { id: string } }>).map(
        (item) => item.submission.id,
      ),
    ).toEqual([first.submissionId]);

    const byNotice = await world.app.inject({
      method: "GET",
      url: `/api/submissions?noticeId=${second.noticeId}`,
      headers: { cookie: admin.cookie },
    });
    expect(
      (byNotice.json().items as Array<{ submission: { id: string } }>).map(
        (item) => item.submission.id,
      ),
    ).toEqual([second.submissionId]);
  });

  // ---------------------------------------------------------------- seam 7
  it("refuses every transition on a cancelled submission", async () => {
    const target = await pendingSubmission("https://pirate.net/cancelled-1");
    const withdrawn = await world.app.inject({
      method: "POST",
      url: `/api/notices/${target.noticeId}/withdrawal`,
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: { reason: "composed in error" },
    });
    expect(withdrawn.statusCode).toBe(200);
    await pool.query(
      "update submissions set created_at = $2 where id = $1",
      [target.submissionId, "2025-12-01T00:00:00.000Z"],
    );

    for (const [path, payload] of [
      ["delivery", { attestation }],
      [
        "acknowledgement",
        {
          attestation,
          acknowledgement: {
            recipient: "google",
            referenceNumber: "dmc-1111-2222",
            dashboardUrl: "https://support.google.com/legal/removals/dashboard",
          },
        },
      ],
      ["failure", { reason: "recipient_error", note: "late" }],
      ["retry", {}],
    ] as const) {
      const response = await post(`${target.submissionId}/${path}`, payload);
      expect(response.statusCode).toBe(409);
      expect(response.json().code).toBe("state_conflict");
      expect(response.json().currentState).toBe("cancelled");
    }

    // A cancelled row never joins the reminder backlog.
    const backlog = await pendingSubmissionBacklog(pool, clock.now, REMINDER_DAYS);
    expect(backlog.map((item) => item.submissionId)).not.toContain(target.submissionId);
  });

  it("refuses a retry whose notice is already superseded or withdrawn, whatever the row says", async () => {
    // The belt-and-braces read under the retry: the lifecycle's
    // cancellation is the real guard, but a failed row left standing under
    // a dead notice — the exact shape a supersession that cancelled only
    // pending rows produced — must never re-file to pending. The rows are
    // seeded straight, bypassing the lifecycle that would have cancelled
    // them, so the retry's own notice read is the only guard left.
    const googleId = byRecipient.get("google")!.id;
    const seedDeadNotice = async (
      state: "superseded" | "withdrawn",
    ): Promise<string> => {
      const notice = await pool.query<{ id: string }>(
        `insert into notices (recipient, recipient_profile_id, channel, template_version, language,
            composed_at, composed_by, trigger_kind)
         values ('google', $1, 'web_form', $2, 'en', $3, $4, 'on_demand')
         returning id`,
        [googleId, GOOGLE_TEMPLATE, FROZEN_NOW, admin.operatorId],
      );
      const noticeId = notice.rows[0].id;
      if (state === "superseded") {
        // The replacement the superseded row's CHECK demands.
        const replacement = await pool.query<{ id: string }>(
          `insert into notices (recipient, recipient_profile_id, channel, template_version, language,
              composed_at, composed_by, trigger_kind)
           values ('google', $1, 'web_form', $2, 'en', $3, $4, 'on_demand') returning id`,
          [googleId, GOOGLE_TEMPLATE, FROZEN_NOW, admin.operatorId],
        );
        await pool.query(
          `update notices set state = 'superseded', superseded_at = $2, superseded_by_notice_id = $3
           where id = $1`,
          [noticeId, FROZEN_NOW, replacement.rows[0].id],
        );
      } else {
        await pool.query(
          `update notices set state = 'withdrawn', withdrawn_by = $2, withdrawn_at = $3
           where id = $1`,
          [noticeId, admin.operatorId, FROZEN_NOW],
        );
      }
      const submission = await pool.query<{ id: string }>(
        `insert into submissions (notice_id, recipient_profile_id, channel, state, attempt_count,
            pack_language, operator_id, failed_at, failure_reason, failure_note, failure_recorded_at)
         values ($1, $2, 'web_form', 'failed', 1, 'en', $3, $4, 'recipient_error', 'seeded cause', $4)
         returning id`,
        [noticeId, googleId, admin.operatorId, FROZEN_NOW],
      );
      return submission.rows[0].id;
    };

    for (const state of ["superseded", "withdrawn"] as const) {
      const submissionId = await seedDeadNotice(state);
      const retry = await post(`${submissionId}/retry`);
      expect(retry.statusCode).toBe(409);
      expect(retry.json().code).toBe("state_conflict");
      expect(retry.json().currentState).toBe("cancelled");
      // The row itself is untouched: still failed, still uncancelled —
      // the refusal, not a silent repair, is the guard's job.
      const row = await pool.query<{ state: string; cancelled_at: Date | null }>(
        "select state, cancelled_at from submissions where id = $1",
        [submissionId],
      );
      expect(row.rows[0].state).toBe("failed");
      expect(row.rows[0].cancelled_at).toBeNull();
    }
  });

  // ---------------------------------------------------------------- seam 8
  it("tips the profile pause over ten percent on a recorded rejection and stops scheduled drafting", async () => {
    const target = await pendingSubmission("https://pirate.net/pause-reject");
    const rejected = await post(`${target.submissionId}/failure`, {
      reason: "recipient_rejection",
      note: "refused: the work identification was wrong",
    });
    expect(rejected.statusCode).toBe(200);

    const profile = await pool.query<{
      id: string;
      paused: boolean;
      recent_window_size: number;
      recent_rejected: number;
    }>(
      `select p.id, p.paused, p.recent_window_size, p.recent_rejected
       from recipient_profiles p join submissions s on s.recipient_profile_id = p.id
       where s.id = $1`,
      [target.submissionId],
    );
    expect(profile.rows[0].paused).toBe(true);
    expect(profile.rows[0]).toMatchObject({ recent_window_size: 1, recent_rejected: 1 });

    const outcomes = await runScheduledComposition({ pool, now: clock.now });
    expect(
      outcomes.find((outcome) => outcome.recipientProfileId === profile.rows[0].id)
        ?.skippedReason,
    ).toBe("paused");
  });

  // --------------------------------------------------------------- seam 10
  it("flows the submission outcomes through the derived notice status", async () => {
    const byRecipient = await profiles(pool);
    const target = await pendingSubmission("https://pirate.net/status-1");

    const noticeStatus = async (): Promise<string> =>
      (
        await world.app.inject({
          method: "GET",
          url: `/api/notices/${target.noticeId}`,
          headers: { cookie: admin.cookie },
        })
      ).json().status;

    expect(await noticeStatus()).toBe("approved");
    await post(`${target.submissionId}/delivery`, { attestation });
    expect(await noticeStatus()).toBe("delivered");
    await post(`${target.submissionId}/acknowledgement`, {
      attestation,
      acknowledgement: {
        recipient: "google",
        referenceNumber: "dmc-status-0001",
        dashboardUrl: "https://support.google.com/legal/removals/dashboard",
      },
    });
    expect(await noticeStatus()).toBe("acknowledged");

    const failed = await pendingSubmission("https://pirate.net/status-2");
    await post(`${failed.submissionId}/failure`, {
      reason: "recipient_error",
      note: "form outage",
    });
    const listed = await world.app.inject({
      method: "GET",
      url: "/api/notices?state=failed",
      headers: { cookie: admin.cookie },
    });
    expect(
      (listed.json().items as Array<{ id: string }>).map((item) => item.id),
    ).toEqual([failed.noticeId]);

    const rejected = await pendingSubmission("https://pirate.net/status-3");
    await post(`${rejected.submissionId}/failure`, {
      reason: "recipient_rejection",
      note: "refused",
    });
    const rejectedListed = await world.app.inject({
      method: "GET",
      url: "/api/notices?state=rejected",
      headers: { cookie: admin.cookie },
    });
    expect(
      (rejectedListed.json().items as Array<{ id: string }>).map((item) => item.id),
    ).toEqual([rejected.noticeId]);
    void byRecipient;
  });

  it("keeps the submissions surface to signed-in operators only", async () => {
    const anonymous = await world.app.inject({
      method: "GET",
      url: "/api/submissions",
    });
    expect(anonymous.statusCode).toBe(401);

    const target = await pendingSubmission("https://pirate.net/roles-1");
    // A plain operator records deliveries: the contract's role for every
    // Submissions operation.
    const operator = await inviteAndEnroll(world, admin, "operator@example.test", "operator");
    const delivered = await post(
      `${target.submissionId}/delivery`,
      { attestation },
      operator,
    );
    expect(delivered.statusCode).toBe(200);
  });
});
