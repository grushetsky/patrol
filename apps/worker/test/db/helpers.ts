import { Pool } from "pg";

/**
 * The worker's database-test helpers, mirroring the API suite's: the same
 * throwaway database on the shifted loopback port, the same reset
 * discipline, and a seed that stands up the minimum catalogue a scan
 * needs without driving the whole HTTP ceremony.
 */

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
    "select tablename from pg_tables where schemaname = 'public' and tablename <> 'patrol_meta'",
  );
  const tables = result.rows.map((row) => row.tablename);
  if (tables.length === 0) {
    return;
  }
  const list = tables.map((table) => `"${table}"`).join(", ");
  await pool.query(`truncate table ${list} restart identity cascade`);
}

/** The minimum world a scan needs: caps, an operator, a group, a title. */
export interface SeededWorld {
  operatorId: string;
  groupId: string;
  titleId: string;
  originalVariantId: string;
}

export async function seedWorld(
  pool: Pool,
  options: {
    locales?: string[];
    priority?: "high" | "normal" | "low";
    variant?: { text: string; language: string };
  } = {},
): Promise<SeededWorld> {
  const at = "2026-03-01T00:00:00.000Z";
  await pool.query(
    `insert into rights_holder (singleton, legal_name, country)
     values (true, 'Example Rights GmbH', 'DE')
     on conflict (singleton) do nothing`,
  );
  const operator = await pool.query<{ id: string }>(
    `insert into operators (email, password_hash, role, state, created_at, updated_at)
     values ($1, 'x', 'operator', 'active', $2, $2)
     on conflict (email) do update set updated_at = excluded.updated_at
     returning id`,
    [`scanner-${Math.random().toString(36).slice(2)}@example.test`, at],
  );
  const operatorId = operator.rows[0].id;
  const group = await pool.query<{ id: string }>(
    `insert into title_groups (name, locales, scan_time, priority)
     values ('Films', $1, '02:30', $2)
     returning id`,
    [options.locales ?? ["en", "ru"], options.priority ?? "normal"],
  );
  const groupId = group.rows[0].id;
  const title = await pool.query<{ id: string }>(
    `insert into tracked_titles
       (title_group_id, release_year, title_type, paused, source, entered_by, entered_at, updated_by, created_at, updated_at)
     values ($1, 2024, 'film', false, 'operator_knowledge', $2, $3, $2, $3, $3)
     returning id`,
    [groupId, operatorId, at],
  );
  const titleId = title.rows[0].id;
  const variant = options.variant ?? { text: "Sunrise", language: "en" };
  const original = await pool.query<{ id: string }>(
    `insert into title_variants
       (tracked_title_id, text, normalized_text, kind, language, script, source, added_by, added_at)
     values ($1, $2, lower($2), 'original', $3, 'Latn', 'operator_knowledge', $4, $5)
     returning id`,
    [titleId, variant.text, variant.language, operatorId, at],
  );
  await pool.query(
    "update tracked_titles set original_variant_id = $2 where id = $1",
    [titleId, original.rows[0].id],
  );
  return {
    operatorId,
    groupId,
    titleId,
    originalVariantId: original.rows[0].id,
  };
}

/** A Russian localized variant for the seeded title. */
export async function addVariant(
  pool: Pool,
  world: SeededWorld,
  variant: { text: string; language: string; kind?: string },
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `insert into title_variants
       (tracked_title_id, text, normalized_text, kind, language, script, source, added_by, added_at)
     values ($1, $2, lower($2), $3, $4, 'Latn', 'operator_knowledge', $5, '2026-03-01T00:00:00.000Z')
     returning id`,
    [
      world.titleId,
      variant.text,
      variant.kind ?? "localized",
      variant.language,
      world.operatorId,
    ],
  );
  return result.rows[0].id;
}

/** One extra group with one original-variant title, for queue tests. */
export async function seedExtraGroup(
  pool: Pool,
  world: SeededWorld,
  options: {
    name: string;
    priority: "high" | "normal" | "low";
    titleText: string;
  },
): Promise<{ groupId: string; titleId: string }> {
  const at = "2026-03-01T00:00:00.000Z";
  const group = await pool.query<{ id: string }>(
    `insert into title_groups (name, locales, scan_time, priority)
     values ($1, '{en}', '02:30', $2)
     returning id`,
    [options.name, options.priority],
  );
  const groupId = group.rows[0].id;
  const title = await pool.query<{ id: string }>(
    `insert into tracked_titles
       (title_group_id, release_year, title_type, paused, source, entered_by, entered_at, updated_by, created_at, updated_at)
     values ($1, 2024, 'film', false, 'operator_knowledge', $2, $3, $2, $3, $3)
     returning id`,
    [groupId, world.operatorId, at],
  );
  const variant = await pool.query<{ id: string }>(
    `insert into title_variants
       (tracked_title_id, text, normalized_text, kind, language, script, source, added_by, added_at)
     values ($1, $2, lower($2), 'original', 'en', 'Latn', 'operator_knowledge', $3, $4)
     returning id`,
    [title.rows[0].id, options.titleText, world.operatorId, at],
  );
  await pool.query(
    "update tracked_titles set original_variant_id = $2 where id = $1",
    [title.rows[0].id, variant.rows[0].id],
  );
  return { groupId, titleId: title.rows[0].id };
}

/** A clock a test freezes and advances. */
export function controlledClock(initial: string): {
  now: () => Date;
  advance: (ms: number) => void;
  set: (iso: string) => void;
} {
  let current = new Date(initial).getTime();
  return {
    now: () => new Date(current),
    advance: (ms) => {
      current += ms;
    },
    set: (iso) => {
      current = new Date(iso).getTime();
    },
  };
}

/** The month's counters, for degradation and settlement assertions. */
export async function readLedger(
  pool: Pool,
  engine: "google" | "yandex",
  now: () => Date,
): Promise<{
  scanReserved: number;
  scanCommitted: number;
  recheckReserved: number;
  recheckCommitted: number;
}> {
  const at = now();
  const monthStart = `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, "0")}-01`;
  const result = await pool.query<{
    scan_reserved: number;
    scan_committed: number;
    recheck_reserved: number;
    recheck_committed: number;
  }>(
    `select scan_reserved, scan_committed, recheck_reserved, recheck_committed
       from quota_ledger where engine = $1 and month_start = $2::date`,
    [engine, monthStart],
  );
  const row = result.rows[0];
  return {
    scanReserved: Number(row?.scan_reserved ?? 0),
    scanCommitted: Number(row?.scan_committed ?? 0),
    recheckReserved: Number(row?.recheck_reserved ?? 0),
    recheckCommitted: Number(row?.recheck_committed ?? 0),
  };
}
