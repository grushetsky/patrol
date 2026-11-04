import { Pool } from "pg";
import { loadRuntimeConfig } from "../config.js";
import { migrate } from "./migrations.js";

const config = loadRuntimeConfig();
const pool = new Pool({ connectionString: config.databaseUrl });

try {
  const result = await migrate(pool, config.migrationsDir);
  console.log(
    result.applied.length > 0
      ? `Applied ${result.applied.join(", ")}; now at ${result.version}.`
      : `Already at ${result.version}.`,
  );
} finally {
  await pool.end();
}
