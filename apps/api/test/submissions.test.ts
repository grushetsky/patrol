import { beforeEach, describe, expect, it } from "vitest";
import {
  bootstrapAdmin,
  harness,
  mutate,
  read,
  type Harness,
} from "./support/harness.js";

const GROUP_ID = "01900000-0000-7000-8000-000000001001";
const TITLE_ID = "01900000-0000-7000-8000-000000001002";
const VARIANT_ID = "01900000-0000-7000-8000-000000001003";
const GOOGLE_PROFILE = "01900000-0000-7000-8000-000000001004";
const BING_PROFILE = "01900000-0000-7000-8000-000000001005";
const NOW = new Date("2026-11-04T12:00:00Z");

let h: Harness;
let session: string;
let adminId: string;

beforeEach(async () => {
  h = await harness();
  const admin = await bootstrapAdmin(h);
  session = admin.session;
  adminId = admin.operator.id;
  const now = NOW.toISOString();
  await h.db.query(
    `INSERT INTO title_group
      (id, name, locales, scan_time, priority, created_at, updated_at)
     VALUES ($1, 'Group', '["en-US"]', '02:00:00', 'normal', $2, $2)`,
    [GROUP_ID, now],
  );
  await h.db.query(
    `INSERT INTO tracked_title
      (id, title_group_id, release_year, title_type, runtime_minutes,
       original_variant_id, paused, merged_into_title_id, source, entered_by,
       entered_at, updated_by, created_at, updated_at)
     VALUES ($1, $2, 2026, 'film', 90, $3, false, NULL, 'operator_knowledge',
             'seed', $4, 'seed', $4, $4)`,
    [TITLE_ID, GROUP_ID, VARIANT_ID, now],
  );
  await h.db.query(
    `INSERT INTO title_variant
      (id, tracked_title_id, text, normalized_text, kind, language, script,
       territory, source, added_by, added_at)
     VALUES ($1, $2, 'Fixture film', 'fixture film', 'original', 'en', 'Latn',
             NULL, 'operator_knowledge', 'seed', $3)`,
    [VARIANT_ID, TITLE_ID, now],
  );
  for (const [id, recipient, formUrl] of [
    [GOOGLE_PROFILE, "google", "https://reportcontent.google.com/forms/dmca_search"],
    [BING_PROFILE, "bing", "https://www.bing.com/webmaster/contentremovalform/showcontentremovalform"],
  ] as const) {
    await h.db.query(
      `INSERT INTO recipient_profile
        (id, recipient, channel, account, contact_email, composition_trigger,
         window_time, eligible_territories, max_urls_per_notice,
         max_urls_per_file, max_urls_per_day, form_url,
         last_observed_max_urls_per_file, last_observed_daily_quota, paused,
         pause_reason, version, updated_by, updated_at)
       VALUES ($1, $2, 'web_form', 'operator@example.test', NULL, 'on_demand',
               '07:00:00', '[]', 500, 500, NULL, $3, NULL, NULL, false, NULL, 1,
               $4, $5)`,
      [id, recipient, formUrl, adminId, now],
    );
  }
});

async function approveNotice(
  suffix: string,
  recipient: "google" | "bing" = "google",
): Promise<{
  noticeId: string;
  submissionId: string;
  statementVersion: string;
}> {
  const violationId = `01900000-0000-7000-8000-0000000011${suffix}`;
  const evidenceId = `01900000-0000-7000-8000-0000000021${suffix}`;
  const url = `https://example.test/case-${suffix}`;
  const now = NOW.toISOString();
  await h.db.query(
    `INSERT INTO violation
      (id, tracked_title_id, state, candidate_id, review_decision_id, url,
       normalized_url, host, host_source, registrable_domain, detected_at,
       confirmed_at, confirmed_by, engine, title_group_id)
     VALUES ($1, $2, 'open', $3, $4, $5, $6, 'example.test', 'landing_page',
             'example.test', $7, $7, $8, 'google', $9)`,
    [
      violationId,
      TITLE_ID,
      `candidate-${violationId}`,
      `decision-${violationId}`,
      url,
      new URL(url).hostname + new URL(url).pathname,
      now,
      adminId,
      GROUP_ID,
    ],
  );
  await h.db.query(
    `INSERT INTO evidence
      (id, tracked_title_id, title_group_id, requested_url,
       normalized_requested_url, redirect_chain, final_url, host, host_source,
       reason, capture_point, outcome, http_status, failure_reason,
       attempt_number, observed_at, profile, purged_at, purge_reason, created_at)
     VALUES ($1, $2, $3, $4, $5, '[]', $4, 'example.test', 'landing_page',
             'detection', NULL, 'captured', 200, NULL, 1, $6, 'default', NULL,
             NULL, $6)`,
    [
      evidenceId,
      TITLE_ID,
      GROUP_ID,
      url,
      new URL(url).hostname + new URL(url).pathname,
      new Date("2026-11-04T10:00:00Z"),
    ],
  );
  const profileId = recipient === "google" ? GOOGLE_PROFILE : BING_PROFILE;
  const composed = await mutate(h.app, session, "POST", "/api/notices", {
    recipient,
    recipientProfileId: profileId,
    violationIds: [violationId],
  });
  expect(composed.statusCode).toBe(201);
  const noticeId = composed.json().notice.id as string;
  const statementVersion = (
    await h.db.query("SELECT template_version FROM notice WHERE id = $1", [
      noticeId,
    ])
  ).rows[0].template_version as string;
  const approved = await mutate(
    h.app,
    session,
    "POST",
    `/api/notices/${noticeId}/approval`,
    {
      statementVersion,
      attestation: {
        reviewedViolations: true,
        currentStatements: true,
        authorizedSignatory: true,
      },
    },
  );
  expect(approved.statusCode).toBe(200);
  return {
    noticeId,
    submissionId: approved.json().submission.id as string,
    statementVersion,
  };
}

function attestation(statementVersion: string) {
  return { filedAsPresented: true, statementVersion };
}

function googleAck(referenceNumber = "1-2345678901") {
  return {
    recipient: "google",
    referenceNumber,
    dashboardUrl: "https://reportcontent.google.com/forms/dmca_search",
  };
}

function bingAck(ticketId = "TICKET-1234") {
  return {
    recipient: "bing",
    ticketId,
    ticketDetailsUrl: `https://www.bing.com/webmaster/contentremovalform/ticketdetails?ticketId=${ticketId}`,
  };
}

describe("submission lifecycle", () => {
  it("moves pending to delivered to acknowledged with the declared fields", async () => {
    const { noticeId, submissionId, statementVersion } =
      await approveNotice("01");

    const pending = await read(h.app, session, `/api/submissions/${submissionId}`);
    expect(pending.statusCode).toBe(200);
    expect(pending.json().submission.lifecycle.state).toBe("pending");
    expect(pending.json().submission.attemptCount).toBe(1);
    expect(pending.json().notice.id).toBe(noticeId);

    const delivered = await mutate(
      h.app,
      session,
      "POST",
      `/api/submissions/${submissionId}/delivery`,
      { attestation: attestation(statementVersion) },
    );
    expect(delivered.statusCode).toBe(200);
    expect(delivered.json().lifecycle).toMatchObject({
      state: "delivered",
      operatorId: adminId,
      attestation: {
        filedAsPresented: true,
        statementVersion,
      },
    });
    expect(delivered.json().lifecycle.deliveredAt).toBeDefined();
    expect(delivered.json().lifecycle.attestation.attestedAt).toBeDefined();

    const acknowledged = await mutate(
      h.app,
      session,
      "POST",
      `/api/submissions/${submissionId}/acknowledgement`,
      {
        attestation: attestation(statementVersion),
        acknowledgement: googleAck(),
      },
    );
    expect(acknowledged.statusCode).toBe(200);
    expect(acknowledged.json().lifecycle).toMatchObject({
      state: "acknowledged",
      operatorId: adminId,
      acknowledgement: {
        recipient: "google",
        referenceNumber: "1-2345678901",
      },
    });
    expect(acknowledged.json().lifecycle.deliveredAt).toBeDefined();

    const notice = await read(h.app, session, `/api/notices/${noticeId}`);
    expect(notice.json().status).toBe("acknowledged");
    expect(notice.json().submission.lifecycle.state).toBe("acknowledged");
  });

  it("refuses an acknowledgement for the wrong recipient", async () => {
    const { submissionId, statementVersion } = await approveNotice("02");
    await mutate(
      h.app,
      session,
      "POST",
      `/api/submissions/${submissionId}/delivery`,
      { attestation: attestation(statementVersion) },
    );

    const wrong = await mutate(
      h.app,
      session,
      "POST",
      `/api/submissions/${submissionId}/acknowledgement`,
      {
        attestation: attestation(statementVersion),
        acknowledgement: bingAck(),
      },
    );
    expect(wrong.statusCode).toBe(422);
    expect(wrong.json().code).toBe("validation_failed");
    expect(
      wrong.json().fieldErrors.some(
        (issue: { path: string }) => issue.path === "/acknowledgement/recipient",
      ),
    ).toBe(true);

    const missingFields = await mutate(
      h.app,
      session,
      "POST",
      `/api/submissions/${submissionId}/acknowledgement`,
      {
        attestation: attestation(statementVersion),
        acknowledgement: { recipient: "bing", ticketId: "TICKET-1234" },
      },
    );
    expect(missingFields.statusCode).toBe(400);
  });

  it("keeps one row on retry and raises the attempt count", async () => {
    const { noticeId, submissionId, statementVersion } =
      await approveNotice("03");
    const failed = await mutate(
      h.app,
      session,
      "POST",
      `/api/submissions/${submissionId}/failure`,
      { reason: "recipient_error", note: "The form rejected the upload." },
    );
    expect(failed.statusCode).toBe(200);
    expect(failed.json().lifecycle.state).toBe("failed");

    const retried = await mutate(
      h.app,
      session,
      "POST",
      `/api/submissions/${submissionId}/retry`,
    );
    expect(retried.statusCode).toBe(200);
    expect(retried.json().id).toBe(submissionId);
    expect(retried.json().attemptCount).toBe(2);
    expect(retried.json().lifecycle.state).toBe("pending");

    const delivered = await mutate(
      h.app,
      session,
      "POST",
      `/api/submissions/${submissionId}/delivery`,
      { attestation: attestation(statementVersion) },
    );
    expect(delivered.statusCode).toBe(200);
    expect(delivered.json().id).toBe(submissionId);

    const list = await read(
      h.app,
      session,
      `/api/submissions?noticeId=${noticeId}`,
    );
    expect(list.json().total).toBe(1);
    expect(list.json().items[0].submission.id).toBe(submissionId);
  });

  it("refuses a rejection without a cause note and does not retry it unchanged", async () => {
    const { submissionId } = await approveNotice("04");
    const missingNote = await mutate(
      h.app,
      session,
      "POST",
      `/api/submissions/${submissionId}/failure`,
      { reason: "recipient_rejection", note: "  " },
    );
    expect(missingNote.statusCode).toBe(422);
    expect(missingNote.json().code).toBe("note_required");

    const rejected = await mutate(
      h.app,
      session,
      "POST",
      `/api/submissions/${submissionId}/failure`,
      {
        reason: "recipient_rejection",
        note: "The recipient refused the notice as a duplicate filing.",
      },
    );
    expect(rejected.statusCode).toBe(200);
    expect(rejected.json().lifecycle.state).toBe("rejected");
    expect(rejected.json().lifecycle.failure.note).toContain("duplicate");

    const retried = await mutate(
      h.app,
      session,
      "POST",
      `/api/submissions/${submissionId}/retry`,
    );
    expect(retried.statusCode).toBe(409);
    expect(retried.json().code).toBe("state_conflict");
  });

  it("flags a submission after three failed attempts", async () => {
    const { submissionId } = await approveNotice("05");
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const failed = await mutate(
        h.app,
        session,
        "POST",
        `/api/submissions/${submissionId}/failure`,
        { reason: "recipient_error", note: `Attempt ${attempt} failed.` },
      );
      expect(failed.statusCode).toBe(200);
      if (attempt < 3) {
        const retried = await mutate(
          h.app,
          session,
          "POST",
          `/api/submissions/${submissionId}/retry`,
        );
        expect(retried.statusCode).toBe(200);
      }
    }

    const detail = await read(
      h.app,
      session,
      `/api/submissions/${submissionId}`,
    );
    expect(detail.json().submission.attemptCount).toBe(3);
    expect(detail.json().submission.lifecycle.state).toBe("failed");
    expect(detail.json().flaggedForAdministrator).toBe(true);

    const list = await read(h.app, session, "/api/submissions?state=failed");
    expect(list.json().items[0].flaggedForAdministrator).toBe(true);

    await mutate(
      h.app,
      session,
      "POST",
      `/api/submissions/${submissionId}/retry`,
    );
    const retried = await read(
      h.app,
      session,
      `/api/submissions/${submissionId}`,
    );
    expect(retried.json().flaggedForAdministrator).toBe(false);
  });

  it("surfaces a pending submission older than seven days in the backlog", async () => {
    const { submissionId } = await approveNotice("06");
    const fresh = await read(h.app, session, "/api/submissions?olderThanDays=7");
    expect(fresh.json().total).toBe(0);

    await h.db.query("UPDATE submission SET created_at = $2 WHERE id = $1", [
      submissionId,
      new Date(NOW.getTime() - 8 * 24 * 60 * 60 * 1000),
    ]);
    const stale = await read(h.app, session, "/api/submissions?olderThanDays=7");
    expect(stale.statusCode).toBe(200);
    expect(stale.json().total).toBe(1);
    expect(stale.json().items[0].submission.id).toBe(submissionId);

    await h.db.query("UPDATE submission SET cancelled_at = $2 WHERE id = $1", [
      submissionId,
      NOW,
    ]);
    const cancelled = await read(
      h.app,
      session,
      "/api/submissions?olderThanDays=7",
    );
    expect(cancelled.json().total).toBe(0);
  });

  it("refuses transitions the state machine does not declare", async () => {
    const { submissionId, statementVersion } = await approveNotice("07");
    const earlyAck = await mutate(
      h.app,
      session,
      "POST",
      `/api/submissions/${submissionId}/acknowledgement`,
      {
        attestation: attestation(statementVersion),
        acknowledgement: googleAck(),
      },
    );
    expect(earlyAck.statusCode).toBe(409);

    const earlyRetry = await mutate(
      h.app,
      session,
      "POST",
      `/api/submissions/${submissionId}/retry`,
    );
    expect(earlyRetry.statusCode).toBe(409);

    await mutate(
      h.app,
      session,
      "POST",
      `/api/submissions/${submissionId}/delivery`,
      { attestation: attestation(statementVersion) },
    );
    const lateFailure = await mutate(
      h.app,
      session,
      "POST",
      `/api/submissions/${submissionId}/failure`,
      { reason: "recipient_error", note: "Reported after delivery." },
    );
    expect(lateFailure.statusCode).toBe(409);
    const secondDelivery = await mutate(
      h.app,
      session,
      "POST",
      `/api/submissions/${submissionId}/delivery`,
      { attestation: attestation(statementVersion) },
    );
    expect(secondDelivery.statusCode).toBe(409);
  });

  it("accepts Bing's ticket acknowledgement for a Bing notice", async () => {
    const { submissionId, statementVersion } = await approveNotice("08", "bing");
    await mutate(
      h.app,
      session,
      "POST",
      `/api/submissions/${submissionId}/delivery`,
      { attestation: attestation(statementVersion) },
    );
    const acknowledged = await mutate(
      h.app,
      session,
      "POST",
      `/api/submissions/${submissionId}/acknowledgement`,
      {
        attestation: attestation(statementVersion),
        acknowledgement: bingAck("BING-42"),
      },
    );
    expect(acknowledged.statusCode).toBe(200);
    expect(acknowledged.json().lifecycle.acknowledgement).toMatchObject({
      recipient: "bing",
      ticketId: "BING-42",
    });
  });
});
