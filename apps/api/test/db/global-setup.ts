import { runMigrations } from "@patrol/db";
import { dropPublicSchema, testPool } from "./helpers.js";

/**
 * The database suite starts from an empty test database and migrates from
 * zero, proving the forward-only runner works before any test runs.
 */
export default async function globalSetup(): Promise<void> {
  const pool = testPool();
  try {
    await dropPublicSchema(pool);
    const { applied, schemaStamp } = await runMigrations(pool);
    if (schemaStamp === null || applied.length === 0) {
      throw new Error("global setup failed to migrate the test database");
    }
  } finally {
    await pool.end();
  }
}
