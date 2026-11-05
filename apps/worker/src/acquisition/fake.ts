import type { ProviderBalanceResult } from "@patrol/budget";
import {
  type AcquireOutcome,
  type AcquireRequest,
  type AcquiredRow,
  type RetryTiming,
  type RouteFailureReason,
  type RouteProbeResult,
  type SerpAcquisitor,
} from "./port.js";
import { runWithRetry, type ProviderAttempt } from "./retry.js";

/**
 * The fixture-driven adapter for tests and development: canned rows per
 * query, programmable per-attempt failures (5xx, timeout, 429, and the
 * three route failures), the request shapes recorded for assertion, and a
 * programmable balance for the probe. It never touches a network.
 */

/** What one scripted attempt does. */
export type FakeOutcome =
  | "ok"
  | "server_error"
  | "rate_limited"
  | "timeout"
  | "authentication"
  | "revoked_key"
  | "empty_balance";

export interface FakeSerpFixtures {
  /**
   * Rows a query returns once its script (or the default) says ok. A query
   * with no canned rows gets three deterministic rows derived from its
   * text, so every acquired query produces reproducible provenance.
   */
  results?: Record<string, AcquiredRow[]>;
  /**
   * The per-attempt script a query plays through; attempts past the
   * script's end answer ok. A route failure in the script stops the loop
   * immediately.
   */
  scripts?: Record<string, FakeOutcome[]>;
  /** What the balance probe reads. */
  balanceMinor?: number;
  /** What the balance probe answers instead of a reading. */
  balanceUnavailable?: string;
  /** What the route probe answers, when the test scripts it explicitly. */
  routeProbe?: RouteProbeResult;
}

/** Deterministic canned rows for a query text. */
function defaultRows(text: string): AcquiredRow[] {
  const slug = encodeURIComponent(text.toLowerCase().replace(/\s+/g, "-")).slice(0, 60);
  return [1, 2, 3].map((rank) => ({
    url: `https://fake-${rank}.example.test/watch?q=${slug}`,
    title: `Fake result ${rank} for ${text}`,
    snippet: `A canned snippet about ${text}`,
    rank,
  }));
}

export class FakeSerpAcquisitor implements SerpAcquisitor {
  readonly engine: "google" | "yandex";
  /** Every request the adapter saw, in order, for shape assertions. */
  readonly requests: AcquireRequest[] = [];

  private readonly fixtures: FakeSerpFixtures;

  constructor(engine: "google" | "yandex", fixtures: FakeSerpFixtures = {}) {
    this.engine = engine;
    this.fixtures = fixtures;
  }

  async acquire(
    request: AcquireRequest,
    timing?: RetryTiming,
  ): Promise<AcquireOutcome> {
    this.requests.push(request);
    const script = this.fixtures.scripts?.[request.text] ?? [];
    let attemptIndex = 0;
    const result = await runWithRetry(async (): Promise<ProviderAttempt> => {
      const outcome = script[attemptIndex] ?? "ok";
      attemptIndex += 1;
      if (outcome === "ok") {
        const rows = this.fixtures.results?.[request.text] ?? defaultRows(request.text);
        const observedAt = (timing?.now ?? (() => new Date()))().toISOString();
        return {
          kind: "rows",
          rows,
          rawPayloadRef: `fake:${this.engine}:${request.queryId}`,
          observedAt,
        };
      }
      if (
        outcome === "authentication" ||
        outcome === "revoked_key" ||
        outcome === "empty_balance"
      ) {
        return { kind: "route", reason: outcome as RouteFailureReason };
      }
      return {
        kind: "retryable",
        reason:
          outcome === "server_error"
            ? "provider 5xx"
            : outcome === "rate_limited"
              ? "provider 429"
              : "provider timeout",
      };
    }, timing);
    if (result.outcome === "acquired") {
      return {
        outcome: "acquired",
        rows: result.rows,
        rawPayloadRef: result.rawPayloadRef,
        observedAt: result.observedAt,
      };
    }
    if (result.outcome === "route_failed") {
      return { outcome: "route_failed", reason: result.reason };
    }
    return {
      outcome: "query_failed",
      reason: result.reason,
      attempts: result.attempts,
      attemptLog: result.attemptLog,
    };
  }

  async probeBalance(): Promise<ProviderBalanceResult> {
    if (this.fixtures.balanceUnavailable !== undefined) {
      return {
        outcome: "unavailable",
        reason: this.fixtures.balanceUnavailable,
      };
    }
    return { outcome: "balance", balanceMinor: this.fixtures.balanceMinor ?? 10_000 };
  }

  async probeRoute(): Promise<RouteProbeResult> {
    if (this.fixtures.routeProbe !== undefined) {
      return this.fixtures.routeProbe;
    }
    // Unscripted, the fake's liveness follows its balance: a provider that
    // answers with a positive balance is up, one that cannot answer or
    // reads zero is not.
    if (this.fixtures.balanceUnavailable !== undefined) {
      return { outcome: "down", reason: this.fixtures.balanceUnavailable };
    }
    return (this.fixtures.balanceMinor ?? 10_000) > 0
      ? { outcome: "up" }
      : { outcome: "down", reason: "provider balance empty" };
  }
}
