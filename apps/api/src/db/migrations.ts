import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/** The minimal database surface the migration runner needs. */
export interface Queryable {
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number | null }>;
}

export interface QueryClient extends Queryable {
  release(): void;
}

/** A pool that can lend a dedicated connection for a transaction. */
export interface Connectable extends Queryable {
  connect(): Promise<QueryClient>;
}

export interface Migration {
  /** The filename without its extension, such as "_0001_identity_". */
  version: string;
  sql: string;
}

export interface MigrationResult {
  applied: string[];
  version: string;
}

const MIGRATION_FILE = /^\d{4}_.+\.sql$/;

export async function readMigrations(dir: string): Promise<Migration[]> {
  const names = (await readdir(dir))
    .filter((name) => MIGRATION_FILE.test(name))
    .sort();

  return Promise.all(
    names.map(async (name) => ({
      version: name.replace(/\.sql$/, ""),
      sql: await readFile(join(dir, name), "utf8"),
    })),
  );
}

async function ensureTable(db: Queryable): Promise<void> {
  await db.query(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version text, applied_at timestamptz)",
  );
  await db.query(
    "CREATE UNIQUE INDEX IF NOT EXISTS schema_migrations_version_key ON schema_migrations (version)",
  );
}

export async function currentVersion(db: Queryable): Promise<string> {
  await ensureTable(db);
  const result = await db.query(
    "SELECT COALESCE(MAX(version), '0') AS version FROM schema_migrations",
  );
  return String(result.rows[0]?.version ?? "0");
}

export async function migrate(
  db: Connectable,
  dir: string,
): Promise<MigrationResult> {
  const client = await db.connect();
  try {
    return await runMigrations(client, dir);
  } finally {
    client.release();
  }
}

async function runMigrations(
  db: Queryable,
  dir: string,
): Promise<MigrationResult> {
  await ensureTable(db);
  const migrations = await readMigrations(dir);
  const recorded = new Set(
    (await db.query("SELECT version FROM schema_migrations")).rows.map((row) =>
      String(row.version),
    ),
  );
  const applied: string[] = [];

  for (const migration of migrations) {
    if (recorded.has(migration.version)) {
      continue;
    }
    await db.query("BEGIN");
    try {
      await db.query(migration.sql);
      await db.query("INSERT INTO schema_migrations (version) VALUES ($1)", [
        migration.version,
      ]);
      await db.query("COMMIT");
    } catch (error) {
      await db.query("ROLLBACK");
      throw error;
    }
    applied.push(migration.version);
  }

  return { applied, version: await currentVersion(db) };
}

export function assertSchemaCompatible(
  applied: string,
  expected: string,
): void {
  if (applied !== expected) {
    throw new Error(
      `schema mismatch: database is at ${applied}, image expects ${expected}`,
    );
  }
}
