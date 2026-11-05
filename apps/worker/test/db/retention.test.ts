import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import {
  RAW_SERP_PREFIX,
  markEvidencePurged,
  placeLegalHold,
  releaseLegalHold,
  runRetentionPurge,
  selectDueEvidence,
  type EvidenceStore,
} from "@patrol/evidence";
import { controlledClock, seedWorld, testPool, truncateDomainTables, type SeededWorld } from "./helpers.js";
import { testBucket, testStore } from "./capture-helpers.js";

/**
 * The retention purge (docs/design/evidence-capture.md "Retention"; ADR
 * 0017): the three windows, the legal-hold precedence on every path, and
 * the marker-before-bytes ordering whose failure modes the design fixes —
 * an interrupted run leaves orphaned bytes, never a dangling citation.
 */

const NOW = "2026-07-01T00:00:00.000Z";
const DAY_MS = 24 * 60 * 60 * 1000;
const YEAR_MS = 365.25 * DAY_MS;

const pool = testPool();
let world: SeededWorld;

/** One bare capture + evidence row, optionally with one artifact row. */
async function seedEvidence(
  input: {
    observedAt: string;
    sha256?: string;
    withArtifact?: boolean;
    objectVersion?: string | null;
  },
): Promise<{ evidenceId: string; sha256: string }> {
  const url = `https://retention-${Math.random().toString(36).slice(2)}.example/page`;
  const host = new URL(url).hostname;
  const capture = await pool.query<{ id: string }>(
    `insert into captures (requested_url, normalized_url, reason, point_key, state, requested_at, finished_at)
     values ($1, $2, 'detection', $3, 'done', $4, $4) returning id`,
    [url, `${host}/page`, `seed@${Math.random().toString(36).slice(2)}`, input.observedAt],
  );
  const evidence = await pool.query<{ id: string }>(
    `insert into evidence
       (capture_id, requested_url, normalized_url, final_url, host, host_source, reason,
        outcome, http_status, attempt_number, observed_at, capture_profile)
     values ($1, $2, $3, $2, $4, 'landing_page', 'detection', 'captured', 200, 1, $5,
        '{"userAgent":"patrol","viewportWidth":1280,"viewportHeight":720,"locale":"en","timezone":"UTC",
          "javascriptEnabled":true,"blockedResourceKinds":[],"navigationPolicy":"load","extractorVersion":"1"}'::jsonb)
     returning id`,
    [capture.rows[0].id, url, `${host}/page`, host, input.observedAt],
  );
  const sha256 =
    input.sha256 ??
    Array.from({ length: 64 }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("");
  if (input.withArtifact !== false) {
    await pool.query(
      `insert into evidence_artifacts
         (evidence_id, kind, sha256, size_bytes, content_type, truncated, object_version)
       values ($1, 'response_body', $2, 10, 'text/html', false, $3)`,
      [evidence.rows[0].id, sha256, input.objectVersion ?? "v1"],
    );
  }
  return { evidenceId: evidence.rows[0].id, sha256 };
}

/**
 * A violation citing the evidence, in the given state. Seeds the whole
 * candidate → decision → violation chain the foreign keys require; a null
 * violationState only records a dismissal decision (the never-cited shape
 * — a review decision pinned the capture, but no violation ever cited it).
 */
async function citeViaViolation(
  evidenceId: string,
  input: {
    confirmedAt: string;
    violationState?: "open" | "closed" | "removed";
    closedAt?: string;
  },
): Promise<string | null> {
  const candidate = await pool.query<{ id: string }>(
    `insert into candidates
       (tracked_title_id, url, normalized_url, host, registrable_domain, source, engine,
        engines, best_rank, matched_variant_id, matched_variant, score, band,
        score_components, reputation, first_seen_at, last_observed_at, state, created_at, updated_at)
     values ($1, $2, $3, $4, 'example.com', 'serp', 'google', '{google}', 1, $5,
        '{"id":"x","text":"v","kind":"original","language":"en","script":"Latn"}'::jsonb,
        0.75, 'b', '{"titleMatch":0.6,"signals":[],"reputation":0}'::jsonb,
        '{"registrableDomain":"","confirmedViolations":0,"bonus":0,"blocklisted":false}'::jsonb,
        $6, $6, 'pending', $6, $6)
     returning id`,
    [
      world.titleId,
      `https://cite-${Math.random().toString(36).slice(2)}.example/p`,
      `cite-${Math.random().toString(36).slice(2)}.example/p`,
      "cite.example",
      world.originalVariantId,
      input.confirmedAt,
    ],
  );
  const ids = await pool.query<{ decision_id: string; violation_id: string }>(
    "select uuidv7()::text as decision_id, uuidv7()::text as violation_id",
  );
  const decisionId = ids.rows[0].decision_id;
  const violationId = ids.rows[0].violation_id;
  await pool.query(
    `insert into review_decisions (id, candidate_id, operator_id, action, decided_at, evidence_ids, violation_id)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      decisionId,
      candidate.rows[0].id,
      world.operatorId,
      input.violationState === undefined ? "not_a_violation" : "violation",
      input.confirmedAt,
      [evidenceId],
      input.violationState === undefined ? null : violationId,
    ],
  );
  if (input.violationState === undefined) {
    return null;
  }
  const closureReason =
    input.violationState === "removed"
      ? "url_removed"
      : input.violationState === "closed"
        ? "operator_closed"
        : null;
  await pool.query(
    `insert into violations
       (id, tracked_title_id, candidate_id, review_decision_id, url, normalized_url, host,
        host_source, registrable_domain, detected_at, confirmed_at, confirmed_by, state, opened_at,
        closed_at, closure_reason, closure_note, closed_by, created_at)
     values ($1, $2, $3, $4, $5, $6, 'cite.example', 'landing_page', 'example.com', $7, $7, $8,
        $9, $7, $10, $11, $12, $13, $7)`,
    [
      violationId,
      world.titleId,
      candidate.rows[0].id,
      decisionId,
      `https://cite-${violationId.slice(0, 8)}.example/p`,
      `cite-${violationId.slice(0, 8)}.example/p`,
      input.confirmedAt,
      world.operatorId,
      input.violationState,
      input.closedAt ?? null,
      closureReason,
      input.violationState === "open" ? null : "aged test closure",
      input.violationState === "open" ? null : world.operatorId,
    ],
  );
  await pool.query(
    `insert into violation_evidence (violation_id, evidence_id, role, cited_at, pinned_versions)
     values ($1, $2, 'detection', $3, '[]'::jsonb)`,
    [violationId, evidenceId, input.confirmedAt],
  );
  return violationId;
}

/** One notice citing the evidence through a closed violation. */
async function citeViaNotice(
  evidenceId: string,
  input: {
    composedAt: string;
    noticeState?: "draft" | "approved" | "withdrawn";
    submissionState?: "pending" | "delivered" | "acknowledged" | null;
    submissionAt?: string;
    violationId: string;
  },
): Promise<string> {
  const profile = await pool.query<{ id: string }>(
    `insert into recipient_profiles (recipient, window_time, updated_by)
     values ('google', '07:00', $1)
     on conflict (recipient) do update set updated_by = excluded.updated_by
     returning id`,
    [world.operatorId],
  );
  // Composed as a DRAFT first: the freeze triggers refuse citation inserts
  // into a notice that has already left draft, so the lifecycle write comes
  // after the content, exactly as the composer and approval land it.
  const notice = await pool.query<{ id: string }>(
    `insert into notices (recipient, recipient_profile_id, channel, template_version, language,
        composed_at, composed_by, trigger_kind)
     values ('google', $1, 'web_form', 'google-search.en.v1@ed9f34155836', 'en', $2, $3, 'on_demand')
     returning id`,
    [profile.rows[0].id, input.composedAt, world.operatorId],
  );
  const url = `https://notice-${Math.random().toString(36).slice(2)}.example/p`;
  await pool.query(
    `insert into notice_citations (notice_id, violation_id, recipient_profile_id, tracked_title_id,
        url, normalized_url, state, position, evidence)
     values ($1, $2, $3, $4, $5, $6, 'draft', 0, $7::jsonb)`,
    [
      notice.rows[0].id,
      input.violationId,
      profile.rows[0].id,
      world.titleId,
      url,
      `${new URL(url).hostname}/p`,
      JSON.stringify([{ evidenceId, capturedAt: input.composedAt, reason: "detection" }]),
    ],
  );
  const state = input.noticeState ?? "draft";
  if (state === "approved") {
    // Approval lands the three snapshots and its actor in the same write.
    await pool.query(
      `update notices set state = 'approved', approved_at = $2, approved_by = $3,
          rights_holder_snapshot = '{"legalName":"Example Rights GmbH"}'::jsonb,
          signatory_snapshot = '{"fullName":"Anna Beispiel"}'::jsonb,
          profile_snapshot = '{"recipient":"google"}'::jsonb
       where id = $1`,
      [notice.rows[0].id, input.composedAt, world.operatorId],
    );
  } else if (state === "withdrawn") {
    await pool.query(
      `update notices set state = 'withdrawn', withdrawn_at = $2, withdrawn_by = $3,
          withdrawal_reason = 'test withdrawal'
       where id = $1`,
      [notice.rows[0].id, input.composedAt, world.operatorId],
    );
  }
  if (input.submissionState !== null && input.submissionState !== undefined) {
    const at = input.submissionAt ?? input.composedAt;
    await pool.query(
      `insert into submissions (notice_id, recipient_profile_id, channel, state, attempt_count,
          pack_language, created_at, operator_id, delivered_at, attested_at, statement_version,
          acknowledged_at, acknowledgement)
       values ($1, $2, 'web_form', $3, 0, 'en', $4,
          case when $3 in ('delivered','acknowledged') then $5::uuid end,
          case when $3 in ('delivered','acknowledged') then $4::timestamptz end,
          case when $3 in ('delivered','acknowledged') then $4::timestamptz end,
          case when $3 in ('delivered','acknowledged') then 'google-search.en.v1@ed9f34155836' end,
          case when $3 = 'acknowledged' then $4::timestamptz end,
          case when $3 = 'acknowledged' then '{"referenceNumber":"ref-1","dashboardUrl":"https://example.test/d"}'::jsonb end)`,
      [notice.rows[0].id, profile.rows[0].id, input.submissionState, at, world.operatorId],
    );
  }
  return notice.rows[0].id;
}

/** A store that records version deletes and can be told to fail some. */
class RecordingPurgeStore
  implements Pick<EvidenceStore, "deleteArtifactVersion" | "purgeRawSerpPayloadsOlderThan">
{
  readonly deletions: Array<{ kind: string; sha256: string; objectVersion: string | null }> = [];
  readonly failSha256s = new Set<string>();

  async deleteArtifactVersion(request: {
    kind: string;
    sha256: string;
    objectVersion: string | null;
  }): Promise<void> {
    if (this.failSha256s.has(request.sha256)) {
      throw new Error(`store refused to delete ${request.sha256}`);
    }
    this.deletions.push({ ...request });
  }

  async purgeRawSerpPayloadsOlderThan(): Promise<string[]> {
    return [];
  }
}

async function purgeRow(evidenceId: string): Promise<{
  purged_at: string | null;
  purge_reason: string | null;
  bytes_purged_at: string | null;
}> {
  const result = await pool.query(
    "select purged_at, purge_reason, bytes_purged_at from evidence where id = $1",
    [evidenceId],
  );
  return result.rows[0];
}

const clock = controlledClock(NOW);

beforeAll(async () => {
  world = await seedWorld(pool);
});

beforeEach(async () => {
  await truncateDomainTables(pool);
  world = await seedWorld(pool);
  clock.set(NOW);
});

afterAll(async () => {
  await pool.end();
});

describe("retention windows", () => {
  it("keeps evidence cited by an open violation however old", async () => {
    const { evidenceId } = await seedEvidence({ observedAt: "2019-01-01T00:00:00.000Z" });
    await citeViaViolation(evidenceId, {
      confirmedAt: "2019-01-02T00:00:00.000Z",
      violationState: "open",
    });
    const store = new RecordingPurgeStore();
    const summary = await runRetentionPurge({ pool, now: clock.now, store });
    expect(summary.marked).toBe(0);
    expect((await purgeRow(evidenceId)).purged_at).toBeNull();
  });

  it("keeps evidence a live draft notice cites even once its violation closed", async () => {
    const { evidenceId } = await seedEvidence({ observedAt: "2019-01-01T00:00:00.000Z" });
    const violationId = (await citeViaViolation(evidenceId, {
      confirmedAt: "2019-01-02T00:00:00.000Z",
      violationState: "closed",
      closedAt: "2019-02-01T00:00:00.000Z",
    }))!;
    await citeViaNotice(evidenceId, {
      composedAt: "2026-06-01T00:00:00.000Z",
      noticeState: "draft",
      violationId,
    });
    const summary = await runRetentionPurge({ pool, now: clock.now, store: new RecordingPurgeStore() });
    expect(summary.marked).toBe(0);
    expect((await purgeRow(evidenceId)).purged_at).toBeNull();
  });

  it("keeps evidence an approved notice still awaits acknowledgement for", async () => {
    const { evidenceId } = await seedEvidence({ observedAt: "2019-01-01T00:00:00.000Z" });
    for (const submissionState of ["pending", "delivered"] as const) {
      // One closed violation per notice: a violation is reserved by at most
      // one active notice, so each citation path needs its own.
      const violationId = (await citeViaViolation(evidenceId, {
        confirmedAt: "2019-01-02T00:00:00.000Z",
        violationState: "closed",
        closedAt: "2019-02-01T00:00:00.000Z",
      }))!;
      await citeViaNotice(evidenceId, {
        composedAt: "2026-01-01T00:00:00.000Z",
        noticeState: "approved",
        submissionState,
        submissionAt: "2026-03-01T00:00:00.000Z",
        violationId,
      });
    }
    const summary = await runRetentionPurge({ pool, now: clock.now, store: new RecordingPurgeStore() });
    expect(summary.marked).toBe(0);
    expect((await purgeRow(evidenceId)).purged_at).toBeNull();
  });

  it("purges closed-citation evidence five years after the later of closure and last citing submission", async () => {
    // Closure six years ago, no submission: the closure alone starts the clock.
    const old = await seedEvidence({ observedAt: "2019-01-01T00:00:00.000Z" });
    await citeViaViolation(old.evidenceId, {
      confirmedAt: "2019-01-02T00:00:00.000Z",
      violationState: "closed",
      closedAt: new Date(new Date(NOW).getTime() - 6 * YEAR_MS).toISOString(),
    });
    // Closure six years ago but the submission was acknowledged three years ago:
    // the later date is the acknowledgement, so the window has a year to run.
    const recentSubmission = await seedEvidence({ observedAt: "2019-01-01T00:00:00.000Z" });
    const recentViolation = (await citeViaViolation(recentSubmission.evidenceId, {
      confirmedAt: "2019-01-02T00:00:00.000Z",
      violationState: "closed",
      closedAt: new Date(new Date(NOW).getTime() - 6 * YEAR_MS).toISOString(),
    }))!;
    await citeViaNotice(recentSubmission.evidenceId, {
      composedAt: "2020-01-01T00:00:00.000Z",
      noticeState: "approved",
      submissionState: "acknowledged",
      submissionAt: new Date(new Date(NOW).getTime() - 3 * YEAR_MS).toISOString(),
      violationId: recentViolation,
    });
    // Closure three years ago with an acknowledgement six years ago: the
    // closure is later, and five years from it has a year to run.
    const recentClosure = await seedEvidence({ observedAt: "2019-01-01T00:00:00.000Z" });
    const recentClosureViolation = (await citeViaViolation(recentClosure.evidenceId, {
      confirmedAt: "2019-01-02T00:00:00.000Z",
      violationState: "closed",
      closedAt: new Date(new Date(NOW).getTime() - 3 * YEAR_MS).toISOString(),
    }))!;
    await citeViaNotice(recentClosure.evidenceId, {
      composedAt: "2020-01-01T00:00:00.000Z",
      noticeState: "approved",
      submissionState: "acknowledged",
      submissionAt: new Date(new Date(NOW).getTime() - 6 * YEAR_MS).toISOString(),
      violationId: recentClosureViolation,
    });

    const summary = await runRetentionPurge({ pool, now: clock.now, store: new RecordingPurgeStore() });
    expect(summary.marked).toBe(1);
    expect((await purgeRow(old.evidenceId)).purge_reason).toBe("closed_citations_window");
    expect((await purgeRow(recentSubmission.evidenceId)).purged_at).toBeNull();
    expect((await purgeRow(recentClosure.evidenceId)).purged_at).toBeNull();
  });

  it("purges never-cited evidence twelve months after the last review decision, or after capture", async () => {
    // A decision thirteen months ago: due.
    const oldDecision = await seedEvidence({ observedAt: "2024-01-01T00:00:00.000Z" });
    await citeViaViolation(oldDecision.evidenceId, { confirmedAt: new Date(new Date(NOW).getTime() - 13 * 30 * DAY_MS).toISOString() });
    // A decision six months ago: not due.
    const youngDecision = await seedEvidence({ observedAt: "2024-01-01T00:00:00.000Z" });
    await citeViaViolation(youngDecision.evidenceId, { confirmedAt: new Date(new Date(NOW).getTime() - 6 * 30 * DAY_MS).toISOString() });
    // No decision, captured thirteen months ago: due.
    const oldCapture = await seedEvidence({
      observedAt: new Date(new Date(NOW).getTime() - 13 * 30 * DAY_MS).toISOString(),
    });
    // No decision, captured six months ago: not due.
    const youngCapture = await seedEvidence({
      observedAt: new Date(new Date(NOW).getTime() - 6 * 30 * DAY_MS).toISOString(),
    });

    const summary = await runRetentionPurge({ pool, now: clock.now, store: new RecordingPurgeStore() });
    expect(summary.marked).toBe(2);
    expect((await purgeRow(oldDecision.evidenceId)).purge_reason).toBe("never_cited_window");
    expect((await purgeRow(oldCapture.evidenceId)).purge_reason).toBe("never_cited_window");
    expect((await purgeRow(youngDecision.evidenceId)).purged_at).toBeNull();
    expect((await purgeRow(youngCapture.evidenceId)).purged_at).toBeNull();
  });
});

describe("legal holds", () => {
  async function overdueClosedEvidence(): Promise<{
    evidenceId: string;
    violationId: string;
    noticeId: string;
  }> {
    const { evidenceId } = await seedEvidence({ observedAt: "2019-01-01T00:00:00.000Z" });
    const violationId = (await citeViaViolation(evidenceId, {
      confirmedAt: "2019-01-02T00:00:00.000Z",
      violationState: "closed",
      closedAt: "2019-02-01T00:00:00.000Z",
    }))!;
    const noticeId = await citeViaNotice(evidenceId, {
      composedAt: "2019-03-01T00:00:00.000Z",
      noticeState: "withdrawn",
      violationId,
    });
    return { evidenceId, violationId, noticeId };
  }

  it.each(["evidence" as const, "violation" as const, "notice" as const])(
    "a hold over the %s scope suspends the purge until released",
    async (scope) => {
      const seeded = await overdueClosedEvidence();
      await placeLegalHold(pool, clock.now, {
        reason: "Counter-notice received",
        createdBy: world.operatorId,
        ...(scope === "evidence" ? { evidenceIds: [seeded.evidenceId] } : {}),
        ...(scope === "violation" ? { violationIds: [seeded.violationId] } : {}),
        ...(scope === "notice" ? { noticeIds: [seeded.noticeId] } : {}),
      });
      const held = await runRetentionPurge({ pool, now: clock.now, store: new RecordingPurgeStore() });
      expect(held.marked).toBe(0);
      expect((await purgeRow(seeded.evidenceId)).purged_at).toBeNull();

      const holds = await pool.query("select id from legal_holds");
      const release = await releaseLegalHold(pool, clock.now, {
        legalHoldId: holds.rows[0].id,
        operatorId: world.operatorId,
        reason: "Dispute resolved",
      });
      expect(release.status).toBe("released");
      const releasedRow = await pool.query(
        "select released_by, release_reason from legal_holds where id = $1",
        [holds.rows[0].id],
      );
      expect(releasedRow.rows[0].released_by).toBe(world.operatorId);
      expect(releasedRow.rows[0].release_reason).toBe("Dispute resolved");

      const afterRelease = await runRetentionPurge({
        pool,
        now: clock.now,
        store: new RecordingPurgeStore(),
      });
      expect(afterRelease.marked).toBe(1);
      expect((await purgeRow(seeded.evidenceId)).purge_reason).toBe("closed_citations_window");
    },
  );

  it("skips the mark when a hold commits between the selection and it", async () => {
    // The exact race the marking UPDATE re-checks under its row lock: the
    // selection found the row due, a hold committed after that, and the
    // marker must lose to it (ADR 0017) — the row keeps its bytes.
    const { evidenceId } = await seedEvidence({
      observedAt: new Date(new Date(NOW).getTime() - 13 * 30 * DAY_MS).toISOString(),
    });
    const due = await selectDueEvidence(pool, clock.now);
    expect(due.map((row) => row.id)).toContain(evidenceId);

    await placeLegalHold(pool, clock.now, {
      reason: "Dispute opened after the selection",
      evidenceIds: [evidenceId],
      createdBy: world.operatorId,
    });

    const marked = await markEvidencePurged(pool, clock.now, evidenceId, "never_cited_window");
    expect(marked).toBe(false);
    expect((await purgeRow(evidenceId)).purged_at).toBeNull();

    // The full pass agrees: nothing marked, nothing asked of the store, and
    // the artifact row with its hash still describes the capture.
    const store = new RecordingPurgeStore();
    const summary = await runRetentionPurge({ pool, now: clock.now, store });
    expect(summary.marked).toBe(0);
    expect(store.deletions).toHaveLength(0);
    const artifacts = await pool.query(
      "select sha256 from evidence_artifacts where evidence_id = $1",
      [evidenceId],
    );
    expect(artifacts.rows).toHaveLength(1);
  });

  it("leaves host objections untouched by the purge", async () => {
    const { evidenceId } = await seedEvidence({
      observedAt: new Date(new Date(NOW).getTime() - 13 * 30 * DAY_MS).toISOString(),
    });
    void evidenceId;
    await pool.query(
      `insert into host_objections (host, registrable_domain, source, reason, recorded_at, affected_candidate_count)
       values ('blocker.example', 'blocker.example', 'host_contact', 'cease and desist', $1, 0)`,
      ["2026-01-01T00:00:00.000Z"],
    );
    await runRetentionPurge({ pool, now: clock.now, store: new RecordingPurgeStore() });
    const objections = await pool.query("select count(*)::int as count from host_objections");
    expect(objections.rows[0].count).toBe(1);
  });
});

describe("purge ordering and recovery", () => {
  it("marks the metadata first: a failing store leaves orphaned bytes, a set marker, and intact citations", async () => {
    const { evidenceId, sha256 } = await seedEvidence({
      observedAt: new Date(new Date(NOW).getTime() - 13 * 30 * DAY_MS).toISOString(),
    });
    const store = new RecordingPurgeStore();
    store.failSha256s.add(sha256);
    const summary = await runRetentionPurge({ pool, now: clock.now, store });

    // The marker stands although no byte could be deleted.
    const row = await purgeRow(evidenceId);
    expect(row.purged_at).not.toBeNull();
    expect(row.purge_reason).toBe("never_cited_window");
    expect(row.bytes_purged_at).toBeNull();
    expect(summary.marked).toBe(1);
    expect(summary.versionsDeleted).toBe(0);

    // The citation that would have dangled is intact: an artifact row with
    // its hash still describes the capture.
    const artifacts = await pool.query(
      "select sha256 from evidence_artifacts where evidence_id = $1",
      [evidenceId],
    );
    expect(artifacts.rows).toHaveLength(1);
    expect(artifacts.rows[0].sha256).toBe(sha256);

    // The re-run completes: the same hash is retried, deleted, and the
    // completion marker lands.
    store.failSha256s.clear();
    const rerun = await runRetentionPurge({ pool, now: clock.now, store });
    expect(rerun.versionsDeleted).toBe(1);
    expect(rerun.due).toBe(0);
    expect((await purgeRow(evidenceId)).bytes_purged_at).not.toBeNull();
  });

  it("deletes a shared blob only when no unpurged artifact row still references its hash", async () => {
    const shared = "a".repeat(64);
    const young = await seedEvidence({
      observedAt: new Date(new Date(NOW).getTime() - 30 * DAY_MS).toISOString(),
      sha256: shared,
    });
    const old = await seedEvidence({
      observedAt: new Date(new Date(NOW).getTime() - 13 * 30 * DAY_MS).toISOString(),
      sha256: shared,
    });
    const store = new RecordingPurgeStore();
    const first = await runRetentionPurge({ pool, now: clock.now, store });
    expect(first.marked).toBe(1);
    expect(first.versionsDeleted).toBe(0);
    expect((await purgeRow(old.evidenceId)).bytes_purged_at).toBeNull();

    // The young referent's own window elapses: the blob now has no
    // unpurged referent and the next pass deletes it once.
    clock.advance(13 * 30 * DAY_MS);
    const second = await runRetentionPurge({ pool, now: clock.now, store });
    expect(second.versionsDeleted).toBe(1);
    expect(store.deletions).toHaveLength(1);
    expect(store.deletions[0].sha256).toBe(shared);
    expect((await purgeRow(old.evidenceId)).bytes_purged_at).not.toBeNull();
    expect((await purgeRow(young.evidenceId)).bytes_purged_at).not.toBeNull();
  });

  it("purges raw SERP payload versions past the cutoff and keeps the younger ones", async () => {
    const bucket = testBucket("retention-serp");
    const store = testStore(bucket);
    await store.ensureReady();
    // Raw payload objects under the serp/ prefix, the way an adapter that
    // owns its response stores it. The older key lands TWICE so the bucket
    // carries two versions of it: the window is version-addressed, and the
    // assertion must see the bytes go, not a delete marker hide them. Two
    // keys a real moment apart, so the store's own cutoff between them
    // decides — this asserts the store's window semantics; the runner test
    // below asserts the job wires the ninety-day cutoff.
    const { ListObjectVersionsCommand, PutObjectCommand, S3Client } = await import(
      "@aws-sdk/client-s3"
    );
    const client = new S3Client({
      endpoint: "http://127.0.0.1:9002",
      region: "us-east-1",
      forcePathStyle: true,
      credentials: { accessKeyId: "patrolminio", secretAccessKey: "patrolminio" },
    });
    const olderKey = "serp/yandex/2026/03/scan-1/q1.json.gz";
    const youngerKey = "serp/yandex/2026/07/scan-2/q2.json.gz";
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: olderKey, Body: "{}" }));
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: olderKey, Body: "{v2}" }));
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const between = new Date();
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: youngerKey, Body: "{}" }));

    const deletedAtStoreLevel = await store.purgeRawSerpPayloadsOlderThan(between);
    // Both of the older key's versions went; the key reports once.
    expect(deletedAtStoreLevel).toEqual([olderKey]);
    const afterOlder = await client.send(
      new ListObjectVersionsCommand({ Bucket: bucket, Prefix: olderKey }),
    );
    expect(afterOlder.Versions ?? []).toHaveLength(0);
    // Nothing hid the bytes behind a delete marker: an unversioned delete
    // would have left both versions listed and a marker on top.
    expect(afterOlder.DeleteMarkers ?? []).toHaveLength(0);

    // A cutoff everything precedes takes the younger object too: the window
    // is a plain "older than" comparison, nothing more.
    const survivors = await store.purgeRawSerpPayloadsOlderThan(
      new Date(Date.now() + 60_000),
    );
    expect(survivors).toEqual([youngerKey]);
    const afterYounger = await client.send(
      new ListObjectVersionsCommand({ Bucket: bucket, Prefix: RAW_SERP_PREFIX }),
    );
    expect(afterYounger.Versions ?? []).toHaveLength(0);
    expect(afterYounger.DeleteMarkers ?? []).toHaveLength(0);

    // The runner wires the ninety-day cutoff: an object written now is past
    // its window once the job's clock has moved ninety-one days on.
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: youngerKey, Body: "{}" }));
    clock.set(new Date(Date.now() + 91 * DAY_MS).toISOString());
    const summary = await runRetentionPurge({ pool, now: clock.now, store });
    expect(summary.rawSerpKeysDeleted).toBe(1);
    await client.destroy();
  });
});
