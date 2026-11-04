import { describe, expect, it } from "vitest";
import {
  hashPassword,
  passwordIssues,
  verifyPassword,
} from "../src/auth/passwords.js";
import {
  generateRecoveryCodes,
  hashRecoveryCode,
} from "../src/auth/recovery.js";
import { randomToken, sha256Hex } from "../src/auth/tokens.js";
import { createTotp, totpCode, verifyTotp } from "../src/auth/totp.js";

describe("passwords", () => {
  it("hashes with Argon2id and verifies the original", async () => {
    const hash = await hashPassword("correct horse battery");

    expect(hash.startsWith("$argon2id$")).toBe(true);
    expect(await verifyPassword(hash, "correct horse battery")).toBe(true);
    expect(await verifyPassword(hash, "wrong horse battery")).toBe(false);
  });

  it("requires at least twelve characters", () => {
    expect(passwordIssues("short")).not.toHaveLength(0);
    expect(passwordIssues("twelve chars")).toEqual([]);
    expect(passwordIssues("passwordpassword")).not.toHaveLength(0);
  });

  it("rejects a missing hash", async () => {
    expect(await verifyPassword(null, "correct horse battery")).toBe(false);
  });
});

describe("totp", () => {
  it("generates a secret and accepts its current code", () => {
    const enrollment = createTotp("operator@example.test");
    const code = totpCode(enrollment.secret);

    expect(enrollment.uri.startsWith("otpauth://totp/")).toBe(true);
    expect(verifyTotp(enrollment.secret, code)).toBe(true);
    expect(verifyTotp(enrollment.secret, "000000")).toBe(false);
  });
});

describe("recovery codes", () => {
  it("generates ten unique codes and hashes them stably", () => {
    const codes = generateRecoveryCodes();

    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    expect(hashRecoveryCode(codes[0])).toBe(hashRecoveryCode(codes[0]));
    expect(hashRecoveryCode(codes[0])).not.toBe(hashRecoveryCode(codes[1]));
  });
});

describe("tokens", () => {
  it("generates random tokens and stable SHA-256 hashes", () => {
    const token = randomToken();

    expect(token.length).toBeGreaterThan(20);
    expect(sha256Hex(token)).toMatch(/^[a-f0-9]{64}$/);
    expect(sha256Hex(token)).toBe(sha256Hex(token));
  });
});
