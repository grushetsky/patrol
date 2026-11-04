import { randomBytes } from "node:crypto";
import { Secret, TOTP } from "otpauth";

/**
 * TOTP second factor (RFC 6238): SHA-1, six digits, a 30-second step, and
 * one step of drift. The enrollment secret is 20 random bytes, base32; the
 * otpauth URI is what an authenticator app scans.
 *
 * The public generate/verify pair speaks base32 only — every stored and
 * transmitted secret in Patrol is base32. The `...SecretBytes` pair is the
 * explicit seam for the RFC 6238 test vectors, whose shared secret is the
 * raw ASCII bytes of "12345678901234567890" and not a base32 string.
 */

export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** One step of drift is accepted on either side of the current step. */
export const TOTP_DRIFT_STEPS = 1;

export interface TotpCodeOptions {
  /** Digit count; Patrol's second factor is six, the RFC vectors are eight. */
  digits?: number;
}

function totpFromSecretBytes(
  secretBytes: Uint8Array,
  digits: number,
): TOTP {
  return new TOTP({
    algorithm: "SHA1",
    digits,
    period: TOTP_PERIOD_SECONDS,
    secret: new Secret(secretBytes),
  });
}

/** The six-digit code an authenticator shows at `at` for a base32 secret. */
export function generateTotpCode(
  secretBase32: string,
  at: Date,
  options: TotpCodeOptions = {},
): string {
  return generateTotpCodeWithSecretBytes(
    Secret.fromBase32(secretBase32).bytes,
    at,
    options,
  );
}

/** Verifies a presented code against a base32 secret, with drift. */
export function verifyTotpCode(
  secretBase32: string,
  code: string,
  at: Date,
  options: TotpCodeOptions = {},
): boolean {
  return verifyTotpCodeWithSecretBytes(
    Secret.fromBase32(secretBase32).bytes,
    code,
    at,
    options,
  );
}

/** Test-only seam: generate from raw secret bytes (RFC vectors). */
export function generateTotpCodeWithSecretBytes(
  secretBytes: Uint8Array,
  at: Date,
  options: TotpCodeOptions = {},
): string {
  return totpFromSecretBytes(secretBytes, options.digits ?? TOTP_DIGITS).generate(
    { timestamp: at.getTime() },
  );
}

/** Test-only seam: verify against raw secret bytes (RFC vectors). */
export function verifyTotpCodeWithSecretBytes(
  secretBytes: Uint8Array,
  code: string,
  at: Date,
  options: TotpCodeOptions = {},
): boolean {
  if (!/^\d+$/.test(code)) {
    return false;
  }
  const matched = totpFromSecretBytes(
    secretBytes,
    options.digits ?? TOTP_DIGITS,
  ).validate({
    token: code,
    timestamp: at.getTime(),
    window: TOTP_DRIFT_STEPS,
  });
  return matched !== null;
}

/** A fresh enrollment secret: 20 random bytes, base32 without padding. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** The otpauth URI an authenticator app scans for one operator's account. */
export function otpauthUri(secret: string, accountEmail: string): string {
  return new TOTP({
    issuer: "Patrol",
    label: accountEmail,
    algorithm: "SHA1",
    digits: TOTP_DIGITS,
    period: TOTP_PERIOD_SECONDS,
    secret: Secret.fromBase32(secret),
  }).toString();
}

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 base32, unpadded — the encoding every authenticator accepts. */
export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}
