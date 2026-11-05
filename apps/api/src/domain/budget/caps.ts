/**
 * The budget settings reader moved behind `@patrol/budget` in slice 3b;
 * this module is the API's stable facade over it.
 */
export { capFor, readCaps } from "@patrol/budget";
export type { BudgetCapRow } from "@patrol/budget";
