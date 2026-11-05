import type { Pool } from "pg";
import { type EngineName } from "./pricing.js";
/** One engine's month after a rollover run. */
export interface RolloverOutcome {
    engine: EngineName;
    monthStart: string;
    /** Whether this run opened the row; false when it already stood. */
    created: boolean;
    /** The allowance the settings cap bought when the row opened. */
    allowanceUnits: number;
}
/**
 * Opens the current month's rows from the current settings caps, in one
 * transaction. Idempotent: a row that already stands is left exactly as
 * it is and reported with created false, so a job restart or a duplicate
 * wake-up changes nothing. Reads the caps through the shared reader, so
 * an unbootstrapped database refuses with setup_required like every
 * other budget path.
 */
export declare function rollOverMonth(pool: Pool, now: () => Date): Promise<RolloverOutcome[]>;
