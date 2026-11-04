export type OperatorRole = "administrator" | "operator";
export type OperatorState = "invited" | "active" | "disabled";
export type InterfaceLanguage = "en" | "ru";

export interface OperatorRecord {
  id: string;
  email: string;
  role: OperatorRole;
  state: OperatorState;
  preferredLanguage: InterfaceLanguage | null;
  passwordHash: string | null;
  totpSecret: string | null;
  pendingTotpSecret: string | null;
  totpEnrolledAt: string | null;
  lastSignInAt: string | null;
  failedAttempts: number;
  lockedUntil: string | null;
  disabledAt: string | null;
  disabledBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SessionRecord {
  id: string;
  operatorId: string;
  tokenSha256: string;
  createdAt: string;
  lastSeenAt: string;
  idleExpiresAt: string;
  absoluteExpiresAt: string;
  revokedAt: string | null;
  userAgent: string | null;
  coarseIp: string | null;
}

export function toOperator(row: Record<string, unknown>): OperatorRecord {
  return {
    id: String(row.id),
    email: String(row.email),
    role: String(row.role) as OperatorRole,
    state: String(row.state) as OperatorState,
    preferredLanguage: (row.preferred_language as InterfaceLanguage | null) ?? null,
    passwordHash: (row.password_hash as string | null) ?? null,
    totpSecret: (row.totp_secret as string | null) ?? null,
    pendingTotpSecret: (row.pending_totp_secret as string | null) ?? null,
    totpEnrolledAt: iso(row.totp_enrolled_at),
    lastSignInAt: iso(row.last_sign_in_at),
    failedAttempts: Number(row.failed_attempts ?? 0),
    lockedUntil: iso(row.locked_until),
    disabledAt: iso(row.disabled_at),
    disabledBy: (row.disabled_by as string | null) ?? null,
    createdAt: iso(row.created_at) ?? "",
    updatedAt: iso(row.updated_at) ?? "",
  };
}

export function toSession(row: Record<string, unknown>): SessionRecord {
  return {
    id: String(row.id),
    operatorId: String(row.operator_id),
    tokenSha256: String(row.token_sha256),
    createdAt: iso(row.created_at) ?? "",
    lastSeenAt: iso(row.last_seen_at) ?? "",
    idleExpiresAt: iso(row.idle_expires_at) ?? "",
    absoluteExpiresAt: iso(row.absolute_expires_at) ?? "",
    revokedAt: iso(row.revoked_at),
    userAgent: (row.user_agent as string | null) ?? null,
    coarseIp: (row.coarse_ip as string | null) ?? null,
  };
}

/** The public operator shape the contract returns; credentials never leave. */
export function publicOperator(operator: OperatorRecord) {
  return {
    id: operator.id,
    email: operator.email,
    role: operator.role,
    state: operator.state,
    preferredLanguage: operator.preferredLanguage ?? undefined,
    createdAt: operator.createdAt,
    updatedAt: operator.updatedAt,
    lastSignInAt: operator.lastSignInAt ?? undefined,
    totpEnrolledAt: operator.totpEnrolledAt ?? undefined,
    disabledAt: operator.disabledAt ?? undefined,
    disabledBy: operator.disabledBy ?? undefined,
  };
}

export function publicSession(session: SessionRecord) {
  return {
    id: session.id,
    createdAt: session.createdAt,
    lastSeenAt: session.lastSeenAt,
    idleExpiresAt: session.idleExpiresAt,
    absoluteExpiresAt: session.absoluteExpiresAt,
    userAgent: session.userAgent ?? undefined,
    coarseIp: session.coarseIp ?? undefined,
  };
}

function iso(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return new Date(value as string).toISOString();
}
