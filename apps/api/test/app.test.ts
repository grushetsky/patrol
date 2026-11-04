import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newDb } from "pg-mem";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadContract } from "../src/contract.js";
import { ValidationError } from "../src/errors.js";
import { migrate, type Connectable } from "../src/db/migrations.js";

const bundle = new URL("../../../contract/generated/json-schema/patrol", import.meta.url);

async function appUnderTest() {
  const db = newDb();
  const adapter = db.adapters.createPg();
  const pool = new adapter.Pool() as unknown as Connectable;
  const dir = await mkdtemp(join(tmpdir(), "patrol-app-"));
  await migrate(pool, dir);
  const contract = await loadContract(bundle);
  const app = buildApp({
    db: pool,
    contract,
    buildVersion: "0.1.0",
    expectedMigration: "0",
    logger: false,
  });
  return app;
}

describe("health and system routes", () => {
  it("answers health without authentication", async () => {
    const app = await appUnderTest();

    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
    await app.close();
  });

  it("reports the build and applied migration version", async () => {
    const app = await appUnderTest();

    const response = await app.inject({ method: "GET", url: "/api/system/version" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      buildVersion: "0.1.0",
      migrationVersion: "0",
      schemaCompatible: true,
    });
    await app.close();
  });

  it("reports that the deployment is not bootstrapped", async () => {
    const app = await appUnderTest();

    const response = await app.inject({ method: "GET", url: "/api/system/setup" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      bootstrapped: false,
      rightsHolderConfigured: false,
      administratorCount: 0,
    });
    await app.close();
  });

  it("answers an unknown route with the contract error body", async () => {
    const app = await appUnderTest();

    const response = await app.inject({ method: "GET", url: "/api/nope" });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: "not_found" });
    await app.close();
  });
});

async function appWithValidationRoute() {
  const app = await appUnderTest();
  const contract = await loadContract(bundle);
  app.post("/__test/validate", async (request) => {
    const result = contract.validate("ReviewDecisionRequest", request.body);
    if (!result.valid) {
      throw new ValidationError(result.issues);
    }
    return { ok: true };
  });
  await app.ready();
  return app;
}

describe("sign-in validation", () => {
  it("rejects an invalid sign-in body with field errors", async () => {
    const app = await appUnderTest();

    const response = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in",
      payload: { email: "not-an-email", password: "" },
    });

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.code).toBe("validation_failed");
    expect(body.fieldErrors).toContainEqual(
      expect.objectContaining({ path: "/email" }),
    );
    await app.close();
  });

  it("refuses a valid sign-in until the deployment is bootstrapped", async () => {
    const app = await appUnderTest();

    const response = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in",
      payload: { email: "operator@example.test", password: "correct horse battery" },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: "setup_required" });
    await app.close();
  });
});

describe("validation wiring", () => {
  it("answers an invalid body with 400 and field errors", async () => {
    const app = await appWithValidationRoute();

    const response = await app.inject({
      method: "POST",
      url: "/__test/validate",
      payload: { action: "remove", evidenceIds: [] },
    });

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.code).toBe("validation_failed");
    expect(body.fieldErrors.some((issue: { path: string }) => issue.path === "/action")).toBe(true);
    await app.close();
  });

  it("accepts a valid body through the same seam", async () => {
    const app = await appWithValidationRoute();

    const response = await app.inject({
      method: "POST",
      url: "/__test/validate",
      payload: {
        action: "violation",
        evidenceIds: ["018f4c8e-1c2a-7c3e-9b1f-2b6d9f0a3c09"],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    await app.close();
  });
});
