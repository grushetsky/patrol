import { readFileSync } from "node:fs";
import { expectedSchemaStamp } from "@patrol/db";
import { s3ConfigFromEnv } from "@patrol/evidence";

/** Runtime configuration, parsed once at boot and injected everywhere. */
export interface AppConfig {
  databaseUrl: string;
  port: number;
  /** The running build, from PATROL_BUILD_VERSION or the package version. */
  buildVersion: string;
  /** The migration stamp this image expects the database to carry. */
  schemaStamp: number;
  /**
   * The deployment environment (PATROL_ENV, "dev" by default). Slice-0
   * scaffolding such as the stub routes mounts only outside production.
   */
  env: string;
  /**
   * The server-side pepper mixed into every recovery-code hash. A stable
   * value from PATROL_RECOVERY_PEPPER in production; the development default
   * exists only so a local database boots without secrets.
   */
  recoveryPepper: string;
  /**
   * The origin invitation and reset emails link back to. Defaults to the
   * local compose web port.
   */
  publicUrl: string;
  /**
   * The MediaWiki API origin the Wikidata proxy calls. Injectable so tests
   * drive it against a stub server and staging can pin it.
   */
  wikidataOrigin: string;
  /**
   * The contactable User-Agent the Wikidata proxy identifies itself with;
   * Wikidata requires identification and states no hard read limit.
   */
  wikidataUserAgent: string;
  /**
   * How long one upstream Wikidata request may take before it is treated
   * as unreachable.
   */
  upstreamTimeoutMs: number;
  /**
   * Injectable clock, real time unless a test freezes it. Pre-agreed seam:
   * slice 1 consumes it for session idle/absolute expiry; do not inline
   * `new Date()` in domain code.
   */
  now: () => Date;
  /**
   * The S3-compatible evidence store's addressing (ADR 0006): the endpoint
   * override selects MinIO or another provider, the bucket holds the
   * content-addressed bytes the download route presigns against.
   */
  s3: {
    endpoint?: string;
    region: string;
    bucket: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    forcePathStyle?: boolean;
  };
  /**
   * How long a signed artifact download stays valid. Short by design: the
   * reference is minted per request and carries nothing but the read.
   */
  evidenceDownloadTtlSeconds: number;
  /**
   * The general API rate limits (slice 9): per-session and per-IP
   * ceilings over every route but the health probe, complementing the
   * sign-in throttle. Environment-configurable with operator-comfortable
   * defaults (see .env.example).
   */
  rateLimit: {
    windowMs: number;
    sessionMax: number;
    anonymousMax: number;
  };
}

function packageVersion(): string {
  const manifest = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version: string };
  return manifest.version;
}

/**
 * Reads the environment. PATROL_PORT wins over PORT, which exists so tests
 * can override the listener port without colliding with a dev API.
 * PATROL_RECOVERY_PEPPER is required in production: without it every
 * recovery-code hash would derive from a public literal, so the boot
 * refuses; outside production the development default stands with a
 * warning so a local database starts without secrets.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }
  const deploymentEnv = env.PATROL_ENV ?? "dev";
  const pepper = env.PATROL_RECOVERY_PEPPER;
  if (pepper === undefined || pepper === "") {
    if (deploymentEnv === "production") {
      throw new Error(
        "PATROL_RECOVERY_PEPPER is required in production: recovery-code hashes must derive from a deployment secret, not the development default",
      );
    }
    console.warn(
      "PATROL_RECOVERY_PEPPER is not set; using the development default. Set it before any recovery code is issued outside a throwaway database.",
    );
  }
  // The design requires a contactable User-Agent against Wikidata; without
  // an address the deployment only names its unconfigured state, so the boot
  // refuses in production and warns elsewhere — the pepper pattern.
  if (env.PATROL_CONTACT_EMAIL === undefined || env.PATROL_CONTACT_EMAIL === "") {
    if (deploymentEnv === "production") {
      throw new Error(
        "PATROL_CONTACT_EMAIL is required in production: the Wikidata User-Agent must carry a contactable address (docs/design/catalogue-entry.md)",
      );
    }
    console.warn(
      "PATROL_CONTACT_EMAIL is not set; the Wikidata User-Agent will state that no contact is configured. Set it before any upstream lookup runs outside a throwaway deployment.",
    );
  }
  const port = env.PATROL_PORT
    ? parseInteger(env.PATROL_PORT, "PATROL_PORT")
    : env.PORT
      ? parseInteger(env.PORT, "PORT")
      : 8080;
  return {
    databaseUrl,
    port,
    buildVersion: env.PATROL_BUILD_VERSION ?? packageVersion(),
    schemaStamp: expectedSchemaStamp(env.PATROL_SCHEMA_STAMP),
    env: deploymentEnv,
    recoveryPepper: pepper ?? "patrol-development-recovery-pepper",
    publicUrl: env.PATROL_PUBLIC_URL ?? "http://localhost:3000",
    wikidataOrigin: env.PATROL_WIKIDATA_ORIGIN ?? "https://www.wikidata.org",
    wikidataUserAgent: wikidataUserAgent(env, env.PATROL_BUILD_VERSION ?? packageVersion()),
    upstreamTimeoutMs: parsePositiveInteger(
      env.PATROL_UPSTREAM_TIMEOUT_MS ?? "5000",
      "PATROL_UPSTREAM_TIMEOUT_MS",
    ),
    now: () => new Date(),
    s3: s3ConfigFromEnv(env),
    evidenceDownloadTtlSeconds: parsePositiveInteger(
      env.PATROL_EVIDENCE_DOWNLOAD_TTL_SECONDS ?? "300",
      "PATROL_EVIDENCE_DOWNLOAD_TTL_SECONDS",
    ),
    rateLimit: {
      windowMs:
        parsePositiveInteger(
          env.PATROL_RATE_LIMIT_WINDOW_SECONDS ?? "60",
          "PATROL_RATE_LIMIT_WINDOW_SECONDS",
        ) * 1000,
      sessionMax: parsePositiveInteger(
        env.PATROL_RATE_LIMIT_SESSION_MAX ?? "600",
        "PATROL_RATE_LIMIT_SESSION_MAX",
      ),
      anonymousMax: parsePositiveInteger(
        env.PATROL_RATE_LIMIT_ANONYMOUS_MAX ?? "120",
        "PATROL_RATE_LIMIT_ANONYMOUS_MAX",
      ),
    },
  };
}

/**
 * The contactable User-Agent (docs/design/catalogue-entry.md): Wikidata
 * requires identification. The contact address comes from
 * PATROL_CONTACT_EMAIL; without it the agent names the deployment's
 * unconfigured state rather than pretending to be a browser.
 */
function wikidataUserAgent(env: NodeJS.ProcessEnv, buildVersion: string): string {
  const contact = env.PATROL_CONTACT_EMAIL;
  return contact === undefined || contact === ""
    ? `Patrol/${buildVersion} (SERP enforcement tool; contact unset)`
    : `Patrol/${buildVersion} (SERP enforcement tool; contact: ${contact})`;
}

function parsePositiveInteger(value: string, label: string): number {
  const parsed = parseInteger(value, label);
  if (parsed < 1) {
    throw new Error(`${label} must be positive, got ${value}`);
  }
  return parsed;
}

function parseInteger(value: string, label: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) {
    throw new Error(`${label} must be an integer, got ${value}`);
  }
  return parsed;
}
