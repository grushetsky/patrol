/**
 * The monthly rollover moved behind `@patrol/budget` in slice 3b (the
 * worker's `budget.rollover` cron calls it on the first at 00:00 UTC);
 * this module is the API's stable facade over it.
 */
export { rollOverMonth } from "@patrol/budget";
export type { RolloverOutcome } from "@patrol/budget";
