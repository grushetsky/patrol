import { readFileSync } from "node:fs";
import { expectedSchemaStamp } from "@patrol/db";

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
   * Injectable clock, real time unless a test freezes it. Pre-agreed seam:
   * slice 1 consumes it for session idle/absolute expiry; do not inline
   * `new Date()` in domain code.
   */
  now: () => Date;
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
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
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
    env: env.PATROL_ENV ?? "dev",
    now: () => new Date(),
  };
}

function parseInteger(value: string, label: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) {
    throw new Error(`${label} must be an integer, got ${value}`);
  }
  return parsed;
}
