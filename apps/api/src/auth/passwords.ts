import { Algorithm, hash, verify } from "@node-rs/argon2";

export const MIN_PASSWORD_LENGTH = 12;

// The bundled list is intentionally small here; the build replaces it with the
// deployment's breached-password list.
const BREACHED_PASSWORDS = new Set([
  "passwordpassword",
  "123456789012",
  "qwertyuiopas",
  "letmein12345",
]);

const OPTIONS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 1,
};

/** Return the policy failures for a candidate password. */
export function passwordIssues(password: string): string[] {
  const issues: string[] = [];
  if (password.length < MIN_PASSWORD_LENGTH) {
    issues.push(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  if (BREACHED_PASSWORDS.has(password.trim().toLowerCase())) {
    issues.push("Password appears in the breached-password list.");
  }
  return issues;
}

export async function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

export async function verifyPassword(
  hashed: string | null | undefined,
  password: string,
): Promise<boolean> {
  if (!hashed) {
    return false;
  }
  try {
    return await verify(hashed, password, OPTIONS);
  } catch {
    return false;
  }
}
