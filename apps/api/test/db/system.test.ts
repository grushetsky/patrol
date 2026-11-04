import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { getValidator } from "../../src/plugins/validator.js";
import { buildApp, poolSchemaStamp, testConfig } from "../test-app.js";
import { MemoryMailTransport } from "../../src/mail/transport.js";
import { testPool } from "./helpers.js";

/**
 * The system routes answer the contract's shapes (Patrol.Http HealthReport,
 * VersionReport, SetupState) against a real migrated database, and every
 * response body is re-validated against the emitted JSON Schema bundle.
 */
describe("system routes against the test database", () => {
  let app: FastifyInstance;
  const pool = testPool();

  beforeAll(async () => {
    app = await buildApp({
      config: testConfig(),
      pool,
      mail: new MemoryMailTransport(),
      schemaStamp: poolSchemaStamp(pool),
    });
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it("serves GET /api/health as a schema-valid HealthReport", async () => {
    const response = await app.inject({ method: "GET", url: "/api/health" });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toEqual({ status: "ok" });
    expect(getValidator("HealthReport")(body)).toBe(true);
  });

  it("serves GET /api/system/version reporting the carried migration and a compatible stamp", async () => {
    const response = await app.inject({ method: "GET", url: "/api/system/version" });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.buildVersion).toBe("test-build");
    expect(body.migrationVersion).toBe("1");
    expect(body.schemaCompatible).toBe(true);
    expect(getValidator("VersionReport")(body)).toBe(true);
  });

  it("answers 503 schema_mismatch when the stamp is tampered with", async () => {
    await pool.query("update patrol_meta set schema_version = 99");
    try {
      const response = await app.inject({ method: "GET", url: "/api/system/version" });

      expect(response.statusCode).toBe(503);
      const body = response.json();
      expect(body.code).toBe("schema_mismatch");
      expect(typeof body.message).toBe("string");
      expect(getValidator("ErrorBody")(body)).toBe(true);
    } finally {
      await pool.query("update patrol_meta set schema_version = 1");
    }
  });

  it("answers 503 schema_mismatch when no stamp is recorded at all", async () => {
    await pool.query("delete from patrol_meta");
    try {
      const response = await app.inject({ method: "GET", url: "/api/system/version" });

      expect(response.statusCode).toBe(503);
      expect(response.json().code).toBe("schema_mismatch");
    } finally {
      await pool.query(
        "insert into patrol_meta (singleton, schema_version, applied_at, name) values (true, 1, now(), '0001_identity')",
      );
    }
  });

  it("serves GET /api/system/setup as the contract-shaped unconfigured state", async () => {
    const response = await app.inject({ method: "GET", url: "/api/system/setup" });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toEqual({
      bootstrapped: false,
      rightsHolderConfigured: false,
      administratorCount: 0,
    });
    expect(getValidator("SetupState")(body)).toBe(true);
  });
});
