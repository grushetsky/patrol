import { describe, expect, it } from "vitest";
import { ScanRunner } from "../src/acquisition/runner.js";
import {
  type Engine,
  type PlannedQuery,
  type SearchAdapter,
  type SearchBatch,
} from "../src/acquisition/types.js";
import { scoreCandidateAfterCapture } from "../src/matching/scoring.js";
import { pollCaptureRequests } from "../src/matching/requests.js";
import { memoryDb, seedCatalogue, seedScan } from "./support.js";

class FakeAdapter implements SearchAdapter {
  constructor(
    readonly engine: Engine,
    private readonly rows: SearchBatch["rows"],
  ) {}

  async search(_query: PlannedQuery): Promise<SearchBatch> {
    return { rawBody: "{}", rows: this.rows };
  }

  async probe(): Promise<void> {
    return;
  }
}

const row = {
  url: "https://www.Example.com/watch/film?utm_source=x",
  title: "Ирония судьбы",
  snippet: "Snippet",
  host: "www.example.com",
  position: 1,
  engine: "google" as const,
  retrievedAt: "2026-11-04T03:01:00.000Z",
  rawRef: "",
};

describe("candidate formation", () => {
  it("forms one candidate, links the result, and queues a detection capture", async () => {
    const db = await memoryDb();
    const { groupId } = await seedCatalogue(db);
    const scanId = await seedScan(db, { groupId });
    await new ScanRunner(db, { google: new FakeAdapter("google", [row]) }).run(
      scanId,
    );

    const candidate = (
      await db.query("SELECT * FROM candidate")
    ).rows[0];
    expect(candidate).toBeDefined();
    expect(candidate.state).toBe("pending");
    expect(candidate.normalized_url).toBe("example.com/watch/film");
    expect(Number(candidate.score)).toBe(0.7);

    const result = (
      await db.query("SELECT candidate_id FROM search_result LIMIT 1")
    ).rows[0];
    expect(result.candidate_id).toBe(candidate.id);

    const request = (
      await db.query("SELECT * FROM capture_request")
    ).rows[0];
    expect(request).toBeDefined();
    expect(request.state).toBe("pending");
    expect(request.candidate_id).toBe(candidate.id);
  });

  it("hands a pending capture request to the queue once", async () => {
    const db = await memoryDb();
    await db.query(
      `INSERT INTO capture_request
        (id, url, normalized_url, reason, state, created_at)
       VALUES ('request-1', 'https://example.test/a', 'example.test/a',
               'detection', 'pending', $1)`,
      [new Date()],
    );
    const sent: Array<{ requestId: string }> = [];
    expect(
      await pollCaptureRequests(db, async (data) => {
        sent.push(data);
      }),
    ).toBe(1);
    expect(sent[0].requestId).toBe("request-1");
    expect(
      (await db.query("SELECT state FROM capture_request")).rows[0].state,
    ).toBe("queued");
    expect(await pollCaptureRequests(db, async () => undefined)).toBe(0);
  });
});

describe("post-capture scoring", () => {
  async function candidate() {
    const db = await memoryDb();
    const { groupId } = await seedCatalogue(db);
    const scanId = await seedScan(db, { groupId });
    await new ScanRunner(db, { google: new FakeAdapter("google", [row]) }).run(
      scanId,
    );
    const found = (await db.query("SELECT * FROM candidate")).rows[0];
    return { db, candidateId: String(found.id) };
  }

  it("adds a captured signal to the candidate score", async () => {
    const { db, candidateId } = await candidate();
    await scoreCandidateAfterCapture(db, {
      candidateId,
      sidecar: {
        title: "Ирония судьбы",
        h1: ["Ирония судьбы"],
        meta: {},
        jsonLd: [],
        iframes: [],
        videos: [],
        downloadAffordances: ["magnet:?xt=urn:btih:abc"],
      },
      finalUrl: "https://example.com/watch/film",
      host: "example.com",
      outcome: "captured",
      observedAt: new Date("2026-11-04T03:02:00Z"),
    });
    const updated = (
      await db.query("SELECT * FROM candidate WHERE id = $1", [candidateId])
    ).rows[0];
    expect(Number(updated.score)).toBe(0.95);
    expect(updated.final_url).toBe("https://example.com/watch/film");
  });

  it("reopens a dismissed pair on a new strong signal", async () => {
    const { db, candidateId } = await candidate();
    await db.query(
      `UPDATE candidate
          SET state = 'dismissed', dismissal = '{"action":"not_a_violation"}',
              dismissal_signals = '[]', dismissal_episode_max = 0,
              dismissal_registrable_domain = 'example.com'
        WHERE id = $1`,
      [candidateId],
    );
    await scoreCandidateAfterCapture(db, {
      candidateId,
      sidecar: {
        title: "Ирония судьбы",
        h1: ["Ирония судьбы"],
        meta: {},
        jsonLd: [],
        iframes: [],
        videos: [],
        downloadAffordances: ["magnet:?xt=urn:btih:abc"],
      },
      finalUrl: "https://example.com/watch/film",
      host: "example.com",
      outcome: "captured",
      observedAt: new Date("2026-11-04T03:03:00Z"),
    });
    const updated = (
      await db.query("SELECT state FROM candidate WHERE id = $1", [candidateId])
    ).rows[0];
    expect(updated.state).toBe("pending");
  });
});
