/**
 * The quota ledger moved behind `@patrol/budget` in slice 3b: the worker's
 * pg-boss jobs reserve, commit, and expire alongside the API, so the
 * domain lives in the shared package and this module is the API's stable
 * facade over it. The behavior and its tests are unchanged.
 */
export {
  RESERVATION_TTL_MS,
  bucketShares,
  commitReservation,
  ensureMonth,
  expireReservations,
  monthStartOf,
  readLedgerRow,
  readMonthLedgerRows,
  releaseReservation,
  reserve,
} from "@patrol/budget";
export type { ReserveResult } from "@patrol/budget";
