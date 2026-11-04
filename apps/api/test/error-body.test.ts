import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { t } from "@patrol/i18n";
import { getValidator } from "../src/plugins/validator.js";
import { buildApp, unitAppDeps } from "./test-app.js";

/**
 * ErrorBody is the shape every error response carries (contract Patrol.Http).
 * A rejected body answers 400 validation_failed with fieldErrors whose paths
 * are JSON pointers, and no error leaks internals into the response body.
 * The slice-0 placeholder route these tests used is gone; POST /auth/sign-in
 * is the real route under test now.
 */
async function unitApp(): Promise<FastifyInstance> {
  const deps = unitAppDeps();
  return buildApp(deps);
}

/**
 * The CSRF pair every anonymous mutation carries: the cookie GET /auth/csrf
 * sets plus the same value in the header.
 */
async function anonCsrfHeaders(app: FastifyInstance): Promise<Record<string, string>> {
  const csrf = await app.inject({ method: "GET", url: "/api/auth/csrf" });
  const token = csrf.json().csrfToken as string;
  const cookie = String(csrf.headers["set-cookie"]).split(";")[0];
  return { cookie, "x-patrol-csrf": token };
}

describe("error body contract", () => {
  it("answers 400 validation_failed with fieldErrors for a schema-invalid body", async () => {
    const app = await unitApp();
    const csrf = await anonCsrfHeaders(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in",
      headers: { "content-type": "application/json", ...csrf },
      // The email is not an address; the password is missing.
      payload: { email: "not-an-email" },
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
    expect(paths).toContain("/email");
    expect(paths).toContain("/password");
    for (const fieldError of body.fieldErrors) {
      expect(typeof fieldError.message).toBe("string");
      expect(fieldError.message.length).toBeGreaterThan(0);
    }
  });

  it("answers 400 validation_failed when the body is not valid JSON", async () => {
    const app = await unitApp();
    const csrf = await anonCsrfHeaders(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in",
      headers: { "content-type": "application/json", ...csrf },
      payload: "{not json",
    });

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.code).toBe("validation_failed");
    expect(body.message).toBeTypeOf("string");
    expect(getValidator("ErrorBody")(body)).toBe(true);
  });

  it("answers 400 validation_failed when the body is missing entirely", async () => {
    const app = await unitApp();
    const csrf = await anonCsrfHeaders(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in",
      headers: { "content-type": "application/json", ...csrf },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("validation_failed");
  });

  it("answers 500 internal_error in a schema-valid ErrorBody without internals", async () => {
    const app = await unitApp();
    // A test-only route the contract does not declare: it must declare its
    // roles explicitly, or the default-closed role guard refuses it first.
    app.get("/api/__boom", { config: { patrolRoles: ["anonymous"] } }, async () => {
      throw new Error("secret internals");
    });

    const response = await app.inject({ method: "GET", url: "/api/__boom" });

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
    const app = await unitApp();

    const response = await app.inject({ method: "GET", url: "/api/no-such-route" });

    expect(response.statusCode).toBe(404);
    const body = response.json();
    expect(body.code).toBe("not_found");
    expect(typeof body.message).toBe("string");
    expect(getValidator("ErrorBody")(body)).toBe(true);
  });

  it("localizes the display message to the request's Accept-Language, never the code", async () => {
    const app = await unitApp();
    const csrf = await anonCsrfHeaders(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in",
      headers: {
        "content-type": "application/json",
        "accept-language": "ru-RU,ru;q=0.9,en;q=0.8",
        ...csrf,
      },
      payload: "{not json",
    });

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.code).toBe("validation_failed");
    expect(body.message).toBe(t("ru", "errors.validation_failed"));

    const english = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in",
      headers: {
        "content-type": "application/json",
        "accept-language": "en-GB,en;q=0.9",
        ...csrf,
      },
      payload: "{not json",
    });
    expect(english.json().message).toBe(t("en", "errors.validation_failed"));
  });

  it("mounts the real auth routes in production too", async () => {
    // The slice-0 stub-echo route is deleted; the auth routes are product
    // code and must exist in every environment.
    const production = await buildApp(unitAppDeps({ env: "production" }));
    const csrf = await anonCsrfHeaders(production);
    const productionResponse = await production.inject({
      method: "POST",
      url: "/api/auth/sign-in",
      headers: { "content-type": "application/json", ...csrf },
      payload: { action: "remove" },
    });
    expect(productionResponse.statusCode).toBe(400);
    expect(productionResponse.json().code).toBe("validation_failed");
  });

  it("stamps x-request-id on every response", async () => {
    const app = await unitApp();

    const ok = await app.inject({ method: "GET", url: "/api/health" });
    expect(ok.statusCode).toBe(200);
    const requestId = String(ok.headers["x-request-id"]);
    expect(requestId.length).toBeGreaterThan(0);

    const csrf = await anonCsrfHeaders(app);
    const bad = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in",
      headers: { "content-type": "application/json", ...csrf },
      payload: { email: "not-an-email" },
    });
    expect(bad.statusCode).toBe(400);
    expect(typeof bad.headers["x-request-id"]).toBe("string");
  });

  it("gives each request a fresh request id", async () => {
    const app = await unitApp();

    const first = await app.inject({ method: "GET", url: "/api/health" });
    const second = await app.inject({ method: "GET", url: "/api/health" });

    expect(first.headers["x-request-id"]).not.toBe(
      second.headers["x-request-id"],
    );
  });
});
