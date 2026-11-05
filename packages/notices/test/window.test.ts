import { describe, expect, it } from "vitest";
import {
  lastWindowOccurrence,
  previousWindowOccurrence,
} from "../src/window.js";

/**
 * Seam 7's cut-off arithmetic (the pure half): a profile's window is a
 * CUT-OFF, not a rolling queue — the most recent window occurrence at or
 * before the run time is the one that composes, and a violation confirmed
 * while the window stands open waits for the next one. All arithmetic is
 * UTC; a window time is a wall-clock HH:MM:SS on a UTC day.
 */

const utc = (iso: string): Date => new Date(`${iso}Z`);

describe("the most recent window occurrence", () => {
  it("is today's window when the window time has passed", () => {
    expect(lastWindowOccurrence("07:00:00", utc("2026-01-02T08:00:00")).toISOString()).toBe(
      "2026-01-02T07:00:00.000Z",
    );
  });

  it("is yesterday's window when today's has not opened yet", () => {
    expect(lastWindowOccurrence("07:00:00", utc("2026-01-02T06:59:59")).toISOString()).toBe(
      "2026-01-01T07:00:00.000Z",
    );
  });

  it("treats the exact window instant as passed (a cut-off is inclusive)", () => {
    expect(lastWindowOccurrence("07:00:00", utc("2026-01-02T07:00:00")).toISOString()).toBe(
      "2026-01-02T07:00:00.000Z",
    );
  });

  it("respects a per-profile window time that is not the default", () => {
    expect(lastWindowOccurrence("23:30:00", utc("2026-01-02T23:45:00")).toISOString()).toBe(
      "2026-01-02T23:30:00.000Z",
    );
    // The same run, for a profile whose window is later, resolves to the
    // previous day's occurrence — the per-profile window is respected.
    expect(lastWindowOccurrence("23:45:30", utc("2026-01-02T23:45:00")).toISOString()).toBe(
      "2026-01-01T23:45:30.000Z",
    );
  });

  it("crosses month and year boundaries", () => {
    expect(lastWindowOccurrence("07:00:00", utc("2026-01-01T00:30:00")).toISOString()).toBe(
      "2025-12-31T07:00:00.000Z",
    );
  });
});

describe("the previous occurrence", () => {
  it("is one day before the given occurrence", () => {
    expect(previousWindowOccurrence("07:00:00", utc("2026-01-02T07:00:00")).toISOString()).toBe(
      "2026-01-01T07:00:00.000Z",
    );
  });

  it("keeps the profile's own window time across the day step", () => {
    expect(previousWindowOccurrence("23:30:00", utc("2026-03-01T23:30:00")).toISOString()).toBe(
      "2026-02-28T23:30:00.000Z",
    );
  });
});

describe("the composition interval (cut-off, not rolling)", () => {
  it("composes violations confirmed after the previous window and at or before this one", () => {
    const previous = previousWindowOccurrence("07:00:00", utc("2026-01-02T07:00:00"));
    const window = lastWindowOccurrence("07:00:00", utc("2026-01-02T08:00:00"));
    // A violation confirmed while the window stood open — after the
    // cut-off — is NOT in this interval; it waits for the next window.
    const confirmedAfterWindow = utc("2026-01-02T07:30:00");
    const confirmedAtWindow = utc("2026-01-02T07:00:00");
    const confirmedInside = utc("2026-01-02T06:00:00");
    const inInterval = (at: Date): boolean =>
      at.getTime() > previous.getTime() && at.getTime() <= window.getTime();
    expect(inInterval(confirmedInside)).toBe(true);
    expect(inInterval(confirmedAtWindow)).toBe(true);
    expect(inInterval(confirmedAfterWindow)).toBe(false);
    // The previous window's own instant is excluded (half-open interval).
    expect(inInterval(previous)).toBe(false);
  });
});
