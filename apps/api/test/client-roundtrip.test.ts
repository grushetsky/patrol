import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import createClient from "openapi-fetch";
import type { components, paths } from "../src/lib/api/schema.js";
import { buildApp, fakeSchemaStamp, testConfig } from "./test-app.js";
import { fetchThroughInject } from "./helpers/inject-fetch.js";

/**
 * The typed client generated from the contract's OpenAPI document must reach
 * the API and read the ErrorBody a rejection carries. The stub echo route is
 * temporary scaffolding for slice 0 and is deleted in slice 1.
 */
type ReviewDecisionRequest =
  components["schemas"]["Http.ReviewDecisionRequest"];

/**
 * The stub lives outside the contract, so the typed client has no entry for
 * it; the request body still comes from the generated components, and the
 * error shape is asserted by hand until the stub dies in slice 1.
 */
interface StubError {
  code?: string;
  fieldErrors?: { path: string; message: string }[];
}

async function typedClient() {
  const app = await buildApp({
    config: testConfig(),
    schemaStamp: fakeSchemaStamp(0),
  });
  // An absolute origin because Node's fetch refuses a relative URL; the
  // adapter ignores the origin and injects by path.
  return createClient<paths>({
    baseUrl: "http://patrol.test/api",
    fetch: fetchThroughInject(app),
  });
}

describe("generated client round trip", () => {
  it("carries a valid body to the stub and echoes it back", async () => {
    const client = await typedClient();
    const body: ReviewDecisionRequest = {
      action: "violation",
      evidenceIds: [randomUUID()],
    };

    const result = await client.POST("/__stub/echo" as never, {
      body,
    } as never);

    expect(result.response.status).toBe(200);
    expect(result.data).toEqual(body);
  });

  it("surfaces a 400 with code and fieldErrors for an invalid body", async () => {
    const client = await typedClient();

    const result = await client.POST("/__stub/echo" as never, {
      body: { action: "remove" },
    } as never);

    expect(result.response.status).toBe(400);
    const error = result.error as StubError | undefined;
    expect(error?.code).toBe("validation_failed");
    expect(error?.fieldErrors?.length).toBeGreaterThan(0);
  });

  it("reads a system route through the typed client", async () => {
    const client = await typedClient();

    const result = await client.GET("/health");

    expect(result.response.status).toBe(200);
    expect(result.data?.status).toBe("ok");
  });
});
