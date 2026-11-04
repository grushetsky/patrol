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
      PATROL_CONTACT_EMAIL: "ops@example.test",
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

/**
 * The Wikidata contact address's environment rule, cut to the pepper's
 * pattern: the design requires a contactable User-Agent, so production
 * boots only with PATROL_CONTACT_EMAIL set, while every other environment
 * warns and names its unconfigured state in the agent string.
 */
describe("wikidata contact configuration", () => {
  it("refuses to boot in production without PATROL_CONTACT_EMAIL", () => {
    expect(() =>
      loadConfig({
        DATABASE_URL: "postgres://x",
        PATROL_ENV: "production",
        PATROL_RECOVERY_PEPPER: "a real deployment secret",
      }),
    ).toThrow(/PATROL_CONTACT_EMAIL/);
  });

  it("carries the address in the User-Agent and states its absence otherwise", () => {
    const configured = loadConfig({
      DATABASE_URL: "postgres://x",
      PATROL_CONTACT_EMAIL: "ops@example.test",
    });
    expect(configured.wikidataUserAgent).toContain("contact: ops@example.test");
    const unconfigured = loadConfig({ DATABASE_URL: "postgres://x" });
    expect(unconfigured.wikidataUserAgent).toContain("contact unset");
  });
});
