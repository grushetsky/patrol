/**
 * Sign-in rate limiting (implementation-rules "Sign-in rate"): ten failures
 * per account trigger a fifteen-minute lock; per-IP attempts are throttled
 * separately; both are audited as security events. The per-IP threshold
 * fires on failures counted from the audit trail inside the window, so the
 * throttle needs no second counter table.
 */

/** Consecutive failures on one account before the lock. */
export const MAX_FAILED_ATTEMPTS = 10;

/** How long a triggered lock holds. */
export const LOCK_DURATION_MINUTES = 15;

/** Per-IP failures inside the window before the address is throttled. */
export const PER_IP_MAX_FAILURES = 20;

/** The window the per-IP throttle counts inside. */
export const PER_IP_WINDOW_MINUTES = 15;

export function lockDurationMs(): number {
  return LOCK_DURATION_MINUTES * 60 * 1000;
}

export function perIpWindowMs(): number {
  return PER_IP_WINDOW_MINUTES * 60 * 1000;
}

/** The instant a lock triggered at `now` releases. */
export function lockUntil(now: Date): Date {
  return new Date(now.getTime() + lockDurationMs());
}

/** Whether a lock is still holding at `now`. */
export function isLocked(lockedUntil: Date | null, now: Date): boolean {
  return lockedUntil !== null && lockedUntil.getTime() > now.getTime();
}

/** Whole seconds remaining in a lock, for `retryAfterSeconds`. */
export function retryAfterSeconds(lockedUntil: Date, now: Date): number {
  return Math.max(1, Math.ceil((lockedUntil.getTime() - now.getTime()) / 1000));
}
