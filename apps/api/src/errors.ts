import type { FieldIssue } from "./contract.js";

/** A request body that failed contract validation. */
export class ValidationError extends Error {
  readonly issues: FieldIssue[];

  constructor(issues: FieldIssue[]) {
    super("The request body is invalid.");
    this.name = "ValidationError";
    this.issues = issues;
  }
}
