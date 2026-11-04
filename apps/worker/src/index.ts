import { writeFileSync } from "node:fs";
import { Pool } from "pg";
import pino from "pino";
import { assertSchema, expectedSchemaStamp } from "@patrol/db";

/**
 * Slice-0 placeholder: the worker proves its database wiring, refuses to run
 * against a schema it does not expect, and stays alive with a heartbeat.
 * pg-boss queues, the per-engine concurrency, and capture work arrive in
 * slice 3.
 */
const log = pino({
  level: process.env.PATROL_LOG_LEVEL ?? "info",
  redact: { paths: ["req.headers.cookie", "req.headers.authorization"], censor: "[redacted]" },
});

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  log.error("DATABASE_URL is required");
  process.exit(1);
}

const pool = new Pool({ connectionString: databaseUrl });

/**
 * The file the compose healthcheck watches: the worker touches it every 30 s
 * and docker treats a file older than 90 s as an unhealthy process.
 * TODO(slice 3): replace this process-alive signal with the queue heartbeat
 * (pg-boss heartbeat row) the deployment topology actually specifies.
 */
const heartbeatFile =
  process.env.PATROL_WORKER_HEARTBEAT_FILE ?? "/tmp/patrol-worker-heartbeat";

function touchHeartbeat(): void {
  try {
    writeFileSync(heartbeatFile, `${Date.now()}\n`);
  } catch (error) {
    // A failed heartbeat write must never kill the worker; docker observes
    // the stale file and reports it.
    log.warn({ err: error, file: heartbeatFile }, "worker heartbeat write failed");
  }
}

async function boot(): Promise<void> {
  try {
    await pool.query("select 1");
  } catch (error) {
    log.error(
      { err: error },
      "worker cannot reach the database; refusing to start",
    );
    process.exit(1);
  }
  log.info("worker connected to postgres");

  // ADR 0028: same startup check as the API — the worker refuses to run
  // against a schema the image does not expect (unrecorded, ahead, behind).
  try {
    const schemaStamp = await assertSchema(pool, expectedSchemaStamp());
    log.info({ schemaStamp }, "worker verified the database schema");
  } catch (error) {
    log.error(
      { err: error },
      "worker refuses to start: the database schema and the image disagree",
    );
    await pool.end().catch(() => undefined);
    process.exit(1);
  }

  touchHeartbeat();
  const heartbeat = setInterval(() => {
    touchHeartbeat();
    log.info("worker heartbeat");
  }, 30_000);

  const shutdown = async (signal: string) => {
    clearInterval(heartbeat);
    await pool.end();
    log.info(`worker stopped on ${signal}`);
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}

boot().catch((error) => {
  log.error({ err: error }, "worker failed to boot");
  process.exit(1);
});
