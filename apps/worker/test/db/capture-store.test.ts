import { beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { GetObjectCommand, ListObjectVersionsCommand, S3Client } from "@aws-sdk/client-s3";
import {
  artifactKey,
  enqueueCapture,
  readCapture,
  readEvidence,
  sha256Hex,
} from "@patrol/evidence";
import { runCapture } from "../../src/capture/runner.js";
import { controlledClock, testPool } from "./helpers.js";
import {
  FailingStore,
  MemoryStore,
  TEST_S3_ENDPOINT,
  capturedObservation,
  noopDispatch,
  runnerDeps,
  testBucket,
  testStore,
} from "./capture-helpers.js";

/**
 * Seam 5, the content-addressed half over the real store and record:
 * identical bytes produce identical keys and the second upload is skipped
 * (the HEAD dedup leaves one object version); a rejected write mid-capture
 * marks only its own capture failed and leaves the earlier evidence row
 * and its bytes intact — bytes first, record second, so an interrupted
 * write can orphan bytes but never a citation.
 */

let pool: Pool;
const bucket = testBucket("store");
const rawClient = new S3Client({
  endpoint: TEST_S3_ENDPOINT,
  region: "us-east-1",
  credentials: { accessKeyId: "patrolminio", secretAccessKey: "patrolminio" },
  forcePathStyle: true,
});

beforeAll(async () => {
  await testStore(bucket).ensureReady();
  pool = testPool();
});

async function versionsOf(key: string): Promise<number> {
  const versions = await rawClient.send(
    new ListObjectVersionsCommand({ Bucket: bucket, Prefix: key }),
  );
  return versions.Versions?.length ?? 0;
}

async function capture(
  clock: ReturnType<typeof controlledClock>,
  url: string,
  observation = capturedObservation(url),
): Promise<string> {
  const enqueued = await enqueueCapture(
    { pool, now: clock.now, dispatch: noopDispatch },
    { url, reason: "detection" },
  );
  if (enqueued.status !== "queued") {
    throw new Error(`unexpected enqueue status ${enqueued.status}`);
  }
  await runCapture(
    runnerDeps(pool, clock, testStore(bucket), async () => observation),
    enqueued.captureId,
    () => {},
  );
  const capture = await readCapture(pool, enqueued.captureId);
  if (capture?.evidenceId === null || capture?.evidenceId === undefined) {
    throw new Error("capture produced no evidence");
  }
  return capture.evidenceId;
}

describe("the content-addressed store (seam 5)", () => {
  it("writes one version per hash and skips the second upload of the same bytes", async () => {
    const clock = controlledClock("2026-05-01T10:00:00.000Z");
    const memory = new MemoryStore();
    const deps = runnerDeps(pool, clock, memory, async (target) =>
      capturedObservation(target),
    );
    const first = await enqueueCapture(
      { pool, now: clock.now, dispatch: noopDispatch },
      { url: "https://twin.example.test/watch", reason: "detection" },
    );
    const second = await enqueueCapture(
      { pool, now: clock.now, dispatch: noopDispatch },
      { url: "https://twin.example.test/watch?twin=1", reason: "detection" },
    );
    await runCapture(deps, (first as { captureId: string }).captureId, () => {});
    await runCapture(deps, (second as { captureId: string }).captureId, () => {});
    // Every artifact of the two captures hashed identically, so the same
    // number of uploads as artifacts — the second capture uploaded none.
    expect(memory.putUploads).toBe(6);
    expect(memory.putCalls).toBe(12);
  });

  it("answers a presigned download pinned to the recorded version", async () => {
    const clock = controlledClock("2026-05-01T10:00:00.000Z");
    const evidenceId = await capture(clock, "https://signed.example.test/watch");
    const record = (await readEvidence(pool, evidenceId))!;
    const body = record.artifacts.find((artifact) => artifact.kind === "response_body")!;
    expect(body.objectVersion).not.toBeNull();

    const ref = await testStore(bucket).presignDownload({
      kind: body.kind,
      sha256: body.sha256,
      contentType: body.contentType,
      objectVersion: body.objectVersion,
      expiresInSeconds: 120,
    });
    expect(ref.url).toContain(artifactKey("response_body", body.sha256));
    // The signed read is pinned to the recorded version.
    expect(ref.url).toContain(`versionId=${body.objectVersion}`);
    expect(ref.url).toContain("X-Amz-Signature");
    expect(ref.expiresAt.getTime()).toBeGreaterThan(clock.now().getTime());

    // The object stands in one version under the sharded key.
    expect(await versionsOf(artifactKey("response_body", body.sha256))).toBe(1);
  });

  it("leaves the earlier evidence row intact when a later write is rejected mid-write", async () => {
    const clock = controlledClock("2026-05-01T10:00:00.000Z");
    const survivor = await capture(clock, "https://survivor.example.test/watch");
    const survivorRecord = (await readEvidence(pool, survivor))!;

    const failing = new FailingStore(new MemoryStore(), "screenshot");
    const doomed = await enqueueCapture(
      { pool, now: clock.now, dispatch: noopDispatch },
      { url: "https://doomed.example.test/watch", reason: "detection" },
    );
    await runCapture(
      runnerDeps(pool, clock, failing, async (target) => capturedObservation(target)),
      (doomed as { captureId: string }).captureId,
      () => {},
    );
    const doomedCapture = await readCapture(pool, (doomed as { captureId: string }).captureId);
    expect(doomedCapture?.state).toBe("failed");
    expect(doomedCapture?.evidenceId).toBeNull();

    // The earlier record is untouched: same row, same manifest, same bytes,
    // and no evidence row exists for the rejected capture.
    const after = (await readEvidence(pool, survivor))!;
    expect(after.evidence).toEqual(survivorRecord.evidence);
    expect(after.artifacts).toEqual(survivorRecord.artifacts);
    const count = await pool.query(
      "select count(*) as count from evidence where capture_id = any($1::uuid[])",
      [[(doomed as { captureId: string }).captureId]],
    );
    expect(Number(count.rows[0].count)).toBe(0);
  });

  it("stores bytes that hash to their key, under versioning", async () => {
    const bytes = new TextEncoder().encode(
      JSON.stringify({ title: "Hashed", h1: ["Hashed"] }),
    );
    const sha = sha256Hex(bytes);
    await testStore(bucket).putArtifact({
      kind: "extraction_sidecar",
      sha256: sha,
      bytes,
      contentType: "application/json",
    });
    const object = await rawClient.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: artifactKey("extraction_sidecar", sha),
      }),
    );
    const stored = await object.Body!.transformToByteArray();
    expect(sha256Hex(stored)).toBe(sha);
    // Versioning was enabled on the bucket: the object carries a version.
    expect(object.VersionId).toBeTruthy();
    expect(await versionsOf(artifactKey("extraction_sidecar", sha))).toBe(1);
  });
});
