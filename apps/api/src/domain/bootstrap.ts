import type { Pool, PoolClient } from "pg";
import type { AppConfig } from "../config.js";
import { newOpaqueToken, sha256Hex } from "./session.js";
import { recordSecurityEvent } from "./security-events.js";

/**
 * Host-level bootstrap and recovery (Authentication "Bootstrap and
 * invitation"): `patrol bootstrap` writes the rights holder and an invited
 * administrator and prints the one-time setup token; `patrol admin recover`
 * mints a reset token for the last administrator. Both consume the same
 * invitation rows the API's setup and acceptance paths use.
 */

/** How long an invitation — the bootstrap setup token included — lives. */
export const INVITATION_TTL_MS = 24 * 60 * 60 * 1000;

export interface BootstrapInput {
  legalName: string;
  country: string;
  administratorEmail: string;
}

export type BootstrapOutcome =
  | {
      status: "created";
      /** The one-time setup token, returned exactly once. */
      setupToken: string;
      invitationId: string;
    }
  | { status: "refused" };

/**
 * Creates the rights holder and the invited first administrator in one
 * transaction. Refuses once a rights holder exists — the idempotence the
 * design demands — because a second bootstrap would mint a second setup
 * token against the same deployment. The refusal is guaranteed by the
 * `rights_holder_singleton_key` unique index, not just the read below, so
 * two racing bootstrap transactions cannot both insert: the loser's insert
 * fails with a unique violation that maps onto the same refusal.
 */
export async function bootstrapDeployment(
  pool: Pool,
  config: AppConfig,
  input: BootstrapInput,
): Promise<BootstrapOutcome> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const existing = await client.query<{ id: string }>(
      "select id from rights_holder limit 1",
    );
    if (existing.rows.length > 0) {
      await client.query("rollback");
      return { status: "refused" };
    }
    const now = config.now().toISOString();
    try {
      await client.query(
        `insert into rights_holder (legal_name, country, created_at, updated_at)
         values ($1, $2, $3, $3)`,
        [input.legalName, input.country, now],
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        // A concurrent bootstrap won the race for the singleton row.
        await client.query("rollback");
        return { status: "refused" };
      }
      throw error;
    }
    const setupToken = newOpaqueToken();
    const invitation = await client.query<{ id: string }>(
      `insert into invitations (email, role, token_hash, invited_by, expires_at, created_at)
       values ($1, 'administrator', $2, null, $3, $4)
       returning id`,
      [
        input.administratorEmail,
        sha256Hex(setupToken),
        new Date(config.now().getTime() + INVITATION_TTL_MS).toISOString(),
        now,
      ],
    );
    await recordSecurityEvent(
      client,
      {
        kind: "bootstrap_completed",
        detail: { administratorEmail: input.administratorEmail },
      },
      config.now(),
    );
    await client.query("commit");
    return {
      status: "created",
      setupToken,
      invitationId: invitation.rows[0].id,
    };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "23505"
  );
}

export interface AdminRecoverInput {
  email: string;
}

export type AdminRecoverOutcome =
  | { status: "issued"; resetToken: string }
  | { status: "no_such_administrator" }
  /**
   * Another active administrator exists, so `admin recover` is not the
   * last-administrator path; that administrator resets the credentials
   * through POST /operators/{id}/credential-reset instead.
   */
  | { status: "other_administrators_active" };

/**
 * The last-administrator recovery path: mints a one-time reset token that
 * the setup endpoint consumes to replace the password and force TOTP
 * re-enrolment. Refused while any other active administrator exists — the
 * ordinary credential-reset route covers that case without host access.
 * Host access is the same authority that could edit the database directly,
 * which is why this lives in the CLI and not the API.
 */
export async function adminRecoverLastAdministrator(
  pool: Pool,
  config: AppConfig,
  input: AdminRecoverInput,
): Promise<AdminRecoverOutcome> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const admin = await client.query<{ id: string }>(
      "select id from operators where email = $1 and role = 'administrator' limit 1",
      [input.email],
    );
    if (admin.rows.length === 0) {
      await client.query("rollback");
      return { status: "no_such_administrator" };
    }
    const operatorId = admin.rows[0].id;
    const otherActive = await client.query<{ count: string }>(
      "select count(*) as count from operators where role = 'administrator' and state = 'active' and id <> $1",
      [operatorId],
    );
    if (Number(otherActive.rows[0].count) > 0) {
      await client.query("rollback");
      return { status: "other_administrators_active" };
    }
    const now = config.now();
    // Force the re-enrolment the reset implies, drop the credentials, and
    // end every session the account held.
    await client.query(
      `update operators set password_hash = null, totp_secret = null,
         totp_enrolled_at = null, state = 'invited', failed_attempts = 0,
         locked_until = null, disabled_at = null, disabled_by = null,
         updated_at = $1
       where id = $2`,
      [now.toISOString(), operatorId],
    );
    await client.query("delete from recovery_codes where operator_id = $1", [
      operatorId,
    ]);
    await client.query("delete from operator_sessions where operator_id = $1", [
      operatorId,
    ]);
    const resetToken = newOpaqueToken();
    await client.query(
      `insert into invitations (email, role, token_hash, invited_by, expires_at, created_at)
       values ($1, 'administrator', $2, $3, $4, $5)`,
      [
        input.email,
        sha256Hex(resetToken),
        operatorId,
        new Date(now.getTime() + INVITATION_TTL_MS).toISOString(),
        now.toISOString(),
      ],
    );
    await recordSecurityEvent(
      client,
      { operatorId, kind: "credential_reset", detail: { via: "admin_recover" } },
      now,
    );
    await client.query("commit");
    return { status: "issued", resetToken };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export interface DeploymentSetupState {
  bootstrapped: boolean;
  rightsHolderConfigured: boolean;
  administratorCount: number;
}

/**
 * The SetupState GET /system/setup reports and setup gating reads. Only an
 * active administrator counts: an invited one has not finished the
 * enrolment ceremony, and a disabled one cannot administer, so a deployment
 * whose every administrator is invited or disabled is not bootstrapped in
 * the sense the gate enforces.
 */
export async function readSetupState(
  pool: Pool,
): Promise<DeploymentSetupState> {
  const result = await pool.query<{ rights_holders: string; admins: string }>(
    `select
       (select count(*) from rights_holder) as rights_holders,
       (select count(*) from operators where role = 'administrator' and state = 'active') as admins`,
  );
  const rightsHolderConfigured = Number(result.rows[0].rights_holders) > 0;
  const administratorCount = Number(result.rows[0].admins);
  return {
    bootstrapped: rightsHolderConfigured && administratorCount > 0,
    rightsHolderConfigured,
    administratorCount,
  };
}
