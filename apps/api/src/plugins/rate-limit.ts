import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import type { AppConfig } from "../config.js";
import { ApiError } from "../errors.js";

/**
 * The general API rate limits (slice 9 "Rate limits"): a per-session
 * ceiling for authenticated calls and a per-IP ceiling for anonymous
 * ones, answering the contract's 429 `rate_limited` with
 * `retryAfterSeconds` when either is crossed. This complements — never
 * duplicates — the sign-in throttle (Authentication "Lockout"): the
 * throttle is a lockout policy against credential guessing on one route,
 * while these are load ceilings over every route; a sign-in attempt
 * counts against the anonymous ceiling AND the throttle, and only the
 * throttle decides when signing in is allowed again.
 *
 * Counters are fixed windows in process memory: one API task is the
 * deployment's shape, a restart clears the window, and the ceilings are
 * generous enough that losing a partial window to a deploy is nothing.
 * `trustProxy` is on, so `request.ip` is the ALB-forwarded client
 * address, not the load balancer's. The health probe stays outside both
 * ceilings: the load balancer checks it, and a checked-probe burst must
 * never flap the deployment.
 *
 * Registered BEFORE the auth plugin's preHandler (and after its session
 * resolution, which runs in onRequest), so every request counts toward
 * its ceiling ahead of the setup gate, CSRF, and the role guard — a
 * flood of rejects still spends the sender's window.
 */

/** The limiter's knobs, all environment-configurable with these defaults. */
export interface RateLimitOptions {
  /** The fixed window's length. */
  windowMs: number;
  /** Requests one authenticated session may make per window. */
  sessionMax: number;
  /** Requests one anonymous address may make per window. */
  anonymousMax: number;
}

/** One window's counter. */
interface WindowCounter {
  count: number;
  resetAt: number;
}

/** The load balancer's probe path, exempt from every ceiling. */
const HEALTH_PATH = "/api/health";

/**
 * The per-process window counters the plugin closes over. One instance per
 * app; a second app (a test) gets its own, which is exactly the deployment
 * semantics: one API task, one counter set, restart clears.
 */
export interface RateLimiterState {
  windows: Map<string, WindowCounter>;
}

/**
 * Counts one request against its key's window. Returns the ceiling's
 * verdict: null when the request fits, or the seconds until the window
 * resets when it does not.
 */
export function countAgainstWindow(
  state: RateLimiterState,
  key: string,
  max: number,
  windowMs: number,
  now: number,
): number | null {
  const existing = state.windows.get(key);
  if (existing === undefined || now >= existing.resetAt) {
    state.windows.set(key, { count: 1, resetAt: now + windowMs });
    return null;
  }
  existing.count += 1;
  if (existing.count > max) {
    return Math.max(1, Math.ceil((existing.resetAt - now) / 1000));
  }
  return null;
}

/** Drops expired windows so the map cannot grow without bound. */
function sweep(state: RateLimiterState, now: number): void {
  if (state.windows.size < 10_000) {
    return;
  }
  for (const [key, counter] of state.windows) {
    if (now >= counter.resetAt) {
      state.windows.delete(key);
    }
  }
}

export function rateLimitPlugin(
  options: RateLimitOptions,
): FastifyPluginAsync<{ state?: RateLimiterState }> {
  return fp(async (app: FastifyInstance, opts: { state?: RateLimiterState }) => {
    const state: RateLimiterState = opts.state ?? { windows: new Map() };

    app.addHook(
      "preHandler",
      async (request: FastifyRequest, reply: FastifyReply) => {
        if (request.url.split("?")[0] === HEALTH_PATH) {
          return;
        }
        const now = Date.now();
        sweep(state, now);
        // Authenticated calls spend the session's window; anonymous ones
        // the address's. The session is already resolved (the auth
        // plugin's onRequest hook ran), so the split is exact: a flood of
        // bogus cookies stays anonymous and shares one per-IP ceiling.
        const authenticated = request.session !== null;
        const key = authenticated
          ? `s:${request.session!.session.id}`
          : `ip:${request.ip}`;
        const ceiling = authenticated ? options.sessionMax : options.anonymousMax;
        const retryAfterSeconds = countAgainstWindow(state, key, ceiling, options.windowMs, now);
        if (retryAfterSeconds !== null) {
          reply.header("Retry-After", retryAfterSeconds);
          throw new ApiError(429, "rate_limited", { retryAfterSeconds });
        }
      },
    );
  });
}
