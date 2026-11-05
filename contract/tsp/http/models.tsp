namespace Patrol.Http;

using TypeSpec.Http;
using TypeSpec.OpenAPI;
using Patrol.Domain;

// Shared HTTP vocabulary: authentication, errors, paging, and the read models
// several resources reuse. Domain models are referenced, never duplicated.

// The session cookie the API sets at sign-in and validates against the session table on every authenticated request.
alias SessionCookie = ApiKeyAuth<ApiKeyLocation.cookie, "__Host-patrol_session">;

@doc("The double-submit token every state-changing request carries in a header, paired with the cookie a browser holds.")
model CsrfToken {
  @doc("The token from the session payload, echoed in the header and compared with the cookie server side.")
  @header("X-Patrol-CSRF") csrfToken: string;
}

@doc("One-based paging for list operations. The server defaults to the first page of fifty items and caps the page size at two hundred.")
model PageRequest {
  @doc("The one-based page number. Defaults to one.")
  @query page?: int32;

  @doc("Items per page, at most two hundred. Defaults to fifty.")
  @query pageSize?: int32;
}

@doc("A stable, machine-readable error code. The UI branches on it; the message is for a human.")
enum ErrorCode {
  ValidationFailed: "validation_failed",
  Unauthenticated: "unauthenticated",
  InvalidCredentials: "invalid_credentials",
  InvalidSecondFactor: "invalid_second_factor",
  ChallengeExpired: "challenge_expired",
  AccountLocked: "account_locked",
  InvitationInvalid: "invitation_invalid",
  InvitationExpired: "invitation_expired",
  Forbidden: "forbidden",
  NotFound: "not_found",
  StateConflict: "state_conflict",
  DuplicateTitle: "duplicate_title",
  DuplicateEntity: "duplicate_entity",
  ViolationReserved: "violation_reserved",
  ViolationNeedsReview: "violation_needs_review",
  NoticeNotWithdrawable: "notice_not_withdrawable",
  SubmissionNotPending: "submission_not_pending",
  LastAdministrator: "last_administrator",
  QuotaExhausted: "quota_exhausted",
  ProfilePaused: "profile_paused",
  RecipientIneligible: "recipient_ineligible",
  GroupingLimitExceeded: "grouping_limit_exceeded",
  AllowlistHit: "allowlist_hit",
  HostObjection: "host_objection",
  WrongWorkRequiresTitle: "wrong_work_requires_title",
  NoteRequired: "note_required",
  EvidenceRequired: "evidence_required",
  EmptyCitation: "empty_citation",
  CaptureUnavailable: "capture_unavailable",
  PackNotReady: "pack_not_ready",
  BytesPurged: "bytes_purged",
  SetupRequired: "setup_required",
  SchemaMismatch: "schema_mismatch",
  RateLimited: "rate_limited",
  UpstreamUnavailable: "upstream_unavailable",
  NotSupported: "not_supported",
  InternalError: "internal_error",
}

@doc("One invalid field in a rejected request.")
model FieldError {
  @doc("The JSON pointer of the offending field, or the field name where the body is flat.")
  path: string;

  @doc("What is wrong with the field.")
  message: string;
}

@doc("The body every error response carries, whatever its status code.")
model ErrorBody {
  @doc("The stable code the UI branches on.")
  code: ErrorCode;

  @doc("A human-readable explanation, safe to show an operator.")
  message: string;

  @doc("The fields that failed validation, present when the code is validation_failed.")
  fieldErrors?: FieldError[];

  @doc("How long to wait before retrying, present on a rate-limited response.")
  retryAfterSeconds?: int32;
}

@doc("The request body is malformed or fails schema validation.")
model BadRequest {
  @statusCode statusCode: 400;
  ...ErrorBody;
}

@doc("No valid session, or the credentials offered are wrong.")
model Unauthenticated {
  @statusCode statusCode: 401;
  ...ErrorBody;
}

@doc("The session is valid but the operator's role does not grant the operation.")
model Forbidden {
  @statusCode statusCode: 403;
  ...ErrorBody;
}

@doc("The addressed record does not exist, or the session cannot see it.")
model NotFound {
  @statusCode statusCode: 404;
  ...ErrorBody;
}

@doc("The request conflicts with the record's current state or with an existing record.")
model ConflictBody {
  ...ErrorBody;

  @doc("The tracked title that already exists, present when a create was blocked by a duplicate.")
  existingTitleId?: TrackedTitleId;

  @doc("The title that already has candidates, present when a merge was blocked.")
  blockingTitleId?: TrackedTitleId;

  @doc("The violations already reserved by an active notice, present when a draft was blocked.")
  conflictingViolationIds?: ViolationId[];

  @doc("The notice that already reserves the violation, present when a draft was blocked.")
  existingNoticeId?: NoticeId;

  @doc("The record's state at the moment of the conflict, present on a lifecycle conflict.")
  currentState?: string;

  @doc("The objection suspending captures of the request's host, present when a capture was refused.")
  hostObjectionId?: HostObjectionId;
}

@doc("The request conflicts with the record's current state or with an existing record.")
model Conflict {
  @statusCode statusCode: 409;
  ...ConflictBody;
}

@doc("The request is well formed but breaks a domain rule, such as a recipient's URL cap or an exhausted quota.")
model Unprocessable {
  @statusCode statusCode: 422;
  ...ErrorBody;
}

@doc("Too many attempts, such as a locked account or a throttled address.")
model RateLimited {
  @statusCode statusCode: 429;
  ...ErrorBody;
}

@doc("The deployment is not bootstrapped, or its schema version does not match the running image.")
model ServiceUnavailable {
  @statusCode statusCode: 503;
  ...ErrorBody;
}

@doc("The artifact's bytes were purged under retention while its record survives.")
model Gone {
  @statusCode statusCode: 410;
  ...ErrorBody;
}

@doc("A successful write that returns no body.")
model NoContent {
  @statusCode statusCode: 204;
}

// The errors any authenticated read can return.
alias ReadErrors = Unauthenticated | Forbidden | RateLimited | ServiceUnavailable;

// The errors any authenticated mutation can return.
alias MutationErrors = ReadErrors | BadRequest | Conflict | Unprocessable;

// The errors any authenticated read of one record can return.
alias ResourceErrors = ReadErrors | NotFound;

// The errors any authenticated mutation of one record can return.
alias ResourceMutationErrors = MutationErrors | NotFound;

// The errors an evidence read can return, including purged bytes.
alias EvidenceErrors = ReadErrors | NotFound | Gone;

@doc("A small reference to a notice, for records that point at one.")
model NoticeRef {
  @doc("The notice's identifier.")
  id: NoticeId;

  @doc("The recipient the notice addresses.")
  recipient: Recipient;

  @doc("The derived status the UI renders.")
  status: NoticeStatus;

  @doc("When the draft was created.")
  createdAt: utcDateTime;
}

@doc("The status the notice list and detail render, derived from the notice and its submission lifecycles.")
enum NoticeStatus {
  Draft: "draft",
  Approved: "approved",
  Delivered: "delivered",
  Acknowledged: "acknowledged",
  Rejected: "rejected",
  Failed: "failed",
  Withdrawn: "withdrawn",
  Superseded: "superseded",
}

@doc("One immutable capture as the UI shows it, without the full artifact manifest.")
model EvidenceSummary {
  @doc("The capture's identifier.")
  id: EvidenceId;

  @doc("Why the capture was taken.")
  reason: CaptureReason;

  @doc("What the capture observed.")
  outcome: CaptureOutcome;

  @doc("When the page was observed.")
  observedAt: utcDateTime;

  @doc("The final response's status, when one was received.")
  httpStatus?: int32;

  @doc("The landing page's final URL, absent when no response was received.")
  finalUrl?: Url;

  @doc("The landing page's host, absent when no response was received.")
  host?: Host;

  @doc("The viewport thumbnail, present when the capture produced one.")
  thumbnail?: ArtifactSummary;

  @doc("Whether the bytes were purged under retention.")
  purged: boolean;
}

@doc("One artifact's metadata, keyed by its content hash.")
model ArtifactSummary {
  @doc("Which artifact this is.")
  kind: EvidenceArtifactKind;

  @doc("The SHA-256 of the bytes, which is also the object key.")
  sha256: Sha256;

  @doc("The artifact's content type.")
  contentType: string;

  @doc("The artifact's size in bytes.")
  byteSize: int32;

  @doc("The artifact's width, for image artifacts.")
  width?: int32;

  @doc("The artifact's height, for image artifacts.")
  height?: int32;

  @doc("Whether the artifact was truncated at a ceiling.")
  truncated: boolean;
}

@doc("One allowlist entry as a review row shows it.")
model AllowlistEntrySummary {
  @doc("The entry's identifier.")
  id: AllowlistEntryId;

  @doc("Why the host or URL prefix is allowed.")
  kind: AllowlistKind;

  @doc("The value the entry matches.")
  value: string;

  @doc("What the entry covers.")
  scope: AllowlistScope;

  @doc("The territory the entry applies to, when it is territory-specific.")
  territory?: Territory;
}
