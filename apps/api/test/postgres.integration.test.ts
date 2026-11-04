import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import {
  assertSchemaCompatible,
  currentVersion,
  migrate,
} from "../src/db/migrations.js";

const databaseUrl = process.env.DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

suite("postgres migrations", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  afterAll(async () => {
    await pool.end();
  });

  it("applies a migration on a real database and refuses a mismatched image", async () => {
    const dir = await mkdtemp(join(tmpdir(), "patrol-pg-"));
    await writeFile(
      join(dir, "0001_probe.sql"),
      "CREATE TABLE IF NOT EXISTS slice0_probe (id text);",
    );
    await currentVersion(pool);
    await pool.query("DROP TABLE IF EXISTS slice0_probe");
    await pool.query("DELETE FROM schema_migrations WHERE version = $1", [
      "0001_probe",
    ]);

    const result = await migrate(pool, dir);

    expect(result.applied).toContain("0001_probe");
    expect(await currentVersion(pool)).toBe("0001_probe");
    expect(() => assertSchemaCompatible("0001_probe", "0002_next")).toThrow(
      /schema/i,
    );

    await currentVersion(pool);
    await pool.query("DROP TABLE IF EXISTS slice0_probe");
    await pool.query("DELETE FROM schema_migrations WHERE version = $1", [
      "0001_probe",
    ]);
  });
});
