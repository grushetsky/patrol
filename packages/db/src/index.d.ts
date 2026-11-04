import type { Pool, PoolClient } from "pg";
/**
 * The database runtime shared by the API and the worker (ADR 0028): the
 * forward-only migration runner, the patrol_meta stamp readers, and the
 * startup check both processes refuse to boot without. This module ships as
 * TypeScript source — Node 26 strips the types at runtime — and the emitted
 * src/index.d.ts is what consuming typechecks resolve.
 */
/** One numbered, forward-only SQL migration shipped in drizzle/. */
export interface MigrationFile {
    number: number;
    name: string;
    path: string;
}
/** The directory of shipped migrations, relative to this source file. */
export declare function migrationsDir(): string;
/**
 * Lists the shipped migrations ordered by number. A duplicate number is a
 * packaging error and refuses loudly rather than applying in glob order.
 */
export declare function listMigrationFiles(dir?: string): MigrationFile[];
/** The highest migration number this image carries. */
export declare function highestMigrationNumber(dir?: string): number;
/**
 * The stamp this image expects the database to carry: the PATROL_SCHEMA_STAMP
 * override when it is set, otherwise the highest migration the image ships.
 */
export declare function expectedSchemaStamp(override?: string | undefined): number;
/** Reads patrol_meta's current stamp, or null before the table exists. */
export declare function readSchemaStamp(client: PoolClient | Pool): Promise<number | null>;
export interface MigrationOutcome {
    /** The migration names applied by this run, in order. */
    applied: string[];
    /** The stamp recorded after the run, or null when nothing is recorded. */
    schemaStamp: number | null;
}
/**
 * The forward-only runner (ADR 0028). Every file applies in its own
 * transaction and records its stamp in patrol_meta; a file whose number is
 * at or below the current stamp is never run again. An advisory lock
 * serializes concurrent runners.
 */
export declare function runMigrations(pool: Pool, dir?: string): Promise<MigrationOutcome>;
/** Raised when the database stamp does not match what the image expects. */
export declare class SchemaMismatchError extends Error {
    constructor(message: string);
}
/**
 * The startup check (ADR 0028): the process refuses to run against a schema
 * it does not expect — unrecorded, ahead, or behind.
 */
export declare function assertSchema(pool: Pool, expected: number): Promise<number>;
