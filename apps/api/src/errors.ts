import type { FieldIssue } from "./contract.js";

/** A domain error that maps to the contract's error body. */
export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly retryAfterSeconds?: number,
    readonly extras: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** A request body that failed contract validation. */
export class ValidationError extends Error {
  readonly issues: FieldIssue[];

  constructor(issues: FieldIssue[]) {
    super("The request body is invalid.");
    this.name = "ValidationError";
    this.issues = issues;
  }
}

/** A well-formed request that breaks a domain rule, answered with 422. */
export function unprocessable(
  issues: FieldIssue[],
  message = "The request breaks a domain rule.",
): ApiError {
  return new ApiError(422, "validation_failed", message, undefined, {
    fieldErrors: issues,
  });
}
