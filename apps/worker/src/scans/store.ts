/**
 * The scan store moved behind `@patrol/scans` in slice 3b: the API's
 * manual-request path and read models share it with the worker's
 * scheduling and execution. This module is the worker's stable facade.
 */
export * from "@patrol/scans";
