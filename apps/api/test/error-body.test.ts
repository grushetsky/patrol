import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { t } from "@patrol/i18n";
import { getValidator } from "../src/plugins/validator.js";
import { buildApp, fakeSchemaStamp, testConfig } from "./test-app.js";

/**
 * ErrorBody is the shape every error response carries (contract Patrol.Http).
 * A rejected body answers 400 validation_failed with fieldErrors whose paths
 * are JSON pointers, and no error leaks internals into the response body.
 */
describe("error body contract", () => {
  it("answers 400 validation_failed with fieldErrors for a schema-invalid body", async () => {
    const app = await buildApp({
      config: testConfig(),
      schemaStamp: fakeSchemaStamp(0),
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/__stub/echo",
      headers: { "content-type": "application/json" },
      // "remove" is not a ReviewDecisionAction; evidenceIds is missing.
      payload: { action: "remove" },
    });

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.code).toBe("validation_failed");
    expect(typeof body.message).toBe("string");
    expect(getValidator("ErrorBody")(body)).toBe(true);
    expect(Array.isArray(body.fieldErrors)).toBe(true);
    const paths = body.fieldErrors.map(
      (fieldError: { path: string }) => fieldError.path,
    );
    expect(paths).toContain("/action");
    expect(paths).toContain("/evidenceIds");
    for (const fieldError of body.fieldErrors) {
      expect(typeof fieldError.message).toBe("string");
      expect(fieldError.message.length).toBeGreaterThan(0);
    }
  });

  it("answers 400 validation_failed when the body is not valid JSON", async () => {
    const app = await buildApp({
      config: testConfig(),
      schemaStamp: fakeSchemaStamp(0),
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/__stub/echo",
      headers: { "content-type": "application/json" },
      payload: "{not json",
    });

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.code).toBe("validation_failed");
    expect(body.message).toBeTypeOf("string");
    expect(getValidator("ErrorBody")(body)).toBe(true);
  });

  it("answers 400 validation_failed when the body is missing entirely", async () => {
    const app = await buildApp({
      config: testConfig(),
      schemaStamp: fakeSchemaStamp(0),
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/__stub/echo",
      headers: { "content-type": "application/json" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("validation_failed");
  });

  it("answers 500 internal_error in a schema-valid ErrorBody without internals", async () => {
    const app = await buildApp({
      config: testConfig(),
      schemaStamp: fakeSchemaStamp(0),
    });
    app.post("/api/__boom", async () => {
      throw new Error("secret internals");
    });

    const response = await app.inject({ method: "POST", url: "/api/__boom" });

    expect(response.statusCode).toBe(500);
    const body = response.json();
    expect(body.code).toBe("internal_error");
    // internal_error is a member of the contract's ErrorCode enum, so the
    // 500 body must validate against the emitted Http.ErrorBody schema.
    expect(getValidator("ErrorBody")(body)).toBe(true);
    expect(JSON.stringify(body)).not.toContain("secret internals");
    expect(JSON.stringify(body)).not.toContain("stack");
  });

  it("answers 404 not_found in the ErrorBody shape for an unknown route", async () => {
    const app = await buildApp({
      config: testConfig(),
      schemaStamp: fakeSchemaStamp(0),
    });

    const response = await app.inject({ method: "GET", url: "/api/no-such-route" });

    expect(response.statusCode).toBe(404);
    const body = response.json();
    expect(body.code).toBe("not_found");
    expect(typeof body.message).toBe("string");
    expect(getValidator("ErrorBody")(body)).toBe(true);
  });

  it("localizes the display message to the request's Accept-Language, never the code", async () => {
    const app = await buildApp({
      config: testConfig(),
      schemaStamp: fakeSchemaStamp(0),
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/__stub/echo",
      headers: { "content-type": "application/json", "accept-language": "ru-RU,ru;q=0.9,en;q=0.8" },
      payload: "{not json",
    });

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.code).toBe("validation_failed");
    expect(body.message).toBe(t("ru", "errors.validation_failed"));

    const english = await app.inject({
      method: "POST",
      url: "/api/__stub/echo",
      headers: { "content-type": "application/json", "accept-language": "en-GB,en;q=0.9" },
      payload: "{not json",
    });
    expect(english.json().message).toBe(t("en", "errors.validation_failed"));
  });

  it("mounts the stub routes outside production only", async () => {
    // The default (dev) mounts them; every other test in this file relies on it.
    const dev = await buildApp({
      config: testConfig(),
      schemaStamp: fakeSchemaStamp(0),
    });
    const devResponse = await dev.inject({
      method: "POST",
      url: "/api/__stub/echo",
      headers: { "content-type": "application/json" },
    });
    expect(devResponse.statusCode).toBe(400);

    const production = await buildApp({
      config: testConfig({ env: "production" }),
      schemaStamp: fakeSchemaStamp(0),
    });
    // A parseable body, so fastify's empty-JSON parsing error cannot mask
    // the not-found answer the missing route must give.
    const productionResponse = await production.inject({
      method: "POST",
      url: "/api/__stub/echo",
      headers: { "content-type": "application/json" },
      payload: { action: "remove" },
    });
    expect(productionResponse.statusCode).toBe(404);
    expect(productionResponse.json().code).toBe("not_found");
  });

  it("stamps x-request-id on every response", async () => {
    const app: FastifyInstance = await buildApp({
      config: testConfig(),
      schemaStamp: fakeSchemaStamp(0),
    });

    const ok = await app.inject({ method: "GET", url: "/api/health" });
    expect(ok.statusCode).toBe(200);
    const requestId = String(ok.headers["x-request-id"]);
    expect(requestId.length).toBeGreaterThan(0);

    const bad = await app.inject({
      method: "POST",
      url: "/api/__stub/echo",
      headers: { "content-type": "application/json" },
      payload: { action: "remove" },
    });
    expect(bad.statusCode).toBe(400);
    expect(typeof bad.headers["x-request-id"]).toBe("string");
  });

  it("gives each request a fresh request id", async () => {
    const app = await buildApp({
      config: testConfig(),
      schemaStamp: fakeSchemaStamp(0),
    });

    const first = await app.inject({ method: "GET", url: "/api/health" });
    const second = await app.inject({ method: "GET", url: "/api/health" });

    expect(first.headers["x-request-id"]).not.toBe(
      second.headers["x-request-id"],
    );
  });
});
