namespace Patrol.Http;

using TypeSpec.Http;
using TypeSpec.OpenAPI;
using Patrol.Domain;

// Operator administration: accounts, invitations, and the credentials an
// administrator can reset. An administrator inherits every operator capability;
// these operations are the ones only an administrator holds.

@doc("The account states an administrator may set. The invited state belongs to the invitation, not to administration.")
enum OperatorAdministrationState {
  Active: "active",
  Disabled: "disabled",
}

@doc("A page of operator accounts.")
model OperatorPage {
  @doc("The accounts on this page, by email.")
  items: Operator[];

  @doc("How many accounts exist in total.")
  total: int32;

  @doc("The one-based page number.")
  page: int32;

  @doc("The page size.")
  pageSize: int32;
}

@doc("A role change or a disable. Disabling and every role change revoke the account's sessions.")
model OperatorPatchRequest {
  @doc("The role the account should hold. Omit to leave it unchanged.")
  role?: OperatorRole;

  @doc("The account state. Only active and disabled can be set. Omit to leave it unchanged.")
  state?: OperatorAdministrationState;
}

@doc("An administrator's request to reset an operator's password and second factor, forcing re-enrolment.")
model CredentialResetRequest {
  @doc("Why the credentials are being reset, recorded in the security audit.")
  reason?: string;
}

@doc("The result of an administrative credential reset.")
model CredentialReset {
  @doc("The operator whose credentials were reset.")
  operator: Operator;

  @doc("When the reset was recorded.")
  resetAt: utcDateTime;

  @doc("Whether a re-enrolment ceremony is now required before the account can sign in again.")
  reenrollmentRequired: boolean;
}

@doc("The credentials were reset and the account must re-enrol.")
model CredentialResetAccepted {
  @statusCode statusCode: 202;
  @body body: CredentialReset;
}

@doc("The derived state of an invitation.")
enum InvitationState {
  Pending: "pending",
  Accepted: "accepted",
  Revoked: "revoked",
  Expired: "expired",
}

@doc("An invitation with the state the list renders.")
model InvitationView {
  @doc("The invitation record.")
  invitation: Invitation;

  @doc("The derived state: pending, accepted, revoked, or expired.")
  state: InvitationState;
}

@doc("A page of invitations.")
model InvitationPage {
  @doc("The invitations on this page, newest first.")
  items: InvitationView[];

  @doc("How many invitations match the filter in total.")
  total: int32;

  @doc("The one-based page number.")
  page: int32;

  @doc("The page size.")
  pageSize: int32;
}

@doc("An invitation for a new operator account, valid twenty-four hours.")
model CreateInvitationRequest {
  @doc("The invited email address.")
  email: Email;

  @doc("The role the accepted account will hold.")
  role: OperatorRole;
}

@doc("The invitation was created and its token emailed.")
model InvitationCreated {
  @statusCode statusCode: 201;
  @body body: InvitationView;
}

@doc("One authentication security event. Events never carry a password, TOTP secret, session token, or recovery code.")
model SecurityEventView {
  @doc("The event's identifier.")
  id: string;

  @doc("The event kind, such as sign_in or password_accepted.")
  kind: string;

  @doc("The account the event concerns, when one was known.")
  operatorId?: OperatorId;

  @doc("The email the event concerned, when one was known.")
  email?: Email;

  @doc("The coarse client IP recorded with the event.")
  coarseIp?: string;

  @doc("The client user agent recorded with the event.")
  userAgent?: string;

  @doc("The event's supplementary detail, when it has any.")
  detail?: string;

  @doc("When the event happened.")
  createdAt: utcDateTime;
}

@doc("A page of security events, newest first.")
model SecurityEventPage {
  @doc("The events on this page.")
  items: SecurityEventView[];

  @doc("How many events match the filter in total.")
  total: int32;

  @doc("The one-based page number.")
  page: int32;

  @doc("The page size.")
  pageSize: int32;
}

@doc("Operator accounts and their credentials. Every operation here requires the administrator role.")
@tag("Operators")
@useAuth(SessionCookie)
@route("/operators")
interface Operators {
  @doc("Every operator account, by email.")
  @extension("x-patrol-roles", #["administrator"])
  @get
  op list(...PageRequest): OperatorPage | ReadErrors;

  @doc("Change an account's role, disable it, or reinstate it. The last administrator cannot be demoted or disabled.")
  @extension("x-patrol-roles", #["administrator"])
  @patch
  @route("/{operatorId}")
  op update(...CsrfToken, @path operatorId: OperatorId, @body body: OperatorPatchRequest): Operator | ResourceMutationErrors;

  @doc("Reset an operator's password and second factor, forcing re-enrolment and revoking every session.")
  @extension("x-patrol-roles", #["administrator"])
  @post
  @route("/{operatorId}/credential-reset")
  op resetCredentials(...CsrfToken, @path operatorId: OperatorId, @body body: CredentialResetRequest): CredentialResetAccepted | ResourceMutationErrors;

  @doc("Any operator's sessions, newest first.")
  @extension("x-patrol-roles", #["administrator"])
  @get
  @route("/{operatorId}/sessions")
  op listSessions(...PageRequest, @path operatorId: OperatorId): OperatorSessionPage | ResourceErrors;

  @doc("Revoke one of any operator's sessions.")
  @extension("x-patrol-roles", #["administrator"])
  @delete
  @route("/{operatorId}/sessions/{sessionId}")
  op revokeSession(...CsrfToken, @path operatorId: OperatorId, @path sessionId: SessionId): NoContent | ResourceMutationErrors;
}

@doc("Invitations, which only an administrator issues or revokes.")
@tag("Operators")
@useAuth(SessionCookie)
@route("/invitations")
interface Invitations {
  @doc("Every invitation, newest first, with its derived state.")
  @extension("x-patrol-roles", #["administrator"])
  @get
  op list(...PageRequest): InvitationPage | ReadErrors;

  @doc("Invite an operator by email. The token is single-use, valid for twenty-four hours, and stored only as a hash.")
  @extension("x-patrol-roles", #["administrator"])
  @post
  op create(...CsrfToken, @body body: CreateInvitationRequest): InvitationCreated | MutationErrors;

  @doc("Revoke an invitation before it is accepted.")
  @extension("x-patrol-roles", #["administrator"])
  @delete
  @route("/{invitationId}")
  op revoke(...CsrfToken, @path invitationId: InvitationId): NoContent | ResourceMutationErrors;
}

@doc("The append-only authentication audit, readable by administrators.")
@tag("Operators")
@useAuth(SessionCookie)
@route("/security-events")
interface SecurityEvents {
  @doc("Security events, newest first.")
  @extension("x-patrol-roles", #["administrator"])
  @get
  op list(...PageRequest, @query kind?: string, @query operatorId?: OperatorId): SecurityEventPage | ReadErrors;
}
