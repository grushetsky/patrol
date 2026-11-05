/**
 * The provider balance probe's port and thresholds moved behind
 * `@patrol/budget` in slice 3b (the acquisition adapters implement the
 * probe); this module is the API's stable facade over it.
 */
export {
  balanceCriticalThresholdMinor,
  committedUnitsToMinor,
  isBalanceCritical,
} from "@patrol/budget";
export type { ProviderBalanceProbe, ProviderBalanceResult } from "@patrol/budget";
