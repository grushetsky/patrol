import { beforeEach, describe, expect, it } from "vitest";
import { buildApp, poolSchemaStamp, testConfig } from "../test-app.js";
import { MemoryMailTransport } from "../../src/mail/transport.js";
import {
  ceremonyApp,
  signedInAdministrator,
  inviteAndEnroll,
  type CeremonyApp,
  type SignedInOperator,
} from "./ceremony.js";
import { testPool, truncateDomainTables } from "./helpers.js";

/**
 * The general API rate limits (slice 9 "Rate limits"): a per-session
 * ceiling for authenticated calls, a per-IP ceiling for anonymous ones,
 * the contract's 429 rate_limited with retryAfterSeconds when either is
 * crossed — complementing, not duplicating, the sign-in throttle (which
 * is a lockout policy against guessing, not a load ceiling). The health
 * endpoint stays outside both ceilings: the load balancer probes it.
 */

describe("general API rate limits", () => {
  let world: CeremonyApp;
  let admin: SignedInOperator;
  let operator: SignedInOperator;
  const pool = testPool();

  beforeEach(async () => {
    await truncateDomainTables(pool);
    world = await ceremonyApp();
    admin = await signedInAdministrator(world, "admin@example.test");
    operator = await inviteAndEnroll(world, admin, "holder@example.test");
    const app = await buildApp({
      config: testConfig({
        now: world.clock.now,
        rateLimit: { windowMs: 60_000, sessionMax: 5, anonymousMax: 3 },
      }),
      pool: world.pool,
      mail: world.mail,
      schemaStamp: poolSchemaStamp(world.pool),
    });
    world.app = app;
  });

  it("answers 429 rate_limited with retryAfterSeconds once a session crosses its ceiling", async () => {
    let last = 0;
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      const response = await world.app.inject({
        method: "GET",
        url: "/api/settings/rights-holder",
        headers: { cookie: admin.cookie },
      });
      if (attempt <= 5) {
        expect(response.statusCode).toBe(200);
      } else {
        last = response.statusCode;
        const body = response.json();
        expect(response.statusCode).toBe(429);
        expect(body.code).toBe("rate_limited");
        expect(body.retryAfterSeconds).toBeGreaterThanOrEqual(1);
        expect(body.retryAfterSeconds).toBeLessThanOrEqual(60);
        expect(response.headers["retry-after"]).toBe(String(body.retryAfterSeconds));
      }
    }
    expect(last).toBe(429);
  });

  it("isolates two sessions: one exhausted session does not throttle another", async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await world.app.inject({
        method: "GET",
        url: "/api/settings/rights-holder",
        headers: { cookie: admin.cookie },
      });
    }
    const exhausted = await world.app.inject({
      method: "GET",
      url: "/api/settings/rights-holder",
      headers: { cookie: admin.cookie },
    });
    expect(exhausted.statusCode).toBe(429);

    const other = await world.app.inject({
      method: "GET",
      url: "/api/settings/rights-holder",
      headers: { cookie: operator.cookie },
    });
    expect(other.statusCode).toBe(200);
  });

  it("ceils anonymous requests per IP below the authenticated ceiling", async () => {
    // Anonymous calls reach the role guard (401 for an authenticated
    // route), but the ceiling counts them first: after anonymousMax
    // requests from the address, the fourth answers 429 whatever the
    // route would have said.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const within = await world.app.inject({ method: "GET", url: "/api/settings/rights-holder" });
      expect(within.statusCode).toBe(401);
    }
    const fourth = await world.app.inject({ method: "GET", url: "/api/settings/rights-holder" });
    expect(fourth.statusCode).toBe(429);
    expect(fourth.json().code).toBe("rate_limited");
    expect(fourth.json().retryAfterSeconds).toBeGreaterThanOrEqual(1);

    // The anonymous ceiling is the address's, not the route's: a different
    // anonymous path from the same address is throttled too.
    const elsewhere = await world.app.inject({ method: "GET", url: "/api/system/version" });
    expect(elsewhere.statusCode).toBe(429);
  });

  it("never throttles the health probe", async () => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await world.app.inject({ method: "GET", url: "/api/settings/rights-holder" });
    }
    const health = await world.app.inject({ method: "GET", url: "/api/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json().status).toBe("ok");
  });

  it("shares no state across app instances (per-process counters)", async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await world.app.inject({
        method: "GET",
        url: "/api/settings/rights-holder",
        headers: { cookie: admin.cookie },
      });
    }
    const fresh = await buildApp({
      config: testConfig({
        now: world.clock.now,
        rateLimit: { windowMs: 60_000, sessionMax: 5, anonymousMax: 3 },
      }),
      pool: world.pool,
      mail: new MemoryMailTransport(),
      schemaStamp: poolSchemaStamp(world.pool),
    });
    const response = await fresh.inject({
      method: "GET",
      url: "/api/settings/rights-holder",
      headers: { cookie: admin.cookie },
    });
    expect(response.statusCode).toBe(200);
  });
});
