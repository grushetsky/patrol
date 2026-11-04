import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

/**
 * The recovery pepper's environment rule: production boots only with
 * PATROL_RECOVERY_PEPPER set — recovery-code hashes must derive from a
 * deployment secret — while every other environment falls back to the
 * development default so a local database starts.
 */
describe("recovery pepper configuration", () => {
  it("refuses to boot in production without PATROL_RECOVERY_PEPPER", () => {
    expect(() =>
      loadConfig({
        DATABASE_URL: "postgres://x",
        PATROL_ENV: "production",
      }),
    ).toThrow(/PATROL_RECOVERY_PEPPER/);
  });

  it("boots in production with the pepper set", () => {
    const config = loadConfig({
      DATABASE_URL: "postgres://x",
      PATROL_ENV: "production",
      PATROL_RECOVERY_PEPPER: "a real deployment secret",
    });
    expect(config.recoveryPepper).toBe("a real deployment secret");
    expect(config.env).toBe("production");
  });

  it("keeps the development default outside production", () => {
    const config = loadConfig({
      DATABASE_URL: "postgres://x",
      PATROL_ENV: "dev",
    });
    expect(config.recoveryPepper).toBe("patrol-development-recovery-pepper");
  });
});
