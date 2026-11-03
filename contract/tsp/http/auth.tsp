namespace Patrol.Http;

using TypeSpec.Http;
using TypeSpec.OpenAPI;
using Patrol.Domain;

// Authentication, sessions, and the enrolment ceremony that both the bootstrap
// administrator and every invited operator pass through. Credential material is
// never returned: the secret is the operator's to scan, and the session token
// exists only as a cookie and a hash.

@doc("The double-submit token, paired with a cookie the browser holds.")
model CsrfTokenPayload {
  @doc("The token to echo in `X-Patrol-CSRF` on every state-changing request.")
  csrfToken: string;
}

@doc("A freshly issued CSRF token and the cookie that pairs with it.")
model CsrfTokenIssued {
  @statusCode statusCode: 200;

  @doc("The CSRF cookie the browser stores.")
  @header("Set-Cookie") setCookie: string;

  @body body: CsrfTokenPayload;
}

@doc("The bootstrap token from the container logs and the password the first administrator chooses.")
model SetupRequest {
  @doc("The one-time setup token printed by `patrol bootstrap`.")
  token: string;

  @doc("The password, at least twelve characters and checked against the breached-password list.")
  @minLength(12)
  password: string;
}

@doc("The invitation token from the invitation email and the password the invited operator chooses.")
model InvitationAcceptanceRequest {
  @doc("The password, at least twelve characters and checked against the breached-password list.")
  @minLength(12)
  password: string;
}

@doc("A short-lived token that authorises the TOTP enrolment ceremony and nothing else.")
model EnrollmentCeremony {
  @doc("The account the ceremony will activate.")
  operator: Operator;

  @doc("The token the enrolment operations carry.")
  enrollmentToken: string;

  @doc("When the ceremony token expires.")
  expiresAt: utcDateTime;
}

@doc("The account was created in the invited state and must enrol a second factor.")
model EnrollmentRequired {
  @statusCode statusCode: 201;
  @body body: EnrollmentCeremony;
}

@doc("An email address and password, the first of the two sign-in factors.")
model SignInRequest {
  @doc("The account's email address.")
  email: Email;

  @doc("The account's password.")
  password: string;
}

@doc("The second-factor challenge a correct password produces.")
model SecondFactorChallenge {
  @doc("The challenge to present with the second factor.")
  challengeId: string;

  @doc("When the challenge expires.")
  expiresAt: utcDateTime;
}

@doc("The password was correct and a second factor is required.")
model SecondFactorRequired {
  @statusCode statusCode: 202;
  @body body: SecondFactorChallenge;
}

@doc("The second factor the operator presents.")
enum SecondFactorMethod {
  Totp: "totp",
  RecoveryCode: "recovery_code",
}

@doc("The second factor an operator presents for a pending challenge.")
model SecondFactorRequest {
  @doc("The challenge the password produced.")
  challengeId: string;

  @doc("A six-digit TOTP code, or a single-use recovery code.")
  code: string;

  @doc("Whether the code is a TOTP code or a recovery code.")
  method: SecondFactorMethod;
}

@doc("One server-side session as an operator sees it. The token itself is never exposed.")
model SessionView {
  @doc("The session's identifier.")
  id: SessionId;

  @doc("When the session was created.")
  createdAt: utcDateTime;

  @doc("When the session was last seen.")
  lastSeenAt: utcDateTime;

  @doc("When eight hours of inactivity end the session.")
  idleExpiresAt: utcDateTime;

  @doc("The session's absolute expiry, seven days after creation.")
  absoluteExpiresAt: utcDateTime;

  @doc("The user agent the session was created under.")
  userAgent: string;

  @doc("The coarse IP address the session was created from.")
  coarseIp?: string;
}

@doc("An authenticated operator, the session they hold, and the token their mutations carry.")
model AuthenticatedSession {
  @doc("The signed-in operator.")
  operator: Operator;

  @doc("The session the cookie names.")
  session: SessionView;

  @doc("The double-submit token for this session.")
  csrfToken: string;

  @doc("How many recovery codes remain unused, present after a recovery-code sign-in.")
  recoveryCodesRemaining?: int32;
}

@doc("Sign-in succeeded and the session cookie is set.")
model SignedIn {
  @statusCode statusCode: 200;

  @doc("The session cookie. The API sets it and the browser stores it.")
  @header("Set-Cookie") setCookie: string;

  @body body: AuthenticatedSession;
}

@doc("The token that authorises a TOTP enrolment ceremony.")
model TotpEnrollmentRequest {
  @doc("The enrollment token from the setup or invitation ceremony.")
  enrollmentToken: string;
}

@doc("The secret to enrol, shown once.")
model TotpEnrollment {
  @doc("The shared secret, base32.")
  secret: string;

  @doc("The otpauth URI the authenticator app scans.")
  otpauthUri: string;

  @doc("When the enrolment expires and a new one must be started.")
  expiresAt: utcDateTime;
}

@doc("The code from the authenticator app that completes enrolment.")
model TotpEnrollmentConfirmation {
  @doc("The enrollment token from the setup or invitation ceremony.")
  enrollmentToken: string;

  @doc("The six-digit code the authenticator app shows.")
  code: string;
}

@doc("A completed registration: a session, the recovery codes, and the CSRF token.")
model RegistrationCompleted {
  @doc("The now-active operator.")
  operator: Operator;

  @doc("The session the cookie names.")
  session: SessionView;

  @doc("The double-submit token for this session.")
  csrfToken: string;

  @doc("The ten single-use recovery codes, shown once and never again.")
  recoveryCodes: string[];
}

@doc("Registration completed and the session cookie is set.")
model Registered {
  @statusCode statusCode: 201;

  @doc("The session cookie. The API sets it and the browser stores it.")
  @header("Set-Cookie") setCookie: string;

  @body body: RegistrationCompleted;
}

@doc("The password and current code that authorise re-enrolling a second factor.")
model ReenrollmentRequest {
  @doc("The account's current password.")
  password: string;

  @doc("The current six-digit TOTP code.")
  currentCode: string;
}

@doc("The new code that completes re-enrolment.")
model ReenrollmentConfirmation {
  @doc("The six-digit code from the new authenticator entry.")
  code: string;
}

@doc("A fresh set of ten single-use recovery codes, shown once.")
model RecoveryCodesIssued {
  @doc("The new recovery codes, which replace every earlier code.")
  recoveryCodes: string[];
}

@doc("A password change. Both the current password and a fresh TOTP code are required.")
model PasswordChangeRequest {
  @doc("The account's current password.")
  currentPassword: string;

  @doc("The new password, at least twelve characters and checked against the breached-password list.")
  @minLength(12)
  newPassword: string;

  @doc("The current six-digit TOTP code.")
  currentCode: string;
}

@doc("An email change. The address is the sign-in identifier, so the current password and a fresh TOTP code are required.")
model EmailChangeRequest {
  @doc("The new email address.")
  newEmail: Email;

  @doc("The account's current password.")
  currentPassword: string;

  @doc("The current six-digit TOTP code.")
  currentCode: string;
}

@doc("A page of the signed-in operator's sessions.")
model OperatorSessionPage {
  @doc("The sessions on this page, newest first.")
  items: SessionView[];

  @doc("How many sessions the operator holds in total.")
  total: int32;

  @doc("The one-based page number.")
  page: int32;

  @doc("The page size.")
  pageSize: int32;
}

@doc("Sign-in, the enrolment ceremony, and the challenge that sits between them. Every state-changing operation requires the CSRF token.")
@tag("Authentication")
@route("/auth")
interface Authentication {
  @doc("Issue a CSRF token and its cookie, for the sign-in and setup forms.")
  @extension("x-patrol-roles", #["anonymous"])
  @get
  @route("/csrf")
  op csrf(): CsrfTokenIssued;

  @doc("Consume the bootstrap token, set the first administrator's password, and start the enrolment ceremony.")
  @extension("x-patrol-roles", #["anonymous"])
  @post
  @route("/setup")
  op setup(...CsrfToken, @body body: SetupRequest): EnrollmentRequired | BadRequest | Unauthenticated | Conflict | Unprocessable | ServiceUnavailable;

  @doc("Check the password and issue a second-factor challenge. Credentials are never accepted without the second factor.")
  @extension("x-patrol-roles", #["anonymous"])
  @post
  @route("/sign-in")
  op signIn(...CsrfToken, @body body: SignInRequest): SecondFactorRequired | BadRequest | Unauthenticated | RateLimited | ServiceUnavailable;

  @doc("Present the second factor for a pending challenge and receive the session cookie.")
  @extension("x-patrol-roles", #["anonymous"])
  @post
  @route("/second-factor")
  op secondFactor(...CsrfToken, @body body: SecondFactorRequest): SignedIn | BadRequest | Unauthenticated | RateLimited | ServiceUnavailable;

  @doc("Start the TOTP enrolment a setup or invitation ceremony requires.")
  @extension("x-patrol-roles", #["anonymous"])
  @post
  @route("/enrollment")
  op beginEnrollment(...CsrfToken, @body body: TotpEnrollmentRequest): TotpEnrollment | BadRequest | Unauthenticated | Unprocessable | ServiceUnavailable;

  @doc("Confirm the enrolment code, receive the recovery codes, and sign in.")
  @extension("x-patrol-roles", #["anonymous"])
  @post
  @route("/enrollment/confirmation")
  op confirmEnrollment(...CsrfToken, @body body: TotpEnrollmentConfirmation): Registered | BadRequest | Unauthenticated | Unprocessable | ServiceUnavailable;
}

@doc("The invitation link's acceptance step, before the operator has any account to sign in with.")
@tag("Authentication")
@route("/invitations/{token}")
interface InvitationAcceptance {
  @doc("Consume a single-use invitation, set the password, and start the enrolment ceremony.")
  @extension("x-patrol-roles", #["anonymous"])
  @post
  @route("/acceptance")
  op accept(...CsrfToken, @path token: string, @body body: InvitationAcceptanceRequest): EnrollmentRequired | BadRequest | Unauthenticated | Conflict | Unprocessable | ServiceUnavailable;
}

@doc("The signed-in operator's own session and credentials.")
@tag("Authentication")
@useAuth(SessionCookie)
@route("/auth")
interface Sessions {
  @doc("The operator and session behind the cookie, plus the CSRF token mutations carry.")
  @extension("x-patrol-roles", #["operator", "administrator"])
  @get
  @route("/session")
  op read(): AuthenticatedSession | ReadErrors;

  @doc("Delete the current session.")
  @extension("x-patrol-roles", #["operator", "administrator"])
  @delete
  @route("/session")
  op signOut(...CsrfToken): NoContent | MutationErrors;

  @doc("The operator's own sessions, newest first.")
  @extension("x-patrol-roles", #["operator", "administrator"])
  @get
  @route("/sessions")
  op listSessions(...PageRequest): OperatorSessionPage | ReadErrors;

  @doc("Revoke one of the operator's own sessions. Revoking another device requires its identifier from the list.")
  @extension("x-patrol-roles", #["operator", "administrator"])
  @delete
  @route("/sessions/{sessionId}")
  op revokeSession(...CsrfToken, @path sessionId: SessionId): NoContent | ResourceMutationErrors;

  @doc("Change the password. Every other session is revoked.")
  @extension("x-patrol-roles", #["operator", "administrator"])
  @post
  @route("/password")
  op changePassword(...CsrfToken, @body body: PasswordChangeRequest): NoContent | MutationErrors;

  @doc("Change the email address. Every other session is revoked.")
  @extension("x-patrol-roles", #["operator", "administrator"])
  @post
  @route("/email")
  op changeEmail(...CsrfToken, @body body: EmailChangeRequest): NoContent | MutationErrors;

  @doc("Start re-enrolling the second factor, authorised by the current password and code.")
  @extension("x-patrol-roles", #["operator", "administrator"])
  @post
  @route("/totp")
  op beginReenrollment(...CsrfToken, @body body: ReenrollmentRequest): TotpEnrollment | MutationErrors;

  @doc("Confirm the new second factor and receive fresh recovery codes. Other sessions are revoked.")
  @extension("x-patrol-roles", #["operator", "administrator"])
  @post
  @route("/totp/confirmation")
  op confirmReenrollment(...CsrfToken, @body body: ReenrollmentConfirmation): RecoveryCodesIssued | MutationErrors;
}
