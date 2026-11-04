import { unprocessable } from "./errors.js";

const PLAIN_TIME = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;

/** Normalize an `HH:MM` or `HH:MM:SS` request value to the contract's time. */
export function normalizePlainTime(value: unknown, path: string): string {
  const text = String(value ?? "").trim();
  const match = PLAIN_TIME.exec(text);
  if (!match) {
    throw unprocessable([
      { path, message: "must be a time in HH:MM or HH:MM:SS form" },
    ]);
  }
  return `${match[1]}:${match[2]}:${match[3] ?? "00"}`;
}
