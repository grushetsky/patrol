import type { Pool } from "pg";
import type { RouteFailureReason, RouteProbeResult } from "../acquisition/port.js";

/**
 * The route state (docs/design/scan-scheduling.md "Failure handling"):
 * an authentication failure, a revoked key, or an exhausted provider
 * balance disables an engine — no retries apply — and the hourly
 * `route.probe` job checks whether the route has recovered. A disabled
 * engine's scheduler does not enqueue work; manual URL entry keeps
 * working either way, and a scan that did not run is never
 * indistinguishable from a scan that found nothing.
 */

/** One engine's route row as the scheduler reads it. */
export interface RouteStateRow {
  engine: "google" | "bing" | "yandex";
  disabled: boolean;
  disabledReason: RouteFailureReason | null;
  disabledAt: Date | null;
  probeNextAt: Date | null;
}

/** Reads one engine's route row; enabled when no row stands. */
export async function readRouteState(
  pool: Pool,
  engine: "google" | "bing" | "yandex",
): Promise<RouteStateRow> {
  const result = await pool.query<{
    engine: string;
    disabled: boolean;
    disabled_reason: string | null;
    disabled_at: Date | null;
    probe_next_at: Date | null;
  }>(
    "select engine, disabled, disabled_reason, disabled_at, probe_next_at from route_state where engine = $1",
    [engine],
  );
  if (result.rows.length === 0) {
    return {
      engine,
      disabled: false,
      disabledReason: null,
      disabledAt: null,
      probeNextAt: null,
    };
  }
  const row = result.rows[0];
  return {
    engine: row.engine as RouteStateRow["engine"],
    disabled: row.disabled,
    disabledReason:
      row.disabled_reason === null
        ? null
        : (row.disabled_reason as RouteFailureReason),
    disabledAt: row.disabled_at === null ? null : new Date(row.disabled_at),
    probeNextAt: row.probe_next_at === null ? null : new Date(row.probe_next_at),
  };
}

/** Every engine whose route is disabled. */
export async function disabledEngines(
  pool: Pool,
): Promise<RouteStateRow[]> {
  const result = await pool.query<{
    engine: string;
    disabled_reason: string | null;
    disabled_at: Date | null;
    probe_next_at: Date | null;
  }>(
    "select engine, disabled_reason, disabled_at, probe_next_at from route_state where disabled",
  );
  return result.rows.map((row) => ({
    engine: row.engine as RouteStateRow["engine"],
    disabled: true,
    disabledReason:
      row.disabled_reason === null
        ? null
        : (row.disabled_reason as RouteFailureReason),
    disabledAt: row.disabled_at === null ? null : new Date(row.disabled_at),
    probeNextAt: row.probe_next_at === null ? null : new Date(row.probe_next_at),
  }));
}

/**
 * Disables an engine's route. Idempotent: an engine already down keeps its
 * original reason and time; the probe schedule tightens to hourly.
 */
export async function disableRoute(
  pool: Pool,
  now: () => Date,
  engine: "google" | "bing" | "yandex",
  reason: RouteFailureReason,
): Promise<void> {
  const at = now().toISOString();
  await pool.query(
    `insert into route_state (engine, disabled, disabled_reason, disabled_at, probe_next_at)
     values ($1, true, $2, $3, $3)
     on conflict (engine) do update
       set disabled = true,
           disabled_reason = coalesce(route_state.disabled_reason, excluded.disabled_reason),
           disabled_at = coalesce(route_state.disabled_at, excluded.disabled_at),
           probe_next_at = excluded.probe_next_at
       where not route_state.disabled`,
    [engine, reason, at],
  );
}

/** Re-enables an engine's route after a probe saw it recovered. */
export async function enableRoute(
  pool: Pool,
  now: () => Date,
  engine: "google" | "bing" | "yandex",
): Promise<void> {
  await pool.query(
    `update route_state
        set disabled = false, disabled_reason = null, disabled_at = null, probe_next_at = null
      where engine = $1 and disabled`,
    [engine],
  );
}

/**
 * One probe round: every disabled engine is probed through its adapter's
 * lightweight `probeRoute`, and a probe that answers re-enables the route.
 * The balance reading is deliberately NOT the gate — Yandex exposes no
 * prepaid balance endpoint, so gating on it would disable that route
 * forever; liveness is what recovery means, and the balance reading stays
 * with the daily `budget.balance` job's alerts. A probe that answers
 * auth-down or not at all records nothing and leaves the route disabled —
 * recovery is observed, never assumed, and a scan that did not run must
 * never look like a scan that found nothing. Returns the engines this
 * round re-enabled.
 */
export async function probeRoutes(
  pool: Pool,
  now: () => Date,
  probes: ReadonlyMap<string, { probeRoute(): Promise<RouteProbeResult> }>,
): Promise<{ reenabled: ("google" | "bing" | "yandex")[]; results: { engine: string; outcome: string }[] }> {
  const down = await disabledEngines(pool);
  const reenabled: ("google" | "bing" | "yandex")[] = [];
  const results: { engine: string; outcome: string }[] = [];
  for (const row of down) {
    const probe = probes.get(row.engine);
    if (probe === undefined) {
      results.push({ engine: row.engine, outcome: "no adapter configured" });
      continue;
    }
    const reading = await probe.probeRoute();
    if (reading.outcome === "up") {
      await enableRoute(pool, now, row.engine);
      reenabled.push(row.engine);
      results.push({ engine: row.engine, outcome: "route up" });
    } else if (reading.outcome === "auth_down") {
      results.push({ engine: row.engine, outcome: "auth down" });
    } else {
      results.push({ engine: row.engine, outcome: `down: ${reading.reason}` });
    }
  }
  return { reenabled, results };
}
