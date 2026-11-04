import { ApiError } from "../../errors.js";

/**
 * Helpers the catalogue's modules share: plain-time parsing for the two
 * time-of-day columns (a group's scan time, a profile's composition
 * window), and the PostgreSQL unique-violation test the duplicate races
 * settle by.
 */

/**
 * A plainTime as "HH:MM" (input) parsed to "HH:MM:SS" for a time column.
 * The path names the offending field in the validation error.
 */
export function parsePlainTime(value: string, path: string): string {
  const match = /^(\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})?$/.exec(value);
  if (match === null) {
    throw new ApiError(400, "validation_failed", {
      fieldErrors: [{ path, message: "not a time of day" }],
    });
  }
  const [, hours, minutes, seconds = "00"] = match;
  return `${hours}:${minutes}:${seconds}`;
}

/** True when a PostgreSQL error is the 23505 unique-violation refusal. */
export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "23505"
  );
}
