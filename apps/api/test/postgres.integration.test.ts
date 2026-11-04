import { randomUUID } from "node:crypto";
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
    const schema = `probe_${randomUUID().replaceAll("-", "")}`;
    await pool.query(`CREATE SCHEMA "${schema}"`);
    const probe = new Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schema}`,
    });

    try {
      const dir = await mkdtemp(join(tmpdir(), "patrol-pg-"));
      await writeFile(
        join(dir, "0001_probe.sql"),
        "CREATE TABLE IF NOT EXISTS slice0_probe (id text);",
      );

      const result = await migrate(probe, dir);

      expect(result.applied).toContain("0001_probe");
      expect(await currentVersion(probe)).toBe("0001_probe");
      expect(() => assertSchemaCompatible("0001_probe", "0002_next")).toThrow(
        /schema/i,
      );
    } finally {
      await probe.end();
      await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    }
  });
});
