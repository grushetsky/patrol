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
/**
 * The most recent window occurrence at or before `now`. The exact window
 * instant counts as passed: a window at 07:00 composes at 07:00:00.
 */
export declare function lastWindowOccurrence(windowTime: string, now: Date): Date;
/** The occurrence one day before the given one, at the same window time. */
export declare function previousWindowOccurrence(windowTime: string, window: Date): Date;
/**
 * The cut-off interval a window composes: violations confirmed strictly
 * after the previous window and at or before this one. `previousWindow` is
 * the profile's last RECORDED window when one exists (a worker that was
 * down for days does not skip the days it missed); otherwise the
 * arithmetic occurrence a day before.
 */
export declare function compositionInterval(previousWindow: Date, window: Date): {
    from: Date;
    to: Date;
};
