import type { FieldError } from "./rows.js";

/**
 * A budget-domain rejection. Slice 3a raised these as the API's ApiError;
 * moving the domain behind the worker's jobs (slice 3b) put it in a package
 * the API and the worker share, so the rejection carries the wire-facing
 * facts — the status, the stable code, the field errors — and the API maps
 * it onto its localized ErrorBody at the route boundary.
 */
export class BudgetError extends Error {
  readonly statusCode: number;
  readonly code:
    | "unprocessable"
    | "not_found"
    | "state_conflict"
    | "setup_required";
  readonly fieldErrors?: FieldError[];

  constructor(
    statusCode: number,
    code: BudgetError["code"],
    options: { fieldErrors?: FieldError[] } = {},
  ) {
    super(`${statusCode} ${code}`);
    this.name = "BudgetError";
    this.statusCode = statusCode;
    this.code = code;
    this.fieldErrors = options.fieldErrors;
  }
}
