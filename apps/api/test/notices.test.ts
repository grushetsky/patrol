import { beforeEach, describe, expect, it } from "vitest";
import {
  addOperator,
  bootstrapAdmin,
  harness,
  mutate,
  read,
  type Harness,
} from "./support/harness.js";
import type { ArtifactStore } from "../src/evidence/store.js";
import {
  STATEMENT_TEMPLATES,
  statementHash,
} from "../src/notices/templates.js";

const GROUP_ID = "01900000-0000-7000-8000-000000001001";
const TITLE_ID = "01900000-0000-7000-8000-000000001002";
const VARIANT_ID = "01900000-0000-7000-8000-000000001003";
const GOOGLE_PROFILE = "01900000-0000-7000-8000-000000001004";
const BING_PROFILE = "01900000-0000-7000-8000-000000001005";
const NOW = new Date("2026-11-04T12:00:00Z");

const objects = new Map<string, Buffer>();
const store: ArtifactStore = {
  async signedUrl(key) {
    return {
      url: `https://s3.test/${key}`,
      expiresAt: "2026-11-04T12:05:00.000Z",
    };
  },
  async put(key, body) {
    objects.set(key, body);
    return "v1";
  },
};

let h: Harness;
let session: string;
let adminId: string;

beforeEach(async () => {
  objects.clear();
  h = await harness(undefined, store);
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
  for (const [id, recipient, cap, formUrl] of [
    [GOOGLE_PROFILE, "google", 2, "https://reportcontent.google.com/forms/dmca_search"],
    [BING_PROFILE, "bing", 1_000, "https://www.bing.com/webmaster/contentremovalform/showcontentremovalform"],
  ] as const) {
    await h.db.query(
      `INSERT INTO recipient_profile
        (id, recipient, channel, account, contact_email, composition_trigger,
         window_time, eligible_territories, max_urls_per_notice,
         max_urls_per_file, max_urls_per_day, form_url,
         last_observed_max_urls_per_file, last_observed_daily_quota, paused,
         pause_reason, version, updated_by, updated_at)
       VALUES ($1, $2, 'web_form', 'operator@example.test', NULL, 'on_demand',
               '07:00:00', '[]', $3, $3, NULL, $4, NULL, NULL, false, NULL, 1,
               $5, $6)`,
      [id, recipient, cap, formUrl, adminId, now],
    );
  }
});

async function seedViolation(
  id: string,
  url: string,
  evidence: Array<{ id: string; outcome: string; observedAt: string }>,
) {
  const now = NOW.toISOString();
  const normalized = new URL(url).hostname + new URL(url).pathname;
  await h.db.query(
    `INSERT INTO violation
      (id, tracked_title_id, state, candidate_id, review_decision_id, url,
       normalized_url, host, host_source, registrable_domain, detected_at,
       confirmed_at, confirmed_by, engine, title_group_id)
     VALUES ($1, $2, 'open', $3, $4, $5, $6, 'example.test', 'landing_page',
             'example.test', $7, $7, $8, 'google', $9)`,
    [
      id,
      TITLE_ID,
      `candidate-${id}`,
      `decision-${id}`,
      url,
      normalized,
      now,
      adminId,
      GROUP_ID,
    ],
  );
  for (const item of evidence) {
    await h.db.query(
      `INSERT INTO evidence
        (id, tracked_title_id, title_group_id, requested_url,
         normalized_requested_url, redirect_chain, final_url, host, host_source,
         reason, capture_point, outcome, http_status, failure_reason,
         attempt_number, observed_at, profile, purged_at, purge_reason, created_at)
       VALUES ($1, $2, $3, $4, $5, '[]', $4, 'example.test', 'landing_page',
               'detection', NULL, $6, 200, NULL, 1, $7, 'default', NULL, NULL, $7)`,
      [
        item.id,
        TITLE_ID,
        GROUP_ID,
        url,
        normalized,
        item.outcome,
        new Date(item.observedAt),
      ],
    );
  }
}

async function compose(
  violationIds: string[],
  profileId = GOOGLE_PROFILE,
  recipient = "google",
) {
  return mutate(h.app, session, "POST", "/api/notices", {
    recipient,
    recipientProfileId: profileId,
    violationIds,
  });
}

async function approve(noticeId: string) {
  return mutate(h.app, session, "POST", `/api/notices/${noticeId}/approval`, {
    statementVersion: (
      await h.db.query("SELECT template_version FROM notice WHERE id = $1", [
        noticeId,
      ])
    ).rows[0].template_version,
    attestation: {
      reviewedViolations: true,
      currentStatements: true,
      authorizedSignatory: true,
    },
  });
}

describe("statement templates", () => {
  it("recomputes the checked-in fixture hashes", () => {
    expect(statementHash(STATEMENT_TEMPLATES[0].statements)).toBe("4ad3ef1527fe");
    expect(statementHash(STATEMENT_TEMPLATES[1].statements)).toBe("61c284fbec16");
    expect(statementHash(STATEMENT_TEMPLATES[2].statements)).toBe("2e177d094399");
  });
});

describe("notice composition", () => {
  it("splits a Google batch over the per-file cap", async () => {
    const ids = [
      "01900000-0000-7000-8000-000000001101",
      "01900000-0000-7000-8000-000000001102",
      "01900000-0000-7000-8000-000000001103",
    ];
    for (const [index, id] of ids.entries()) {
      await seedViolation(id, `https://example.test/film-${index}`, [
        {
          id: `01900000-0000-7000-8000-00000000210${index}`,
          outcome: "captured",
          observedAt: "2026-11-04T10:00:00Z",
        },
      ]);
    }
    const response = await compose(ids);
    expect(response.statusCode).toBe(201);
    const notices = await read(h.app, session, "/api/notices");
    expect(notices.json().total).toBe(2);
    expect(notices.json().items.every((item: { violationCount: number }) => item.violationCount <= 2)).toBe(true);
  });

  it("refuses a violation already reserved by another draft", async () => {
    const id = "01900000-0000-7000-8000-000000001111";
    await seedViolation(id, "https://example.test/reserved", [
      {
        id: "01900000-0000-7000-8000-000000002111",
        outcome: "captured",
        observedAt: "2026-11-04T10:00:00Z",
      },
    ]);
    expect((await compose([id])).statusCode).toBe(201);
    const second = await compose([id]);
    expect(second.statusCode).toBe(409);
    expect(second.json().code).toBe("violation_reserved");
  });
});

describe("approval and pack", () => {
  it("freezes citations, flags a dead capture, and keeps the pack hash stable", async () => {
    const violationId = "01900000-0000-7000-8000-000000001121";
    const earlier = "01900000-0000-7000-8000-000000002121";
    const dead = "01900000-0000-7000-8000-000000002122";
    await seedViolation(violationId, "https://example.test/dead-page", [
      { id: earlier, outcome: "captured", observedAt: "2026-11-01T10:00:00Z" },
      { id: dead, outcome: "dead", observedAt: "2026-11-04T10:00:00Z" },
    ]);
    const composed = await compose([violationId]);
    const noticeId = composed.json().notice.id as string;
    const approved = await approve(noticeId);
    expect(approved.statusCode).toBe(200);
    expect(approved.json().status).toBe("approved");

    const detail = await read(h.app, session, `/api/notices/${noticeId}`);
    expect(detail.json().notice.content.citedViolations[0].evidence[0].evidenceId).toBe(
      earlier,
    );

    const pack = await read(h.app, session, `/api/notices/${noticeId}/pack`);
    expect(pack.statusCode).toBe(200);
    expect(pack.json().captureFlags[0].newestOutcome).toBe("dead");
    expect(pack.json().captureFlags[0].earlierLiveEvidenceId).toBe(earlier);
    const firstHash = pack.json().packSha256 as string;

    await seedViolation(
      "01900000-0000-7000-8000-000000001122",
      "https://example.test/other",
      [
        {
          id: "01900000-0000-7000-8000-000000002123",
          outcome: "captured",
          observedAt: "2026-11-04T11:00:00Z",
        },
      ],
    );
    const again = await read(h.app, session, `/api/notices/${noticeId}/pack`);
    expect(again.json().packSha256).toBe(firstHash);
  });

  it("waits for pre-handoff captures before freezing the pack", async () => {
    const violationId = "01900000-0000-7000-8000-000000001125";
    await seedViolation(violationId, "https://example.test/old-capture", [
      {
        id: "01900000-0000-7000-8000-000000002125",
        outcome: "captured",
        observedAt: "2026-10-01T10:00:00Z",
      },
    ]);
    const composed = await compose([violationId]);
    const noticeId = composed.json().notice.id as string;
    const approved = await approve(noticeId);
    expect(approved.statusCode).toBe(200);
    expect(approved.json().queuedCaptures).toBe(1);
    expect(approved.json().submission).toBeUndefined();

    const notReady = await read(h.app, session, `/api/notices/${noticeId}/pack`);
    expect(notReady.statusCode).toBe(409);
    expect(notReady.json().code).toBe("pack_not_ready");

    await h.db.query(
      "UPDATE capture_request SET state = 'finished', finished_at = $1 WHERE capture_point LIKE $2",
      [NOW, `pre_handoff:${noticeId}:%`],
    );
    const ready = await read(h.app, session, `/api/notices/${noticeId}/pack`);
    expect(ready.statusCode).toBe(200);
  });

  it("blocks approval of a stale template", async () => {
    const violationId = "01900000-0000-7000-8000-000000001131";
    await seedViolation(violationId, "https://example.test/stale", [
      {
        id: "01900000-0000-7000-8000-000000002131",
        outcome: "captured",
        observedAt: "2026-11-04T10:00:00Z",
      },
    ]);
    const composed = await compose([violationId]);
    await h.db.query(
      "UPDATE notice_template SET verified_at = $1",
      [new Date("2026-07-01T00:00:00Z")],
    );
    const response = await approve(composed.json().notice.id);
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("state_conflict");
  });

  it("freezes the pack language at approval", async () => {
    await h.db.query(
      "UPDATE operator_account SET preferred_language = 'ru' WHERE id = $1",
      [adminId],
    );
    const violationId = "01900000-0000-7000-8000-000000001141";
    await seedViolation(violationId, "https://example.test/language", [
      {
        id: "01900000-0000-7000-8000-000000002141",
        outcome: "captured",
        observedAt: "2026-11-04T10:00:00Z",
      },
    ]);
    const composed = await compose([violationId]);
    const noticeId = composed.json().notice.id as string;
    const approved = await approve(noticeId);
    expect(approved.json().submission.packLanguage).toBe("ru");

    await h.db.query(
      "UPDATE operator_account SET preferred_language = 'en' WHERE id = $1",
      [adminId],
    );
    const submissionId = approved.json().submission.id as string;
    const submission = await read(h.app, session, `/api/submissions/${submissionId}`);
    expect(submission.json().submission.packLanguage).toBe("ru");
  });
});

describe("withdrawal and supersession", () => {
  it("refuses withdrawal after delivery", async () => {
    const violationId = "01900000-0000-7000-8000-000000001151";
    await seedViolation(violationId, "https://example.test/withdraw", [
      {
        id: "01900000-0000-7000-8000-000000002151",
        outcome: "captured",
        observedAt: "2026-11-04T10:00:00Z",
      },
    ]);
    const composed = await compose([violationId]);
    const approved = await approve(composed.json().notice.id);
    const submissionId = approved.json().submission.id as string;
    expect(
      (
        await mutate(h.app, session, "POST", `/api/submissions/${submissionId}/delivery`, {
          attestation: {
            filedAsPresented: true,
            statementVersion: approved.json().notice.content.templateVersion,
          },
        })
      ).statusCode,
    ).toBe(200);
    const response = await mutate(
      h.app,
      session,
      "POST",
      `/api/notices/${composed.json().notice.id}/withdrawal`,
      { reason: "Too late" },
    );
    expect(response.statusCode).toBe(409);
  });

  it("cancels a pending submission and creates the replacement draft", async () => {
    const ids = [
      "01900000-0000-7000-8000-000000001161",
      "01900000-0000-7000-8000-000000001162",
    ];
    for (const [index, id] of ids.entries()) {
      await seedViolation(id, `https://example.test/replace-${index}`, [
        {
          id: `01900000-0000-7000-8000-00000000216${index}`,
          outcome: "captured",
          observedAt: "2026-11-04T10:00:00Z",
        },
      ]);
    }
    const composed = await compose(ids);
    const noticeId = composed.json().notice.id as string;
    const approved = await approve(noticeId);
    const replacementViolation = "01900000-0000-7000-8000-000000001163";
    await seedViolation(replacementViolation, "https://example.test/replacement", [
      {
        id: "01900000-0000-7000-8000-000000002163",
        outcome: "captured",
        observedAt: "2026-11-04T10:00:00Z",
      },
    ]);
    const response = await mutate(
      h.app,
      session,
      "POST",
      `/api/notices/${noticeId}/supersession`,
      { citedViolationIds: [replacementViolation] },
    );
    expect(response.statusCode).toBe(200);
    expect(response.json().superseded.lifecycle.state).toBe("superseded");
    expect(response.json().draft.notice.lifecycle.state).toBe("draft");
    const cancelled = await read(
      h.app,
      session,
      `/api/submissions/${approved.json().submission.id}`,
    );
    expect(cancelled.json().submission.cancelledAt).toBeDefined();
  });
});

describe("rejection threshold", () => {
  it("pauses the profile but leaves on-demand drafting available", async () => {
    const violationId = "01900000-0000-7000-8000-000000001171";
    await seedViolation(violationId, "https://example.test/rejected", [
      {
        id: "01900000-0000-7000-8000-000000002171",
        outcome: "captured",
        observedAt: "2026-11-04T10:00:00Z",
      },
    ]);
    const composed = await compose([violationId]);
    const approved = await approve(composed.json().notice.id);
    const submissionId = approved.json().submission.id as string;
    const failed = await mutate(
      h.app,
      session,
      "POST",
      `/api/submissions/${submissionId}/failure`,
      { reason: "recipient_rejection", note: "Wrong form field" },
    );
    expect(failed.statusCode).toBe(200);
    const profile = await h.db.query(
      "SELECT paused FROM recipient_profile WHERE id = $1",
      [GOOGLE_PROFILE],
    );
    expect(profile.rows[0].paused).toBe(true);

    const second = "01900000-0000-7000-8000-000000001172";
    await seedViolation(second, "https://example.test/on-demand", [
      {
        id: "01900000-0000-7000-8000-000000002172",
        outcome: "captured",
        observedAt: "2026-11-04T10:00:00Z",
      },
    ]);
    expect((await compose([second])).statusCode).toBe(201);

    const other = await addOperator(h.auth, adminId, "second@example.test");
    expect(other.operator.id).not.toBe(adminId);
    const third = "01900000-0000-7000-8000-000000001173";
    await seedViolation(third, "https://example.test/second-check", [
      {
        id: "01900000-0000-7000-8000-000000002173",
        outcome: "captured",
        observedAt: "2026-11-04T10:00:00Z",
      },
    ]);
    const thirdNotice = await compose([third]);
    await approve(thirdNotice.json().notice.id);
    const check = await h.db.query(
      "SELECT second_operator_check FROM notice WHERE id = $1",
      [thirdNotice.json().notice.id],
    );
    expect(JSON.parse(String(check.rows[0].second_operator_check))).toMatchObject({
      required: true,
      secondOperatorExists: true,
    });
  });
});
