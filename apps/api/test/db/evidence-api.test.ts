import { beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { buildApp, testConfig } from "../test-app.js";
import { getValidator } from "../../src/plugins/validator.js";
import { MemoryMailTransport } from "../../src/mail/transport.js";
import {
  ceremonyApp,
  signedInAdministrator,
  inviteAndEnroll,
  authHeaders,
  FROZEN_NOW as CEREMONY_NOW,
  type CeremonyApp,
  type SignedInOperator,
} from "./ceremony.js";
import { testPool, truncateDomainTables } from "./helpers.js";
import type { PresignRequest } from "@patrol/evidence";

/**
 * Seams 4 (the API half), 9, and 10 over HTTP: the evidence metadata
 * endpoint validates against the emitted contract schema and surfaces the
 * capture profile and the truncation flags, the download route returns a
 * signed content-pinned reference minted with the recorded parameters —
 * and 410 bytes_purged once retention has marked the bytes while the
 * metadata survives — the objection list serves its filters, and the
 * clearance route is the operator decision that reopens a host, never a
 * deletion. A plain operator reaches everything the contract's
 * x-patrol-roles allows.
 */

const FROZEN_NOW = "2026-05-01T10:00:00.000Z";

const PROFILE = {
  userAgent: "Patrol/0.1 (evidentiary page capture; contact: tests@example.test)",
  viewportWidth: 800,
  viewportHeight: 600,
  locale: "en-US",
  timezone: "UTC",
  javascriptEnabled: true,
  blockedResourceKinds: [
    "media",
    "websocket",
    "service_worker",
    "advertising",
    "third_party_analytics",
  ],
  navigationPolicy: "load+2000ms settle; 25s navigation; 45s total",
  extractorVersion: "sidecar-minimal/1",
};

const SHA_BODY = "ab".repeat(32);
const SHA_HEADERS = "cd".repeat(32);
const SHA_SHOT = "ef".repeat(32);

/** One captured evidence row with its artifact manifest, seeded directly. */
async function seedEvidence(
  pool: Pool,
  options: {
    host?: string;
    truncatedScreenshot?: boolean;
    purgedAt?: string;
  } = {},
): Promise<string> {
  const host = options.host ?? "page.example.test";
  const url = `https://${host}/watch`;
  const capture = await pool.query<{ id: string }>(
    `insert into captures (requested_url, normalized_url, reason, point_key, requested_at)
     values ($1, $2, 'detection', $3, $4) returning id`,
    [url, `${host}/watch`, `seed-${Math.random().toString(36).slice(2)}`, FROZEN_NOW],
  );
  const evidence = await pool.query<{ id: string }>(
    `insert into evidence
       (capture_id, requested_url, normalized_url, final_url, redirect_chain, host, host_source,
        reason, outcome, http_status, attempt_number, observed_at, capture_profile, purged_at, purge_reason)
     values ($1, $2, $3, $2, $4::jsonb, $5, 'landing_page', 'detection', 'captured', 200, 1, $6, $7::jsonb, $8, $9)
     returning id`,
    [
      capture.rows[0].id,
      url,
      `${host}/watch`,
      JSON.stringify([{ url, statusCode: 302, location: "/watch" }]),
      host,
      FROZEN_NOW,
      JSON.stringify(PROFILE),
      options.purgedAt ?? null,
      options.purgedAt === undefined ? null : "retention_window_elapsed",
    ],
  );
  const evidenceId = evidence.rows[0].id;
  await pool.query(
    `insert into evidence_artifacts
       (evidence_id, kind, sha256, size_bytes, content_type, width, height, truncated, object_version)
     values
       ($1, 'response_body', $2, 2048, 'text/html; charset=utf-8', null, null, false, 'v-1'),
       ($1, 'response_headers', $3, 300, 'application/json', null, null, false, 'v-2'),
       ($1, 'screenshot', $4, 999999, 'image/png', 800, 600, $5, 'v-3')`,
    [evidenceId, SHA_BODY, SHA_HEADERS, SHA_SHOT, options.truncatedScreenshot ?? false],
  );
  await pool.query(
    "update captures set evidence_id = $2, state = 'done', finished_at = $3 where id = $1",
    [capture.rows[0].id, evidenceId, FROZEN_NOW],
  );
  return evidenceId;
}

async function seedObjection(
  pool: Pool,
  operatorId: string,
  options: { host: string; cleared?: boolean },
): Promise<string> {
  const row = await pool.query<{ id: string }>(
    `insert into host_objections
       (host, registrable_domain, source, reason, recorded_at, recorded_by, affected_candidate_count,
        cleared_at, cleared_by, clearance_reason)
     values ($1, 'example.test', 'operator', $2, $3, $4, 2, $5, $6, $7)
     returning id`,
    [
      options.host,
      "The host sent a cease-and-desist naming Patrol.",
      FROZEN_NOW,
      operatorId,
      options.cleared === true ? FROZEN_NOW : null,
      options.cleared === true ? operatorId : null,
      options.cleared === true ? "Resolved with the host." : null,
    ],
  );
  return row.rows[0].id;
}

/** The recording presigner: what the download route asked the store for. */
function recordingPresigner() {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    async presignDownload(request: PresignRequest) {
      calls.push({ ...request });
      return {
        url: `https://minio.example.test/signed/${request.sha256.slice(0, 8)}`,
        expiresAt: new Date(
          new Date(FROZEN_NOW).getTime() + request.expiresInSeconds * 1000,
        ),
      };
    },
  };
}

describe("the evidence and host-objection routes", () => {
  let world: CeremonyApp;
  let admin: SignedInOperator;
  let presigner: ReturnType<typeof recordingPresigner>;

  beforeEach(async () => {
    const pool = testPool();
    try {
      await truncateDomainTables(pool);
    } finally {
      await pool.end();
    }
    world = await ceremonyApp();
    admin = await signedInAdministrator(world);
    presigner = recordingPresigner();
    const app = await buildApp({
      config: testConfig({ now: world.clock.now }),
      pool: world.pool,
      mail: world.mail,
      schemaStamp: () => Promise.resolve(5),
      evidencePresigner: presigner,
    });
    world.app = app;
  });

  it("serves the capture's metadata in the emitted EvidenceDetail shape (seam 9)", async () => {
    const evidenceId = await seedEvidence(world.pool);
    const response = await world.app.inject({
      method: "GET",
      url: `/api/evidence/${evidenceId}`,
      headers: { cookie: admin.cookie },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(getValidator("EvidenceDetail")(body)).toBe(true);

    const evidence = body.evidence;
    expect(evidence.requestedUrl).toBe("https://page.example.test/watch");
    expect(evidence.redirectChain).toEqual([
      { url: "https://page.example.test/watch", statusCode: 302, location: "/watch" },
    ]);
    expect(evidence.host).toBe("page.example.test");
    expect(evidence.hostSource).toBe("landing_page");
    expect(evidence.outcome).toBe("captured");
    expect(evidence.attemptNumber).toBe(1);
    // Seam 10: the profile and the truncation flags are part of the read.
    expect(evidence.profile).toEqual(PROFILE);
    expect(body.downloadAvailable).toBe(true);
    const shot = body.artifacts.find(
      (artifact: { kind: string }) => artifact.kind === "screenshot",
    );
    expect(shot.truncated).toBe(false);
  });

  it("surfaces the truncation flags the ceilings set (seam 10)", async () => {
    const evidenceId = await seedEvidence(world.pool, { truncatedScreenshot: true });
    const response = await world.app.inject({
      method: "GET",
      url: `/api/evidence/${evidenceId}`,
      headers: { cookie: admin.cookie },
    });
    const shot = response
      .json()
      .artifacts.find((artifact: { kind: string }) => artifact.kind === "screenshot");
    expect(shot.truncated).toBe(true);
    expect(shot.height).toBe(600);
  });

  it("answers 404 for an unknown capture", async () => {
    const response = await world.app.inject({
      method: "GET",
      url: "/api/evidence/018f4c8e-1c2a-7c3e-9b1f-2b6d9f0a3c99",
      headers: { cookie: admin.cookie },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().code).toBe("not_found");
  });

  it("mints a signed, content-pinned download reference (seam 9)", async () => {
    const evidenceId = await seedEvidence(world.pool);
    const response = await world.app.inject({
      method: "GET",
      url: `/api/evidence/${evidenceId}/artifacts/${SHA_SHOT}/download`,
      headers: { cookie: admin.cookie },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(getValidator("ArtifactDownloadRef")(body)).toBe(true);
    expect(body.sha256).toBe(SHA_SHOT);
    expect(body.contentType).toBe("image/png");
    // The presign carried the artifact's pinning: the hash, the content
    // type, the recorded object version, and the configured TTL.
    expect(presigner.calls).toHaveLength(1);
    expect(presigner.calls[0]).toEqual({
      kind: "screenshot",
      sha256: SHA_SHOT,
      contentType: "image/png",
      objectVersion: "v-3",
      expiresInSeconds: 300,
    });
  });

  it("answers 404 for an artifact the capture does not carry", async () => {
    const evidenceId = await seedEvidence(world.pool);
    const response = await world.app.inject({
      method: "GET",
      url: `/api/evidence/${evidenceId}/artifacts/${"09".repeat(32)}/download`,
      headers: { cookie: admin.cookie },
    });
    expect(response.statusCode).toBe(404);
  });

  it("answers 410 bytes_purged when retention has taken the bytes (seam 9)", async () => {
    const evidenceId = await seedEvidence(world.pool, {
      purgedAt: "2031-05-01T10:00:00.000Z",
    });
    // The metadata survives the purge.
    const metadata = await world.app.inject({
      method: "GET",
      url: `/api/evidence/${evidenceId}`,
      headers: { cookie: admin.cookie },
    });
    expect(metadata.statusCode).toBe(200);
    expect(metadata.json().downloadAvailable).toBe(false);
    expect(metadata.json().evidence.purgedAt).toBe("2031-05-01T10:00:00.000Z");
    expect(metadata.json().evidence.purgeReason).toBe("retention_window_elapsed");

    const download = await world.app.inject({
      method: "GET",
      url: `/api/evidence/${evidenceId}/artifacts/${SHA_BODY}/download`,
      headers: { cookie: admin.cookie },
    });
    expect(download.statusCode).toBe(410);
    expect(download.json().code).toBe("bytes_purged");
    expect(presigner.calls).toHaveLength(0);
  });

  it("lists objections with the host and active filters (seam 4)", async () => {
    const active = await seedObjection(world.pool, admin.operatorId, {
      host: "active.example.test",
    });
    await seedObjection(world.pool, admin.operatorId, {
      host: "cleared.example.test",
      cleared: true,
    });
    const all = await world.app.inject({
      method: "GET",
      url: "/api/host-objections",
      headers: { cookie: admin.cookie },
    });
    expect(all.statusCode).toBe(200);
    expect(all.json().total).toBe(2);
    expect(all.json().items).toHaveLength(2);
    expect(getValidator("HostObjection")(all.json().items[0])).toBe(true);

    const onlyActive = await world.app.inject({
      method: "GET",
      url: "/api/host-objections?active=true",
      headers: { cookie: admin.cookie },
    });
    expect(onlyActive.json().total).toBe(1);
    expect(onlyActive.json().items[0].host).toBe("active.example.test");
    expect(onlyActive.json().items[0].clearedAt).toBeUndefined();

    const byHost = await world.app.inject({
      method: "GET",
      url: "/api/host-objections?host=cleared.example.test",
      headers: { cookie: admin.cookie },
    });
    expect(byHost.json().total).toBe(1);
    expect(byHost.json().items[0].clearedAt).toBe(FROZEN_NOW);
    void active;
  });

  it("clears an objection on an operator's explicit decision, once (seam 4)", async () => {
    const objectionId = await seedObjection(world.pool, admin.operatorId, {
      host: "clearance.example.test",
    });
    const response = await world.app.inject({
      method: "POST",
      url: `/api/host-objections/${objectionId}/clearance`,
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: { reason: "The host and the rights holder resolved the complaint." },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(getValidator("HostObjection")(body)).toBe(true);
    expect(body.clearedAt).toBe(CEREMONY_NOW);
    expect(body.clearedBy).toBe(admin.operatorId);
    expect(body.clearanceReason).toContain("resolved");

    // The objection row survives as history — it is never deleted.
    const rows = await world.pool.query("select * from host_objections");
    expect(rows.rows).toHaveLength(1);

    // Clearing an already-cleared objection is a state conflict.
    const again = await world.app.inject({
      method: "POST",
      url: `/api/host-objections/${objectionId}/clearance`,
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: { reason: "A second decision." },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe("state_conflict");
  });

  it("answers 404 for an unknown objection", async () => {
    const missing = await world.app.inject({
      method: "POST",
      url: "/api/host-objections/018f4c8e-1c2a-7c3e-9b1f-2b6d9f0a3c99/clearance",
      headers: { "content-type": "application/json", ...authHeaders(admin) },
      payload: { reason: "Whatever." },
    });
    expect(missing.statusCode).toBe(404);
  });

  it("serves a plain operator everything the contract's roles allow", async () => {
    const operator = await inviteAndEnroll(world, admin, "operator-evidence@example.test");
    const evidenceId = await seedEvidence(world.pool);
    const read = await world.app.inject({
      method: "GET",
      url: `/api/evidence/${evidenceId}`,
      headers: { cookie: operator.cookie },
    });
    expect(read.statusCode).toBe(200);
    const objectionId = await seedObjection(world.pool, admin.operatorId, {
      host: "operator-clears.example.test",
    });
    const cleared = await world.app.inject({
      method: "POST",
      url: `/api/host-objections/${objectionId}/clearance`,
      headers: { "content-type": "application/json", ...authHeaders(operator) },
      payload: { reason: "The operator reviewed the correspondence." },
    });
    expect(cleared.statusCode).toBe(200);
  });

  it("requires a session", async () => {
    const response = await world.app.inject({
      method: "GET",
      url: "/api/evidence/018f4c8e-1c2a-7c3e-9b1f-2b6d9f0a3c99",
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().code).toBe("unauthenticated");
  });
});
