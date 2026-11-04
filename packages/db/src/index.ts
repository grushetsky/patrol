import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Pool, PoolClient } from "pg";

/**
 * The database runtime shared by the API and the worker (ADR 0028): the
 * forward-only migration runner, the patrol_meta stamp readers, and the
 * startup check both processes refuse to boot without. This module ships as
 * TypeScript source — Node 26 strips the types at runtime — and the emitted
 * src/index.d.ts is what consuming typechecks resolve.
 */

/** One numbered, forward-only SQL migration shipped in drizzle/. */
export interface MigrationFile {
  number: number;
  name: string;
  path: string;
}

/** The directory of shipped migrations, relative to this source file. */
export function migrationsDir(): string {
  // src/ and (if a build ever emits one) dist/ both sit directly under the
  // package root, so ../drizzle/ resolves from either.
  return fileURLToPath(new URL("../drizzle/", import.meta.url));
}

/**
 * Lists the shipped migrations ordered by number. A duplicate number is a
 * packaging error and refuses loudly rather than applying in glob order.
 */
export function listMigrationFiles(dir = migrationsDir()): MigrationFile[] {
  const entries = readdirSync(dir)
    .filter((entry) => /^\d+_.+\.sql$/.test(entry))
    .sort();
  const files: MigrationFile[] = [];
  for (const entry of entries) {
    const number = Number.parseInt(entry.split("_", 1)[0], 10);
    if (files.some((file) => file.number === number)) {
      throw new Error(`duplicate migration number in ${entry}`);
    }
    files.push({ number, name: entry.replace(/\.sql$/, ""), path: `${dir}/${entry}` });
  }
  return files;
}

/** The highest migration number this image carries. */
export function highestMigrationNumber(dir = migrationsDir()): number {
  const files = listMigrationFiles(dir);
  return files.length === 0 ? 0 : files[files.length - 1].number;
}

/**
 * The stamp this image expects the database to carry: the PATROL_SCHEMA_STAMP
 * override when it is set, otherwise the highest migration the image ships.
 */
export function expectedSchemaStamp(override?: string | undefined): number {
  if (override === undefined || override === "") {
    return highestMigrationNumber();
  }
  const parsed = Number.parseInt(override, 10);
  if (!Number.isInteger(parsed)) {
    throw new Error(`PATROL_SCHEMA_STAMP must be an integer, got ${override}`);
  }
  return parsed;
}

/** Reads patrol_meta's current stamp, or null before the table exists. */
export async function readSchemaStamp(
  client: PoolClient | Pool,
): Promise<number | null> {
  let result: { rows: { schema_version: number | string }[] };
  try {
    result = await client.query(
      "select schema_version from patrol_meta order by schema_version desc limit 1",
    );
  } catch (error) {
    if (isUndefinedTable(error)) {
      return null;
    }
    throw error;
  }
  return result.rows.length === 0 ? null : Number(result.rows[0].schema_version);
}

function isUndefinedTable(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "42P01"
  );
}

/** Serializes migration runs across processes on one database. */
const MIGRATION_LOCK_KEY = 741_209;

export interface MigrationOutcome {
  /** The migration names applied by this run, in order. */
  applied: string[];
  /** The stamp recorded after the run, or null when nothing is recorded. */
  schemaStamp: number | null;
}

/**
 * The forward-only runner (ADR 0028). Every file applies in its own
 * transaction and records its stamp in patrol_meta; a file whose number is
 * at or below the current stamp is never run again. An advisory lock
 * serializes concurrent runners.
 */
export async function runMigrations(
  pool: Pool,
  dir = migrationsDir(),
): Promise<MigrationOutcome> {
  const client = await pool.connect();
  try {
    await client.query("select pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    try {
      const files = listMigrationFiles(dir);
      const applied: string[] = [];
      let schemaStamp = await readSchemaStamp(client);
      for (const file of files) {
        if (schemaStamp !== null && file.number <= schemaStamp) {
          continue;
        }
        const sql = readFileSync(file.path, "utf8");
        await client.query("begin");
        try {
          await client.query(sql);
          await client.query(
            "insert into patrol_meta (singleton, schema_version, applied_at, name) values (true, $1, now(), $2) on conflict (singleton) do update set schema_version = excluded.schema_version, applied_at = excluded.applied_at, name = excluded.name",
            [file.number, file.name],
          );
          await client.query("commit");
        } catch (error) {
          await client.query("rollback");
          throw error;
        }
        applied.push(file.name);
        schemaStamp = file.number;
      }
      return { applied, schemaStamp };
    } finally {
      await client.query("select pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}

/** Raised when the database stamp does not match what the image expects. */
export class SchemaMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchemaMismatchError";
  }
}

/**
 * The startup check (ADR 0028): the process refuses to run against a schema
 * it does not expect — unrecorded, ahead, or behind.
 */
export async function assertSchema(
  pool: Pool,
  expected: number,
): Promise<number> {
  const schemaStamp = await readSchemaStamp(pool);
  if (schemaStamp === null) {
    throw new SchemaMismatchError(
      `database has no patrol_meta stamp; expected ${expected} — run the migrate task before starting`,
    );
  }
  if (schemaStamp !== expected) {
    throw new SchemaMismatchError(
      `database schema stamp ${schemaStamp} does not match expected ${expected}; the image and the database disagree`,
    );
  }
  return schemaStamp;
}
