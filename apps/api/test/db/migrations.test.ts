import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  SchemaMismatchError,
  assertSchema,
  expectedSchemaStamp,
  highestMigrationNumber,
  listMigrationFiles,
  readSchemaStamp,
  runMigrations,
} from "@patrol/db";
import { dropPublicSchema, testPool } from "./helpers.js";

/**
 * ADR 0028: migrations are numbered forward-only SQL, applied one transaction
 * each, recorded in patrol_meta, and the process refuses to run against a
 * schema it does not expect.
 */
describe("forward-only migrations", () => {
  const pool = testPool();
  const tempDirs: string[] = [];

  beforeAll(async () => {
    // Start from zero regardless of what globalSetup left behind.
    await dropPublicSchema(pool);
  });

  afterAll(async () => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    // Leave the database in the migrated baseline for any file that follows.
    await dropPublicSchema(pool);
    await runMigrations(pool);
    await pool.end();
  });

  function migrationDir(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), "patrol-migrations-"));
    tempDirs.push(dir);
    for (const [name, sql] of Object.entries(files)) {
      writeFileSync(join(dir, name), sql);
    }
    return dir;
  }

  it("lists the shipped migrations ordered by number", () => {
    const files = listMigrationFiles();
    expect(files.map((file) => file.name)).toEqual([
      "0000_meta",
      "0001_identity",
      "0002_catalogue",
      "0003_budget",
      "0004_scans",
    ]);
    expect(highestMigrationNumber()).toBe(4);
  });

  it("expects the carried migrations as the schema stamp", () => {
    expect(expectedSchemaStamp()).toBe(4);
    expect(expectedSchemaStamp("5")).toBe(5);
    expect(() => expectedSchemaStamp("nope")).toThrow(/PATROL_SCHEMA_STAMP/i);
    expect(expectedSchemaStamp(undefined)).toBe(4);
  });

  it("refuses duplicate migration numbers", () => {
    const dir = migrationDir({
      "0000_meta.sql": "select 1;",
      "0000_again.sql": "select 1;",
    });
    expect(() => listMigrationFiles(dir)).toThrow(/duplicate migration number/i);
  });

  it("migrates an empty database from zero and records the stamp", async () => {
    const { applied, schemaStamp } = await runMigrations(pool);

    expect(applied).toEqual([
      "0000_meta",
      "0001_identity",
      "0002_catalogue",
      "0003_budget",
      "0004_scans",
    ]);
    expect(schemaStamp).toBe(4);

    const recorded = await pool.query<{ schema_version: number; name: string }>(
      "select schema_version, name from patrol_meta",
    );
    expect(recorded.rows).toHaveLength(1);
    expect(Number(recorded.rows[0].schema_version)).toBe(4);
    expect(recorded.rows[0].name).toBe("0004_scans");

    const meta = await pool.query(
      "select column_name from information_schema.columns where table_name = 'patrol_meta' order by column_name",
    );
    const columns = meta.rows.map((row) => row.column_name);
    for (const expected of ["schema_version", "applied_at", "name"]) {
      expect(columns).toContain(expected);
    }
  });

  it("skips files whose number is at or below the current stamp", async () => {
    const again = await runMigrations(pool);
    expect(again.applied).toEqual([]);
    expect(again.schemaStamp).toBe(4);
  });

  it("applies only newer files and records each stamp", async () => {
    const dir = migrationDir({
      "0000_meta.sql": "select 1;",
      "0005_probe.sql": "create table migration_probe (id integer primary key);",
    });

    const first = await runMigrations(pool, dir);
    expect(first.applied).toEqual(["0005_probe"]);
    expect(first.schemaStamp).toBe(5);

    const probe = await pool.query(
      "select column_name from information_schema.columns where table_name = 'migration_probe'",
    );
    expect(probe.rows.length).toBeGreaterThan(0);

    // A late-added file numbered at or below the stamp is never run.
    const lateDir = migrationDir({
      "0000_meta.sql": "select 1;",
      "0005_probe.sql": "create table never_applied (id integer);",
    });
    const second = await runMigrations(pool, lateDir);
    expect(second.applied).toEqual([]);
    expect(second.schemaStamp).toBe(5);

    const never = await pool.query<{ t: string | null }>(
      "select to_regclass('public.never_applied') as t",
    );
    expect(never.rows[0].t).toBeNull();

    // Rewind to the shipped baseline for the tests that follow.
    await pool.query("drop table migration_probe");
    await pool.query(
      "update patrol_meta set schema_version = 4, name = '0004_scans'",
    );
  });

  it("asserts the schema and refuses a stamp ahead of the expected version", async () => {
    await pool.query("update patrol_meta set schema_version = 99");
    try {
      await expect(assertSchema(pool, 4)).rejects.toBeInstanceOf(
        SchemaMismatchError,
      );
    } finally {
      await pool.query("update patrol_meta set schema_version = 4");
    }
  });

  it("refuses a stamp behind the expected version", async () => {
    await expect(assertSchema(pool, 5)).rejects.toThrow(/schema stamp 4/i);
  });

  it("refuses to boot without any stamp at all", async () => {
    await pool.query("delete from patrol_meta");
    await expect(assertSchema(pool, 4)).rejects.toThrow(/no.*stamp/i);
    // Restore the baseline this file started from.
    await dropPublicSchema(pool);
    await runMigrations(pool);
  });

  it("accepts a matching stamp", async () => {
    await expect(assertSchema(pool, 4)).resolves.toBe(4);
    expect(await readSchemaStamp(pool)).toBe(4);
  });
});
