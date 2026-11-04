import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newDb } from "pg-mem";
import { describe, expect, it } from "vitest";
import {
  assertSchemaCompatible,
  currentVersion,
  migrate,
  readMigrations,
  type Connectable,
} from "../src/db/migrations.js";

async function migrationDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "patrol-migrations-"));
  for (const [name, sql] of Object.entries(files)) {
    await writeFile(join(dir, name), sql);
  }
  return dir;
}

function memoryDb(): Connectable {
  const db = newDb();
  const adapter = db.adapters.createPg();
  return new adapter.Pool() as unknown as Connectable;
}

describe("readMigrations", () => {
  it("reads numbered SQL files in filename order", async () => {
    const dir = await migrationDir({
      "0002_beta.sql": "CREATE TABLE beta (id text);",
      "0001_alpha.sql": "CREATE TABLE alpha (id text);",
      "notes.txt": "ignored",
    });

    const migrations = await readMigrations(dir);

    expect(migrations.map((migration) => migration.version)).toEqual([
      "0001_alpha",
      "0002_beta",
    ]);
  });
});

describe("migrate", () => {
  it("applies a fresh database from zero and records each version", async () => {
    const db = memoryDb();
    const dir = await migrationDir({
      "0001_alpha.sql": "CREATE TABLE alpha (id text primary key);",
      "0002_beta.sql": "CREATE TABLE beta (id text primary key);",
    });

    const result = await migrate(db, dir);

    expect(result.applied).toEqual(["0001_alpha", "0002_beta"]);
    expect(result.version).toBe("0002_beta");
    expect(await currentVersion(db)).toBe("0002_beta");
  });

  it("applies only migrations that are not recorded", async () => {
    const db = memoryDb();
    const first = await migrationDir({
      "0001_alpha.sql": "CREATE TABLE alpha (id text primary key);",
    });
    await migrate(db, first);

    const second = await migrationDir({
      "0001_alpha.sql": "CREATE TABLE alpha (id text primary key);",
      "0002_beta.sql": "CREATE TABLE beta (id text primary key);",
    });
    const result = await migrate(db, second);

    expect(result.applied).toEqual(["0002_beta"]);
    expect(result.version).toBe("0002_beta");
  });

  it("does nothing on an unchanged database", async () => {
    const db = memoryDb();
    const dir = await migrationDir({
      "0001_alpha.sql": "CREATE TABLE alpha (id text primary key);",
    });
    await migrate(db, dir);

    const result = await migrate(db, dir);

    expect(result.applied).toEqual([]);
    expect(result.version).toBe("0001_alpha");
  });
});

describe("identity migration", () => {
  it("applies the committed migrations from zero", async () => {
    const db = memoryDb();
    const dir = new URL("../drizzle", import.meta.url).pathname;

    const result = await migrate(db, dir);

    expect(result.applied).toContain("0001_identity");
    expect(result.version).toBe("0001_identity");
  });
});

describe("assertSchemaCompatible", () => {
  it("accepts an applied schema that matches the image", () => {
    expect(() => assertSchemaCompatible("0002_beta", "0002_beta")).not.toThrow();
  });

  it("refuses an image that expects a different schema", () => {
    expect(() => assertSchemaCompatible("0001_alpha", "0002_beta")).toThrow(
      /schema/i,
    );
  });
});
