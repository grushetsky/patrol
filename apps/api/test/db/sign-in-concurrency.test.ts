import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MAX_FAILED_ATTEMPTS } from "../../src/domain/lockout.js";
import {
  anonCsrf,
  ceremonyApp,
  signedInAdministrator,
  type CeremonyApp,
} from "./ceremony.js";

/**
 * The failure counter under concurrency: ten simultaneous wrong passwords
 * each land their increment (the SQL-side `failed_attempts + 1`), so the
 * account locks instead of racing ten stale reads down to one increment.
 */
describe("concurrent wrong passwords lock the account", () => {
  let world: CeremonyApp;
  const email = "admin@example.test";

  beforeAll(async () => {
    world = await ceremonyApp();
    await signedInAdministrator(world, email);
  });

  afterAll(async () => {
    await world.app.close();
    await world.pool.end();
  });

  it("counts every parallel attempt and locks at the threshold", async () => {
    const csrf = await anonCsrf(world.app);
    const attempts = await Promise.all(
      Array.from({ length: MAX_FAILED_ATTEMPTS }, () =>
        world.app.inject({
          method: "POST",
          url: "/api/auth/sign-in",
          headers: { "content-type": "application/json", ...csrf },
          payload: { email, password: "not the password at all" },
        }),
      ),
    );
    const statuses = attempts.map((attempt) => attempt.statusCode);
    // Every attempt is accounted for: nine 401s and the tenth that locks,
    // in whatever order the increments landed.
    expect(statuses.filter((status) => status === 401)).toHaveLength(
      MAX_FAILED_ATTEMPTS - 1,
    );
    expect(statuses.filter((status) => status === 429)).toHaveLength(1);

    const row = await world.pool.query<{ failed_attempts: number; locked_until: Date | null }>(
      "select failed_attempts, locked_until from operators where email = $1",
      [email],
    );
    expect(row.rows[0].failed_attempts).toBe(MAX_FAILED_ATTEMPTS);
    expect(row.rows[0].locked_until).not.toBeNull();

    // Exactly one lock was audited.
    const events = await world.pool.query(
      "select count(*)::int as n from security_events where kind = 'account_locked'",
    );
    expect(events.rows[0].n).toBe(1);
  });
});
