import { Pool } from "pg";
import { buildApp } from "./app.js";
import { loadRuntimeConfig } from "./config.js";
import { loadContract } from "./contract.js";
import {
  assertSchemaCompatible,
  currentVersion,
  readMigrations,
} from "./db/migrations.js";

const config = loadRuntimeConfig();
const pool = new Pool({ connectionString: config.databaseUrl });
const expectedMigration =
  (await readMigrations(config.migrationsDir)).at(-1)?.version ?? "0";

try {
  const applied = await currentVersion(pool);
  assertSchemaCompatible(applied, expectedMigration);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  await pool.end();
  process.exit(1);
}

const contract = await loadContract(config.schemaPath);
const app = buildApp({
  db: pool,
  contract,
  buildVersion: process.env.BUILD_VERSION ?? "0.1.0",
  expectedMigration,
});

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "shutting down");
  await app.close();
  await pool.end();
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? "0.0.0.0",
});
