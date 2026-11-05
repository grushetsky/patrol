import { beforeAll } from "vitest";
import { testPool, truncateDomainTables } from "./helpers.js";

/**
 * Runs once per test file: domain tables are truncated back to the
 * migrated baseline while the patrol_meta stamp is preserved.
 */
beforeAll(async () => {
  const pool = testPool();
  try {
    await truncateDomainTables(pool);
  } finally {
    await pool.end();
  }
});
