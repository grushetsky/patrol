import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

export interface Db {
  pool: Pool;
  db: NodePgDatabase;
}

/** The pg pool plus a Drizzle instance over it, from one DATABASE_URL. */
export function createDb(databaseUrl: string): Db {
  const pool = new Pool({ connectionString: databaseUrl });
  return { pool, db: drizzle(pool) };
}
