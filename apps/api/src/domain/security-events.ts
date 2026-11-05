import type { Pool, PoolClient } from "pg";

/**
 * Append-only security events (Authentication "Audit"), separate from the
 * domain audit trail. The kinds are the ones the design names: sign-in
 * success and failure, invitation create/revoke/accept, credential changes,
 * session revocation including an administrator's disable, lockout, and
 * recovery-code use. One deliberate extension beyond that authentication
 * scope: `candidate_reopened`, the operator's overturn of a colleague's
 * dismissal with their reason — the reopen has no row of its own anywhere
 * else, and this log is where an audit wants a name on it. `detail` never
 * carries a password, a TOTP secret, a session token, or a recovery code.
 */
export type SecurityEventKind =
  | "sign_in_succeeded"
  | "sign_in_failed"
  | "account_locked"
  | "ip_throttled"
  | "invitation_created"
  | "invitation_revoked"
  | "invitation_accepted"
  | "bootstrap_completed"
  | "password_changed"
  | "email_changed"
  | "role_changed"
  | "totp_enrolled"
  | "totp_reenrolled"
  | "credential_reset"
  | "operator_disabled"
  | "operator_reinstated"
  | "session_revoked"
  | "recovery_code_used"
  | "recovery_codes_issued"
  | "candidate_reopened";

export interface SecurityEventInput {
  operatorId?: string | null;
  kind: SecurityEventKind;
  detail?: Record<string, unknown>;
  coarseIp?: string | null;
  userAgent?: string | null;
}

/** Records one security event. Never throws upward silently: awaited by callers in the same transaction. */
export async function recordSecurityEvent(
  client: Pool | PoolClient,
  input: SecurityEventInput,
  at: Date,
): Promise<void> {
  await client.query(
    `insert into security_events (operator_id, kind, detail, coarse_ip, user_agent, created_at)
     values ($1, $2, $3::jsonb, $4, $5, $6)`,
    [
      input.operatorId ?? null,
      input.kind,
      JSON.stringify(input.detail ?? {}),
      input.coarseIp ?? null,
      input.userAgent ?? null,
      at.toISOString(),
    ],
  );
}
