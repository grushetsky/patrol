import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCli } from "../../src/cli/index.js";
import { testConfig } from "../test-app.js";
import { ceremonyApp, type CeremonyApp } from "./ceremony.js";

/**
 * The singleton guarantee on the rights holder: two bootstrap commands
 * racing one empty database produce exactly one rights holder and exactly
 * one setup token. The pre-check alone could not promise this — the unique
 * index on rights_holder (singleton) is what does.
 */
describe("concurrent bootstrap", () => {
  let world: CeremonyApp;

  beforeAll(async () => {
    world = await ceremonyApp();
  });

  afterAll(async () => {
    await world.app.close();
    await world.pool.end();
  });

  function cli(adminEmail: string): Promise<{ code: number; refused: boolean }> {
    return runCli(
      ["bootstrap", "--legal-name", "Example Rights GmbH", "--country", "DE", "--admin-email", adminEmail],
      {
        pool: world.pool,
        config: testConfig({ now: world.clock.now }),
        stdout: () => undefined,
        stderr: () => undefined,
      },
    ).then((code) => ({
      code,
      refused: code !== 0,
    }));
  }

  it("lets exactly one of two parallel bootstraps win", async () => {
    const results = await Promise.all([
      cli("first@example.test"),
      cli("second@example.test"),
    ]);
    expect(results.filter((result) => result.refused)).toHaveLength(1);

    const holders = await world.pool.query<{ legal_name: string }>(
      "select legal_name from rights_holder",
    );
    expect(holders.rows).toEqual([{ legal_name: "Example Rights GmbH" }]);

    const invitations = await world.pool.query<{ email: string }>(
      "select email from invitations",
    );
    // The winner's invitation only; the loser minted nothing. Which of the
    // two won is the race's choice, not the test's.
    expect(invitations.rows).toHaveLength(1);
    expect(["first@example.test", "second@example.test"]).toContain(
      invitations.rows[0].email,
    );
  });
});
