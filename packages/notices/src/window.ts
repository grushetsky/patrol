/**
 * The composition window arithmetic (docs/design/notice-composition.md
 * "Composition triggers and windows"): every scheduled profile carries a
 * daily window, default 07:00 UTC and configurable, that composes drafts
 * for violations confirmed since the profile's previous window. A window
 * is a CUT-OFF, not a rolling queue — a violation confirmed while the
 * window stands open waits for the next one — so the interval is the
 * half-open `(previous window, this window]` over the profile's own
 * wall-clock time, in UTC.
 */

/** Parses an HH:MM:SS window time into UTC minutes-and-seconds of day. */
function parseWindowTime(windowTime: string): { hours: number; minutes: number; seconds: number } {
  const match = /^(\d{2}):(\d{2}):(\d{2})$/.exec(windowTime);
  if (match === null) {
    throw new Error(`window time must be HH:MM:SS, got ${windowTime}`);
  }
  const [hours, minutes, seconds] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (hours > 23 || minutes > 59 || seconds > 59) {
    throw new Error(`window time is not a valid time of day, got ${windowTime}`);
  }
  return { hours, minutes, seconds };
}

/**
 * The most recent window occurrence at or before `now`. The exact window
 * instant counts as passed: a window at 07:00 composes at 07:00:00.
 */
export function lastWindowOccurrence(windowTime: string, now: Date): Date {
  const { hours, minutes, seconds } = parseWindowTime(windowTime);
  const candidate = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    hours,
    minutes,
    seconds,
  );
  if (candidate <= now.getTime()) {
    return new Date(candidate);
  }
  return new Date(candidate - 24 * 60 * 60 * 1000);
}

/** The occurrence one day before the given one, at the same window time. */
export function previousWindowOccurrence(windowTime: string, window: Date): Date {
  return new Date(window.getTime() - 24 * 60 * 60 * 1000);
}

/**
 * The cut-off interval a window composes: violations confirmed strictly
 * after the previous window and at or before this one. `previousWindow` is
 * the profile's last recorded UNSKIPPED window when one exists (a worker
 * that was down for days does not skip the days it missed, and a skipped
 * window never moves the cut-off); otherwise the arithmetic occurrence a
 * day before.
 */
export function compositionInterval(previousWindow: Date, window: Date): { from: Date; to: Date } {
  return { from: previousWindow, to: window };
}
