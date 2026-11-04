import { beforeEach, describe, expect, it } from "vitest";
import {
  bootstrapAdmin,
  harness,
  mutate,
  read,
  type Harness,
} from "./support/harness.js";

const GROUP_ID = "01900000-0000-7000-8000-000000000001";
const TITLE_A = "01900000-0000-7000-8000-000000000002";
const TITLE_B = "01900000-0000-7000-8000-000000000003";
const VARIANT_A = "01900000-0000-7000-8000-000000000004";
const VARIANT_B = "01900000-0000-7000-8000-000000000005";
const EVIDENCE = "01900000-0000-7000-8000-000000000006";
const URL = "https://example.test/fixture-film";
const NORMALIZED = "example.test/fixture-film";

let h: Harness;
let session: string;

beforeEach(async () => {
  h = await harness();
  const admin = await bootstrapAdmin(h);
  session = admin.session;
  const now = new Date().toISOString();
  await h.db.query(
    `INSERT INTO title_group
      (id, name, locales, scan_time, priority, created_at, updated_at)
     VALUES ($1, 'Fixture group', '["en-US"]', '03:15', 'normal', $2, $2)`,
    [GROUP_ID, now],
  );
  for (const [titleId, variantId, text] of [
    [TITLE_A, VARIANT_A, "Fixture film"],
    [TITLE_B, VARIANT_B, "Fixture film two"],
  ]) {
    await h.db.query(
      `INSERT INTO tracked_title
        (id, title_group_id, release_year, title_type, runtime_minutes,
         original_variant_id, paused, merged_into_title_id, source, entered_by,
         entered_at, updated_by, created_at, updated_at)
       VALUES ($1, $2, 2026, 'film', 90, $3, false, NULL, 'operator_knowledge',
               'seed', $4, 'seed', $4, $4)`,
      [titleId, GROUP_ID, variantId, now],
    );
    await h.db.query(
      `INSERT INTO title_variant
        (id, tracked_title_id, text, normalized_text, kind, language, script,
         territory, source, added_by, added_at)
       VALUES ($1, $2, $3, $3, 'original', 'en', 'Latn', NULL,
               'operator_knowledge', 'seed', $4)`,
      [variantId, titleId, text.toLowerCase(), now],
    );
  }
  await h.db.query(
    `INSERT INTO evidence
      (id, tracked_title_id, title_group_id, requested_url,
       normalized_requested_url, redirect_chain, final_url, host, host_source,
       reason, capture_point, outcome, http_status, failure_reason,
       attempt_number, observed_at, profile, purged_at, purge_reason, created_at)
     VALUES ($1, $2, $3, $4, $5, '[]', $4, 'example.test', 'destination',
             'detection', NULL, 'captured', 200, NULL, 1, $6, 'default',
             NULL, NULL, $6)`,
    [EVIDENCE, TITLE_A, GROUP_ID, URL, NORMALIZED, now],
  );
});

async function seedCandidate(
  id: string,
  titleId: string,
  variantId: string,
  options: {
    score?: number;
    rank?: number;
    url?: string;
    normalized?: string;
    allowlistEntryId?: string;
    observedAt?: string;
    signals?: Array<{ kind: string; value: number }>;
  } = {},
) {
  const now = options.observedAt ?? new Date().toISOString();
  await h.db.query(
    `INSERT INTO candidate
      (id, tracked_title_id, state, url, normalized_url, host,
       registrable_domain, source, engine, rank, query_text, locale,
       matched_variant_id, matched_variant, score, score_components,
       reputation, allowlist_entry_id, first_observed_at, last_observed_at,
       created_at)
     VALUES ($1, $2, 'pending', $3, $4, 'example.test', 'example.test', 'serp',
             'google', $5, 'fixture film', 'en-US', $6, $7, $8, $9, $10, $11,
             $12, $12, $12)`,
    [
      id,
      titleId,
      options.url ?? URL,
      options.normalized ?? NORMALIZED,
      options.rank ?? 1,
      variantId,
      JSON.stringify({
        id: variantId,
        text: "Fixture film",
        kind: "original",
        language: "en",
        script: "Latn",
      }),
      options.score ?? 0.7,
      JSON.stringify({
        titleMatch: 0.7,
        signals: options.signals ?? [],
        reputation: 0,
      }),
      JSON.stringify({
        registrableDomain: "example.test",
        confirmedViolations: 0,
        bonus: 0,
        blocklisted: false,
      }),
      options.allowlistEntryId ?? null,
      now,
    ],
  );
}

describe("manual candidates", () => {
  it("returns the existing pair instead of creating a duplicate", async () => {
    const first = await mutate(h.app, session, "POST", "/api/candidates", {
      url: "https://example.test/manual-film",
      trackedTitleId: TITLE_A,
    });
    expect(first.statusCode).toBe(201);
    expect(h.contract.validate("Candidate", first.json()).issues).toEqual([]);

    const second = await mutate(h.app, session, "POST", "/api/candidates", {
      url: "https://example.test/manual-film",
      trackedTitleId: TITLE_A,
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().id).toBe(first.json().id);
  });
});

describe("review queue", () => {
  it("orders by score, then rank, then observation time", async () => {
    await seedCandidate("01900000-0000-7000-8000-000000000010", TITLE_A, VARIANT_A, {
      score: 0.7,
      rank: 1,
      url: "https://example.test/low",
      normalized: "example.test/low",
      observedAt: "2026-11-04T10:00:00.000Z",
    });
    await seedCandidate("01900000-0000-7000-8000-000000000011", TITLE_A, VARIANT_A, {
      score: 0.9,
      rank: 5,
      url: "https://example.test/high",
      normalized: "example.test/high",
      observedAt: "2026-11-04T09:00:00.000Z",
    });
    await seedCandidate("01900000-0000-7000-8000-000000000012", TITLE_A, VARIANT_A, {
      score: 0.9,
      rank: 2,
      url: "https://example.test/rank",
      normalized: "example.test/rank",
      observedAt: "2026-11-04T11:00:00.000Z",
    });

    const response = await read(h.app, session, "/api/candidates");
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.items.map((row: { id: string }) => row.id)).toEqual([
      "01900000-0000-7000-8000-000000000012",
      "01900000-0000-7000-8000-000000000011",
      "01900000-0000-7000-8000-000000000010",
    ]);
    expect(h.contract.validate("CandidateReviewRow", body.items[0]).issues).toEqual(
      [],
    );
  });

  it("refuses a wrong-work decision without the correct title", async () => {
    await seedCandidate("01900000-0000-7000-8000-000000000013", TITLE_A, VARIANT_A);
    const response = await mutate(
      h.app,
      session,
      "POST",
      "/api/candidates/01900000-0000-7000-8000-000000000013/review-decisions",
      { action: "wrong_work", evidenceIds: [EVIDENCE] },
    );
    expect(response.statusCode).toBe(422);
    expect(response.json().fieldErrors[0].path).toBe(
      "/rematchedTrackedTitleId",
    );
  });

  it("scopes a dismissal to one URL and title pair", async () => {
    await seedCandidate("01900000-0000-7000-8000-000000000014", TITLE_A, VARIANT_A, {
      signals: [{ kind: "download", value: 0.25 }],
    });
    await seedCandidate("01900000-0000-7000-8000-000000000015", TITLE_B, VARIANT_B);

    const dismissed = await mutate(
      h.app,
      session,
      "POST",
      "/api/candidates/01900000-0000-7000-8000-000000000014/review-decisions",
      {
        action: "not_a_violation",
        note: "Authorized copy",
        evidenceIds: [EVIDENCE],
      },
    );
    expect(dismissed.statusCode).toBe(201);
    expect(dismissed.json().candidate.lifecycle.state).toBe("dismissed");
    const stored = await h.db.query(
      "SELECT dismissal_signals FROM candidate WHERE id = $1",
      ["01900000-0000-7000-8000-000000000014"],
    );
    expect(JSON.parse(String(stored.rows[0].dismissal_signals))).toEqual([
      "download",
    ]);

    const pending = await read(h.app, session, "/api/candidates?state=pending");
    expect(pending.json().items.map((row: { id: string }) => row.id)).toEqual([
      "01900000-0000-7000-8000-000000000015",
    ]);

    const reopened = await mutate(
      h.app,
      session,
      "POST",
      "/api/candidates/01900000-0000-7000-8000-000000000014/reopen",
      { note: "Recheck" },
    );
    expect(reopened.statusCode).toBe(200);
    expect(reopened.json().lifecycle.state).toBe("pending");
  });

  it("creates a violation only from a confirmation and shares evidence", async () => {
    await seedCandidate("01900000-0000-7000-8000-000000000014", TITLE_A, VARIANT_A);
    await seedCandidate("01900000-0000-7000-8000-000000000015", TITLE_B, VARIANT_B);

    const first = await mutate(
      h.app,
      session,
      "POST",
      "/api/candidates/01900000-0000-7000-8000-000000000014/review-decisions",
      { action: "violation", evidenceIds: [EVIDENCE] },
    );
    expect(first.statusCode).toBe(201);
    expect(first.json().violation.lifecycle.state).toBe("open");

    const second = await mutate(
      h.app,
      session,
      "POST",
      "/api/candidates/01900000-0000-7000-8000-000000000015/review-decisions",
      { action: "violation", evidenceIds: [EVIDENCE] },
    );
    expect(second.statusCode).toBe(201);

    const detail = await read(
      h.app,
      session,
      `/api/violations/${first.json().violation.id}`,
    );
    expect(detail.statusCode).toBe(200);
    expect(detail.json().evidence[0].evidence.id).toBe(EVIDENCE);
    expect(h.contract.validate("ViolationDetail", detail.json()).issues).toEqual(
      [],
    );

    const violations = await read(h.app, session, "/api/violations");
    expect(violations.json().total).toBe(2);
    const citations = await h.db.query(
      "SELECT COUNT(*)::int AS count FROM violation_evidence WHERE evidence_id = $1",
      [EVIDENCE],
    );
    expect(Number(citations.rows[0]?.count)).toBe(2);

    const again = await mutate(
      h.app,
      session,
      "POST",
      "/api/candidates/01900000-0000-7000-8000-000000000014/review-decisions",
      { action: "violation", evidenceIds: [EVIDENCE] },
    );
    expect(again.statusCode).toBe(409);
    expect(again.json().currentState).toBe("confirmed");
  });

  it("refuses confirmation when an allowlist entry hits the URL", async () => {
    await h.db.query(
      `INSERT INTO allowlist_entry
        (id, kind, match_kind, value, scope, title_group_id, tracked_title_id,
         territory, origin, proposed_by_decision_id, confirmed_by, confirmed_at)
       VALUES ('01900000-0000-7000-8000-000000000016', 'official_domain', 'host', 'example.test',
               'rights_holder', NULL, NULL, NULL, 'operator', NULL, 'admin', $1)`,
      [new Date().toISOString()],
    );
    await seedCandidate("01900000-0000-7000-8000-000000000014", TITLE_A, VARIANT_A);
    const response = await mutate(
      h.app,
      session,
      "POST",
      "/api/candidates/01900000-0000-7000-8000-000000000014/review-decisions",
      { action: "violation", evidenceIds: [EVIDENCE] },
    );
    expect(response.statusCode).toBe(422);
    expect(response.json().code).toBe("allowlist_hit");
  });

  it("closes a violation only with a note and never twice", async () => {
    await seedCandidate("01900000-0000-7000-8000-000000000014", TITLE_A, VARIANT_A);
    const confirmed = await mutate(
      h.app,
      session,
      "POST",
      "/api/candidates/01900000-0000-7000-8000-000000000014/review-decisions",
      { action: "violation", evidenceIds: [EVIDENCE] },
    );
    const violationId = confirmed.json().violation.id as string;

    const missingNote = await mutate(
      h.app,
      session,
      "POST",
      `/api/violations/${violationId}/closure`,
      { reason: "operator_closed" },
    );
    expect(missingNote.statusCode).toBe(422);
    expect(missingNote.json().code).toBe("note_required");

    const closed = await mutate(
      h.app,
      session,
      "POST",
      `/api/violations/${violationId}/closure`,
      { reason: "operator_closed", note: "Gone after re-check" },
    );
    expect(closed.statusCode).toBe(200);
    expect(closed.json().lifecycle.state).toBe("closed");

    const again = await mutate(
      h.app,
      session,
      "POST",
      `/api/violations/${violationId}/closure`,
      { reason: "operator_closed", note: "Again" },
    );
    expect(again.statusCode).toBe(409);

    const candidate = await read(
      h.app,
      session,
      "/api/candidates/01900000-0000-7000-8000-000000000014",
    );
    expect(candidate.json().candidate.lifecycle.state).toBe("pending");

    const reconfirmed = await mutate(
      h.app,
      session,
      "POST",
      "/api/candidates/01900000-0000-7000-8000-000000000014/review-decisions",
      { action: "violation", evidenceIds: [EVIDENCE] },
    );
    expect(reconfirmed.statusCode).toBe(201);
    expect(reconfirmed.json().violation.predecessorViolationId).toBe(
      violationId,
    );
  });
});
