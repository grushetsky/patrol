import { readSchemaStamp } from "@patrol/db";
import type { Pool } from "pg";
import { buildApp } from "../src/app.js";
import { loadConfig, type AppConfig } from "../src/config.js";

/** Configuration fixed for tests: no external env is read. */
export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    ...loadConfig({
      DATABASE_URL: "postgres://patrol:patrol@127.0.0.1:5433/patrol_test",
      PATROL_BUILD_VERSION: "test-build",
    }),
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

/** The schema-stamp source tests inject in place of a live database read. */
export function fakeSchemaStamp(stamp: number | null): () => Promise<number | null> {
  return async () => stamp;
}

/** The real schema-stamp source, backed by the test database pool. */
export function poolSchemaStamp(pool: Pool): () => Promise<number | null> {
  return () => readSchemaStamp(pool);
}

export { buildApp };
