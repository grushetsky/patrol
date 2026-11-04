/**
 * One invalid field in a rejected request, mirroring the contract's
 * Patrol.Http.FieldError: a JSON pointer plus a human-readable cause.
 */
export interface FieldError {
  path: string;
  message: string;
}

/** Thrown when a request body fails its JSON Schema; mapped to 400 by the error handler. */
export class ValidationError extends Error {
  readonly statusCode = 400 as const;
  readonly code = "validation_failed" as const;
  readonly fieldErrors: FieldError[];

  constructor(
    fieldErrors: FieldError[],
    message = "The request body is invalid.",
  ) {
    super(message);
    this.name = "ValidationError";
    this.fieldErrors = fieldErrors;
  }
}
