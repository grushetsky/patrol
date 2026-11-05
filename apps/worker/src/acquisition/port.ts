import type { ProviderBalanceResult } from "@patrol/budget";

/**
 * The one acquisition port both engines sit behind
 * (docs/design/serp-acquisition-route.md "The port"): one adapter per
 * engine, one vendor per engine, no vendor type outside the adapter. The
 * adapter owns request shaping, paging, parsing, retry, and the provider's
 * error taxonomy; `host` and the normalized URL key are derived by the
 * scan executor from the URL the adapter returns, where the provider
 * omits them.
 */

/** Why a route went down: no retries apply, the hourly probe watches it. */
export type RouteFailureReason = "authentication" | "revoked_key" | "empty_balance";

/**
 * One liveness probe's answer for the hourly `route.probe` job: the route
 * answers authenticated requests (`up`), refuses the credentials
 * (`auth_down` — no recovery to observe yet), or cannot be reached
 * (`down`). Liveness is deliberately cheaper and broader than the balance
 * reading: a provider that exposes no balance endpoint (Yandex bills by
 * invoice) can still say whether its route works.
 */
export type RouteProbeResult =
  | { outcome: "up" }
  | { outcome: "auth_down" }
  | { outcome: "down"; reason: string };

/** The engines that own an acquisition route in v1. */
export type RoutedEngine = "google" | "yandex";

/** One query handed to an adapter. */
export interface AcquireRequest {
  /** Patrol's own SearchQuery id, for provenance. */
  queryId: string;
  /** The exact issued text, after the plan's caps and sanitization. */
  text: string;
  /** The locale the query is issued in; the adapter maps it per engine. */
  locale: string;
}

/** One ranked row a provider returned. */
export interface AcquiredRow {
  url: string;
  title: string;
  snippet: string;
  /** The row's rank in the result set, one-based. */
  rank: number;
}

/** One recorded attempt, so the retry sequence a query consumed is on the row. */
export interface AttemptRecord {
  attemptedAt: string;
  outcome: "acquired" | "retryable" | "failed" | "route_failed";
  /** The delay the schedule waited before the next attempt. */
  waitedMs?: number;
}

/** What an adapter hands back for one query. */
export type AcquireOutcome =
  | {
      outcome: "acquired";
      rows: AcquiredRow[];
      /**
       * A reference to the stored vendor response so the observation can be
       * reproduced without re-querying: DataForSEO's task id (their side
       * keeps standard-queue results thirty days), or a content reference
       * for Yandex.
       */
      rawPayloadRef: string;
      observedAt: string;
    }
  | {
      outcome: "query_failed";
      reason: string;
      attempts: number;
      attemptLog: AttemptRecord[];
    }
  | { outcome: "route_failed"; reason: RouteFailureReason };

/**
 * The retry schedule for a provider 5xx, timeout, or 429: the initial
 * request fails fast, then three retries at one, five, and fifteen
 * minutes, the sequence recorded on the query's failure row
 * (docs/design/scan-scheduling.md "Failure handling"; implementation
 * rules "Query retries").
 */
export const QUERY_RETRY_DELAYS_MS: readonly number[] = [60_000, 300_000, 900_000];

/** How the timing of a retry loop is injected, so tests run it instantly. */
export interface RetryTiming {
  /** The delays before each retry. */
  retryDelaysMs?: readonly number[];
  /** The sleep the loop uses; real time in production. */
  sleep?: (ms: number) => Promise<void>;
  /** The clock the attempt log records. */
  now?: () => Date;
}

/**
 * One adapter per engine. `acquire` applies the retry schedule itself —
 * retrying is part of the provider's error taxonomy, not the caller's —
 * `probeBalance` composes with the daily `budget.balance` job's
 * thresholds, and `probeRoute` is the lightweight liveness check the
 * hourly `route.probe` job re-enables a disabled engine on.
 */
export interface SerpAcquisitor {
  readonly engine: RoutedEngine;
  acquire(request: AcquireRequest, timing?: RetryTiming): Promise<AcquireOutcome>;
  probeBalance(): Promise<ProviderBalanceResult>;
  /**
   * Whether the route is alive: one cheap authenticated request. 2xx means
   * up, 401/403 auth-down, anything else down. Never issues a query that
   * bills materially — the DataForSEO probe reads the account's user data,
   * the Yandex probe submits one deferred search and abandons it after
   * the status.
   */
  probeRoute(): Promise<RouteProbeResult>;
}
