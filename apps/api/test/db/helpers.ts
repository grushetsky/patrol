import { Pool } from "pg";

/** The throwaway test database on the shifted loopback port (docker-compose.test.yml, db-test). */
export const DEFAULT_TEST_DATABASE_URL =
  "postgres://patrol:patrol@127.0.0.1:5433/patrol_test";

export function testDatabaseUrl(): string {
  return process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL;
}

export function testPool(): Pool {
  return new Pool({ connectionString: testDatabaseUrl() });
}

/** Drops and recreates the public schema so a migration can run from zero. */
export async function dropPublicSchema(pool: Pool): Promise<void> {
  await pool.query("drop schema if exists public cascade");
  await pool.query("create schema public");
}

/**
 * Per-file reset: every public table except patrol_meta is truncated with
 * identity restart, so each test file starts from the migrated baseline.
 */
export async function truncateDomainTables(pool: Pool): Promise<void> {
  const result = await pool.query<{ tablename: string }>(
    `select tablename from pg_tables where schemaname = 'public'
       and tablename <> 'patrol_meta' and tablename <> 'notice_templates'`,
  );
  const tables = result.rows.map((row) => row.tablename);
  if (tables.length === 0) {
    return;
  }
  const list = tables.map((table) => `"${table}"`).join(", ");
  await pool.query(`truncate table ${list} restart identity cascade`);
}
