import { runMigrations } from "@patrol/db";
import { dropPublicSchema, testPool } from "./helpers.js";

/**
 * The worker's database suite starts from an empty test database and
 * migrates from zero, proving the forward-only runner works before any
 * test runs. The API suite shares the database; the packages run
 * serially, each re-migrating from zero.
 */
export default async function globalSetup(): Promise<void> {
  const pool = testPool();
  try {
    await dropPublicSchema(pool);
    const { applied, schemaStamp } = await runMigrations(pool);
    if (schemaStamp === null || applied.length === 0) {
      throw new Error("worker global setup failed to migrate the test database");
    }
  } finally {
    await pool.end();
  }
}
