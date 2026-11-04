import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp, poolSchemaStamp, testConfig } from "../test-app.js";
import { MemoryMailTransport } from "../../src/mail/transport.js";
import {
  ceremonyApp,
  inviteAndEnroll,
  signedInAdministrator,
  type CeremonyApp,
  type SignedInOperator,
} from "./ceremony.js";

/**
 * The role guard's default-closed posture: the roles a route demands come
 * from the contract's x-patrol-roles (method and path), manual route
 * metadata only overrides them, and a route the contract does not declare
 * is refused with 403 even for an authenticated administrator.
 */
describe("contract-derived role guard", () => {
  let world: CeremonyApp;
  let admin: SignedInOperator;

  beforeAll(async () => {
    world = await ceremonyApp();
    admin = await signedInAdministrator(world, "admin@example.test");
  });

  afterAll(async () => {
    await world.app.close();
    await world.pool.end();
  });

  it("serves the anonymous system and health routes the contract declares", async () => {
    // These routes carry no patrolRoles metadata of their own; the contract
    // is their only role source, and it says anonymous.
    const health = await world.app.inject({ method: "GET", url: "/api/health" });
    expect(health.statusCode).toBe(200);
    const version = await world.app.inject({ method: "GET", url: "/api/system/version" });
    expect(version.statusCode).toBe(200);
    const csrf = await world.app.inject({ method: "GET", url: "/api/auth/csrf" });
    expect(csrf.statusCode).toBe(200);
  });

  it("refuses a route the contract does not declare, even authenticated", async () => {
    // Registered the way a future slice might accidentally ship a helper:
    // no patrolRoles metadata, no contract entry. A route cannot join an
    // app Fastify has already served, so this builds its own instance over
    // the same database.
    const app = await buildApp({
      config: testConfig({ now: world.clock.now }),
      pool: world.pool,
      mail: new MemoryMailTransport(),
      schemaStamp: poolSchemaStamp(world.pool),
    });
    try {
      await app.get("/api/undecided", async () => ({ ok: true }));
      const anonymous = await app.inject({ method: "GET", url: "/api/undecided" });
      expect(anonymous.statusCode).toBe(403);
      expect(anonymous.json().code).toBe("forbidden");

      const operator = await inviteAndEnroll(world, admin, "guard-admin@example.test");
      const authenticated = await app.inject({
        method: "GET",
        url: "/api/undecided",
        headers: { cookie: operator.cookie },
      });
      expect(authenticated.statusCode).toBe(403);
      expect(authenticated.json().code).toBe("forbidden");
    } finally {
      await app.close();
    }
  });

  it("still enforces the contract's roles where it declares them", async () => {
    // /api/operators is an administrator route per the contract; the routes
    // declare matching metadata, and unauthenticated access answers 401.
    const operator = await world.app.inject({ method: "GET", url: "/api/operators" });
    expect(operator.statusCode).toBe(401);
    expect(operator.json().code).toBe("unauthenticated");
  });
});
