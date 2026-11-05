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
  | "unprocessable"
  | "duplicate_title"
  | "duplicate_entity"
  | "violation_reserved"
  | "notice_not_withdrawable"
  | "recipient_ineligible"
  | "grouping_limit_exceeded"
  | "last_administrator"
  | "host_objection"
  | "bytes_purged"
  | "allowlist_hit"
  | "evidence_required"
  | "wrong_work_requires_title"
  | "note_required"
  | "setup_required"
  | "schema_mismatch"
  | "rate_limited"
  | "upstream_unavailable"
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
  unprocessable: "errors.unprocessable",
  duplicate_title: "errors.duplicate_title",
  duplicate_entity: "errors.duplicate_entity",
  violation_reserved: "errors.violation_reserved",
  notice_not_withdrawable: "errors.notice_not_withdrawable",
  recipient_ineligible: "errors.recipient_ineligible",
  grouping_limit_exceeded: "errors.grouping_limit_exceeded",
  last_administrator: "errors.last_administrator",
  host_objection: "errors.host_objection",
  bytes_purged: "errors.bytes_purged",
  allowlist_hit: "errors.allowlist_hit",
  evidence_required: "errors.evidence_required",
  wrong_work_requires_title: "errors.wrong_work_requires_title",
  note_required: "errors.note_required",
  setup_required: "errors.setup_required",
  schema_mismatch: "errors.schema_mismatch",
  rate_limited: "errors.rate_limited",
  upstream_unavailable: "errors.upstream_unavailable",
  internal_error: "errors.internal_error",
};

/**
 * A domain rejection the error handler maps onto the contract's ErrorBody
 * (ConflictBody where the code is a conflict): the status, the stable code,
 * the localized display message, and the optional retryAfterSeconds,
 * fieldErrors, and conflict pointers the body carries.
 */
export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: ApiErrorCode;
  readonly retryAfterSeconds?: number;
  readonly fieldErrors?: FieldError[];
  /** The tracked title that already exists, on a blocked create. */
  readonly existingTitleId?: string;
  /** The title a merge was blocked on, when a guard refused it. */
  readonly blockingTitleId?: string;
  /**
   * The objection suspending the host, on a capture refused with 409
   * host_objection (the contract's ConflictBody pointer).
   */
  readonly hostObjectionId?: string;
  /**
   * The record's state at the moment of the conflict, on a lifecycle
   * conflict (the contract's ConflictBody.currentState).
   */
  readonly currentState?: string;
  /**
   * The violations another active notice reserves, on a draft refused with
   * 409 violation_reserved (the contract's ConflictBody pointer).
   */
  readonly conflictingViolationIds?: string[];
  /** The notice that already reserves the violations or the pair. */
  readonly existingNoticeId?: string;

  constructor(
    statusCode: number,
    code: ApiErrorCode,
    options: {
      retryAfterSeconds?: number;
      fieldErrors?: FieldError[];
      existingTitleId?: string;
      blockingTitleId?: string;
      hostObjectionId?: string;
      currentState?: string;
      conflictingViolationIds?: string[];
      existingNoticeId?: string;
    } = {},
  ) {
    super(`${statusCode} ${code}`);
    this.name = "ApiError";
    this.statusCode = statusCode;
    this.code = code;
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.fieldErrors = options.fieldErrors;
    this.existingTitleId = options.existingTitleId;
    this.blockingTitleId = options.blockingTitleId;
    this.hostObjectionId = options.hostObjectionId;
    this.currentState = options.currentState;
    this.conflictingViolationIds = options.conflictingViolationIds;
    this.existingNoticeId = options.existingNoticeId;
  }

  /** The catalogue key the display message resolves through. */
  get messageKey(): MessageKey {
    return MESSAGE_KEYS[this.code];
  }
}
