import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PER_IP_MAX_FAILURES } from "../../src/domain/lockout.js";
import {
  anonCsrf,
  ceremonyApp,
  signedInAdministrator,
  type CeremonyApp,
} from "./ceremony.js";

/**
 * The per-IP throttle's coverage of unknown accounts: every refused
 * sign-in writes a sign_in_failed row — with a null operator when the
 * email names no account — so one address probing usernames throttles
 * exactly like one guessing passwords (implementation-rules "Sign-in
 * rate"). This file owns its operator and its failure budget: the twenty
 * probe events it writes are the throttle's own fixture.
 */
describe("the per-IP throttle counts unknown-account attempts", () => {
  let world: CeremonyApp;

  beforeAll(async () => {
    world = await ceremonyApp();
    await signedInAdministrator(world, "admin@example.test");
  });

  afterAll(async () => {
    await world.app.close();
    await world.pool.end();
  });

  async function probe(): Promise<number> {
    const csrf = await anonCsrf(world.app);
    const response = await world.app.inject({
      method: "POST",
      url: "/api/auth/sign-in",
      headers: { "content-type": "application/json", ...csrf },
      payload: {
        email: `ghost-${Math.random()}@example.test`,
        password: "whatever-long-enough",
      },
    });
    return response.statusCode;
  }

  it("audits unknown-email failures with a null operator", async () => {
    expect(await probe()).toBe(401);
    const events = await world.pool.query<{
      operator_id: string | null;
      coarse_ip: string | null;
      detail: Record<string, unknown>;
    }>(
      "select operator_id, coarse_ip, detail from security_events where kind = 'sign_in_failed' and operator_id is null",
    );
    expect(events.rows.length).toBe(1);
    expect(events.rows[0].coarse_ip).toBeTypeOf("string");
    expect(events.rows[0].detail).toMatchObject({ reason: "unknown_account" });
  });

  it("throttles the address after the twentieth unknown-account failure", async () => {
    // One failure is already audited above.
    for (let attempt = 1; attempt < PER_IP_MAX_FAILURES; attempt += 1) {
      expect(await probe()).toBe(401);
    }
    const throttled = await world.app.inject({
      method: "POST",
      url: "/api/auth/sign-in",
      headers: {
        "content-type": "application/json",
        ...(await anonCsrf(world.app)),
      },
      payload: { email: "still-unknown@example.test", password: "whatever-long-enough" },
    });
    expect(throttled.statusCode).toBe(429);
    expect(throttled.json().code).toBe("rate_limited");
    expect(throttled.json().retryAfterSeconds).toBe(60);

    // The refusal itself is audited, with the address it throttled.
    const events = await world.pool.query(
      "select count(*)::int as n from security_events where kind = 'ip_throttled'",
    );
    expect(events.rows[0].n).toBeGreaterThanOrEqual(1);
  });
});
