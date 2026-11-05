import { beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runRetentionPurge, type RetentionStore, type PresignRequest } from "@patrol/evidence";
import { buildApp, poolSchemaStamp, testConfig } from "../test-app.js";
import { MemoryMailTransport } from "../../src/mail/transport.js";
import {
  ceremonyApp,
  signedInAdministrator,
  inviteAndEnroll,
  authHeaders,
  FROZEN_NOW,
  type CeremonyApp,
  type SignedInOperator,
} from "./ceremony.js";
import { testPool, truncateDomainTables } from "./helpers.js";

/**
 * Seams 10 and 4 over HTTP: the legal-hold routes the contract carries
 * (list, placement over the three scopes, the administrator-only release),
 * and the download route's 410 bytes_purged verified against a REAL
 * retention pass rather than a hand-set marker — the purge marks, the
 * metadata survives, and the next download of the purged bytes answers
 * 410 while the metadata endpoint still serves the record.
 */

const PROFILE = {
  userAgent: "Patrol/0.1 (evidentiary page capture; contact: tests@example.test)",
  viewportWidth: 800,
  viewportHeight: 600,
  locale: "en-US",
  timezone: "UTC",
  javascriptEnabled: true,
  blockedResourceKinds: ["media", "websocket", "service_worker", "advertising", "third_party_analytics"],
  navigationPolicy: "load+2000ms settle; 25s navigation; 45s total",
  extractorVersion: "sidecar-minimal/1",
};

/** One never-cited captured evidence row with one artifact. */
async function seedEvidence(pool: Pool, observedAt: string): Promise<string> {
  const host = `page-${Math.random().toString(36).slice(2)}.example.test`;
  const url = `https://${host}/watch`;
  const capture = await pool.query<{ id: string }>(
    `insert into captures (requested_url, normalized_url, reason, point_key, requested_at)
     values ($1, $2, 'detection', $3, $4) returning id`,
    [url, `${host}/watch`, `seed-${Math.random().toString(36).slice(2)}`, observedAt],
  );
  const evidence = await pool.query<{ id: string }>(
    `insert into evidence
       (capture_id, requested_url, normalized_url, final_url, host, host_source,
        reason, outcome, http_status, attempt_number, observed_at, capture_profile)
     values ($1, $2, $3, $2, $4, 'landing_page', 'detection', 'captured', 200, 1, $5, $6::jsonb)
     returning id`,
    [capture.rows[0].id, url, `${host}/watch`, host, observedAt, JSON.stringify(PROFILE)],
  );
  await pool.query(
    `insert into evidence_artifacts
       (evidence_id, kind, sha256, size_bytes, content_type, truncated, object_version)
     values ($1, 'response_body', $2, 10, 'text/html', false, 'v1')`,
    [evidence.rows[0].id, `${Math.random().toString(16).slice(2, 8)}`.padEnd(64, "0")],
  );
  return evidence.rows[0].id;
}

/** A purge store that records deletes without touching any bucket. */
class RecordingStore implements RetentionStore {
  readonly deleted: string[] = [];
  async deleteArtifactVersion(request: { sha256: string }): Promise<void> {
    this.deleted.push(request.sha256);
  }
  async purgeRawSerpPayloadsOlderThan(): Promise<string[]> {
    return [];
  }
}

describe("legal holds over HTTP", () => {
  let world: CeremonyApp;
  let admin: SignedInOperator;
  let operator: SignedInOperator;
  const pool: Pool = testPool();

  beforeEach(async () => {
    await truncateDomainTables(pool);
    world = await ceremonyApp();
    admin = await signedInAdministrator(world, "admin@example.test");
    operator = await inviteAndEnroll(world, admin, "holder@example.test");
    // A presigning fake, so the download route needs no bucket.
    const app = await buildApp({
      config: testConfig({ now: world.clock.now }),
      pool: world.pool,
      mail: world.mail,
      schemaStamp: poolSchemaStamp(world.pool),
      evidencePresigner: recordingPresigner(),
    });
    world.app = app;
  });

  it("places a hold, lists it, and records the release with its operator and reason", async () => {
    const evidenceId = await seedEvidence(pool, FROZEN_NOW);
    const place = await world.app.inject({
      method: "POST",
      url: "/api/legal-holds",
      headers: authHeaders(operator),
      payload: {
        reason: "Counter-notice received",
        evidenceIds: [evidenceId],
        violationIds: [],
        noticeIds: [],
      },
    });
    expect(place.statusCode).toBe(201);
    const hold = place.json();
    expect(hold.reason).toBe("Counter-notice received");
    expect(hold.createdBy).toBe(operator.operatorId);
    expect(hold.evidenceIds).toEqual([evidenceId]);
    expect(hold.releasedAt).toBeUndefined();

    const list = await world.app.inject({
      method: "GET",
      url: "/api/legal-holds",
      headers: { cookie: operator.cookie },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().total).toBe(1);
    expect(list.json().items[0].id).toBe(hold.id);

    // The release is the administrator's alone (the contract's role).
    const operatorRelease = await world.app.inject({
      method: "POST",
      url: `/api/legal-holds/${hold.id}/release`,
      headers: authHeaders(operator),
      payload: { reason: "Dispute resolved" },
    });
    expect(operatorRelease.statusCode).toBe(403);

    const release = await world.app.inject({
      method: "POST",
      url: `/api/legal-holds/${hold.id}/release`,
      headers: authHeaders(admin),
      payload: { reason: "Dispute resolved" },
    });
    expect(release.statusCode).toBe(200);
    expect(release.json().releasedBy).toBe(admin.operatorId);
    expect(release.json().releasedAt).toBe(FROZEN_NOW);

    // A second release is a state conflict, not a second release.
    const again = await world.app.inject({
      method: "POST",
      url: `/api/legal-holds/${hold.id}/release`,
      headers: authHeaders(admin),
      payload: { reason: "once more" },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe("state_conflict");

    const absent = await world.app.inject({
      method: "POST",
      url: "/api/legal-holds/00000000-0000-7000-8000-000000000000/release",
      headers: authHeaders(admin),
      payload: { reason: "no such hold" },
    });
    expect(absent.statusCode).toBe(404);
  });

  it("refuses a hold that covers nothing", async () => {
    const place = await world.app.inject({
      method: "POST",
      url: "/api/legal-holds",
      headers: authHeaders(admin),
      payload: {
        reason: "no scope",
        evidenceIds: [],
        violationIds: [],
        noticeIds: [],
      },
    });
    expect(place.statusCode).toBe(422);
  });

  it("refuses a whitespace-only reason with 422, not the database's CHECK", async () => {
    const evidenceId = await seedEvidence(pool, FROZEN_NOW);
    // The contract types reason as a bare string, so "   " passes schema
    // validation; the route's trim-and-reject keeps it a 422 instead of
    // the insert dying on the table's CHECK (a 500 to the operator).
    const place = await world.app.inject({
      method: "POST",
      url: "/api/legal-holds",
      headers: authHeaders(operator),
      payload: {
        reason: "   ",
        evidenceIds: [evidenceId],
        violationIds: [],
        noticeIds: [],
      },
    });
    expect(place.statusCode).toBe(422);

    // A padded but real reason places the hold with its trimmed text.
    const padded = await world.app.inject({
      method: "POST",
      url: "/api/legal-holds",
      headers: authHeaders(operator),
      payload: {
        reason: "  Counter-notice received  ",
        evidenceIds: [evidenceId],
        violationIds: [],
        noticeIds: [],
      },
    });
    expect(padded.statusCode).toBe(201);
    const hold = padded.json();
    expect(hold.reason).toBe("Counter-notice received");

    // The release reason answers to the same line.
    const release = await world.app.inject({
      method: "POST",
      url: `/api/legal-holds/${hold.id}/release`,
      headers: authHeaders(admin),
      payload: { reason: " " },
    });
    expect(release.statusCode).toBe(422);
  });

  it("serves the list to operators and keeps it administrator-shaped for placement", async () => {
    const operatorList = await world.app.inject({
      method: "GET",
      url: "/api/legal-holds",
      headers: { cookie: operator.cookie },
    });
    expect(operatorList.statusCode).toBe(200);

    const anonymous = await world.app.inject({ method: "GET", url: "/api/legal-holds" });
    expect(anonymous.statusCode).toBe(401);
  });

  it("410 bytes_purged after a real retention pass, with the metadata surviving", async () => {
    const evidenceId = await seedEvidence(world.pool, "2024-01-01T00:00:00.000Z");
    const shaRow = await world.pool.query<{ sha256: string }>(
      "select sha256 from evidence_artifacts where evidence_id = $1",
      [evidenceId],
    );
    const sha256 = shaRow.rows[0].sha256;

    // The download works before the window elapses.
    const before = await world.app.inject({
      method: "GET",
      url: `/api/evidence/${evidenceId}/artifacts/${sha256}/download`,
      headers: { cookie: admin.cookie },
    });
    expect(before.statusCode).toBe(200);

    // The real purge: the never-cited window has long passed.
    const store = new RecordingStore();
    const summary = await runRetentionPurge({
      pool: world.pool,
      now: () => new Date(FROZEN_NOW),
      store,
    });
    expect(summary.marked).toBeGreaterThanOrEqual(1);
    expect(store.deleted).toContain(sha256);

    const after = await world.app.inject({
      method: "GET",
      url: `/api/evidence/${evidenceId}/artifacts/${sha256}/download`,
      headers: { cookie: admin.cookie },
    });
    expect(after.statusCode).toBe(410);
    expect(after.json().code).toBe("bytes_purged");

    // The record survives with its manifest and purge marker.
    const metadata = await world.app.inject({
      method: "GET",
      url: `/api/evidence/${evidenceId}`,
      headers: { cookie: admin.cookie },
    });
    expect(metadata.statusCode).toBe(200);
    const detail = metadata.json();
    expect(detail.downloadAvailable).toBe(false);
    expect(detail.evidence.purgedAt).toBe(FROZEN_NOW);
    expect(detail.evidence.purgeReason).toBe("never_cited_window");
    expect(detail.evidence.artifacts).toHaveLength(1);
  });
});

/** The recording presigner the download assertions ride on. */
function recordingPresigner() {
  return {
    async presignDownload(request: PresignRequest) {
      return {
        url: `https://minio.example.test/signed/${request.sha256.slice(0, 8)}`,
        expiresAt: new Date(new Date(FROZEN_NOW).getTime() + request.expiresInSeconds * 1000),
      };
    },
  };
}
