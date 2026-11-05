import PgBoss from "pg-boss";
import { ENGINE_QUEUE_NAMES } from "@patrol/domain";

/**
 * How the API tells the worker a scan wants to run: one scan.run picker
 * job into the engine's pg-boss queue. The API is a producer only — the
 * worker owns the queues, the handlers, and the cron — so a manual scan
 * starts promptly instead of waiting for the fifteen-minute schedule tick.
 * The queue names are single-sourced in `@patrol/domain`, shared with the
 * worker's consumer, so the two processes cannot drift.
 */

/** The engines that own an acquisition route in v1. */
export type DispatchEngine = "google" | "yandex";

/** The port the scan routes use; injectable so tests record instead of send. */
export interface ScanDispatcher {
  dispatchScanRun(engine: DispatchEngine): Promise<void>;
}

/**
 * The production dispatcher over a started pg-boss producer. The producer
 * boots its own boss instance — pg-boss supports several processes on one
 * database — and only ever sends; the worker consumes.
 */
export function bossScanDispatcher(boss: PgBoss): ScanDispatcher {
  return {
    async dispatchScanRun(engine) {
      await boss.send(ENGINE_QUEUE_NAMES[engine], { engine });
    },
  };
}

/**
 * A dispatcher that starts a producer on the database and returns it. The
 * producer's errors go to `logError` — a producer that cannot reconnect is
 * a silent scan delay otherwise, and a send failure surfaces at the route
 * only when a request is actually in flight.
 */
export async function startScanDispatcher(input: {
  databaseUrl: string;
  bossSchema: string;
  logError?: (error: Error) => void;
}): Promise<{ dispatcher: ScanDispatcher; stop: () => Promise<void> }> {
  const logError =
    input.logError ??
    ((error: Error) => console.error("pg-boss producer error:", error));
  const boss = new PgBoss({
    connectionString: input.databaseUrl,
    schema: input.bossSchema,
  });
  boss.on("error", (error: Error) => {
    // pg-boss reconnects on its own; the error is logged, never swallowed.
    logError(error);
  });
  await boss.start();
  // The queues exist so a send before the worker's first boot still lands;
  // creation is idempotent.
  for (const engine of ["google", "yandex"] as const) {
    const name = ENGINE_QUEUE_NAMES[engine];
    await boss.createQueue(name, { name, expireInSeconds: 7_200, retentionMinutes: 60 * 24 });
  }
  return {
    dispatcher: bossScanDispatcher(boss),
    stop: async () => {
      await boss.stop({ close: false, graceful: true, timeout: 10_000 }).catch(
        () => undefined,
      );
    },
  };
}

/** A no-op dispatcher for tests that never touch a queue. */
export function noopScanDispatcher(): ScanDispatcher {
  return { async dispatchScanRun() {} };
}
