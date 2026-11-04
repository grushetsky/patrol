import { createHash } from "node:crypto";
import { randomInt } from "node:crypto";

/**
 * Recovery codes (implementation-rules "Recovery codes"): ten single-use
 * codes issued at enrolment, stored only as hashes, shown once; a used code
 * is marked and re-enrolment replaces every earlier code.
 *
 * Hashing is SHA-256 with a server-side pepper rather than Argon2: a recovery
 * code is a high-entropy random value (about 50 bits over a 31-character
 * alphabet), not a human password, so offline brute force is already
 * infeasible and a fast peppered digest keeps second-factor latency flat
 * without the 64 MiB cost of an Argon2 run per attempt.
 */

export const RECOVERY_CODE_COUNT = 10;

/** No 0/O/1/I/L: the codes are read aloud and retyped by humans. */
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

function randomCodeGroup(length: number): string {
  let group = "";
  for (let index = 0; index < length; index += 1) {
    group += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return group;
}

/** Ten fresh codes, `xxxxx-xxxxx`. */
export function generateRecoveryCodes(): string[] {
  return Array.from({ length: RECOVERY_CODE_COUNT }, () =>
    `${randomCodeGroup(5)}-${randomCodeGroup(5)}`,
  );
}

/** Uppercases and trims a presented code before hashing. */
export function normalizeRecoveryCode(code: string): string {
  return code.trim().toUpperCase();
}

/** The at-rest digest: sha256(pepper + normalized code). */
export function hashRecoveryCode(code: string, pepper: string): string {
  return createHash("sha256")
    .update(pepper + normalizeRecoveryCode(code))
    .digest("hex");
}
