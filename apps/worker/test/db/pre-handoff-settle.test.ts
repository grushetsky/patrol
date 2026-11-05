import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { approveNotice, settlePreHandoffCapture } from "@patrol/notices";
import {
  appendEvidence,
  type CaptureProfileJson,
  type EvidenceStore,
  type ArtifactUpload,
  type PresignRequest,
  type PresignedDownload,
  type StoredObject,
} from "@patrol/evidence";
import { controlledClock, seedWorld, testPool, truncateDomainTables, type SeededWorld } from "./helpers.js";

/**
 * The pre-handoff settle watcher (docs/design/notice-composition.md
 * "Re-verification before handoff"): the capture runner's post-terminal hook
 * that turns an approved notice whose queued pre-handoff captures have all
 * settled into its pending submission — once, whatever races it. The hook
 * writes DATABASE rows only: the deployment topology grants the object
 * store to the API alone, so the pack's bytes are built there (lazily, on
 * the first pack read) and the worker never touches the store.
 */

const AT = "2026-03-01T00:00:00.000Z";
const STALE_OBSERVED = "2026-02-15T00:00:00.000Z"; // 14 days before the clock

const PROFILE: CaptureProfileJson = {
  userAgent: "patrol",
  viewportWidth: 1280,
  viewportHeight: 720,
  locale: "en",
  timezone: "UTC",
  javascriptEnabled: true,
  blockedResourceKinds: [],
  navigationPolicy: "load",
  extractorVersion: "1",
};

/** The in-memory store the settle path COULD write pack bytes through — held
 *  to assert the worker never does (the API owns the object store). */
class MemoryStore implements Pick<EvidenceStore, "putArtifact" | "presignDownload"> {
  readonly keys: string[] = [];
  private readonly objects = new Map<string, Uint8Array>();

  async putArtifact(upload: ArtifactUpload): Promise<StoredObject> {
    const key = `packs/sha256/${upload.sha256.slice(0, 2)}/${upload.sha256.slice(2, 4)}/${upload.sha256}`;
    if (this.objects.has(key)) {
      return { sha256: upload.sha256, objectVersion: null, existed: true };
    }
    this.objects.set(key, upload.bytes.slice());
    this.keys.push(key);
    return { sha256: upload.sha256, objectVersion: null, existed: false };
  }

  async presignDownload(request: PresignRequest): Promise<PresignedDownload> {
    return { url: `https://signed.test/${request.sha256}`, expiresAt: new Date(AT) };
  }
}

/** One OPEN violation whose pinned capture was observed at the given time. */
async function seedViolation(
  pool: Pool,
  world: SeededWorld,
  input: { url: string; observedAt: string },
): Promise<string> {
  const host = new URL(input.url).hostname;
  const normalized = `${host}${new URL(input.url).pathname}`;
  const candidate = await pool.query<{ id: string }>(
    `insert into candidates
       (tracked_title_id, url, normalized_url, host, registrable_domain, source, engine,
        engines, best_rank, matched_variant_id, matched_variant, score, band,
        score_components, reputation, first_seen_at, last_observed_at, state,
        review_decision_id, violation_id, confirmed_at, created_at, updated_at)
     values ($1, $2, $3, $4, $5, 'serp', 'google', '{google}', 1, $6,
        '{"id":"x","text":"Sunrise","kind":"original","language":"en","script":"Latn"}'::jsonb,
        0.75, 'b', '{"titleMatch":0.6,"signals":[],"reputation":0}'::jsonb,
        '{"registrableDomain":"","confirmedViolations":0,"bonus":0,"blocklisted":false}'::jsonb,
        $7, $7, 'pending', null, null, null, $7, $7)
     returning id`,
    [world.titleId, input.url, normalized, host, host.split(".").slice(-2).join("."), world.originalVariantId, input.observedAt],
  );
  const capture = await pool.query<{ id: string }>(
    `insert into captures (requested_url, normalized_url, reason, point_key, state, requested_at, finished_at)
     values ($1, $2, 'detection', $3, 'done', $4, $4) returning id`,
    [input.url, normalized, `seed@${Math.random().toString(36).slice(2)}`, input.observedAt],
  );
  const evidence = await pool.query<{ id: string }>(
    `insert into evidence
       (capture_id, requested_url, normalized_url, final_url, host, host_source, reason,
        outcome, http_status, attempt_number, observed_at, capture_profile)
     values ($1, $2, $3, $2, $4, 'landing_page', 'detection', 'captured', 200, 1, $5, $6::jsonb)
     returning id`,
    [capture.rows[0].id, input.url, normalized, host, input.observedAt, JSON.stringify(PROFILE)],
  );
  const ids = await pool.query<{ decision_id: string; violation_id: string }>(
    "select uuidv7()::text as decision_id, uuidv7()::text as violation_id",
  );
  await pool.query(
    `insert into review_decisions (id, candidate_id, operator_id, action, decided_at, evidence_ids, violation_id)
     values ($1, $2, $3, 'violation', $4, $5, $6)`,
    [ids.rows[0].decision_id, candidate.rows[0].id, world.operatorId, input.observedAt, [evidence.rows[0].id], ids.rows[0].violation_id],
  );
  await pool.query(
    `insert into violations
       (id, tracked_title_id, candidate_id, review_decision_id, url, normalized_url, host,
        host_source, registrable_domain, detected_at, confirmed_at, confirmed_by, state, opened_at, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, 'landing_page', $8, $9, $9, $10, 'open', $9, $9)`,
    [
      ids.rows[0].violation_id,
      world.titleId,
      candidate.rows[0].id,
      ids.rows[0].decision_id,
      input.url,
      normalized,
      host,
      host.split(".").slice(-2).join("."),
      input.observedAt,
      world.operatorId,
    ],
  );
  await pool.query(
    `update candidates set state = 'confirmed', review_decision_id = $2, violation_id = $3, confirmed_at = $4 where id = $1`,
    [candidate.rows[0].id, ids.rows[0].decision_id, ids.rows[0].violation_id, input.observedAt],
  );
  await pool.query(
    `insert into violation_evidence (violation_id, evidence_id, role, cited_at, pinned_versions)
     values ($1, $2, 'detection', $3, '[]'::jsonb)`,
    [ids.rows[0].violation_id, evidence.rows[0].id, input.observedAt],
  );
  return ids.rows[0].violation_id;
}

describe("the pre-handoff settle watcher", () => {
  let pool: Pool;
  let clock: ReturnType<typeof controlledClock>;
  let world: SeededWorld;
  let store: MemoryStore;

  beforeEach(async () => {
    if (pool === undefined) {
      pool = testPool();
    }
    await truncateDomainTables(pool);
    clock = controlledClock(AT);
    store = new MemoryStore();
    world = await seedWorld(pool);
    await pool.query(
      `insert into rights_holder (singleton, legal_name, country, address_line1, address_city,
          address_postal_code, role_mailbox, signatory_full_legal_name, signatory_authority_basis,
          signatory_contact_email)
       values (true, 'Example Rights GmbH', 'DE', '1 Example Street', 'Exampleville', '10001',
          'legal@example.test', 'Anna Beispiel', 'Copyright owner', 'signatory@example.test')
       on conflict (singleton) do update set legal_name = excluded.legal_name,
          role_mailbox = excluded.role_mailbox, signatory_full_legal_name = excluded.signatory_full_legal_name`,
    );
    await pool.query(
      `insert into recipient_profiles (recipient, window_time, account, updated_by)
       values ('google', '07:00', 'noticeops@example.test', $1)
       on conflict (recipient) do update set account = excluded.account`,
      [world.operatorId],
    );
  });

  afterAll(async () => {
    if (pool !== undefined) {
      await pool.end();
    }
  });

  async function approveFor(
    url: string,
    options: { approverLanguage?: "en" | "ru" } = {},
  ): Promise<{ noticeId: string; captureId: string }> {
    const violationId = await seedViolation(pool, world, { url, observedAt: STALE_OBSERVED });
    if (options.approverLanguage !== undefined) {
      await pool.query("update operators set preferred_language = $2 where id = $1", [
        world.operatorId,
        options.approverLanguage,
      ]);
    }
    const profile = await pool.query<{ id: string }>(
      "select id from recipient_profiles where recipient = 'google'",
    );
    const composed = await pool.query<{ id: string; template_version: string }>(
      `insert into notices (recipient, recipient_profile_id, channel, template_version, language,
          composed_at, composed_by, trigger_kind)
       values ('google', $1, 'web_form', 'google-search.en.v1@ed9f34155836', 'en', $2, $3, 'on_demand')
       returning id, template_version`,
      [profile.rows[0].id, AT, world.operatorId],
    );
    const noticeId = composed.rows[0].id;
    await pool.query(
      `insert into notice_citations (notice_id, violation_id, recipient_profile_id, tracked_title_id,
          url, normalized_url, state, position, evidence)
       values ($1, $2, $3, $4, $5, $6, 'draft', 0, '[]'::jsonb)`,
      [
        noticeId,
        violationId,
        profile.rows[0].id,
        world.titleId,
        url,
        `${new URL(url).hostname}${new URL(url).pathname}`,
      ],
    );
    const approval = await approveNotice(
      { pool, now: clock.now, dispatch: async () => undefined },
      {
        noticeId,
        operatorId: world.operatorId,
        statementVersion: composed.rows[0].template_version,
      },
    );
    if (approval.status !== "approved") {
      throw new Error(`approval refused: ${JSON.stringify(approval)}`);
    }
    expect(approval.queuedCaptures).toBe(1);
    const capture = await pool.query<{ id: string }>(
      "select capture_id as id from notice_pre_handoff_captures where notice_id = $1",
      [noticeId],
    );
    return { noticeId, captureId: capture.rows[0].id };
  }

  it("creates the pending submission row once the queued captures settle — database only, never the pack bytes", async () => {
    const { noticeId, captureId } = await approveFor("https://pirate.net/settle-1");

    // Before the capture settles, the watcher creates nothing.
    expect(await settlePreHandoffCapture({ pool, now: clock.now }, captureId)).toEqual([]);

    // The runner finishes the capture: evidence appended, row terminal.
    const evidenceId = await appendEvidence(pool, clock.now, {
      captureId,
      requestedUrl: "https://pirate.net/settle-1",
      normalizedUrl: "pirate.net/settle-1",
      redirectChain: [],
      finalUrl: "https://pirate.net/settle-1",
      httpStatus: 200,
      host: "pirate.net",
      hostSource: "landing_page",
      reason: "pre_handoff",
      outcome: "captured",
      failureReason: null,
      attemptNumber: 1,
      observedAt: clock.now(),
      profile: PROFILE,
      artifacts: [],
    }, { terminal: true });

    const created = await settlePreHandoffCapture({ pool, now: clock.now }, captureId);
    expect(created).toHaveLength(1);
    const submission = await pool.query<{
      id: string;
      state: string;
      pack_language: string;
      pack_ref: string | null;
    }>(
      "select id, state, pack_language, pack_ref from submissions where notice_id = $1",
      [noticeId],
    );
    expect(submission.rows).toHaveLength(1);
    expect(submission.rows[0].state).toBe("pending");
    expect(submission.rows[0].pack_language).toBe("en");
    expect(evidenceId).toBeDefined();

    // The pack is NOT the worker's to build: no pack row, no pack reference,
    // and not one byte through the store. The API builds the pack lazily on
    // the first pack read.
    expect(submission.rows[0].pack_ref).toBeNull();
    const packs = await pool.query<{ count: string }>(
      "select count(*) as count from handoff_packs where notice_id = $1",
      [noticeId],
    );
    expect(Number(packs.rows[0].count)).toBe(0);
    expect(store.keys).toHaveLength(0);

    // A duplicate wake-up (the sweeper racing the hook) is a no-op.
    expect(await settlePreHandoffCapture({ pool, now: clock.now }, captureId)).toEqual([]);
    const stillOne = await pool.query<{ count: string }>(
      "select count(*) as count from submissions where notice_id = $1",
      [noticeId],
    );
    expect(Number(stillOne.rows[0].count)).toBe(1);
    expect(store.keys).toHaveLength(0);
  });

  it("settles the pack language frozen at approval, not the approver's later preference", async () => {
    const { noticeId, captureId } = await approveFor("https://pirate.net/settle-2", {
      approverLanguage: "ru",
    });
    // The approver's preference moves AFTER approval.
    await pool.query("update operators set preferred_language = 'en' where id = $1", [
      world.operatorId,
    ]);

    await appendEvidence(pool, clock.now, {
      captureId,
      requestedUrl: "https://pirate.net/settle-2",
      normalizedUrl: "pirate.net/settle-2",
      redirectChain: [],
      finalUrl: "https://pirate.net/settle-2",
      httpStatus: 200,
      host: "pirate.net",
      hostSource: "landing_page",
      reason: "pre_handoff",
      outcome: "captured",
      failureReason: null,
      attemptNumber: 1,
      observedAt: clock.now(),
      profile: PROFILE,
      artifacts: [],
    }, { terminal: true });

    expect(await settlePreHandoffCapture({ pool, now: clock.now }, captureId)).toHaveLength(1);
    const submission = await pool.query<{ pack_language: string }>(
      "select pack_language from submissions where notice_id = $1",
      [noticeId],
    );
    expect(submission.rows[0].pack_language).toBe("ru");
  });

  it("leaves withdrawn and superseded notices alone", async () => {
    const { noticeId, captureId } = await approveFor("https://pirate.net/settle-3");
    await pool.query(
      `update notices set state = 'withdrawn', withdrawn_by = $2, withdrawn_at = $3 where id = $1`,
      [noticeId, world.operatorId, AT],
    );
    await appendEvidence(pool, clock.now, {
      captureId,
      requestedUrl: "https://pirate.net/settle-3",
      normalizedUrl: "pirate.net/settle-3",
      redirectChain: [],
      finalUrl: null,
      httpStatus: 404,
      host: "pirate.net",
      hostSource: "landing_page",
      reason: "pre_handoff",
      outcome: "dead",
      failureReason: "http_404",
      attemptNumber: 1,
      observedAt: clock.now(),
      profile: PROFILE,
      artifacts: [],
    }, { terminal: true });

    expect(await settlePreHandoffCapture({ pool, now: clock.now }, captureId)).toEqual([]);
    const submissions = await pool.query<{ count: string }>(
      "select count(*) as count from submissions where notice_id = $1",
      [noticeId],
    );
    expect(Number(submissions.rows[0].count)).toBe(0);
  });
});
