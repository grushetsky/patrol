import { readFileSync } from "node:fs";
import type { CaptureProfileJson } from "@patrol/evidence";

/** Runtime configuration for the worker, parsed once at boot. */
export interface WorkerConfig {
  databaseUrl: string;
  /**
   * Injectable clock, real time unless a test freezes it. The scans table's
   * created_at and every job's idea of "today" read it.
   */
  now: () => Date;
  /**
   * The query retry schedule — the delay before each retry of a provider
   * 5xx, timeout, or 429 (docs/design/scan-scheduling.md "Failure
   * handling").
   */
  retryDelaysMs: readonly number[];
  /** How long one upstream provider request may take. */
  upstreamTimeoutMs: number;
  /**
   * How long an asynchronous provider task is polled for its results
   * before the query is treated as failed.
   */
  taskPollIntervalMs: number;
  taskPollDeadlineMs: number;
  /** The file the compose healthcheck watches. */
  heartbeatFile: string;
  /** The PostgreSQL schema pg-boss keeps its tables in. */
  bossSchema: string;
  /** DataForSEO credentials for the Google route; absent disables it. */
  dataforseo: { login: string; password: string } | null;
  /** Yandex Search API v2 credentials; absent disables the route. */
  yandex: { apiKey: string; folderId: string } | null;
  /**
   * The contactable address the adapters' User-Agent carries — the same
   * PATROL_CONTACT_EMAIL the API's Wikidata agent reads. Absent names the
   * deployment's unconfigured state rather than a placeholder.
   */
  contactEmail: string | null;
  /** Whether the fixture-driven fake adapter replaces the real routes. */
  fakeAdapter: boolean;
  /**
   * The capture profile every evidentiary fetch of this worker runs under
   * (docs/design/evidence-capture.md "What a capture records"): without it
   * a capture cannot be explained or repeated.
   */
  captureProfile: CaptureProfileJson;
  /**
   * The capture retry schedule — the delays between the up-to-three
   * attempts a blocked or error capture makes inside 24 hours.
   */
  captureRetryDelaysMs: readonly number[];
  /** Allowed concurrent captures overall ("a handful"; default 3). */
  captureConcurrency: number;
  /** The quiet gap between two captures of the same host. */
  captureSameHostSpacingMs: number;
}

function packageVersion(): string {
  const manifest = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version: string };
  return manifest.version;
}

export { packageVersion };

function parseDelays(value: string | undefined, label: string): number[] {
  const raw = (value ?? "60000,300000,900000")
    .split(",")
    .map((part) => Number.parseInt(part.trim(), 10));
  if (raw.length === 0 || raw.some((ms) => !Number.isInteger(ms) || ms < 0)) {
    throw new Error(`${label} must be comma-separated non-negative integers, got ${value}`);
  }
  return raw;
}

function parsePositiveInteger(value: string | undefined, label: string): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer, got ${value}`);
  }
  return parsed;
}

function parseNonNegativeInteger(value: string | undefined, label: string): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative integer, got ${value}`);
  }
  return parsed;
}

/**
 * The capture profile from the environment: the identifiable user agent
 * (ADR 0018 — it names Patrol and the contactable address, never a generic
 * browser), the viewport and locale the screenshot and DOM record, and the
 * navigation policy string the ceilings fix. The extractor version is
 * code, not configuration: it changes only when the sidecar's shape does.
 */
export const EXTRACTOR_VERSION = "sidecar-minimal/1";

function captureProfile(
  env: NodeJS.ProcessEnv,
  contactEmail: string | null,
  version: string,
): CaptureProfileJson {
  return {
    userAgent: `Patrol/${version} (evidentiary page capture; contact: ${
      contactEmail ?? "no contact configured"
    })`,
    viewportWidth: parsePositiveInteger(
      env.PATROL_CAPTURE_VIEWPORT_WIDTH ?? "1280",
      "PATROL_CAPTURE_VIEWPORT_WIDTH",
    ),
    viewportHeight: parsePositiveInteger(
      env.PATROL_CAPTURE_VIEWPORT_HEIGHT ?? "800",
      "PATROL_CAPTURE_VIEWPORT_HEIGHT",
    ),
    locale: env.PATROL_CAPTURE_LOCALE ?? "en-US",
    timezone: env.PATROL_CAPTURE_TIMEZONE ?? "UTC",
    javascriptEnabled: true,
    blockedResourceKinds: [
      "media",
      "websocket",
      "service_worker",
      "advertising",
      "third_party_analytics",
    ],
    navigationPolicy: "load+2000ms settle; 25s navigation; 45s total",
    extractorVersion: EXTRACTOR_VERSION,
  };
}

/**
 * Reads the worker's environment. Provider credentials are optional: a
 * route without credentials is a route the scheduler does not use, and the
 * fake adapter (PATROL_FAKE_ADAPTER=1) drives scans against fixtures for
 * development and tests without ever touching a network.
 */
export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }
  const dataforseoLogin = env.DATAFORSEO_LOGIN;
  const dataforseoPassword = env.DATAFORSEO_PASSWORD;
  const yandexKey = env.YANDEX_SEARCH_API_KEY;
  const yandexFolder = env.YANDEX_FOLDER_ID;
  const contactEmail =
    env.PATROL_CONTACT_EMAIL === undefined || env.PATROL_CONTACT_EMAIL === ""
      ? null
      : env.PATROL_CONTACT_EMAIL;
  if (contactEmail === null) {
    console.warn(
      "PATROL_CONTACT_EMAIL is not set; the acquisition User-Agent will state that no contact is configured. Set it before the real routes run outside a throwaway deployment.",
    );
  }
  return {
    databaseUrl,
    now: () => new Date(),
    retryDelaysMs: parseDelays(env.PATROL_QUERY_RETRY_DELAYS_MS, "PATROL_QUERY_RETRY_DELAYS_MS"),
    upstreamTimeoutMs: parsePositiveInteger(
      env.PATROL_UPSTREAM_TIMEOUT_MS ?? "30000",
      "PATROL_UPSTREAM_TIMEOUT_MS",
    ),
    taskPollIntervalMs: parsePositiveInteger(
      env.PATROL_TASK_POLL_INTERVAL_MS ?? "15000",
      "PATROL_TASK_POLL_INTERVAL_MS",
    ),
    taskPollDeadlineMs: parsePositiveInteger(
      env.PATROL_TASK_POLL_DEADLINE_MS ?? "3300000",
      "PATROL_TASK_POLL_DEADLINE_MS",
    ),
    heartbeatFile: env.PATROL_WORKER_HEARTBEAT_FILE ?? "/tmp/patrol-worker-heartbeat",
    bossSchema: env.PATROL_BOSS_SCHEMA ?? "pgboss",
    dataforseo:
      dataforseoLogin && dataforseoPassword
        ? { login: dataforseoLogin, password: dataforseoPassword }
        : null,
    yandex:
      yandexKey && yandexFolder
        ? { apiKey: yandexKey, folderId: yandexFolder }
        : null,
    contactEmail,
    fakeAdapter: env.PATROL_FAKE_ADAPTER === "1",
    captureProfile: captureProfile(env, contactEmail, packageVersion()),
    captureRetryDelaysMs: parseDelays(
      env.PATROL_CAPTURE_RETRY_DELAYS_MS ?? "900000,7200000",
      "PATROL_CAPTURE_RETRY_DELAYS_MS",
    ),
    captureConcurrency: parsePositiveInteger(
      env.PATROL_CAPTURE_CONCURRENCY ?? "3",
      "PATROL_CAPTURE_CONCURRENCY",
    ),
    captureSameHostSpacingMs: parseNonNegativeInteger(
      env.PATROL_CAPTURE_HOST_SPACING_MS ?? "2000",
      "PATROL_CAPTURE_HOST_SPACING_MS",
    ),
  };
}
