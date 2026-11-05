import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { ListObjectVersionsCommand, S3Client } from "@aws-sdk/client-s3";
import { artifactKey, enqueueCapture, readCapture, readEvidence } from "@patrol/evidence";
import { capturePage, launchCaptureBrowser } from "../../src/capture/browser.js";
import type { Browser } from "playwright";
import { runCapture } from "../../src/capture/runner.js";
import { startFixtureServer, type FixtureServer } from "../fixtures/server.js";
import { controlledClock, seedWorld, testPool } from "./helpers.js";
import {
  TEST_PROFILE,
  noopDispatch,
  runnerDeps,
  testBucket,
  testStore,
} from "./capture-helpers.js";

/**
 * Seams 1, 2, 3, 8, 10 against the real stack: a real Chromium fetching
 * fixture pages, the real content-addressed store on the throwaway minio
 * container, and the real record in PostgreSQL. Every fixture page asserts
 * its exact outcome, artifact set, and metadata.
 */

const BUDGETS = { navigationMs: 10_000, settleMs: 100, totalMs: 20_000 };

let browser: Browser;
let fixtures: FixtureServer;
let pool: Pool;
const bucket = testBucket("fixtures");

beforeAll(async () => {
  fixtures = await startFixtureServer();
  browser = await launchCaptureBrowser();
  await testStore(bucket).ensureReady();
  pool = testPool();
  await seedWorld(pool);
});

afterAll(async () => {
  await browser.close();
  await fixtures.close();
  await pool.end();
});

/** Each runOne is its own detection instant; the clock moves a minute a run. */
let clockMinutes = 0;

async function runOne(
  path: string,
  options: { budgets?: typeof BUDGETS } = {},
): Promise<{ captureId: string; evidenceId: string; at: Date }> {
  clockMinutes += 1;
  const clock = controlledClock(
    new Date(new Date("2026-05-01T10:00:00.000Z").getTime() + clockMinutes * 60_000).toISOString(),
  );
  const url = `${fixtures.url}${path}`;
  const result = await enqueueCapture(
    { pool, now: clock.now, dispatch: noopDispatch },
    { url, reason: "detection" },
  );
  if (result.status !== "queued") {
    throw new Error(`fixture enqueue did not queue: ${JSON.stringify(result)}`);
  }
  const deps = runnerDeps(pool, clock, testStore(bucket), (target) =>
    capturePage(browser, target, TEST_PROFILE, options.budgets ?? BUDGETS),
  );
  await runCapture(deps, result.captureId, () => {});
  const capture = await readCapture(pool, result.captureId);
  if (capture === null || capture.evidenceId === null) {
    throw new Error("fixture capture produced no evidence row");
  }
  return { captureId: result.captureId, evidenceId: capture.evidenceId, at: clock.now() };
}

function kindsOf(artifacts: Array<{ kind: string }>): string[] {
  return artifacts.map((artifact) => artifact.kind).sort();
}

describe("the capture worker over fixture pages (seam 1)", () => {
  it("captures a normal page with the full bundle and sanitized headers", async () => {
    const { evidenceId } = await runOne("/normal");
    const record = await readEvidence(pool, evidenceId);
    if (record === null) {
      throw new Error("evidence row missing");
    }
    const { evidence, artifacts } = record;
    expect(evidence.outcome).toBe("captured");
    expect(evidence.failureReason).toBeNull();
    expect(evidence.httpStatus).toBe(200);
    expect(evidence.finalUrl).toBe(`${fixtures.url}/normal`);
    expect(evidence.host).toBe("127.0.0.1");
    expect(evidence.hostSource).toBe("landing_page");
    expect(evidence.requestedUrl).toBe(`${fixtures.url}/normal`);
    expect(evidence.redirectChain).toEqual([]);
    expect(evidence.attemptNumber).toBe(1);
    expect(kindsOf(artifacts)).toEqual([
      "extraction_sidecar",
      "rendered_dom",
      "response_body",
      "response_headers",
      "screenshot",
      "thumbnail",
    ]);

    // Seam 8 is asserted by the dedicated headers test below; here the
    // artifact set is the point.

    // The screenshot recorded its dimensions; the sidecar its extraction.
    const screenshot = artifacts.find((artifact) => artifact.kind === "screenshot")!;
    expect(screenshot.width).toBe(TEST_PROFILE.viewportWidth);
    expect(screenshot.height).toBeGreaterThan(0);
    expect(screenshot.truncated).toBe(false);
    const sidecar = artifacts.find((artifact) => artifact.kind === "extraction_sidecar")!;
    expect(sidecar.contentType).toBe("application/json");

    // Seam 10: the capture profile is part of the record.
    expect(evidence.profile.userAgent).toBe(TEST_PROFILE.userAgent);
    expect(evidence.profile.viewportWidth).toBe(TEST_PROFILE.viewportWidth);
    expect(evidence.profile.blockedResourceKinds).toEqual(TEST_PROFILE.blockedResourceKinds);

    // The blocked resources never reached the fixture server; the allowed
    // stylesheet and image did.
    expect(fixtures.served).toContain("/style.css");
    expect(fixtures.served).toContain("/poster.png");
    expect(fixtures.served).not.toContain("/media/fixture.mp4");
  }, 120_000);

  it("sanitizes the credential headers into the stored header artifact", async () => {
    const { evidenceId } = await runOne("/normal");
    const record = await readEvidence(pool, evidenceId);
    const headersArtifact = record!.artifacts.find((a) => a.kind === "response_headers")!;
    // Fetch the bytes back through the store and read the header map.
    const store = testStore(bucket);
    const rawClient = new S3Client({
      endpoint: new URL("http://127.0.0.1:9002").toString(),
      region: "us-east-1",
      credentials: { accessKeyId: "patrolminio", secretAccessKey: "patrolminio" },
      forcePathStyle: true,
    });
    const object = await rawClient.send(
      new (await import("@aws-sdk/client-s3")).GetObjectCommand({
        Bucket: bucket,
        Key: artifactKey("response_headers", headersArtifact.sha256),
      }),
    );
    const headerMap = JSON.parse(
      new TextDecoder().decode(await object.Body!.transformToByteArray()),
    ) as Record<string, string>;
    const names = Object.keys(headerMap).map((name) => name.toLowerCase());
    expect(names).not.toContain("set-cookie");
    expect(names).not.toContain("cookie");
    expect(names).not.toContain("authorization");
    expect(names).toContain("content-type");
  }, 120_000);

  it("records the redirect chain verbatim and derives the landing host (seam 2)", async () => {
    const requested = `${fixtures.url}/hop1`;
    const { evidenceId } = await runOne("/hop1");
    const { evidence } = (await readEvidence(pool, evidenceId))!;
    // The submitted URL is retained verbatim; the chain proves the hops.
    expect(evidence.requestedUrl).toBe(requested);
    expect(evidence.redirectChain).toHaveLength(2);
    expect(evidence.redirectChain[0]).toEqual({
      url: requested,
      statusCode: 302,
      location: "/hop2",
    });
    expect(evidence.redirectChain[1]).toEqual({
      url: `${fixtures.url}/hop2`,
      statusCode: 302,
      location: "/normal",
    });
    expect(evidence.finalUrl).toBe(`${fixtures.url}/normal`);
    expect(evidence.host).toBe("127.0.0.1");
    expect(evidence.hostSource).toBe("landing_page");
    expect(evidence.outcome).toBe("captured");
  }, 120_000);

  it("records a dead page's metadata and body, and never its render", async () => {
    const { evidenceId } = await runOne("/gone");
    const { evidence, artifacts } = (await readEvidence(pool, evidenceId))!;
    expect(evidence.outcome).toBe("dead");
    expect(evidence.failureReason).toBe("http_404");
    expect(evidence.httpStatus).toBe(404);
    expect(kindsOf(artifacts)).toEqual(["response_body", "response_headers"]);
    const capture = await readCapture(pool, evidence.captureId);
    expect(capture?.state).toBe("done");
    expect(capture?.attemptCount).toBe(1);
  }, 120_000);

  it("records a challenge page as blocked without rendering it", async () => {
    const { evidenceId } = await runOne("/challenge");
    const { evidence, artifacts } = (await readEvidence(pool, evidenceId))!;
    expect(evidence.outcome).toBe("blocked");
    expect(evidence.failureReason).toBe("challenge");
    expect(kindsOf(artifacts)).toEqual(["response_body", "response_headers"]);
  }, 120_000);

  it("records a bare 451 as blocked without an objection", async () => {
    const { evidenceId } = await runOne("/objection-unnamed");
    const { evidence } = (await readEvidence(pool, evidenceId))!;
    expect(evidence.outcome).toBe("blocked");
    expect(evidence.failureReason).toBe("http_451");

    // The status alone does not say the host objects to Patrol: no
    // objection row exists for the fixture host.
    const objections = await pool.query(
      "select * from host_objections where host = '127.0.0.1' and cleared_at is null",
    );
    expect(objections.rows).toHaveLength(0);
  }, 120_000);

  it("records a 451 objection, suspends the host, and never deletes the objection", async () => {
    const { evidenceId } = await runOne("/objection");
    const { evidence } = (await readEvidence(pool, evidenceId))!;
    expect(evidence.outcome).toBe("blocked");
    expect(evidence.failureReason).toBe("http_451");

    const objections = await pool.query("select * from host_objections");
    expect(objections.rows).toHaveLength(1);
    const row = objections.rows[0];
    expect(row.host).toBe("127.0.0.1");
    expect(row.source).toBe("host_contact");
    expect(row.cleared_at).toBeNull();

    // The objection is never deleted, even by direct SQL.
    await expect(
      pool.query("delete from host_objections where id = $1", [row.id]),
    ).rejects.toThrow();

    // Further captures of the host are refused.
    const refused = await enqueueCapture(
      { pool, now: () => new Date("2026-05-01T11:00:00.000Z"), dispatch: noopDispatch },
      { url: `${fixtures.url}/normal`, reason: "review" },
    );
    expect(refused).toEqual({ status: "refused", hostObjectionId: row.id });

    // Clear the objection so the fixture host serves this file's later
    // captures again — the same operator decision the API route records.
    const operator = await pool.query<{ id: string }>("select id from operators limit 1");
    await pool.query(
      `update host_objections
         set cleared_at = $2, cleared_by = $3, clearance_reason = 'test clearance'
       where id = $1`,
      [row.id, new Date("2026-05-01T11:30:00.000Z"), operator.rows[0].id],
    );
  }, 120_000);

  it("truncates an over-ceiling DOM and stores no oversized bytes (seam 3)", async () => {
    const { evidenceId } = await runOne("/huge");
    const { evidence, artifacts } = (await readEvidence(pool, evidenceId))!;
    expect(evidence.outcome).toBe("captured");
    const dom = artifacts.find((artifact) => artifact.kind === "rendered_dom")!;
    expect(dom.truncated).toBe(true);
    expect(dom.sizeBytes).toBe(10 * 1024 * 1024);
    const body = artifacts.find((artifact) => artifact.kind === "response_body")!;
    expect(body.truncated).toBe(true);
    expect(body.sizeBytes).toBe(10 * 1024 * 1024);
    for (const artifact of artifacts) {
      expect(artifact.sizeBytes).toBeLessThanOrEqual(10 * 1024 * 1024);
    }
  }, 240_000);

  it("clips an over-cap screenshot at 16 000 pixels with the flag set (seam 3)", async () => {
    const { evidenceId } = await runOne("/tall");
    const { artifacts } = (await readEvidence(pool, evidenceId))!;
    const screenshot = artifacts.find((artifact) => artifact.kind === "screenshot")!;
    expect(screenshot.truncated).toBe(true);
    expect(screenshot.height).toBe(16_000);
    expect(screenshot.sizeBytes).toBeGreaterThan(0);
    const thumbnail = artifacts.find((artifact) => artifact.kind === "thumbnail")!;
    expect(thumbnail.truncated).toBe(false);
    expect(thumbnail.contentType).toBe("image/jpeg");
  }, 120_000);

  it("records a page wider than the viewport at its scroll width", async () => {
    const { evidenceId } = await runOne("/wide");
    const { artifacts } = (await readEvidence(pool, evidenceId))!;
    const screenshot = artifacts.find((artifact) => artifact.kind === "screenshot")!;
    // The artifact's width is what the capture actually spans — the page's
    // own 1600-px scroll width, not the 800-px viewport.
    expect(screenshot.width).toBe(1_600);
    expect(screenshot.height).toBeGreaterThan(0);
    expect(screenshot.truncated).toBe(false);
    // The thumbnail stays the settled viewport and carries no dimensions.
    const thumbnail = artifacts.find((artifact) => artifact.kind === "thumbnail")!;
    expect(thumbnail.width).toBeNull();
  }, 120_000);

  it("records a timeout as error and schedules the first retry (seam 6)", async () => {
    const { captureId, evidenceId, at } = await runOne("/hang", {
      budgets: { navigationMs: 1_500, settleMs: 100, totalMs: 5_000 },
    });
    const { evidence, artifacts } = (await readEvidence(pool, evidenceId))!;
    expect(evidence.outcome).toBe("error");
    expect(evidence.failureReason).toBe("timeout_navigation");
    expect(evidence.finalUrl).toBeNull();
    expect(evidence.host).toBeNull();
    expect(artifacts).toEqual([]);
    const capture = await readCapture(pool, captureId);
    expect(capture?.state).toBe("pending");
    expect(capture?.attemptCount).toBe(1);
    // The runner's injected schedule (capture-helpers' default: 1s, 2s)
    // decided the next attempt's time; production's constant is asserted
    // in the outcomes unit suite.
    expect(capture?.nextAttemptAt).toEqual(new Date(at.getTime() + 1_000));
  }, 120_000);

  it("deduplicates identical bytes across captures: same keys, one version, a new row (seam 5)", async () => {
    const first = await runOne("/normal");
    const second = await runOne("/normal");
    expect(first.evidenceId).not.toBe(second.evidenceId);

    const firstRecord = (await readEvidence(pool, first.evidenceId))!;
    const secondRecord = (await readEvidence(pool, second.evidenceId))!;
    const hash = (kind: string) =>
      firstRecord.artifacts.find((artifact) => artifact.kind === kind)!.sha256;
    // The byte-deterministic artifacts share their keys exactly. The
    // screenshot and thumbnail are Chromium encodings of a live render —
    // the design accepts they are not perfectly reproducible, which is
    // precisely why the raw DOM and body stay in the bundle; their
    // dedup is proven by the store suite's memory counts.
    for (const kind of [
      "response_body",
      "response_headers",
      "rendered_dom",
      "extraction_sidecar",
    ]) {
      expect(secondRecord.artifacts.find((artifact) => artifact.kind === kind)!.sha256).toBe(
        hash(kind),
      );
    }
    for (const kind of ["screenshot", "thumbnail"]) {
      const a = firstRecord.artifacts.find((artifact) => artifact.kind === kind)!;
      const b = secondRecord.artifacts.find((artifact) => artifact.kind === kind)!;
      expect(b.width ?? a.width).toBe(a.width);
      expect(b.sizeBytes).toBeGreaterThan(0);
    }

    // The object store holds one version of the shared body: the second
    // capture's upload was skipped (the HEAD dedup).
    const rawClient = new S3Client({
      endpoint: "http://127.0.0.1:9002",
      region: "us-east-1",
      credentials: { accessKeyId: "patrolminio", secretAccessKey: "patrolminio" },
      forcePathStyle: true,
    });
    const versions = await rawClient.send(
      new ListObjectVersionsCommand({
        Bucket: bucket,
        Prefix: artifactKey("response_body", hash("response_body")),
      }),
    );
    expect(versions.Versions?.length ?? 0).toBe(1);
  }, 240_000);
});
