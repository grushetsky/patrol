import { readSchemaStamp } from "@patrol/db";
import type { Pool } from "pg";
import { Pool as PgPool } from "pg";
import { buildApp } from "../src/app.js";
import { loadConfig, type AppConfig } from "../src/config.js";
import { MemoryMailTransport } from "../src/mail/transport.js";

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

/**
 * The deps the app assembles from, for unit tests that never touch the
 * database: the pool is lazy and stays unconnected because no request in
 * these tests carries a session cookie or reaches a domain query.
 */
export function unitAppDeps(overrides: Partial<AppConfig> = {}): {
  config: AppConfig;
  pool: Pool;
  mail: MemoryMailTransport;
  schemaStamp: () => Promise<number | null>;
} {
  return {
    config: testConfig(overrides),
    pool: new PgPool({
      connectionString: "postgres://patrol:patrol@127.0.0.1:1/unused",
      max: 1,
    }),
    mail: new MemoryMailTransport(),
    schemaStamp: fakeSchemaStamp(testConfig().schemaStamp),
  };
}

/**
 * A clock a test freezes and advances: session idle and absolute expiry,
 * lockouts, and challenge expiry all read it.
 */
export function controlledClock(initial: string): {
  now: () => Date;
  advance: (ms: number) => void;
  set: (iso: string) => void;
} {
  let current = new Date(initial).getTime();
  return {
    now: () => new Date(current),
    advance: (ms: number) => {
      current += ms;
    },
    set: (iso: string) => {
      current = new Date(iso).getTime();
    },
  };
}

export { buildApp };
