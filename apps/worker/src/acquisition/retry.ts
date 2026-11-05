import {
  QUERY_RETRY_DELAYS_MS,
  type AcquiredRow,
  type AttemptRecord,
  type RetryTiming,
} from "./port.js";

/**
 * The retry loop every adapter shares: one provider request fails fast,
 * then retries at the schedule's delays with the sequence recorded. A
 * retryable class (5xx, timeout, 429) consumes the whole schedule; a
 * route failure (authentication, revoked key, empty balance) stops
 * immediately — no retry applies, the engine is disabled and the hourly
 * probe watches for recovery. The caller's engine queue is held at
 * concurrency one, so backing off inside the adapter throttles the whole
 * engine, which is exactly what a 429 asks for.
 */

/** What one provider request produced, before any retry decision. */
export type ProviderAttempt =
  | { kind: "rows"; rows: AcquiredRow[]; rawPayloadRef: string; observedAt: string }
  | { kind: "retryable"; reason: string }
  | {
      kind: "route";
      reason: "authentication" | "revoked_key" | "empty_balance";
    };

/** The result of running one request through the retry schedule. */
export type RetryResult =
  | {
      outcome: "acquired";
      rows: AcquiredRow[];
      rawPayloadRef: string;
      observedAt: string;
      attempts: number;
      attemptLog: AttemptRecord[];
    }
  | {
      outcome: "query_failed";
      reason: string;
      attempts: number;
      attemptLog: AttemptRecord[];
    }
  | {
      outcome: "route_failed";
      reason: "authentication" | "revoked_key" | "empty_balance";
      attempts: number;
      attemptLog: AttemptRecord[];
    };

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Runs `attempt` up to one initial try plus one retry per configured
 * delay, recording every attempt: the initial request, then a retry after
 * each delay the schedule names. The waits come from the injected timing,
 * so a test drives the schedule without waiting for it.
 */
export async function runWithRetry(
  attempt: () => Promise<ProviderAttempt>,
  timing: RetryTiming = {},
): Promise<RetryResult> {
  const delays = timing.retryDelaysMs ?? QUERY_RETRY_DELAYS_MS;
  const sleep = timing.sleep ?? defaultSleep;
  const now = timing.now ?? (() => new Date());
  const attemptLog: AttemptRecord[] = [];
  let lastRetryableReason = "provider retries exhausted";

  for (let round = 0; round <= delays.length; round += 1) {
    if (round > 0) {
      await sleep(delays[round - 1] ?? 0);
    }
    const startedAt = now().toISOString();
    const result = await attempt();
    if (result.kind === "rows") {
      attemptLog.push({ attemptedAt: startedAt, outcome: "acquired" });
      return {
        outcome: "acquired",
        rows: result.rows,
        rawPayloadRef: result.rawPayloadRef,
        observedAt: result.observedAt,
        attempts: round + 1,
        attemptLog,
      };
    }
    if (result.kind === "route") {
      attemptLog.push({ attemptedAt: startedAt, outcome: "route_failed" });
      return {
        outcome: "route_failed",
        reason: result.reason,
        attempts: round + 1,
        attemptLog,
      };
    }
    lastRetryableReason = result.reason;
    attemptLog.push({
      attemptedAt: startedAt,
      outcome: "retryable",
      waitedMs: delays[round],
    });
  }
  return {
    outcome: "query_failed",
    reason: lastRetryableReason,
    attempts: attemptLog.length,
    attemptLog,
  };
}

export { defaultSleep };
