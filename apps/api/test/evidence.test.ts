import { beforeEach, describe, expect, it } from "vitest";
import {
  bootstrapAdmin,
  harness,
  mutate,
  read,
  type Harness,
} from "./support/harness.js";
import type { ArtifactStore } from "../src/evidence/store.js";

const EVIDENCE_ID = "00000000-0000-7000-8000-000000000101";
const OBJECTION_ID = "00000000-0000-7000-8000-000000000102";
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const NOW = new Date("2026-11-04T12:00:00Z");

const store: ArtifactStore = {
  async signedUrl(key, version) {
    return {
      url: `https://s3.test/${key}?versionId=${version ?? "none"}`,
      expiresAt: "2026-11-04T12:05:00.000Z",
    };
  },
};

async function seedEvidence(
  db: Harness["db"],
  overrides: { purged?: boolean } = {},
) {
  await db.query(
    `INSERT INTO evidence
      (id, tracked_title_id, title_group_id, requested_url,
       normalized_requested_url, redirect_chain, final_url, host, host_source,
       reason, outcome, http_status, failure_reason, attempt_number,
       observed_at, profile, purged_at, purge_reason, created_at)
     VALUES ($1, NULL, NULL, 'https://example.test/watch',
             'example.test/watch', $2, 'https://example.test/watch',
             'example.test', 'landing_page', 'detection', 'captured', 200,
             NULL, 1, $3, $4, $5, $6, $3)`,
    [
      EVIDENCE_ID,
      JSON.stringify([
        { url: "https://example.test/watch", statusCode: 200 },
      ]),
      NOW,
      JSON.stringify({
        userAgent: "PatrolBot/0.1",
        viewportWidth: 1365,
        viewportHeight: 900,
        locale: "en-US",
        timezone: "UTC",
        javascriptEnabled: true,
        blockedResourceKinds: ["media", "service_worker"],
        navigationPolicy: "load plus 2s settle",
        extractorVersion: "1",
      }),
      overrides.purged ? NOW : null,
      overrides.purged ? "retention" : null,
    ],
  );
  for (const [index, sha] of [SHA_A, SHA_B].entries()) {
    await db.query(
      `INSERT INTO evidence_artifact
        (evidence_id, kind, sha256, byte_size, content_type, width, height,
         truncated, object_key, object_version, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, false, $8, 'v1', $9)`,
      [
        EVIDENCE_ID,
        index === 0 ? "response_body" : "thumbnail",
        sha,
        index === 0 ? 120 : 4000,
        index === 0 ? "text/html" : "image/jpeg",
        index === 0 ? null : 1365,
        index === 0 ? null : 900,
        `evidence/sha256/${sha.slice(0, 2)}/${sha.slice(2, 4)}/${sha}`,
        NOW,
      ],
    );
  }
}

describe("evidence", () => {
  let h: Harness;
  let session: string;

  beforeEach(async () => {
    h = await harness(undefined, store);
    session = (await bootstrapAdmin(h)).session;
  });

  it("reads a capture with its artifact manifest", async () => {
    await seedEvidence(h.db);

    const response = await read(
      h.app,
      session,
      `/api/evidence/${EVIDENCE_ID}`,
    );

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      downloadAvailable: true,
      evidence: {
        id: EVIDENCE_ID,
        requestedUrl: "https://example.test/watch",
        normalizedRequestedUrl: "example.test/watch",
        finalUrl: "https://example.test/watch",
        host: "example.test",
        hostSource: "landing_page",
        reason: "detection",
        outcome: "captured",
        attemptNumber: 1,
      },
      artifacts: [
        expect.objectContaining({ sha256: SHA_A, kind: "response_body" }),
        expect.objectContaining({ sha256: SHA_B, kind: "thumbnail" }),
      ],
    });
    expect(
      h.contract.validate("EvidenceDetail", response.json()).issues,
    ).toEqual([]);
  });

  it("signs one artifact and pins its hash and version", async () => {
    await seedEvidence(h.db);

    const response = await read(
      h.app,
      session,
      `/api/evidence/${EVIDENCE_ID}/artifacts/${SHA_A}/download`,
    );

    expect(response.statusCode).toBe(200);
    expect(response.json().sha256).toBe(SHA_A);
    expect(response.json().contentType).toBe("text/html");
    expect(response.json().url).toContain("versionId=v1");
    expect(
      h.contract.validate("ArtifactDownloadRef", response.json()).issues,
    ).toEqual([]);
  });

  it("answers 410 for purged bytes while the record survives", async () => {
    await seedEvidence(h.db, { purged: true });

    const detail = await read(h.app, session, `/api/evidence/${EVIDENCE_ID}`);
    expect(detail.json().downloadAvailable).toBe(false);
    expect(detail.json().evidence.purgedAt).toBeTruthy();

    const download = await read(
      h.app,
      session,
      `/api/evidence/${EVIDENCE_ID}/artifacts/${SHA_A}/download`,
    );
    expect(download.statusCode).toBe(410);
    expect(download.json().code).toBe("bytes_purged");
  });

  it("answers 404 for an unknown capture or artifact", async () => {
    await seedEvidence(h.db);

    const unknownEvidence = await read(
      h.app,
      session,
      "/api/evidence/00000000-0000-7000-8000-000000000999",
    );
    expect(unknownEvidence.statusCode).toBe(404);

    const unknownArtifact = await read(
      h.app,
      session,
      `/api/evidence/${EVIDENCE_ID}/artifacts/${"c".repeat(64)}/download`,
    );
    expect(unknownArtifact.statusCode).toBe(404);
  });

  it("lists objections and clears one without deleting it", async () => {
    await h.db.query(
      `INSERT INTO host_objection
        (id, host, registrable_domain, reason, source, recorded_at, recorded_by,
         affected_candidate_count, cleared_at, cleared_by, clearance_reason)
       VALUES ($1, 'example.test', 'example.test', 'Cease and desist',
               'host_contact', $2, NULL, 3, NULL, NULL, NULL)`,
      [OBJECTION_ID, NOW],
    );
    const admin = (await h.auth.listOperators()).find(
      (operator) => operator.role === "administrator",
    )!;

    const page = await read(h.app, session, "/api/host-objections?active=true");
    expect(page.statusCode).toBe(200);
    expect(page.json().total).toBe(1);
    expect(
      h.contract.validate("HostObjectionPage", page.json()).issues,
    ).toEqual([]);

    const cleared = await mutate(
      h.app,
      session,
      "POST",
      `/api/host-objections/${OBJECTION_ID}/clearance`,
      { reason: "Dispute resolved" },
    );
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toMatchObject({
      id: OBJECTION_ID,
      clearedBy: admin.id,
      clearanceReason: "Dispute resolved",
    });
    expect(
      h.contract.validate("HostObjection", cleared.json()).issues,
    ).toEqual([]);

    const again = await mutate(
      h.app,
      session,
      "POST",
      `/api/host-objections/${OBJECTION_ID}/clearance`,
      { reason: "Again" },
    );
    expect(again.statusCode).toBe(409);
    expect(again.json().currentState).toBe("cleared");

    const active = await read(h.app, session, "/api/host-objections?active=true");
    expect(active.json().total).toBe(0);
    const inactive = await read(
      h.app,
      session,
      "/api/host-objections?active=false",
    );
    expect(inactive.json().total).toBe(1);
  });

  it("gates evidence reads behind bootstrap", async () => {
    const fresh = await harness(undefined, store);

    const response = await read(fresh.app, "unused", "/api/host-objections");
    expect(response.statusCode).toBe(503);
  });
});
