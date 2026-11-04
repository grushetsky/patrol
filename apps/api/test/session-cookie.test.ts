import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  RECOVERY_CODE_COUNT,
  generateRecoveryCodes,
  hashRecoveryCode,
  normalizeRecoveryCode,
} from "../src/domain/recovery.js";
import {
  ABSOLUTE_SESSION_MS,
  IDLE_SESSION_MS,
  newOpaqueToken,
  newSessionToken,
  sessionCookie,
  sessionExpiry,
  sha256Hex,
} from "../src/domain/session.js";
import { loadConfig } from "../src/config.js";

/**
 * Pure identity mechanics: session-token shape and hashing, the cookie string
 * the API sets (the prod default carries the `__Host-` prefix and `Secure`),
 * recovery-code generation and normalization, and hashing at rest.
 */
const TEST_TOKEN =
  "abcdefghijklmnopqrstuvwxyz012345abcdefghijklmnopqrstuvwxyz012345";

describe("session tokens", () => {
  it("mints 256-bit tokens with no structure to leak", () => {
    const tokens = new Set(Array.from({ length: 64 }, () => newSessionToken()));
    expect(tokens.size).toBe(64);
    for (const token of tokens) {
      expect(Buffer.from(token, "base64url").length).toBe(32);
    }
  });

  it("stores only the SHA-256 of a token", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(sha256Hex(TEST_TOKEN)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("applies an eight-hour idle and seven-day absolute lifetime", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const expiry = sessionExpiry(now);
    expect(expiry.idleExpiresAt.getTime() - now.getTime()).toBe(IDLE_SESSION_MS);
    expect(expiry.idleExpiresAt.toISOString()).toBe("2026-01-01T08:00:00.000Z");
    expect(expiry.absoluteExpiresAt.toISOString()).toBe("2026-01-08T00:00:00.000Z");
    expect(ABSOLUTE_SESSION_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(IDLE_SESSION_MS).toBe(8 * 60 * 60 * 1000);
  });

  it("sets the production cookie as __Host-patrol_session with Secure, HttpOnly, SameSite=Lax, Path=/", () => {
    const production = loadConfig({
      DATABASE_URL: "postgres://x",
      PATROL_ENV: "production",
      PATROL_RECOVERY_PEPPER: "test-only pepper",
    });
    const cookie = sessionCookie(production, TEST_TOKEN);
    expect(cookie.startsWith("__Host-patrol_session=")).toBe(true);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
  });

  it("drops the __Host- prefix and the Secure flag outside production", () => {
    const dev = loadConfig({ DATABASE_URL: "postgres://x", PATROL_ENV: "dev" });
    const cookie = sessionCookie(dev, TEST_TOKEN);
    expect(cookie.startsWith("patrol_session=")).toBe(true);
    expect(cookie).not.toContain("Secure");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
  });

  it("mints generic 256-bit opaque tokens for ceremonies", () => {
    const token = newOpaqueToken();
    expect(Buffer.from(token, "base64url").length).toBe(32);
  });
});

describe("recovery codes", () => {
  it("generates ten single-use codes from a 31-character alphabet", () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(RECOVERY_CODE_COUNT);
    expect(RECOVERY_CODE_COUNT).toBe(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) {
      expect(code).toMatch(/^[2-9A-HJ-NP-Z]{5}-[2-9A-HJ-NP-Z]{5}$/);
    }
  });

  it("normalizes case and spacing before hashing", () => {
    expect(normalizeRecoveryCode(" abCde-FGhij ")).toBe("ABCDE-FGHIJ");
  });

  it("hashes deterministically under the pepper, never storing the code", () => {
    const digest = hashRecoveryCode("ABCDE-FGHIJ", "pepper");
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(digest).toBe(hashRecoveryCode("abcde-fghij", "pepper"));
    expect(digest).not.toBe(hashRecoveryCode("ABCDE-FGHIK", "pepper"));
    expect(digest).not.toBe(hashRecoveryCode("ABCDE-FGHIJ", "other-pepper"));
    // The digest equals sha256(pepper + normalized code) — peppered, not salted
    // per code, so a leaked digest cannot be cracked offline without the env.
    expect(digest).toBe(
      createHash("sha256").update("pepper" + "ABCDE-FGHIJ").digest("hex"),
    );
  });
});
