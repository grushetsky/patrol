import { join } from "node:path";
import { findRepoRoot } from "./repo.js";

export interface RuntimeConfig {
  repoRoot: string;
  databaseUrl: string;
  migrationsDir: string;
  schemaPath: string;
}

/** Read the runtime paths and the database URL from the environment. */
export function loadRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
): RuntimeConfig {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required.");
  }
  const repoRoot = findRepoRoot();
  return {
    repoRoot,
    databaseUrl,
    migrationsDir:
      env.PATROL_MIGRATIONS_DIR ?? join(repoRoot, "apps/api/drizzle"),
    schemaPath:
      env.PATROL_SCHEMA_BUNDLE ??
      join(repoRoot, "contract/generated/json-schema/patrol"),
  };
}
