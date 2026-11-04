import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import argon2, { type Algorithm } from "@node-rs/argon2";

/**
 * Password hashing and policy (implementation-rules "Identity and access"):
 * Argon2id at 64 MiB, three iterations, one lane, per-user salt; at least
 * twelve characters checked against the bundled breached-password list, with
 * no composition rules and no forced rotation.
 */

/** The parameters every new hash carries (Authentication design table). */
export const ARGON2_PARAMETERS = {
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 1,
} as const;

const ARGON2ID: Algorithm = argon2.Algorithm.Argon2id;

/** Hashes a password with a fresh per-user salt at the target parameters. */
export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { ...ARGON2_PARAMETERS, algorithm: ARGON2ID });
}

/** Verifies a candidate password against a stored PHC string. */
export function verifyPassword(
  storedHash: string,
  password: string,
): Promise<boolean> {
  return argon2.verify(storedHash, password);
}

/**
 * True when a stored hash was produced with an algorithm or parameters
 * other than the current target, so a successful sign-in should rehash
 * before storing. The variant is part of the target: an argon2i or argon2d
 * row rehashes into argon2id even at matching m/t/p.
 */
export function needsRehash(storedHash: string): boolean {
  const parsed = parseParameters(storedHash);
  if (parsed === null) {
    return true;
  }
  return (
    parsed.variant !== "argon2id" ||
    parsed.m !== ARGON2_PARAMETERS.memoryCost ||
    parsed.t !== ARGON2_PARAMETERS.timeCost ||
    parsed.p !== ARGON2_PARAMETERS.parallelism
  );
}

interface PhcParameters {
  variant: string;
  m: number;
  t: number;
  p: number;
}

/** Parses the variant and m/t/p parameters out of a PHC-format hash string. */
function parseParameters(storedHash: string): PhcParameters | null {
  const match = /^\$(argon2id|argon2i|argon2d)\$v=\d+\$([^$]+)\$/.exec(
    storedHash,
  );
  if (!match) {
    return null;
  }
  const parameters: Partial<PhcParameters> = { variant: match[1] };
  for (const part of match[2].split(",")) {
    const [key, value] = part.split("=");
    if (key === undefined || value === undefined) {
      continue;
    }
    const parsed = Number.parseInt(value, 10);
    if (key === "m" || key === "t" || key === "p") {
      parameters[key] = parsed;
    }
  }
  if (
    parameters.m === undefined ||
    parameters.t === undefined ||
    parameters.p === undefined
  ) {
    return null;
  }
  return parameters as PhcParameters;
}

/** The minimum password length; no composition rules accompany it. */
export const PASSWORD_MIN_LENGTH = 12;

export type BreachedPasswordList = ReadonlySet<string>;

/**
 * Loads the bundled breached-password list at boot. The file ships one
 * password per line (SecLists 10k-most-common); entries are lowercased and
 * trimmed, and the comparison normalizes the candidate the same way.
 */
export function loadBreachedPasswords(path: string): BreachedPasswordList {
  const entries = new Set<string>();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const normalized = line.trim().toLowerCase();
    if (normalized.length > 0) {
      entries.add(normalized);
    }
  }
  return entries;
}

/** The default location of the bundled list, relative to this module. */
export function defaultBreachedPasswordsPath(): string {
  return new URL("../../data/breached-passwords.txt", import.meta.url).pathname;
}

export type PasswordPolicyResult =
  | { ok: true }
  | { ok: false; reason: "too_short" | "breached" };

/**
 * Applies the password policy: at least twelve characters, not present in
 * the breached list, nothing else. The caller maps `reason` onto a localized
 * field error; the schema's `minLength(12)` also rejects short bodies before
 * this guard runs.
 */
export function checkPasswordPolicy(
  password: string,
  breached: BreachedPasswordList,
): PasswordPolicyResult {
  if (password.length < PASSWORD_MIN_LENGTH) {
    return { ok: false, reason: "too_short" };
  }
  if (breached.has(password.trim().toLowerCase())) {
    return { ok: false, reason: "breached" };
  }
  return { ok: true };
}

/** Fresh random bytes, base64url — the shared helper for token material. */
export function randomTokenUrlSafe(byteLength = 32): string {
  return randomBytes(byteLength).toString("base64url");
}
