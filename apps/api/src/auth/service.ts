import { ApiError } from "../errors.js";
import type { Connectable, Queryable } from "../db/migrations.js";
import { hashPassword, passwordIssues, verifyPassword } from "./passwords.js";
import {
  generateRecoveryCodes,
  hashRecoveryCode,
} from "./recovery.js";
import {
  newId,
  randomToken,
  sha256Hex,
} from "./tokens.js";
import { createTotp, verifyTotp } from "./totp.js";
import { ConsoleMailer, type Mailer } from "./mailer.js";
import {
  publicOperator,
  publicSession,
  toOperator,
  toSession,
  type InterfaceLanguage,
  type OperatorRecord,
  type OperatorRole,
  type OperatorState,
  type SessionRecord,
} from "./records.js";

const IDLE_SECONDS = 8 * 60 * 60;
const ABSOLUTE_SECONDS = 7 * 24 * 60 * 60;
const SETUP_TOKEN_SECONDS = 24 * 60 * 60;
const CHALLENGE_SECONDS = 10 * 60;
const LOCK_SECONDS = 15 * 60;
const MAX_FAILURES = 10;
const MAX_IP_FAILURES = 20;

export interface SessionMeta {
  userAgent?: string;
  coarseIp?: string;
}

export interface BootstrapInput {
  legalName: string;
  country: string;
  address: string;
  roleMailbox: string;
  adminEmail: string;
}

export interface IssuedSession {
  session: SessionRecord;
  token: string;
}

export interface Reauthentication {
  password: string;
  code: string;
  sessionId: string;
}

export interface SetupState {
  bootstrapped: boolean;
  rightsHolderConfigured: boolean;
  administratorCount: number;
}

export class AuthService {
  constructor(
    private readonly db: Connectable,
    private readonly clock: () => Date = () => new Date(),
    private readonly mailer: Mailer = new ConsoleMailer(),
  ) {}

  async setupState(): Promise<SetupState> {
    try {
      const result = await this.db.query(
        `SELECT
           (SELECT count(*) FROM rights_holder) AS rights_holders,
           (SELECT count(*) FROM operator_account WHERE role = 'administrator') AS administrators`,
      );
      const row = result.rows[0] ?? {};
      const rightsHolders = Number(row.rights_holders ?? 0);
      const administrators = Number(row.administrators ?? 0);
      return {
        bootstrapped: rightsHolders > 0 && administrators > 0,
        rightsHolderConfigured: rightsHolders > 0,
        administratorCount: administrators,
      };
    } catch {
      return {
        bootstrapped: false,
        rightsHolderConfigured: false,
        administratorCount: 0,
      };
    }
  }

  async bootstrap(input: BootstrapInput): Promise<{
    operator: OperatorRecord;
    setupToken: string;
    expiresAt: string;
  }> {
    return this.withClient(async (db) => {
      const existing = await db.query("SELECT id FROM rights_holder LIMIT 1");
      if (existing.rows.length > 0) {
        throw new ApiError(409, "state_conflict", "The deployment is already bootstrapped.");
      }
      const now = this.now();
      const holderId = newId();
      await db.query(
        `INSERT INTO rights_holder
          (id, legal_name, country, address, role_mailbox, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $6)`,
        [holderId, input.legalName, input.country, input.address, input.roleMailbox, now],
      );
      const operator = await this.insertOperator(db, {
        email: input.adminEmail,
        role: "administrator",
        state: "invited",
        preferredLanguage: null,
        passwordHash: null,
      });
      const { token, expiresAt } = await this.insertSetupToken(
        db,
        operator.id,
        "bootstrap",
        SETUP_TOKEN_SECONDS,
      );
      await this.record(db, "bootstrap", operator.id, input.adminEmail, now);
      return { operator, setupToken: token, expiresAt };
    });
  }

  async consumeSetupToken(
    token: string,
    password: string,
  ): Promise<{
    operator: OperatorRecord;
    enrollmentToken: string;
    expiresAt: string;
  }> {
    const issues = passwordIssues(password);
    if (issues.length > 0) {
      throw new ApiError(422, "validation_failed", issues.join(" "));
    }
    return this.withClient(async (db) => {
      const row = await this.findToken(db, "setup_token", token);
      const operator = await this.findOperatorById(db, String(row.operator_id));
      const now = this.now();
      const passwordHash = await hashPassword(password);
      const purpose = String(row.purpose);
      await db.query(
        `UPDATE operator_account
           SET password_hash = $2, state = 'invited', totp_secret = NULL,
               pending_totp_secret = NULL, updated_at = $3
         WHERE id = $1`,
        [operator.id, passwordHash, now],
      );
      await db.query(
        "UPDATE setup_token SET consumed_at = $2 WHERE id = $1",
        [String(row.id), now],
      );
      if (purpose === "recover") {
        await this.revokeAllSessions(db, operator.id, now);
      }
      const enrollment = await this.insertEnrollmentToken(db, operator.id);
      await this.record(db, "setup_token_consumed", operator.id, operator.email, now);
      const updated = await this.findOperatorById(db, operator.id);
      return {
        operator: updated,
        enrollmentToken: enrollment.token,
        expiresAt: enrollment.expiresAt,
      };
    });
  }

  async startEnrollment(enrollmentToken: string): Promise<{
    secret: string;
    otpauthUri: string;
    expiresAt: string;
  }> {
    const row = await this.findToken(this.db, "enrollment_token", enrollmentToken);
    const operator = await this.findOperatorById(this.db, String(row.operator_id));
    const enrollment = createTotp(operator.email);
    await this.db.query(
      "UPDATE operator_account SET pending_totp_secret = $2, updated_at = $3 WHERE id = $1",
      [operator.id, enrollment.secret, this.now()],
    );
    return {
      secret: enrollment.secret,
      otpauthUri: enrollment.uri,
      expiresAt: new Date(String(row.expires_at)).toISOString(),
    };
  }

  async confirmEnrollment(
    enrollmentToken: string,
    code: string,
    meta: SessionMeta = {},
  ): Promise<{
    operator: OperatorRecord;
    session: SessionRecord;
    token: string;
    recoveryCodes: string[];
  }> {
    const row = await this.findToken(this.db, "enrollment_token", enrollmentToken);
    const operator = await this.findOperatorById(this.db, String(row.operator_id));
    if (!operator.pendingTotpSecret || !verifyTotp(operator.pendingTotpSecret, code)) {
      throw new ApiError(401, "invalid_second_factor", "The enrollment code is wrong.");
    }
    const now = this.now();
    await this.db.query(
      `UPDATE operator_account
         SET totp_secret = $2, pending_totp_secret = NULL, state = 'active',
             totp_enrolled_at = $3, updated_at = $3
       WHERE id = $1`,
      [operator.id, operator.pendingTotpSecret, now],
    );
    await this.db.query(
      "UPDATE enrollment_token SET consumed_at = $2 WHERE id = $1",
      [String(row.id), now],
    );
    const recoveryCodes = await this.replaceRecoveryCodes(this.db, operator.id);
    const session = await this.createSession(operator, meta);
    await this.record(this.db, "operator_enrolled", operator.id, operator.email, now);
    return {
      operator: await this.findOperatorById(this.db, operator.id),
      session: session.session,
      token: session.token,
      recoveryCodes,
    };
  }

  async signIn(
    email: string,
    password: string,
    meta: SessionMeta = {},
  ): Promise<{
    challengeId: string;
    expiresAt: string;
  }> {
    this.assertIpAllowed(meta.coarseIp);
    const state = await this.setupState();
    if (!state.bootstrapped) {
      throw new ApiError(503, "setup_required", "The deployment is not bootstrapped.");
    }
    const operator = await this.findOperatorByEmail(this.db, email);
    if (!operator || operator.state !== "active" || !operator.passwordHash) {
      this.registerIpFailure(meta.coarseIp);
      await this.record(this.db, "sign_in_failed", operator?.id ?? null, email, this.now(), meta);
      throw new ApiError(401, "invalid_credentials", "The email or password is wrong.");
    }
    if (operator.lockedUntil && new Date(operator.lockedUntil) > this.now()) {
      throw this.lockedError(operator);
    }
    if (!(await verifyPassword(operator.passwordHash, password))) {
      this.registerIpFailure(meta.coarseIp);
      await this.record(this.db, "sign_in_failed", operator.id, operator.email, this.now(), meta);
      await this.registerFailure(operator);
      throw new ApiError(401, "invalid_credentials", "The email or password is wrong.");
    }
    const now = this.now();
    await this.db.query(
      "UPDATE operator_account SET failed_attempts = 0, locked_until = NULL, updated_at = $2 WHERE id = $1",
      [operator.id, now],
    );
    const challengeId = newId();
    const expiresAt = new Date(now.getTime() + CHALLENGE_SECONDS * 1000).toISOString();
    await this.db.query(
      `INSERT INTO login_challenge (id, operator_id, expires_at, created_at)
       VALUES ($1, $2, $3, $4)`,
      [challengeId, operator.id, expiresAt, now],
    );
    await this.record(this.db, "password_accepted", operator.id, operator.email, now, meta);
    return { challengeId, expiresAt };
  }

  async secondFactor(
    challengeId: string,
    code: string,
    method: "totp" | "recovery_code",
    meta: SessionMeta = {},
  ): Promise<{
    operator: OperatorRecord;
    session: SessionRecord;
    token: string;
    recoveryCodesRemaining?: number;
  }> {
    const challenge = await this.db.query(
      "SELECT * FROM login_challenge WHERE id = $1",
      [challengeId],
    );
    const row = challenge.rows[0];
    if (!row || row.consumed_at || new Date(String(row.expires_at)) <= this.now()) {
      throw new ApiError(401, "challenge_expired", "The sign-in challenge expired.");
    }
    const operator = await this.findOperatorById(this.db, String(row.operator_id));
    if (operator.state !== "active") {
      throw new ApiError(401, "unauthenticated", "The account is not active.");
    }
    if (operator.lockedUntil && new Date(operator.lockedUntil) > this.now()) {
      throw this.lockedError(operator);
    }
    let recoveryCodesRemaining: number | undefined;
    if (method === "totp") {
      if (!operator.totpSecret || !verifyTotp(operator.totpSecret, code)) {
        await this.registerFailure(operator);
        throw new ApiError(401, "invalid_second_factor", "The code is wrong.");
      }
    } else {
      const used = await this.db.query(
        `UPDATE recovery_code SET used_at = $3
          WHERE operator_id = $1 AND code_hash = $2 AND used_at IS NULL`,
        [operator.id, hashRecoveryCode(code), this.now()],
      );
      if (!used.rowCount) {
        await this.registerFailure(operator);
        throw new ApiError(401, "invalid_second_factor", "The recovery code is wrong.");
      }
      const remaining = await this.db.query(
        "SELECT count(*) AS count FROM recovery_code WHERE operator_id = $1 AND used_at IS NULL",
        [operator.id],
      );
      recoveryCodesRemaining = Number(remaining.rows[0]?.count ?? 0);
      await this.record(this.db, "recovery_code_used", operator.id, operator.email, this.now(), meta);
    }
    const now = this.now();
    await this.db.query(
      "UPDATE login_challenge SET consumed_at = $2 WHERE id = $1",
      [challengeId, now],
    );
    await this.db.query(
      "UPDATE operator_account SET failed_attempts = 0, locked_until = NULL, last_sign_in_at = $2, updated_at = $2 WHERE id = $1",
      [operator.id, now],
    );
    const session = await this.createSession(operator, meta);
    await this.record(this.db, "sign_in", operator.id, operator.email, now, meta);
    return {
      operator: await this.findOperatorById(this.db, operator.id),
      session: session.session,
      token: session.token,
      recoveryCodesRemaining,
    };
  }

  async findSession(token: string): Promise<{
    operator: OperatorRecord;
    session: SessionRecord;
  }> {
    const sessionRow = await this.db.query(
      "SELECT * FROM operator_session WHERE token_sha256 = $1",
      [sha256Hex(token)],
    );
    const row = sessionRow.rows[0];
    if (!row || row.revoked_at) {
      throw new ApiError(401, "unauthenticated", "No valid session.");
    }
    const session = toSession(row);
    const operator = await this.findOperatorById(this.db, session.operatorId);
    if (operator.state !== "active") {
      throw new ApiError(401, "unauthenticated", "The account is not active.");
    }
    const now = this.now();
    if (new Date(session.absoluteExpiresAt) <= now) {
      await this.db.query("UPDATE operator_session SET revoked_at = $2 WHERE id = $1", [
        session.id,
        now,
      ]);
      throw new ApiError(401, "unauthenticated", "The session expired.");
    }
    if (new Date(session.idleExpiresAt) <= now) {
      await this.db.query("UPDATE operator_session SET revoked_at = $2 WHERE id = $1", [
        session.id,
        now,
      ]);
      throw new ApiError(401, "unauthenticated", "The session expired.");
    }
    const idle = new Date(now.getTime() + IDLE_SECONDS * 1000);
    const absolute = new Date(session.absoluteExpiresAt);
    const lastSeenAt = now.toISOString();
    const idleExpiresAt = (idle < absolute ? idle : absolute).toISOString();
    await this.db.query(
      "UPDATE operator_session SET last_seen_at = $2, idle_expires_at = $3 WHERE id = $1",
      [session.id, lastSeenAt, idleExpiresAt],
    );
    return {
      operator,
      session: { ...session, lastSeenAt, idleExpiresAt },
    };
  }

  async signOut(sessionId: string, operatorId?: string): Promise<void> {
    const now = this.now();
    await this.db.query("UPDATE operator_session SET revoked_at = $2 WHERE id = $1", [
      sessionId,
      now,
    ]);
    await this.record(this.db, "sign_out", operatorId ?? null, null, now);
  }

  async listSessions(operatorId: string): Promise<SessionRecord[]> {
    const result = await this.db.query(
      `SELECT * FROM operator_session
        WHERE operator_id = $1 AND revoked_at IS NULL
        ORDER BY created_at DESC`,
      [operatorId],
    );
    return result.rows.map(toSession);
  }

  async revokeSession(operatorId: string, sessionId: string): Promise<void> {
    const result = await this.db.query(
      "UPDATE operator_session SET revoked_at = $3 WHERE id = $1 AND operator_id = $2 AND revoked_at IS NULL",
      [sessionId, operatorId, this.now()],
    );
    if (!result.rowCount) {
      throw new ApiError(404, "not_found", "No such session.");
    }
  }

  async changePassword(
    operatorId: string,
    reauthentication: Reauthentication,
    newPassword: string,
  ): Promise<void> {
    return this.withClient(async (db) => {
      const operator = await this.findOperatorById(db, operatorId);
      await this.verifyReauthentication(operator, reauthentication);
      const issues = passwordIssues(newPassword);
      if (issues.length > 0) {
        throw new ApiError(422, "validation_failed", issues.join(" "));
      }
      const now = this.now();
      await db.query(
        "UPDATE operator_account SET password_hash = $2, updated_at = $3 WHERE id = $1",
        [operator.id, await hashPassword(newPassword), now],
      );
      await this.revokeOtherSessions(db, operator.id, reauthentication.sessionId, now);
      await this.record(db, "password_changed", operator.id, operator.email, now);
    });
  }

  async changeEmail(
    operatorId: string,
    reauthentication: Reauthentication,
    newEmail: string,
  ): Promise<void> {
    return this.withClient(async (db) => {
      const operator = await this.findOperatorById(db, operatorId);
      await this.verifyReauthentication(operator, reauthentication);
      const email = newEmail.trim().toLowerCase();
      const existing = await this.findOperatorByEmail(db, email);
      if (existing && existing.id !== operator.id) {
        throw new ApiError(409, "duplicate_entity", "The email is already in use.");
      }
      const now = this.now();
      await db.query(
        "UPDATE operator_account SET email = $2, updated_at = $3 WHERE id = $1",
        [operator.id, email, now],
      );
      await this.revokeOtherSessions(db, operator.id, reauthentication.sessionId, now);
      await this.record(db, "email_changed", operator.id, email, now);
    });
  }

  async setLanguage(
    operatorId: string,
    language: InterfaceLanguage,
  ): Promise<OperatorRecord> {
    await this.db.query(
      "UPDATE operator_account SET preferred_language = $2, updated_at = $3 WHERE id = $1",
      [operatorId, language, this.now()],
    );
    return this.findOperatorById(this.db, operatorId);
  }

  async beginReenrollment(
    operatorId: string,
    reauthentication: Reauthentication,
  ): Promise<{ secret: string; otpauthUri: string; expiresAt: string }> {
    const operator = await this.findOperatorById(this.db, operatorId);
    await this.verifyReauthentication(operator, reauthentication);
    const enrollment = createTotp(operator.email);
    await this.db.query(
      "UPDATE operator_account SET pending_totp_secret = $2, updated_at = $3 WHERE id = $1",
      [operator.id, enrollment.secret, this.now()],
    );
    return {
      secret: enrollment.secret,
      otpauthUri: enrollment.uri,
      expiresAt: new Date(this.now().getTime() + CHALLENGE_SECONDS * 1000).toISOString(),
    };
  }

  async confirmReenrollment(
    operatorId: string,
    code: string,
    currentSessionId: string,
  ): Promise<string[]> {
    return this.withClient(async (db) => {
      const operator = await this.findOperatorById(db, operatorId);
      if (!operator.pendingTotpSecret || !verifyTotp(operator.pendingTotpSecret, code)) {
        throw new ApiError(401, "invalid_second_factor", "The code is wrong.");
      }
      const now = this.now();
      await db.query(
        `UPDATE operator_account
           SET totp_secret = $2, pending_totp_secret = NULL, totp_enrolled_at = $3, updated_at = $3
         WHERE id = $1`,
        [operator.id, operator.pendingTotpSecret, now],
      );
      const codes = await this.replaceRecoveryCodes(db, operator.id);
      await this.revokeOtherSessions(db, operator.id, currentSessionId, now);
      await this.record(db, "totp_reenrolled", operator.id, operator.email, now);
      return codes;
    });
  }

  async operatorById(operatorId: string): Promise<OperatorRecord> {
    return this.findOperatorById(this.db, operatorId);
  }

  async listOperators(): Promise<OperatorRecord[]> {
    const result = await this.db.query("SELECT * FROM operator_account ORDER BY email");
    return result.rows.map(toOperator);
  }

  async updateOperator(
    actorId: string,
    operatorId: string,
    patch: { role?: OperatorRole; state?: OperatorState },
  ): Promise<OperatorRecord> {
    return this.withClient(async (db) => {
    const operator = await this.findOperatorById(db, operatorId);
    if (
      operator.role === "administrator" &&
      ((patch.role && patch.role !== "administrator") ||
        (patch.state && patch.state !== "active"))
    ) {
      if (await this.isLastAdministrator(operator.id)) {
        throw new ApiError(409, "last_administrator", "The last administrator cannot be demoted or disabled.");
      }
    }
    const now = this.now();
    await db.query(
      `UPDATE operator_account
         SET role = COALESCE($2, role), state = COALESCE($3, state),
             disabled_at = CASE
               WHEN $3 = 'disabled' THEN $4
               WHEN $3 = 'active' THEN NULL
               ELSE disabled_at
             END,
             disabled_by = CASE
               WHEN $3 = 'disabled' THEN $5
               WHEN $3 = 'active' THEN NULL
               ELSE disabled_by
             END,
             updated_at = $4
       WHERE id = $1`,
      [operator.id, patch.role ?? null, patch.state ?? null, now, actorId],
    );
    await this.revokeAllSessions(db, operator.id, now);
    await this.record(db, "operator_updated", operator.id, operator.email, now);
    return this.findOperatorById(db, operator.id);
    });
  }

  async createInvitation(
    actorId: string,
    email: string,
    role: OperatorRole,
  ): Promise<{ invitation: Record<string, unknown>; token: string }> {
    const existing = await this.findOperatorByEmail(this.db, email);
    if (existing) {
      throw new ApiError(409, "duplicate_entity", "An account already uses that email.");
    }
    const token = randomToken();
    const now = this.now();
    const expiresAt = new Date(now.getTime() + SETUP_TOKEN_SECONDS * 1000).toISOString();
    const id = newId();
    await this.db.query(
      `INSERT INTO invitation
         (id, email, role, token_hash, invited_by, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, email.toLowerCase(), role, sha256Hex(token), actorId, now, expiresAt],
    );
    await this.mailer.sendInvitation(email.toLowerCase(), token, expiresAt);
    await this.record(this.db, "invitation_created", null, email, now);
    return {
      invitation: {
        id,
        email: email.toLowerCase(),
        role,
        invitedBy: actorId,
        createdAt: now.toISOString(),
        expiresAt,
      },
      token,
    };
  }

  async listInvitations(): Promise<Array<Record<string, unknown>>> {
    const result = await this.db.query("SELECT * FROM invitation ORDER BY created_at DESC");
    return result.rows.map((row) => ({
      invitation: {
        id: String(row.id),
        email: String(row.email),
        role: String(row.role),
        invitedBy: String(row.invited_by),
        createdAt: new Date(String(row.created_at)).toISOString(),
        expiresAt: new Date(String(row.expires_at)).toISOString(),
        acceptedAt: row.accepted_at ? new Date(String(row.accepted_at)).toISOString() : undefined,
        revokedAt: row.revoked_at ? new Date(String(row.revoked_at)).toISOString() : undefined,
      },
      state: row.accepted_at
        ? "accepted"
        : row.revoked_at
          ? "revoked"
          : new Date(String(row.expires_at)) <= this.now()
            ? "expired"
            : "pending",
    }));
  }

  async revokeInvitation(invitationId: string, actorId?: string): Promise<void> {
    const now = this.now();
    const result = await this.db.query(
      "UPDATE invitation SET revoked_at = $2 WHERE id = $1 AND accepted_at IS NULL AND revoked_at IS NULL",
      [invitationId, now],
    );
    if (!result.rowCount) {
      throw new ApiError(409, "state_conflict", "The invitation cannot be revoked.");
    }
    await this.record(this.db, "invitation_revoked", actorId ?? null, null, now);
  }

  async acceptInvitation(
    token: string,
    password: string,
  ): Promise<{ operator: OperatorRecord; enrollmentToken: string; expiresAt: string }> {
    const issues = passwordIssues(password);
    if (issues.length > 0) {
      throw new ApiError(422, "validation_failed", issues.join(" "));
    }
    return this.withClient(async (db) => {
      const result = await db.query(
        "SELECT * FROM invitation WHERE token_hash = $1",
        [sha256Hex(token)],
      );
      const row = result.rows[0];
      if (!row || row.accepted_at || row.revoked_at) {
        throw new ApiError(401, "invitation_invalid", "The invitation is not valid.");
      }
      if (new Date(String(row.expires_at)) <= this.now()) {
        throw new ApiError(401, "invitation_expired", "The invitation expired.");
      }
      const existing = await this.findOperatorByEmail(db, String(row.email));
      if (existing) {
        throw new ApiError(409, "duplicate_entity", "An account already uses that email.");
      }
      const operator = await this.insertOperator(db, {
        email: String(row.email),
        role: String(row.role) as OperatorRole,
        state: "invited",
        preferredLanguage: null,
        passwordHash: await hashPassword(password),
      });
      await db.query("UPDATE invitation SET accepted_at = $2 WHERE id = $1", [
        String(row.id),
        this.now(),
      ]);
      const enrollment = await this.insertEnrollmentToken(db, operator.id);
      await this.record(db, "invitation_accepted", operator.id, operator.email, this.now());
      return {
        operator,
        enrollmentToken: enrollment.token,
        expiresAt: enrollment.expiresAt,
      };
    });
  }

  async recoverOperator(
    email: string,
    reason?: string,
    actorId?: string,
  ): Promise<{ setupToken: string; expiresAt: string }> {
    const operator = await this.findOperatorByEmail(this.db, email);
    if (!operator) {
      throw new ApiError(404, "not_found", "No such operator.");
    }
    await this.db.query(
      "UPDATE setup_token SET consumed_at = $2 WHERE operator_id = $1 AND consumed_at IS NULL",
      [operator.id, this.now()],
    );
    const result = await this.insertSetupToken(this.db, operator.id, "recover", SETUP_TOKEN_SECONDS);
    await this.revokeAllSessions(this.db, operator.id, this.now());
    await this.mailer.sendRecovery(operator.email, result.token, result.expiresAt);
    await this.record(
      this.db,
      "credential_reset",
      actorId ?? null,
      operator.email,
      this.now(),
    );
    if (reason) {
      await this.record(this.db, "credential_reset_reason", actorId ?? null, reason, this.now());
    }
    return { setupToken: result.token, expiresAt: result.expiresAt };
  }

  private async insertOperator(
    db: Queryable,
    input: {
      email: string;
      role: OperatorRole;
      state: OperatorState;
      preferredLanguage: InterfaceLanguage | null;
      passwordHash: string | null;
    },
  ): Promise<OperatorRecord> {
    const now = this.now();
    const id = newId();
    await db.query(
      `INSERT INTO operator_account
        (id, email, role, state, preferred_language, password_hash, failed_attempts, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 0, $7, $7)`,
      [
        id,
        input.email.toLowerCase(),
        input.role,
        input.state,
        input.preferredLanguage,
        input.passwordHash,
        now,
      ],
    );
    return this.findOperatorById(db, id);
  }

  private async createSession(
    operator: OperatorRecord,
    meta: SessionMeta,
  ): Promise<IssuedSession> {
    const token = randomToken();
    const now = this.now();
    const session: SessionRecord = {
      id: newId(),
      operatorId: operator.id,
      tokenSha256: sha256Hex(token),
      createdAt: now.toISOString(),
      lastSeenAt: now.toISOString(),
      idleExpiresAt: new Date(now.getTime() + IDLE_SECONDS * 1000).toISOString(),
      absoluteExpiresAt: new Date(now.getTime() + ABSOLUTE_SECONDS * 1000).toISOString(),
      revokedAt: null,
      userAgent: meta.userAgent ?? null,
      coarseIp: meta.coarseIp ?? null,
    };
    await this.db.query(
      `INSERT INTO operator_session
        (id, operator_id, token_sha256, created_at, last_seen_at, idle_expires_at, absolute_expires_at, user_agent, coarse_ip)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        session.id,
        session.operatorId,
        session.tokenSha256,
        session.createdAt,
        session.lastSeenAt,
        session.idleExpiresAt,
        session.absoluteExpiresAt,
        session.userAgent,
        session.coarseIp,
      ],
    );
    return { session, token };
  }

  private async replaceRecoveryCodes(
    db: Queryable,
    operatorId: string,
  ): Promise<string[]> {
    await db.query("DELETE FROM recovery_code WHERE operator_id = $1", [operatorId]);
    const codes = generateRecoveryCodes();
    const now = this.now();
    for (const code of codes) {
      await db.query(
        "INSERT INTO recovery_code (id, operator_id, code_hash, created_at) VALUES ($1, $2, $3, $4)",
        [newId(), operatorId, hashRecoveryCode(code), now],
      );
    }
    return codes;
  }

  private async insertSetupToken(
    db: Queryable,
    operatorId: string,
    purpose: string,
    seconds: number,
  ): Promise<{ token: string; expiresAt: string }> {
    const token = randomToken();
    const now = this.now();
    const expiresAt = new Date(now.getTime() + seconds * 1000).toISOString();
    await db.query(
      `INSERT INTO setup_token (id, token_hash, operator_id, purpose, expires_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [newId(), sha256Hex(token), operatorId, purpose, expiresAt, now],
    );
    return { token, expiresAt };
  }

  private async insertEnrollmentToken(
    db: Queryable,
    operatorId: string,
  ): Promise<{ token: string; expiresAt: string }> {
    const token = randomToken();
    const now = this.now();
    const expiresAt = new Date(now.getTime() + SETUP_TOKEN_SECONDS * 1000).toISOString();
    await db.query(
      `INSERT INTO enrollment_token (id, token_hash, operator_id, expires_at, created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [newId(), sha256Hex(token), operatorId, expiresAt, now],
    );
    return { token, expiresAt };
  }

  private async findToken(
    db: Queryable,
    table: "setup_token" | "enrollment_token",
    token: string,
  ): Promise<Record<string, unknown>> {
    const result = await db.query(`SELECT * FROM ${table} WHERE token_hash = $1`, [
      sha256Hex(token),
    ]);
    const row = result.rows[0];
    if (!row || row.consumed_at) {
      throw new ApiError(401, "invitation_invalid", "The token is not valid.");
    }
    if (new Date(String(row.expires_at)) <= this.now()) {
      throw new ApiError(401, "invitation_expired", "The token expired.");
    }
    return row;
  }

  private async findOperatorById(db: Queryable, id: string): Promise<OperatorRecord> {
    const result = await db.query("SELECT * FROM operator_account WHERE id = $1", [id]);
    const row = result.rows[0];
    if (!row) {
      throw new ApiError(404, "not_found", "No such operator.");
    }
    return toOperator(row);
  }

  private async findOperatorByEmail(
    db: Queryable,
    email: string,
  ): Promise<OperatorRecord | null> {
    const result = await db.query(
      "SELECT * FROM operator_account WHERE email = $1",
      [email.trim().toLowerCase()],
    );
    return result.rows[0] ? toOperator(result.rows[0]) : null;
  }

  private async verifyReauthentication(
    operator: OperatorRecord,
    reauthentication: Reauthentication,
  ): Promise<void> {
    if (!(await verifyPassword(operator.passwordHash, reauthentication.password))) {
      throw new ApiError(401, "invalid_credentials", "The current password is wrong.");
    }
    if (
      !operator.totpSecret ||
      !verifyTotp(operator.totpSecret, reauthentication.code)
    ) {
      throw new ApiError(401, "invalid_second_factor", "The code is wrong.");
    }
  }

  private async registerFailure(operator: OperatorRecord): Promise<void> {
    const now = this.now();
    const failures = operator.failedAttempts + 1;
    if (failures >= MAX_FAILURES) {
      await this.db.query(
        "UPDATE operator_account SET failed_attempts = $2, locked_until = $3, updated_at = $4 WHERE id = $1",
        [
          operator.id,
          failures,
          new Date(now.getTime() + LOCK_SECONDS * 1000).toISOString(),
          now,
        ],
      );
      await this.record(this.db, "account_locked", operator.id, operator.email, now);
      throw this.lockedError({ ...operator, lockedUntil: new Date(now.getTime() + LOCK_SECONDS * 1000).toISOString() });
    }
    await this.db.query(
      "UPDATE operator_account SET failed_attempts = $2, updated_at = $3 WHERE id = $1",
      [operator.id, failures, now],
    );
  }

  private lockedError(operator: OperatorRecord): ApiError {
    const retryAfter = operator.lockedUntil
      ? Math.max(1, Math.ceil((new Date(operator.lockedUntil).getTime() - this.now().getTime()) / 1000))
      : LOCK_SECONDS;
    return new ApiError(429, "account_locked", "The account is locked.", retryAfter);
  }

  private async isLastAdministrator(operatorId: string): Promise<boolean> {
    const result = await this.db.query(
      "SELECT count(*) AS count FROM operator_account WHERE role = 'administrator' AND state = 'active' AND id <> $1",
      [operatorId],
    );
    return Number(result.rows[0]?.count ?? 0) === 0;
  }

  private async revokeOtherSessions(
    db: Queryable,
    operatorId: string,
    currentSessionId: string,
    now: Date,
  ): Promise<void> {
    await db.query(
      "UPDATE operator_session SET revoked_at = $3 WHERE operator_id = $1 AND id <> $2 AND revoked_at IS NULL",
      [operatorId, currentSessionId, now],
    );
  }

  private async revokeAllSessions(
    db: Queryable,
    operatorId: string,
    now: Date,
  ): Promise<void> {
    await db.query(
      "UPDATE operator_session SET revoked_at = $2 WHERE operator_id = $1 AND revoked_at IS NULL",
      [operatorId, now],
    );
  }

  private async record(
    db: Queryable,
    kind: string,
    operatorId: string | null,
    email: string | null,
    at: Date,
    meta: SessionMeta = {},
    detail?: string,
  ): Promise<void> {
    await db.query(
      `INSERT INTO security_event (id, kind, operator_id, email, coarse_ip, user_agent, detail, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        newId(),
        kind,
        operatorId,
        email,
        meta.coarseIp ?? null,
        meta.userAgent ?? null,
        detail ?? null,
        at,
      ],
    );
  }

  private assertIpAllowed(ip: string | undefined): void {
    if (!ip) {
      return;
    }
    const entry = this.ipFailures.get(ip);
    if (entry && entry.resetAt > this.now().getTime() && entry.count >= MAX_IP_FAILURES) {
      throw new ApiError(429, "rate_limited", "Too many attempts from this address.", LOCK_SECONDS);
    }
  }

  private registerIpFailure(ip: string | undefined): void {
    if (!ip) {
      return;
    }
    const now = this.now().getTime();
    const entry = this.ipFailures.get(ip);
    if (!entry || entry.resetAt <= now) {
      this.ipFailures.set(ip, { count: 1, resetAt: now + LOCK_SECONDS * 1000 });
      return;
    }
    entry.count += 1;
  }

  private async withClient<T>(fn: (db: Queryable) => Promise<T>): Promise<T> {
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private now(): Date {
    return this.clock();
  }

  private readonly ipFailures = new Map<string, { count: number; resetAt: number }>();
}
