import type { EngineName } from "./pricing.js";
/**
 * Row types for the budget read models, shared by the API's JSON mappers
 * and the worker's job handlers. One invalid field in a rejected write,
 * mirroring the contract's Patrol.Http.FieldError shape.
 */
export interface FieldError {
    path: string;
    message: string;
}
export type BudgetBucketName = "scan" | "recheck";
export type ReservationStateName = "held" | "committed" | "released" | "expired";
export type AlertThresholdName = "warning" | "critical" | "exhausted" | "balance";
export type AlertLevelName = "warning" | "critical";
export interface QuotaLedgerRow {
    id: string;
    engine: EngineName;
    monthStart: string;
    allowanceUnits: number;
    scanReserved: number;
    scanCommitted: number;
    recheckReserved: number;
    recheckCommitted: number;
}
export interface ReservationRow {
    id: string;
    scanId: string | null;
    engine: EngineName;
    monthStart: string;
    bucket: BudgetBucketName;
    units: number;
    state: ReservationStateName;
    createdAt: Date;
    expiresAt: Date;
    settledAt: Date | null;
    committedUnits: number | null;
    releasedUnits: number | null;
}
export interface BudgetAlertRow {
    id: string;
    engine: EngineName;
    monthStart: string;
    threshold: AlertThresholdName;
    bucket: BudgetBucketName | null;
    level: AlertLevelName;
    percentUsed: number;
    groupsNotScanned: number;
    firedAt: Date;
}
