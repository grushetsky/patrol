import { createHash, randomBytes } from "node:crypto";

/** Generate single-use recovery codes in a fixed, human-readable shape. */
export function generateRecoveryCodes(count = 10): string[] {
  return Array.from({ length: count }, () => {
    const hex = randomBytes(5).toString("hex").toUpperCase();
    return `${hex.slice(0, 5)}-${hex.slice(5)}`;
  });
}

export function hashRecoveryCode(code: string): string {
  return createHash("sha256")
    .update(code.trim().toUpperCase())
    .digest("hex");
}
