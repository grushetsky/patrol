import type { Pool } from "pg";
import {
  S3EvidenceStore,
  artifactKey,
  type CaptureProfileJson,
  type EvidenceStore,
} from "@patrol/evidence";
import { CaptureLimiter } from "../../src/capture/limiter.js";
import type { CaptureRunnerDeps } from "../../src/capture/runner.js";
import type { PageObservation } from "../../src/capture/browser.js";
import type { NavigationFailure } from "../../src/capture/outcomes.js";
import { controlledClock } from "./helpers.js";

/**
 * The capture suite's shared scaffolding: a store against the throwaway
 * minio-test container, a deterministic capture profile, a no-op-politeness
 * limiter, a recording retry scheduler, and the fake observation factory
 * the non-browser tests drive the runner with.
 */

/** The minio-test container docker-compose.test.yml stands up. */
export const TEST_S3_ENDPOINT =
  process.env.TEST_S3_ENDPOINT ?? "http://127.0.0.1:9002";

export function testStore(bucket: string): S3EvidenceStore {
  return new S3EvidenceStore({
    endpoint: TEST_S3_ENDPOINT,
    region: "us-east-1",
    bucket,
    accessKeyId: "patrolminio",
    secretAccessKey: "patrolminio",
    forcePathStyle: true,
  });
}

export function testBucket(label: string): string {
  return `patrol-test-${label}-${Math.random().toString(36).slice(2, 10)}`;
}

export const TEST_PROFILE: CaptureProfileJson = {
  userAgent: "Patrol/0.1-test (evidentiary page capture; contact: tests@example.test)",
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
  navigationPolicy: "load+100ms settle; 10s navigation; 20s total (test budgets)",
  extractorVersion: "sidecar-minimal/1",
};

/** A no-op-politeness limiter: the runner tests assert the capture, not the pace. */
export function instantLimiter(): CaptureLimiter {
  return new CaptureLimiter({
    overallConcurrency: 3,
    sameHostSpacingMs: 0,
    now: () => 0,
    sleep: async () => {},
  });
}

/** The runner dependencies with every side effect recorded or neutralized. */
export function runnerDeps(
  pool: Pool,
  clock: ReturnType<typeof controlledClock>,
  store: EvidenceStore,
  fetchPage: (url: string) => Promise<PageObservation>,
  options: { retryDelaysMs?: readonly number[] } = {},
): CaptureRunnerDeps & {
  scheduled: Array<{ captureId: string; delayMs: number }>;
} {
  const scheduled: Array<{ captureId: string; delayMs: number }> = [];
  const deps: CaptureRunnerDeps = {
    pool,
    now: clock.now,
    store,
    fetchPage,
    limiter: instantLimiter(),
    scheduleRetry: async (captureId, delayMs) => {
      scheduled.push({ captureId, delayMs });
    },
    profile: TEST_PROFILE,
    retryDelaysMs: options.retryDelaysMs ?? [1_000, 2_000],
  };
  return { ...deps, scheduled };
}

/** The base observation: nothing observed, nothing rendered. */
export function baseObservation(url: string): PageObservation {
  return {
    requestedUrl: url,
    failure: null,
    redirectChain: [],
    finalUrl: null,
    httpStatus: null,
    headers: null,
    rawBody: null,
    title: null,
    renderedDom: null,
    domTruncated: false,
    screenshot: null,
    screenshotTruncated: false,
    screenshotWidth: null,
    screenshotHeight: null,
    thumbnail: null,
    sidecar: null,
    pageHost: null,
    budgetExceeded: false,
  };
}

/** A successfully captured observation of a deterministic page. */
export function capturedObservation(url: string, overrides: Partial<PageObservation> = {}): PageObservation {
  return {
    ...baseObservation(url),
    finalUrl: url,
    httpStatus: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "set-cookie": "sid=secret",
      server: "fixture",
    },
    rawBody: new TextEncoder().encode(
      "<!doctype html><html><head><title>Fixture Work</title></head><body><h1>Fixture Work</h1></body></html>",
    ),
    title: "Fixture Work",
    renderedDom: "<html><head><title>Fixture Work</title></head><body><h1>Fixture Work</h1></body></html>",
    screenshot: new Uint8Array([137, 80, 78, 71]),
    screenshotHeight: 600,
    thumbnail: new Uint8Array([255, 216, 255, 217]),
    sidecar: JSON.stringify({ title: "Fixture Work", h1: ["Fixture Work"] }),
    pageHost: new URL(url).hostname,
    ...overrides,
  };
}

/** An observation that failed before any response, with its classification. */
export function failedObservation(url: string, failure: NavigationFailure): PageObservation {
  return { ...baseObservation(url), failure };
}

/** A no-op dispatch for the enqueue port in tests. */
export const noopDispatch = async (): Promise<void> => {};

/**
 * An in-memory content-addressed store: same key scheme, same dedup
 * semantics (a second put of the same hash skips the upload), counts the
 * puts and the uploads so tests can prove the skip.
 */
export class MemoryStore {
  readonly objects = new Map<string, { bytes: Uint8Array; contentType: string; version: string }>();
  putCalls = 0;
  putUploads = 0;

  async ensureReady(): Promise<void> {}

  async putArtifact(
    upload: import("@patrol/evidence").ArtifactUpload,
  ): Promise<import("@patrol/evidence").StoredObject> {
    this.putCalls += 1;
    const key = artifactKey(upload.kind, upload.sha256);
    const existing = this.objects.get(key);
    if (existing !== undefined) {
      return { sha256: upload.sha256, objectVersion: existing.version, existed: true };
    }
    const version = `mem-${this.putUploads + 1}`;
    this.objects.set(key, { bytes: upload.bytes, contentType: upload.contentType, version });
    this.putUploads += 1;
    return { sha256: upload.sha256, objectVersion: version, existed: false };
  }

  async presignDownload(
    request: import("@patrol/evidence").PresignRequest,
  ): Promise<import("@patrol/evidence").PresignedDownload> {
    return {
      url: `mem://${artifactKey(request.kind, request.sha256)}`,
      expiresAt: new Date(Date.now() + request.expiresInSeconds * 1000),
    };
  }

  /** The retention purge path, present so the class satisfies the store port. */
  async deleteArtifactVersion(
    request: import("@patrol/evidence").ArtifactVersionDelete,
  ): Promise<void> {
    this.objects.delete(artifactKey(request.kind, request.sha256));
  }

  async purgeRawSerpPayloadsOlderThan(_cutoff: Date): Promise<string[]> {
    return [];
  }
}

/** A store whose puts fail once a designated kind arrives — the mid-write rejection. */
export class FailingStore {
  constructor(
    private readonly inner: MemoryStore,
    private readonly failOnKind: string,
  ) {}

  async ensureReady(): Promise<void> {}

  async putArtifact(
    upload: import("@patrol/evidence").ArtifactUpload,
  ): Promise<import("@patrol/evidence").StoredObject> {
    if (upload.kind === this.failOnKind) {
      throw new Error("simulated storage failure mid-write");
    }
    return this.inner.putArtifact(upload);
  }

  async presignDownload(
    request: import("@patrol/evidence").PresignRequest,
  ): Promise<import("@patrol/evidence").PresignedDownload> {
    return this.inner.presignDownload(request);
  }

  async deleteArtifactVersion(
    request: import("@patrol/evidence").ArtifactVersionDelete,
  ): Promise<void> {
    return this.inner.deleteArtifactVersion(request);
  }

  async purgeRawSerpPayloadsOlderThan(cutoff: Date): Promise<string[]> {
    return this.inner.purgeRawSerpPayloadsOlderThan(cutoff);
  }
}
