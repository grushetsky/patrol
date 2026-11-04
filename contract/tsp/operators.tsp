namespace Patrol.Domain;

// Operators and their sessions. Credential material — password hashes, TOTP
// secrets, recovery-code hashes, session tokens — is deliberately absent from
// the contract: it never crosses the domain or HTTP surface and lives only in
// the API's own tables.

@doc("An authenticated human who reviews candidates, approves notices, and makes submissions.")
model Operator {
  @doc("Patrol's own identifier.")
  id: OperatorId;

  @doc("The operator's email address, which is also their sign-in identifier and is unique.")
  email: Email;

  @doc("The operator's role.")
  role: OperatorRole;

  @doc("The account's state.")
  state: OperatorState;

  @doc("The interface language the operator chose. Absent until the first choice, when the API follows the request's language or English.")
  preferredLanguage?: InterfaceLanguage;

  @doc("When the account was created, by bootstrap or invitation.")
  createdAt: utcDateTime;

  @doc("When the account was last edited.")
  updatedAt: utcDateTime;

  @doc("When the operator last signed in successfully.")
  lastSignInAt?: utcDateTime;

  @doc("When the second factor was enrolled.")
  totpEnrolledAt?: utcDateTime;

  @doc("When the account was disabled.")
  disabledAt?: utcDateTime;

  @doc("The administrator who disabled the account.")
  disabledBy?: OperatorId;
}

@doc("A single-use invitation for a new operator account, valid twenty-four hours.")
model Invitation {
  @doc("Patrol's own identifier.")
  id: InvitationId;

  @doc("The invited email address.")
  email: Email;

  @doc("The role the account will hold.")
  role: OperatorRole;

  @doc("The administrator who issued the invitation.")
  invitedBy: OperatorId;

  @doc("When the invitation was issued.")
  createdAt: utcDateTime;

  @doc("When the invitation expires.")
  expiresAt: utcDateTime;

  @doc("When the invitation was accepted.")
  acceptedAt?: utcDateTime;

  @doc("When the invitation was revoked before use.")
  revokedAt?: utcDateTime;
}

@doc("A server-side session row. The token itself is never stored, only its hash.")
model OperatorSession {
  @doc("Patrol's own identifier.")
  id: SessionId;

  @doc("The operator the session belongs to.")
  operatorId: OperatorId;

  @doc("The SHA-256 of the session token.")
  tokenSha256: Sha256;

  @doc("When the session was created.")
  createdAt: utcDateTime;

  @doc("When the session was last seen.")
  lastSeenAt: utcDateTime;

  @doc("The session's absolute expiry, seven days after creation.")
  absoluteExpiresAt: utcDateTime;

  @doc("When the session was revoked.")
  revokedAt?: utcDateTime;

  @doc("The user agent the session was created under.")
  userAgent: string;

  @doc("The coarse IP address the session was created from.")
  coarseIp?: string;
}
