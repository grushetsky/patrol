import type { Pool, PoolClient } from "pg";
import type { AppConfig } from "../config.js";
import { hashPassword } from "./password.js";
import type { BreachedPasswordList } from "./password.js";
import { newOpaqueToken, sha256Hex } from "./session.js";
import { INVITATION_TTL_MS } from "./bootstrap.js";
import { recordSecurityEvent } from "./security-events.js";
import { checkPasswordPolicy } from "./password.js";

/**
 * Invitations (implementation-rules "Invitations"): single-use, valid
 * twenty-four hours, stored only as a hash, revocable before use. The
 * bootstrap setup token is the first invitation; an administrator's
 * credential reset issues another. Consumption — by POST /auth/setup or
 * POST /invitations/{token}/acceptance — sets the password and opens the
 * TOTP enrolment ceremony.
 */

export interface InvitationRow {
  id: string;
  email: string;
  role: "operator" | "administrator";
  invitedBy: string | null;
  createdAt: Date;
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
}

export function mapInvitationRow(row: {
  id: string;
  email: string;
  role: "operator" | "administrator";
  invited_by: string | null;
  created_at: Date;
  expires_at: Date;
  accepted_at: Date | null;
  revoked_at: Date | null;
}): InvitationRow {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    invitedBy: row.invited_by,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    acceptedAt: row.accepted_at,
    revokedAt: row.revoked_at,
  };
}

/** The derived state the invitation list renders. */
export function invitationState(
  row: InvitationRow,
  now: Date,
): "pending" | "accepted" | "revoked" | "expired" {
  if (row.acceptedAt !== null) {
    return "accepted";
  }
  if (row.revokedAt !== null) {
    return "revoked";
  }
  if (row.expiresAt.getTime() <= now.getTime()) {
    return "expired";
  }
  return "pending";
}

export interface CreateInvitationInput {
  email: string;
  role: "operator" | "administrator";
  invitedBy: string;
}

/** Issues an invitation and returns its plaintext token exactly once. */
export async function createInvitation(
  client: PoolClient,
  config: AppConfig,
  input: CreateInvitationInput,
): Promise<{ row: InvitationRow; token: string }> {
  const token = newOpaqueToken();
  const now = config.now();
  const result = await client.query(
    `insert into invitations (email, role, token_hash, invited_by, expires_at, created_at)
     values ($1, $2, $3, $4, $5, $6)
     returning id, email, role, invited_by, created_at, expires_at, accepted_at, revoked_at`,
    [
      input.email,
      input.role,
      sha256Hex(token),
      input.invitedBy,
      new Date(now.getTime() + INVITATION_TTL_MS).toISOString(),
      now.toISOString(),
    ],
  );
  return { row: mapInvitationRow(result.rows[0]), token };
}

export type ConsumeInvitationFailure =
  | { kind: "invalid" }
  | { kind: "expired" }
  | { kind: "password_too_short" }
  | { kind: "password_breached" };

export interface ConsumeInvitationSuccess {
  kind: "ok";
  /** The token that authorises the enrolment ceremony and nothing else. */
  enrollmentToken: string;
  enrollmentExpiresAt: Date;
  operatorId: string;
  operatorEmail: string;
  operatorRole: "operator" | "administrator";
  /** True when this consumption re-enrolled an existing account. */
  existingAccount: boolean;
}

/**
 * Consumes a single-use invitation in one transaction: validates the token,
 * finds or creates the operator, applies the password policy, clears any
 * earlier second factor, revokes every session, and opens the enrolment
 * ceremony whose token the response returns.
 */
export async function consumeInvitation(
  pool: Pool,
  config: AppConfig,
  input: { token: string; password: string; breached: BreachedPasswordList },
): Promise<ConsumeInvitationSuccess | ConsumeInvitationFailure> {
  const policy = checkPasswordPolicy(input.password, input.breached);
  if (!policy.ok) {
    return policy.reason === "too_short"
      ? { kind: "password_too_short" }
      : { kind: "password_breached" };
  }

  const client = await pool.connect();
  try {
    await client.query("begin");
    const found = await client.query(
      `select id, email, role, invited_by, created_at, expires_at, accepted_at, revoked_at
       from invitations where token_hash = $1 for update`,
      [sha256Hex(input.token)],
    );
    const row = found.rows[0];
    const now = config.now();
    if (!row || row.accepted_at !== null || row.revoked_at !== null) {
      await client.query("rollback");
      return { kind: "invalid" };
    }
    if (row.expires_at.getTime() <= now.getTime()) {
      await client.query("rollback");
      return { kind: "expired" };
    }

    const existing = await client.query<{ id: string }>(
      "select id from operators where email = $1 for update",
      [row.email],
    );
    let operatorId: string;
    let existingAccount: boolean;
    const passwordHash = await hashPassword(input.password);
    if (existing.rows.length > 0) {
      operatorId = existing.rows[0].id;
      existingAccount = true;
      // A consumed invitation on an existing account is the credential-reset
      // path: the new password replaces the old, the second factor must be
      // re-enrolled, and every held session ends.
      await client.query(
        `update operators set password_hash = $1, totp_secret = null,
           totp_enrolled_at = null, state = 'invited', failed_attempts = 0,
           locked_until = null, disabled_at = null, disabled_by = null,
           role = $2, updated_at = $3
         where id = $4`,
        [passwordHash, row.role, now.toISOString(), operatorId],
      );
      await client.query("delete from recovery_codes where operator_id = $1", [
        operatorId,
      ]);
      await client.query(
        "delete from operator_sessions where operator_id = $1",
        [operatorId],
      );
    } else {
      existingAccount = false;
      const created = await client.query<{ id: string }>(
        `insert into operators (email, password_hash, role, state, created_at, updated_at)
         values ($1, $2, $3, 'invited', $4, $4) returning id`,
        [row.email, passwordHash, row.role, now.toISOString()],
      );
      operatorId = created.rows[0].id;
    }

    // Acceptance stamps only accepted_at. `invited_by` stays what the issuing
    // path recorded (null for the bootstrap invitation); the read model
    // resolves that null to the bootstrap administrator.
    await client.query(
      "update invitations set accepted_at = $1 where id = $2",
      [now.toISOString(), row.id],
    );

    const enrollmentToken = newOpaqueToken();
    const enrollmentExpiresAt = new Date(now.getTime() + INVITATION_TTL_MS);
    await client.query(
      `insert into totp_enrollment
         (operator_id, enrollment_token_hash, enrollment_expires_at, created_at, updated_at)
       values ($1, $2, $3, $4, $4)
       on conflict (operator_id) do update set
         enrollment_token_hash = excluded.enrollment_token_hash,
         enrollment_expires_at = excluded.enrollment_expires_at,
         pending_secret = null,
         pending_started_at = null,
         updated_at = excluded.updated_at`,
      [
        operatorId,
        sha256Hex(enrollmentToken),
        enrollmentExpiresAt.toISOString(),
        now.toISOString(),
      ],
    );

    await recordSecurityEvent(
      client,
      {
        operatorId,
        kind: "invitation_accepted",
        detail: { invitationId: row.id, existingAccount },
      },
      now,
    );
    await client.query("commit");
    return {
      kind: "ok",
      enrollmentToken,
      enrollmentExpiresAt,
      operatorId,
      operatorEmail: row.email,
      operatorRole: row.role,
      existingAccount,
    };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Loads an invitation row by id (the administrator's revocation path). */
export async function findInvitationById(
  client: Pool | PoolClient,
  id: string,
): Promise<InvitationRow | null> {
  const result = await client.query(
    `select id, email, role, invited_by, created_at, expires_at, accepted_at, revoked_at
     from invitations where id = $1`,
    [id],
  );
  return result.rows[0] ? mapInvitationRow(result.rows[0]) : null;
}
