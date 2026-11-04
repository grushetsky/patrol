import { beforeEach, describe, expect, it } from "vitest";
import type { Connectable } from "../../api/src/db/migrations.js";
import { purgeExpired } from "../src/retention/purge.js";
import { memoryDb } from "./support.js";

const NOW = new Date("2026-11-05T03:00:00Z");

class FakeStore {
  readonly deleted: Array<{ key: string; version: string | null }> = [];

  async delete(key: string, version: string | null) {
    this.deleted.push({ key, version });
  }
}

let db: Connectable;
let store: FakeStore;

beforeEach(async () => {
  db = await memoryDb();
  store = new FakeStore();
});

async function seedEvidence(
  id: string,
  observedAt: Date,
  options: { purgedAt?: Date; artifact?: string } = {},
) {
  await db.query(
    `INSERT INTO evidence
      (id, tracked_title_id, title_group_id, requested_url,
       normalized_requested_url, redirect_chain, final_url, host, host_source,
       reason, capture_point, outcome, http_status, failure_reason,
       attempt_number, observed_at, profile, purged_at, purge_reason, created_at)
     VALUES ($1, NULL, NULL, $2, $3, '[]', $2, 'example.test', 'landing_page',
             'detection', NULL, 'captured', 200, NULL, 1, $4, 'default', $5,
             $6, $4)`,
    [
      id,
      `https://example.test/${id}`,
      `example.test/${id}`,
      observedAt,
      options.purgedAt ?? null,
      options.purgedAt ? "retention_expired" : null,
    ],
  );
  if (options.artifact) {
    await db.query(
      `INSERT INTO evidence_artifact
        (evidence_id, kind, sha256, byte_size, content_type, width, height,
         truncated, object_key, object_version, created_at)
       VALUES ($1, 'dom', $2, 10, 'text/html', NULL, NULL, false, $3, 'v1', $4)`,
      [id, options.artifact, `evidence/${options.artifact}`, observedAt],
    );
  }
}

async function seedViolation(
  id: string,
  state: string,
  closedAt: Date | undefined,
  evidenceIds: string[],
) {
  await db.query(
    `INSERT INTO violation
      (id, tracked_title_id, state, normalized_url, url, detected_at,
       confirmed_at, closed_at, closure_reason)
     VALUES ($1, 'title-1', $2, $3, $3, $4, $4, $5, $6)`,
    [
      id,
      state,
      `example.test/${id}`,
      new Date("2020-01-01T00:00:00Z"),
      closedAt ?? null,
      closedAt ? "url_removed" : null,
    ],
  );
  for (const evidenceId of evidenceIds) {
    await db.query(
      `INSERT INTO violation_evidence (violation_id, evidence_id, role, cited_at)
       VALUES ($1, $2, 'primary', $3)`,
      [id, evidenceId, NOW],
    );
  }
}

async function seedNoticeCitation(
  noticeId: string,
  violationId: string,
  evidenceIds: string[],
  options: {
    noticeState?: string;
    submissionState?: string;
    submissionAt?: Date;
    noticeAt?: Date;
  } = {},
) {
  const noticeAt = options.noticeAt ?? new Date("2020-01-01T00:00:00Z");
  await db.query(
    `INSERT INTO notice
      (id, recipient, recipient_profile_id, channel, state, template_version,
       created_by, created_at, updated_at)
     VALUES ($1, 'google', 'profile-google', 'web_form', $2, 'v1', 'operator',
             $3, $3)`,
    [noticeId, options.noticeState ?? "draft", noticeAt],
  );
  await db.query(
    `INSERT INTO notice_citation (notice_id, violation_id, evidence_ids, cited_at)
     VALUES ($1, $2, $3, $4)`,
    [
      noticeId,
      violationId,
      JSON.stringify(evidenceIds.map((evidenceId) => ({ evidenceId }))),
      noticeAt,
    ],
  );
  if (options.submissionState) {
    const at = options.submissionAt ?? noticeAt;
    await db.query(
      `INSERT INTO submission
        (id, recipient_profile_id, state, notice_id, channel, pack_language,
         attempt_count, created_at, updated_at)
       VALUES ($1, 'profile-google', $2, $3, 'web_form', 'en', 1, $4, $4)`,
      [`submission-${noticeId}`, options.submissionState, noticeId, at],
    );
  }
}

async function seedDecision(id: string, decidedAt: Date, evidenceIds: string[]) {
  await db.query(
    `INSERT INTO review_decision
      (id, candidate_id, action, operator_id, decided_at, evidence_ids)
     VALUES ($1, $2, 'violation', 'operator', $3, $4)`,
    [id, `candidate-${id}`, decidedAt, JSON.stringify(evidenceIds)],
  );
}

async function seedHold(options: {
  id: string;
  evidenceIds?: string[];
  violationIds?: string[];
  noticeIds?: string[];
  releasedAt?: Date;
}) {
  await db.query(
    `INSERT INTO legal_hold
      (id, reason, created_by, created_at, evidence_ids, violation_ids,
       notice_ids, released_at, released_by, release_reason)
     VALUES ($1, 'Dispute', 'operator', $2, $3, $4, $5, $6, $7, NULL)`,
    [
      options.id,
      NOW,
      JSON.stringify(options.evidenceIds ?? []),
      JSON.stringify(options.violationIds ?? []),
      JSON.stringify(options.noticeIds ?? []),
      options.releasedAt ?? null,
      options.releasedAt ? "operator" : null,
    ],
  );
}

async function purged(id: string) {
  const row = (
    await db.query("SELECT purged_at, purge_reason FROM evidence WHERE id = $1", [
      id,
    ])
  ).rows[0];
  return {
    purged: row.purged_at !== null && row.purged_at !== undefined,
    reason: (row.purge_reason as string | null) ?? null,
  };
}

describe("retention purge", () => {
  it("keeps evidence cited by an open violation or a live notice", async () => {
    await seedEvidence("open", new Date("2020-01-01T00:00:00Z"));
    await seedEvidence("draft", new Date("2020-01-01T00:00:00Z"));
    await seedViolation("violation-open", "open", undefined, ["open"]);
    await seedNoticeCitation("notice-draft", "violation-missing", ["draft"]);

    await purgeExpired(db, store, NOW);

    expect((await purged("open")).purged).toBe(false);
    expect((await purged("draft")).purged).toBe(false);
  });

  it("purges closed citations after five years and leaves the metadata", async () => {
    const artifact = "a".repeat(64);
    await seedEvidence("closed-old", new Date("2018-01-01T00:00:00Z"), {
      artifact,
    });
    await seedEvidence("closed-recent", new Date("2018-01-01T00:00:00Z"), {
      artifact: "b".repeat(64),
    });
    await seedViolation("violation-old", "closed", new Date("2020-01-01T00:00:00Z"), [
      "closed-old",
    ]);
    await seedViolation(
      "violation-recent",
      "closed",
      new Date("2023-01-01T00:00:00Z"),
      ["closed-recent"],
    );

    const report = await purgeExpired(db, store, NOW);

    expect(await purged("closed-old")).toEqual({
      purged: true,
      reason: "closed_citation_retention",
    });
    expect((await purged("closed-recent")).purged).toBe(false);
    expect(report.evidencePurged).toBe(1);
    expect(store.deleted).toEqual([{ key: `evidence/${artifact}`, version: "v1" }]);
    const metadata = (
      await db.query("SELECT sha256 FROM evidence_artifact WHERE evidence_id = $1", [
        "closed-old",
      ])
    ).rows;
    expect(metadata).toHaveLength(1);
  });

  it("counts the last submission citing the evidence in the five-year deadline", async () => {
    await seedEvidence("submitted-recently", new Date("2018-01-01T00:00:00Z"));
    await seedViolation(
      "violation-submitted",
      "closed",
      new Date("2020-01-01T00:00:00Z"),
      ["submitted-recently"],
    );
    await seedNoticeCitation("notice-submitted", "violation-submitted", [
      "submitted-recently",
    ], {
      noticeState: "approved",
      submissionState: "acknowledged",
      submissionAt: new Date("2024-06-01T00:00:00Z"),
      noticeAt: new Date("2024-01-01T00:00:00Z"),
    });

    await purgeExpired(db, store, NOW);

    expect((await purged("submitted-recently")).purged).toBe(false);
  });

  it("purges never-cited evidence twelve months after the capture or last decision", async () => {
    await seedEvidence("uncited-old", new Date("2025-10-01T00:00:00Z"));
    await seedEvidence("uncited-new", new Date("2026-01-15T00:00:00Z"));
    await seedEvidence("decision-old", new Date("2026-01-15T00:00:00Z"));
    await seedEvidence("decision-new", new Date("2020-01-01T00:00:00Z"));
    await seedDecision("decision-old", new Date("2024-01-01T00:00:00Z"), [
      "decision-old",
    ]);
    await seedDecision("decision-new", new Date("2026-06-01T00:00:00Z"), [
      "decision-new",
    ]);

    await purgeExpired(db, store, NOW);

    expect((await purged("uncited-old")).reason).toBe("uncited_retention");
    expect((await purged("uncited-new")).purged).toBe(false);
    expect((await purged("decision-old")).purged).toBe(true);
    expect((await purged("decision-new")).purged).toBe(false);
  });

  it("uses the cited violation's closure for notice-only evidence", async () => {
    await seedEvidence("notice-only-closed", new Date("2020-01-01T00:00:00Z"));
    await seedEvidence("notice-only-open", new Date("2020-01-01T00:00:00Z"));
    await seedViolation(
      "violation-late-closure",
      "closed",
      new Date("2024-06-01T00:00:00Z"),
      [],
    );
    await seedViolation("violation-still-open", "open", undefined, []);
    await seedNoticeCitation(
      "notice-only-closed-notice",
      "violation-late-closure",
      ["notice-only-closed"],
      {
        noticeState: "approved",
        submissionState: "acknowledged",
        submissionAt: new Date("2021-01-01T00:00:00Z"),
      },
    );
    await seedNoticeCitation(
      "notice-only-open-notice",
      "violation-still-open",
      ["notice-only-open"],
      {
        noticeState: "approved",
        submissionState: "acknowledged",
        submissionAt: new Date("2021-01-01T00:00:00Z"),
      },
    );

    await purgeExpired(db, store, NOW);

    expect((await purged("notice-only-closed")).purged).toBe(false);
    expect((await purged("notice-only-open")).purged).toBe(false);
  });

  it("skips every scope a legal hold covers", async () => {
    await seedEvidence("held-direct", new Date("2020-01-01T00:00:00Z"));
    await seedEvidence("held-violation", new Date("2020-01-01T00:00:00Z"));
    await seedEvidence("held-notice", new Date("2020-01-01T00:00:00Z"));
    await seedViolation("violation-held", "closed", new Date("2020-01-01T00:00:00Z"), [
      "held-violation",
    ]);
    await seedNoticeCitation("notice-held", "violation-held", ["held-notice"], {
      noticeState: "approved",
      submissionState: "acknowledged",
      submissionAt: new Date("2020-02-01T00:00:00Z"),
    });
    await seedHold({
      id: "hold-direct",
      evidenceIds: ["held-direct"],
    });
    await seedHold({
      id: "hold-violation",
      violationIds: ["violation-held"],
    });
    await seedHold({
      id: "hold-notice",
      noticeIds: ["notice-held"],
    });

    await purgeExpired(db, store, NOW);

    expect((await purged("held-direct")).purged).toBe(false);
    expect((await purged("held-violation")).purged).toBe(false);
    expect((await purged("held-notice")).purged).toBe(false);
  });

  it("ignores a released hold", async () => {
    await seedEvidence("released-hold", new Date("2020-01-01T00:00:00Z"));
    await seedHold({
      id: "hold-released",
      evidenceIds: ["released-hold"],
      releasedAt: new Date("2026-01-01T00:00:00Z"),
    });

    await purgeExpired(db, store, NOW);

    expect((await purged("released-hold")).purged).toBe(true);
  });

  it("keeps a shared blob while any unpurged record still references it", async () => {
    const shared = "c".repeat(64);
    await seedEvidence("shared-old", new Date("2020-01-01T00:00:00Z"), {
      artifact: shared,
    });
    await seedEvidence("shared-new", new Date("2026-10-01T00:00:00Z"), {
      artifact: shared,
    });

    await purgeExpired(db, store, NOW);

    expect((await purged("shared-old")).purged).toBe(true);
    expect((await purged("shared-new")).purged).toBe(false);
    expect(store.deleted).toEqual([]);
  });

  it("cleans up bytes orphaned by an interrupted run", async () => {
    const artifact = "d".repeat(64);
    await seedEvidence("orphan", new Date("2020-01-01T00:00:00Z"), {
      purgedAt: new Date("2026-10-01T00:00:00Z"),
      artifact,
    });

    await purgeExpired(db, store, NOW);

    expect(store.deleted).toEqual([{ key: `evidence/${artifact}`, version: "v1" }]);
  });

  it("deletes raw search payloads after ninety days", async () => {
    for (const [id, createdAt] of [
      ["payload-old", new Date("2026-08-01T00:00:00Z")],
      ["payload-new", new Date("2026-09-01T00:00:00Z")],
    ] as const) {
      await db.query(
        `INSERT INTO serp_payload (id, scan_id, engine, body, created_at)
         VALUES ($1, 'scan-1', 'google', '{}', $2)`,
        [id, createdAt],
      );
    }

    const report = await purgeExpired(db, store, NOW);

    const rows = (await db.query("SELECT id FROM serp_payload")).rows;
    expect(rows.map((row) => String(row.id))).toEqual(["payload-new"]);
    expect(report.payloadsDeleted).toBe(1);
  });
});
