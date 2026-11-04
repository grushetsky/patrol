import { describe, expect, it } from "vitest";
import {
  TOTP_DRIFT_STEPS,
  TOTP_PERIOD_SECONDS,
  generateTotpCode,
  generateTotpSecret,
  generateTotpCodeWithSecretBytes,
  verifyTotpCode,
  verifyTotpCodeWithSecretBytes,
} from "../src/domain/totp.js";

/**
 * RFC 6238 Appendix B test vectors, SHA-1, 30-second step, the shared secret
 * ASCII "12345678901234567890". The expected codes are copied from the RFC
 * and are never recomputed by the code under test. The RFC publishes
 * eight-digit truncation; Patrol's second factor is six digits, so the
 * six-digit expectations are the RFC's values with the leading two digits
 * dropped, as RFC 4226's truncation defines. The RFC seed is the raw ASCII
 * bytes of the secret — not a base32 string — so the vectors go through the
 * explicit WithSecretBytes seam the module exposes for exactly this.
 */
const RFC_SECRET_BYTES = new TextEncoder().encode("12345678901234567890");

const RFC_VECTORS: ReadonlyArray<{
  unixSeconds: number;
  eightDigits: string;
  sixDigits: string;
}> = [
  { unixSeconds: 59, eightDigits: "94287082", sixDigits: "287082" },
  { unixSeconds: 1111111109, eightDigits: "07081804", sixDigits: "081804" },
  { unixSeconds: 1111111111, eightDigits: "14050471", sixDigits: "050471" },
  { unixSeconds: 1234567890, eightDigits: "89005924", sixDigits: "005924" },
  { unixSeconds: 2000000000, eightDigits: "69279037", sixDigits: "279037" },
  { unixSeconds: 20000000000, eightDigits: "65353130", sixDigits: "353130" },
];

describe("TOTP (RFC 6238, SHA-1, 30-second step)", () => {
  it("reproduces every RFC 6238 Appendix B vector at eight digits", () => {
    for (const vector of RFC_VECTORS) {
      expect(
        generateTotpCodeWithSecretBytes(RFC_SECRET_BYTES, new Date(vector.unixSeconds * 1000), {
          digits: 8,
        }),
      ).toBe(vector.eightDigits);
    }
  });

  it("verifies the RFC vectors at the production six-digit truncation", () => {
    for (const vector of RFC_VECTORS) {
      expect(
        verifyTotpCodeWithSecretBytes(RFC_SECRET_BYTES, vector.sixDigits, new Date(vector.unixSeconds * 1000), {
          digits: 6,
        }),
      ).toBe(true);
    }
  });

  it("accepts exactly one step of drift and rejects two", () => {
    const step = TOTP_PERIOD_SECONDS;
    const boundary = 60_000; // an exact step boundary
    const atBoundary = generateTotpCodeWithSecretBytes(RFC_SECRET_BYTES, new Date(boundary * 1000));

    // The same step and both neighbouring steps verify.
    expect(verifyTotpCodeWithSecretBytes(RFC_SECRET_BYTES, atBoundary, new Date(boundary * 1000))).toBe(true);
    expect(
      verifyTotpCodeWithSecretBytes(RFC_SECRET_BYTES, atBoundary, new Date((boundary + step) * 1000)),
    ).toBe(true);
    expect(
      verifyTotpCodeWithSecretBytes(RFC_SECRET_BYTES, atBoundary, new Date((boundary - step) * 1000)),
    ).toBe(true);

    // Two steps away in either direction is refused.
    expect(
      verifyTotpCodeWithSecretBytes(RFC_SECRET_BYTES, atBoundary, new Date((boundary + 2 * step) * 1000)),
    ).toBe(false);
    expect(
      verifyTotpCodeWithSecretBytes(RFC_SECRET_BYTES, atBoundary, new Date((boundary - 2 * step) * 1000)),
    ).toBe(false);
  });

  it("generates and verifies base32 secrets on the production path", () => {
    // Production secrets are always base32; generate and verify round-trip
    // without any encoding guesswork.
    const secret = generateTotpSecret();
    const at = new Date(60_000);
    const code = generateTotpCode(secret, at);
    expect(verifyTotpCode(secret, code, at)).toBe(true);
    // One flipped digit no longer verifies.
    const flipped = ((Number(code) + 1) % 1_000_000).toString().padStart(6, "0");
    expect(verifyTotpCode(secret, flipped, at)).toBe(false);
  });

  it("declares the one-step drift it allows", () => {
    expect(TOTP_DRIFT_STEPS).toBe(1);
    expect(TOTP_PERIOD_SECONDS).toBe(30);
  });

  it("generates distinct, non-empty, base32 enrollment secrets", () => {
    const secrets = new Set(
      Array.from({ length: 32 }, () => generateTotpSecret()),
    );
    expect(secrets.size).toBe(32);
    for (const secret of secrets) {
      expect(secret.length).toBeGreaterThanOrEqual(32);
      expect(secret).toMatch(/^[A-Z2-7]+=*$/);
    }
  });
});
