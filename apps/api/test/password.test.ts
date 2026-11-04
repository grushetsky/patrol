import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import {
  ARGON2_PARAMETERS,
  checkPasswordPolicy,
  hashPassword,
  loadBreachedPasswords,
  needsRehash,
  verifyPassword,
} from "../src/domain/password.js";

/**
 * Frozen Argon2id reference vectors, generated once outside this suite with
 * the target parameters (m=65536 KiB, t=3, p=1) and a fixed salt, over the
 * passphrase "correct horse battery staple". They pin both the parameter set
 * and the verify path: any drift in parameters or the PHC string format fails
 * these expectations instead of silently re-hashing.
 */
const REFERENCE_HASH_TARGET_PARAMS =
  "$argon2id$v=19$m=65536,t=3,p=1$MDEyMzQ1Njc4OWFiY2RlZg$lMhvVBq9s9mqv+pZqgOWNUlIPpwLGnkzbna1TO5skX4";
const REFERENCE_HASH_LEGACY_MEMORY =
  "$argon2id$v=19$m=32768,t=3,p=1$ZmVkY2JhOTg3NjU0MzIxMA$OwvzxXezqsouOKWMylSvhzXRMgOLX+UbLECRCeCpXrU";
const REFERENCE_HASH_LEGACY_VARIANT =
  "$argon2i$v=19$m=65536,t=3,p=1$MDEyMzQ1Njc4OWFiY2RlZg$OwvzxXezqsouOKWMylSvhzXRMgOLX+UbLECRCeCpXrU";

const require = createRequire(import.meta.url);
const breachedPath = require.resolve("../data/breached-passwords.txt");

describe("Argon2id password hashing", () => {
  it("declares the design's parameters: 64 MiB, three iterations, one lane", () => {
    expect(ARGON2_PARAMETERS).toEqual({
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 1,
    });
  });

  it("verifies the frozen vector hashed at the target parameters", async () => {
    expect(
      await verifyPassword(REFERENCE_HASH_TARGET_PARAMS, "correct horse battery staple"),
    ).toBe(true);
  });

  it("refuses a wrong password against the frozen vector", async () => {
    expect(
      await verifyPassword(REFERENCE_HASH_TARGET_PARAMS, "Tr0ub4dor&3"),
    ).toBe(false);
  });

  it("hashes with per-user salts and encodes the target parameters", async () => {
    const first = await hashPassword("correct horse battery staple");
    const second = await hashPassword("correct horse battery staple");
    expect(first).not.toBe(second);
    expect(first).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=1\$/);
    expect(await verifyPassword(first, "correct horse battery staple")).toBe(true);
    expect(await verifyPassword(first, "something else")).toBe(false);
  });

  it("flags a hash whose parameters or variant drift from the target for rehash", () => {
    expect(needsRehash(REFERENCE_HASH_TARGET_PARAMS)).toBe(false);
    expect(needsRehash(REFERENCE_HASH_LEGACY_MEMORY)).toBe(true);
    // Matching m/t/p is not enough: argon2i rehashes into argon2id.
    expect(needsRehash(REFERENCE_HASH_LEGACY_VARIANT)).toBe(true);
  });
});

describe("password policy", () => {
  const breached = loadBreachedPasswords(breachedPath);

  it("loads the bundled breached-password list at boot", () => {
    expect(breached.size).toBeGreaterThan(9_000);
    // "unbelievable" is a 13-character entry in the bundled top-10k list.
    expect(breached.has("unbelievable")).toBe(true);
  });

  it("requires at least twelve characters, with no composition rules", () => {
    expect(checkPasswordPolicy("short", breached)).toEqual({
      ok: false,
      reason: "too_short",
    });
    expect(checkPasswordPolicy("a".repeat(11), breached)).toEqual({
      ok: false,
      reason: "too_short",
    });
    // No composition rules: no digit, no uppercase, no symbol required.
    expect(checkPasswordPolicy("plain passphrase words", breached)).toEqual({
      ok: true,
    });
    expect(checkPasswordPolicy("          12", breached)).toEqual({ ok: true });
  });

  it("refuses a password that appears in the breached list", () => {
    expect(checkPasswordPolicy("unbelievable", breached)).toEqual({
      ok: false,
      reason: "breached",
    });
    // The comparison is case-insensitive and ignores surrounding whitespace.
    expect(checkPasswordPolicy("  UNBELIEVABLE ", breached)).toEqual({
      ok: false,
      reason: "breached",
    });
  });

  it("accepts a long password absent from the list", () => {
    expect(
      checkPasswordPolicy("solitude-over-the-lake-at-dawn", breached),
    ).toEqual({ ok: true });
  });
});
