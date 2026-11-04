import type { MessageKey } from "@patrol/i18n";

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

/** The ErrorBody codes this API emits. */
export type ApiErrorCode =
  | "validation_failed"
  | "unauthenticated"
  | "invalid_credentials"
  | "invalid_second_factor"
  | "challenge_expired"
  | "account_locked"
  | "invitation_invalid"
  | "invitation_expired"
  | "forbidden"
  | "not_found"
  | "state_conflict"
  | "duplicate_entity"
  | "last_administrator"
  | "setup_required"
  | "schema_mismatch"
  | "rate_limited"
  | "internal_error";

/** The catalogue key each code renders through. */
const MESSAGE_KEYS: Record<ApiErrorCode, MessageKey> = {
  validation_failed: "errors.validation_failed",
  unauthenticated: "errors.unauthenticated",
  invalid_credentials: "errors.invalid_credentials",
  invalid_second_factor: "errors.invalid_second_factor",
  challenge_expired: "errors.challenge_expired",
  account_locked: "errors.account_locked",
  invitation_invalid: "errors.invitation_invalid",
  invitation_expired: "errors.invitation_expired",
  forbidden: "errors.forbidden",
  not_found: "errors.not_found",
  state_conflict: "errors.state_conflict",
  duplicate_entity: "errors.duplicate_entity",
  last_administrator: "errors.last_administrator",
  setup_required: "errors.setup_required",
  schema_mismatch: "errors.schema_mismatch",
  rate_limited: "errors.rate_limited",
  internal_error: "errors.internal_error",
};

/**
 * A domain rejection the error handler maps onto the contract's ErrorBody:
 * the status, the stable code, the localized display message, and the
 * optional retryAfterSeconds and fieldErrors the body carries.
 */
export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: ApiErrorCode;
  readonly retryAfterSeconds?: number;
  readonly fieldErrors?: FieldError[];

  constructor(
    statusCode: number,
    code: ApiErrorCode,
    options: { retryAfterSeconds?: number; fieldErrors?: FieldError[] } = {},
  ) {
    super(`${statusCode} ${code}`);
    this.name = "ApiError";
    this.statusCode = statusCode;
    this.code = code;
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.fieldErrors = options.fieldErrors;
  }

  /** The catalogue key the display message resolves through. */
  get messageKey(): MessageKey {
    return MESSAGE_KEYS[this.code];
  }
}
