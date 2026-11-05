/**
 * The alert evaluator moved behind `@patrol/budget` in slice 3b (the
 * worker fires it on every settled scan and from `budget.balance`); this
 * module is the API's stable facade over it.
 */
export {
  dueAlerts,
  evaluateBudgetAlerts,
  listMonthAlerts,
} from "@patrol/budget";
export type { AlertThreshold, DueAlert, SpendSnapshot } from "@patrol/budget";
