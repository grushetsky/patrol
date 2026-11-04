import { runMigrations } from "@patrol/db";
import { createDb } from "./client.js";
import { loadConfig } from "../config.js";

/**
 * The migrate task (ADR 0028): run from the same image as the API, before
 * the roll. Applies every pending numbered SQL file in order and prints what
 * it did.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const { pool } = createDb(config.databaseUrl);
  try {
    const { applied, schemaStamp } = await runMigrations(pool);
    if (applied.length === 0) {
      console.log(`schema already at stamp ${schemaStamp}; nothing to apply`);
    } else {
      console.log(`applied ${applied.join(", ")}; schema at stamp ${schemaStamp}`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(
    `migration failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
