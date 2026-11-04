import { createHash, randomBytes } from "node:crypto";
import { v7 as uuidv7 } from "uuid";

export function newId(): string {
  return uuidv7();
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
