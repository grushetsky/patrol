import { assertSchema, readSchemaStamp } from "@patrol/db";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDb } from "./db/client.js";
import { ConsoleMailTransport } from "./mail/transport.js";
import { startScanDispatcher } from "./queue/dispatch.js";

/**
 * Boot order (ADR 0028): the migrate task has already run, so the process
 * only checks the stamp and refuses to start when the database and the image
 * disagree, then listens on 0.0.0.0 for the load balancer. Mail goes through
 * the console transport until slice 9 wires the deployment's SMTP relay.
 *
 * The pg-boss producer starts after the stamp check: manual scan requests
 * send scan.run picker jobs into the worker's engine queues through it.
 * pg-boss owns and versions its schema itself; it is deliberately absent
 * from the drizzle migrations.
 */
async function boot(): Promise<void> {
  const config = loadConfig();
  const { pool } = createDb(config.databaseUrl);

  try {
    await assertSchema(pool, config.schemaStamp);
  } catch (error) {
    pool.end().catch(() => undefined);
    console.error(
      `refusing to start: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }

  const producer = await startScanDispatcher({
    databaseUrl: config.databaseUrl,
    bossSchema: process.env.PATROL_BOSS_SCHEMA ?? "pgboss",
    logError: (error) => console.error("pg-boss producer error:", error),
  });

  const app = await buildApp({
    config,
    pool,
    mail: new ConsoleMailTransport(),
    schemaStamp: () => readSchemaStamp(pool),
    dispatcher: producer.dispatcher,
  });

  const shutdown = async (signal: string) => {
    await app.close();
    await producer.stop();
    await pool.end();
    console.log(`api stopped on ${signal}`);
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));

  await app.listen({ port: config.port, host: "0.0.0.0" });
}

boot().catch((error) => {
  console.error(`api failed to boot: ${error instanceof Error ? error.stack : String(error)}`);
  process.exit(1);
});
