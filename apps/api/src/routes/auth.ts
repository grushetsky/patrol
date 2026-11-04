import type { FastifyInstance, FastifyPluginAsync, FastifyReply } from "fastify";
import type { Pool } from "pg";
import type { AppConfig } from "../config.js";
import { t, type Locale } from "@patrol/i18n";
import { ApiError } from "../errors.js";
import {
  defaultBreachedPasswordsPath,
  checkPasswordPolicy,
  hashPassword,
  loadBreachedPasswords,
  needsRehash,
  verifyPassword,
  type BreachedPasswordList,
} from "../domain/password.js";
import {
  generateTotpSecret,
  otpauthUri,
  verifyTotpCode,
} from "../domain/totp.js";
import {
  generateRecoveryCodes,
  hashRecoveryCode,
} from "../domain/recovery.js";
import {
  clearedSessionCookie,
  createSession,
  csrfCookie,
  deleteSession,
  newOpaqueToken,
  revokeOperatorSessions,
  sessionCookie,
  sha256Hex,
  toOperatorRecord,
  type OperatorRecord,
  type OperatorRow,
} from "../domain/session.js";
import {
  lockUntil,
  MAX_FAILED_ATTEMPTS,
  PER_IP_MAX_FAILURES,
  perIpWindowMs,
  retryAfterSeconds,
} from "../domain/lockout.js";
import { consumeInvitation } from "../domain/invitation.js";
import { recordSecurityEvent } from "../domain/security-events.js";
import type { MailTransport } from "../mail/transport.js";
import {
  operatorJson,
  pageParams,
  requestMeta,
  sessionViewJson,
  sessionsPage,
} from "./support.js";

/**
 * The Authentication, InvitationAcceptance, and Sessions interfaces of the
 * contract (Patrol.Http): sign-in's two steps, the enrolment ceremony both
 * the bootstrap administrator and every invited operator pass through, the
 * operator's own sessions and credentials, and the invitation link's
 * anonymous acceptance. Credential material never appears in a response.
 */

/** How long a second-factor challenge lives. */
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

/** How long a re-enrolment's pending secret lives. */
const REENROLLMENT_PENDING_TTL_MS = 60 * 60 * 1000;

export interface AuthRoutesDeps {
  config: AppConfig;
  pool: Pool;
  mail: MailTransport;
}

async function findOperatorRow(
  pool: Pool,
  by: { email?: string; id?: string },
): Promise<OperatorRow | null> {
  const [clause, value] =
    by.email !== undefined ? ["email", by.email] : ["id", by.id!];
  const result = await pool.query<OperatorRow>(
    `select * from operators where ${clause} = $1`,
    [value],
  );
  return result.rows[0] ?? null;
}

async function findOperatorById(
  pool: Pool,
  id: string,
): Promise<OperatorRecord | null> {
  const row = await findOperatorRow(pool, { id });
  return row ? toOperatorRecord(row) : null;
}

/** One failed attempt: counts, locks at the threshold, audits.
 *
 * The counter moves with an atomic read-modify-write in SQL
 * (`failed_attempts = failed_attempts + 1 ... returning`), so concurrent
 * attempts each land their increment instead of racing on a stale row and
 * losing failures.
 */
async function registerFailure(
  pool: Pool,
  config: AppConfig,
  operator: Pick<OperatorRow, "id">,
  kind: "password" | "second_factor",
  meta: { coarseIp: string | null; userAgent: string },
): Promise<ApiError> {
  const now = config.now();
  const client = await pool.connect();
  try {
    const counted = await client.query<{ failed_attempts: number }>(
      `update operators set failed_attempts = failed_attempts + 1, updated_at = $1
       where id = $2 returning failed_attempts`,
      [now.toISOString(), operator.id],
    );
    const failures = counted.rows[0].failed_attempts;
    if (failures >= MAX_FAILED_ATTEMPTS) {
      const until = lockUntil(now);
      await client.query(
        "update operators set locked_until = $1, updated_at = $2 where id = $3",
        [until.toISOString(), now.toISOString(), operator.id],
      );
      await recordSecurityEvent(
        client,
        {
          operatorId: operator.id,
          kind: "account_locked",
          detail: { attempts: failures, on: kind },
          coarseIp: meta.coarseIp,
          userAgent: meta.userAgent,
        },
        now,
      );
      return new ApiError(429, "account_locked", {
        retryAfterSeconds: retryAfterSeconds(until, now),
      });
    }
    await recordSecurityEvent(
      client,
      {
        operatorId: operator.id,
        kind: "sign_in_failed",
        detail: { on: kind },
        coarseIp: meta.coarseIp,
        userAgent: meta.userAgent,
      },
      now,
    );
    return new ApiError(
      401,
      kind === "password" ? "invalid_credentials" : "invalid_second_factor",
    );
  } finally {
    client.release();
  }
}

/** The per-IP throttle, counted from the audited failures in the window.
 *
 * The audit trail carries a `sign_in_failed` row for every refused
 * attempt — including the ones naming no account at all (an unknown
 * email), which carry a null operator — so one address hammering
 * usernames it made up throttles exactly like one guessing passwords.
 */
async function ipIsThrottled(
  pool: Pool,
  config: AppConfig,
  coarseIp: string | null,
): Promise<boolean> {
  if (coarseIp === null) {
    return false;
  }
  const since = new Date(config.now().getTime() - perIpWindowMs());
  const result = await pool.query<{ count: string }>(
    "select count(*) as count from security_events where kind = 'sign_in_failed' and coarse_ip = $1 and created_at > $2",
    [coarseIp, since.toISOString()],
  );
  return Number(result.rows[0].count) >= PER_IP_MAX_FAILURES;
}

export function authRoutes(deps: AuthRoutesDeps): FastifyPluginAsync {
  const { config, pool } = deps;
  const breached: BreachedPasswordList = loadBreachedPasswords(
    defaultBreachedPasswordsPath(),
  );

  /** Rejects a policy-breaking password with a localized field error (400). */
  function passwordPolicyError(
    password: string,
    locale: Locale,
  ): ApiError | null {
    const policy = checkPasswordPolicy(password, breached);
    if (policy.ok) {
      return null;
    }
    return new ApiError(400, "validation_failed", {
      fieldErrors: [
        {
          path: "/password",
          message: t(
            locale,
            policy.reason === "too_short" ? "password.too_short" : "password.breached",
          ),
        },
      ],
    });
  }

  /** The shared tail of setup and invitation acceptance. */
  async function consumeAndOpenCeremony(
    app: FastifyInstance,
    request: { locale: Locale },
    reply: FastifyReply,
    token: string,
    password: string,
  ): Promise<unknown> {
    const outcome = await consumeInvitation(pool, config, {
      token,
      password,
      breached,
    });
    if (outcome.kind !== "ok") {
      if (outcome.kind === "invalid") {
        throw new ApiError(401, "invitation_invalid");
      }
      if (outcome.kind === "expired") {
        throw new ApiError(401, "invitation_expired");
      }
      throw new ApiError(400, "validation_failed", {
        fieldErrors: [
          {
            path: "/password",
            message: t(
              request.locale,
              outcome.kind === "password_too_short"
                ? "password.too_short"
                : "password.breached",
            ),
          },
        ],
      });
    }
    // The ceremony answers with the operator as the database stores it —
    // created/updated timestamps included — not a reconstruction from the
    // clock. Consumption created or reset the row, so the setup gate's
    // cached state is stale by definition.
    const row = await findOperatorRow(pool, { id: outcome.operatorId });
    if (row === null) {
      throw new ApiError(500, "internal_error");
    }
    app.invalidateSetupStateCache();
    reply.status(201);
    return {
      operator: operatorJson(toOperatorRecord(row)),
      enrollmentToken: outcome.enrollmentToken,
      expiresAt: outcome.enrollmentExpiresAt.toISOString(),
    };
  }

  /** Verifies the password+code pair an elevated change demands. */
  async function assertCurrentCredentials(
    operator: OperatorRecord,
    currentPassword: string,
    currentCode: string,
  ): Promise<void> {
    if (
      operator.passwordHash === null ||
      !(await verifyPassword(operator.passwordHash, currentPassword))
    ) {
      throw new ApiError(401, "invalid_credentials");
    }
    if (
      operator.totpSecret === null ||
      !verifyTotpCode(operator.totpSecret, currentCode, config.now())
    ) {
      throw new ApiError(401, "invalid_second_factor");
    }
  }

  return async (app: FastifyInstance) => {
    // -----------------------------------------------------------------
    // Anonymous ceremony: CSRF issuing, setup, sign-in, second factor.

    app.get(
      "/auth/csrf",
      { config: { patrolRoles: ["anonymous"] } },
      async (_request, reply) => {
        const token = newOpaqueToken();
        reply.header("set-cookie", csrfCookie(token));
        return { csrfToken: token };
      },
    );

    app.post(
      "/auth/setup",
      { config: { patrolRoles: ["anonymous"] } },
      async (request, reply) => {
        const body = app.validate(request.body, "SetupRequest") as {
          token: string;
          password: string;
        };
        const policyError = passwordPolicyError(body.password, request.locale);
        if (policyError) {
          throw policyError;
        }
        return consumeAndOpenCeremony(app, request, reply, body.token, body.password);
      },
    );

    app.post(
      "/invitations/:token/acceptance",
      { config: { patrolRoles: ["anonymous"] } },
      async (request, reply) => {
        const body = app.validate(
          request.body,
          "InvitationAcceptanceRequest",
        ) as { password: string };
        const policyError = passwordPolicyError(body.password, request.locale);
        if (policyError) {
          throw policyError;
        }
        const token = (request.params as { token: string }).token;
        return consumeAndOpenCeremony(app, request, reply, token, body.password);
      },
    );

    app.post(
      "/auth/sign-in",
      { config: { patrolRoles: ["anonymous"] } },
      async (request, reply) => {
        const body = app.validate(request.body, "SignInRequest") as {
          email: string;
          password: string;
        };
        const meta = requestMeta(request);
        if (await ipIsThrottled(pool, config, meta.coarseIp)) {
          await recordSecurityEvent(
            pool,
            {
              kind: "ip_throttled",
              coarseIp: meta.coarseIp,
              userAgent: meta.userAgent,
            },
            config.now(),
          );
          throw new ApiError(429, "rate_limited", { retryAfterSeconds: 60 });
        }
        const operator = await findOperatorRow(pool, { email: body.email });
        if (
          operator === null ||
          operator.state !== "active" ||
          operator.password_hash === null ||
          operator.totp_secret === null
        ) {
          // Every refusal is audited — with a null operator for an unknown
          // email, so the per-IP throttle (which counts these rows) covers
          // username probing, not just password guessing.
          await recordSecurityEvent(
            pool,
            {
              operatorId: operator?.id ?? null,
              kind: "sign_in_failed",
              detail: {
                reason:
                  operator === null
                    ? "unknown_account"
                    : operator.state !== "active"
                      ? "not_active"
                      : operator.password_hash === null
                        ? "no_password"
                        : "enrollment_pending",
              },
              coarseIp: meta.coarseIp,
              userAgent: meta.userAgent,
            },
            config.now(),
          );
          throw new ApiError(401, "invalid_credentials");
        }
        const now = config.now();
        const lock = operator.locked_until;
        if (lock !== null && lock.getTime() > now.getTime()) {
          throw new ApiError(429, "account_locked", {
            retryAfterSeconds: retryAfterSeconds(lock, now),
          });
        }
        // A lock that has lapsed resets the counter before this attempt.
        if (
          operator.locked_until !== null &&
          operator.locked_until.getTime() <= now.getTime()
        ) {
          await pool.query(
            "update operators set failed_attempts = 0, locked_until = null, updated_at = $1 where id = $2",
            [now.toISOString(), operator.id],
          );
          operator.failed_attempts = 0;
          operator.locked_until = null;
        }
        const passwordOk = await verifyPassword(
          operator.password_hash,
          body.password,
        );
        if (!passwordOk) {
          throw await registerFailure(pool, config, operator, "password", meta);
        }
        // Rehash on sign-in when the stored parameters drifted.
        if (needsRehash(operator.password_hash)) {
          await pool.query(
            "update operators set password_hash = $1, updated_at = $2 where id = $3",
            [await hashPassword(body.password), now.toISOString(), operator.id],
          );
        }
        const challengeToken = newOpaqueToken();
        const expiresAt = new Date(now.getTime() + CHALLENGE_TTL_MS);
        await pool.query(
          `insert into auth_challenges (operator_id, token_hash, expires_at, created_at)
           values ($1, $2, $3, $4)`,
          [
            operator.id,
            sha256Hex(challengeToken),
            expiresAt.toISOString(),
            now.toISOString(),
          ],
        );
        reply.status(202);
        return { challengeId: challengeToken, expiresAt: expiresAt.toISOString() };
      },
    );

    app.post(
      "/auth/second-factor",
      { config: { patrolRoles: ["anonymous"] } },
      async (request, reply) => {
        const body = app.validate(request.body, "SecondFactorRequest") as {
          challengeId: string;
          code: string;
          method: "totp" | "recovery_code";
        };
        const meta = requestMeta(request);
        const now = config.now();
        const challenge = await pool.query<{
          operator_id: string;
          expires_at: Date;
        }>(
          "select operator_id, expires_at from auth_challenges where token_hash = $1",
          [sha256Hex(body.challengeId)],
        );
        const row = challenge.rows[0];
        if (!row || row.expires_at.getTime() <= now.getTime()) {
          throw new ApiError(401, "challenge_expired");
        }
        const operator = await findOperatorRow(pool, { id: row.operator_id });
        if (operator === null || operator.state !== "active") {
          throw new ApiError(401, "invalid_second_factor");
        }
        const operatorRecord = toOperatorRecord(operator);
        const lock = operatorRecord.lockedUntil;
        if (lock !== null && lock.getTime() > now.getTime()) {
          throw new ApiError(429, "account_locked", {
            retryAfterSeconds: retryAfterSeconds(lock, now),
          });
        }

        let secondFactorOk = false;
        if (body.method === "totp") {
          secondFactorOk =
            operator.totp_secret !== null &&
            verifyTotpCode(operator.totp_secret, body.code, now);
        } else {
          const digest = hashRecoveryCode(body.code, config.recoveryPepper);
          // Consumption is the delete itself: the row that matched the
          // digest disappears, so a replay or a concurrent present of the
          // same code finds nothing left to match.
          const consumed = await pool.query<{ id: string }>(
            `delete from recovery_codes
             where operator_id = $1 and code_hash = $2
             returning id`,
            [operator.id, digest],
          );
          secondFactorOk = consumed.rowCount === 1;
          if (secondFactorOk) {
            await recordSecurityEvent(
              pool,
              {
                operatorId: operator.id,
                kind: "recovery_code_used",
                coarseIp: meta.coarseIp,
                userAgent: meta.userAgent,
              },
              now,
            );
          }
        }
        if (!secondFactorOk) {
          const fresh = await findOperatorRow(pool, { id: operator.id });
          throw await registerFailure(
            pool,
            config,
            fresh ?? operator,
            "second_factor",
            meta,
          );
        }

        const client = await pool.connect();
        try {
          await client.query("begin");
          // Single-use gate: the challenge dies with this transaction, and
          // only the request whose delete claims the row proceeds. A replay
          // — sequential or racing this one — finds no row and answers
          // challenge_expired.
          const claimed = await client.query<{ operator_id: string }>(
            "delete from auth_challenges where token_hash = $1 returning operator_id",
            [sha256Hex(body.challengeId)],
          );
          if (claimed.rowCount !== 1) {
            await client.query("rollback");
            throw new ApiError(401, "challenge_expired");
          }
          await client.query(
            "update operators set failed_attempts = 0, locked_until = null, last_sign_in_at = $1, updated_at = $1 where id = $2",
            [now.toISOString(), operator.id],
          );
          // Rotation: a re-authentication under a still-valid cookie of the
          // same operator deletes the old row and issues a fresh token.
          if (
            request.session !== null &&
            request.session.operator.id === operator.id
          ) {
            await client.query("delete from operator_sessions where id = $1", [
              request.session.session.id,
            ]);
          }
          await recordSecurityEvent(
            client,
            {
              operatorId: operator.id,
              kind: "sign_in_succeeded",
              detail: { method: body.method },
              coarseIp: meta.coarseIp,
              userAgent: meta.userAgent,
            },
            now,
          );
          const issued = await createSession(client, config, {
            operatorId: operator.id,
            userAgent: meta.userAgent,
            coarseIp: meta.coarseIp,
          });
          await client.query("commit");
          reply.header("set-cookie", sessionCookie(config, issued.token));
          const bodyOut: Record<string, unknown> = {
            operator: operatorJson({
              ...operatorRecord,
              lastSignInAt: now,
              failedAttempts: 0,
              lockedUntil: null,
            }),
            session: sessionViewJson(issued.row),
            csrfToken: issued.csrfToken,
          };
          if (body.method === "recovery_code") {
            const remaining = await client.query<{ count: string }>(
              "select count(*) as count from recovery_codes where operator_id = $1",
              [operator.id],
            );
            bodyOut.recoveryCodesRemaining = Number(remaining.rows[0].count);
          }
          return bodyOut;
        } catch (error) {
          await client.query("rollback").catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
      },
    );

    // -----------------------------------------------------------------
    // The enrolment ceremony.

    app.post(
      "/auth/enrollment",
      { config: { patrolRoles: ["anonymous"] } },
      async (request) => {
        const body = app.validate(request.body, "TotpEnrollmentRequest") as {
          enrollmentToken: string;
        };
        const now = config.now();
        const found = await pool.query<{
          operator_id: string;
          enrollment_expires_at: Date;
          email: string;
        }>(
          `select e.operator_id, e.enrollment_expires_at, o.email
           from totp_enrollment e join operators o on o.id = e.operator_id
           where e.enrollment_token_hash = $1`,
          [sha256Hex(body.enrollmentToken)],
        );
        const row = found.rows[0];
        if (!row) {
          throw new ApiError(401, "unauthenticated");
        }
        if (row.enrollment_expires_at.getTime() <= now.getTime()) {
          throw new ApiError(401, "challenge_expired");
        }
        const secret = generateTotpSecret();
        await pool.query(
          `update totp_enrollment set pending_secret = $1, pending_started_at = $2, updated_at = $2
           where operator_id = $3`,
          [secret, now.toISOString(), row.operator_id],
        );
        return {
          secret,
          otpauthUri: otpauthUri(secret, row.email),
          expiresAt: row.enrollment_expires_at.toISOString(),
        };
      },
    );

    app.post(
      "/auth/enrollment/confirmation",
      { config: { patrolRoles: ["anonymous"] } },
      async (request, reply) => {
        const body = app.validate(
          request.body,
          "TotpEnrollmentConfirmation",
        ) as { enrollmentToken: string; code: string };
        const meta = requestMeta(request);
        const now = config.now();
        const found = await pool.query<{
          operator_id: string;
          enrollment_expires_at: Date;
          pending_secret: string | null;
        }>(
          `select operator_id, enrollment_expires_at, pending_secret
           from totp_enrollment where enrollment_token_hash = $1`,
          [sha256Hex(body.enrollmentToken)],
        );
        const row = found.rows[0];
        if (!row) {
          throw new ApiError(401, "unauthenticated");
        }
        if (row.enrollment_expires_at.getTime() <= now.getTime()) {
          throw new ApiError(401, "challenge_expired");
        }
        if (row.pending_secret === null) {
          throw new ApiError(422, "state_conflict");
        }
        if (!verifyTotpCode(row.pending_secret, body.code, now)) {
          throw new ApiError(401, "invalid_second_factor");
        }
        const recoveryCodes = generateRecoveryCodes();
        const client = await pool.connect();
        try {
          await client.query("begin");
          await client.query(
            `update operators set totp_secret = $1, totp_enrolled_at = $2,
               state = 'active', last_sign_in_at = $2, failed_attempts = 0,
               locked_until = null, updated_at = $2
             where id = $3`,
            [row.pending_secret, now.toISOString(), row.operator_id],
          );
          await client.query(
            "delete from totp_enrollment where operator_id = $1",
            [row.operator_id],
          );
          await client.query(
            "delete from recovery_codes where operator_id = $1",
            [row.operator_id],
          );
          for (const code of recoveryCodes) {
            await client.query(
              "insert into recovery_codes (operator_id, code_hash, created_at) values ($1, $2, $3)",
              [
                row.operator_id,
                hashRecoveryCode(code, config.recoveryPepper),
                now.toISOString(),
              ],
            );
          }
          await recordSecurityEvent(
            client,
            { operatorId: row.operator_id, kind: "totp_enrolled" },
            now,
          );
          await recordSecurityEvent(
            client,
            { operatorId: row.operator_id, kind: "recovery_codes_issued" },
            now,
          );
          const issued = await createSession(client, config, {
            operatorId: row.operator_id,
            userAgent: meta.userAgent,
            coarseIp: meta.coarseIp,
          });
          await client.query("commit");
          // The operator just turned active: this is the moment a
          // deployment with its first administrator finishes bootstrapping.
          app.invalidateSetupStateCache();
          const operator = await findOperatorById(pool, row.operator_id);
          if (operator === null) {
            throw new ApiError(500, "internal_error");
          }
          reply.status(201);
          reply.header("set-cookie", sessionCookie(config, issued.token));
          return {
            operator: operatorJson(operator),
            session: sessionViewJson(issued.row),
            csrfToken: issued.csrfToken,
            recoveryCodes,
          };
        } catch (error) {
          await client.query("rollback").catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
      },
    );

    // -----------------------------------------------------------------
    // The signed-in operator's session and credentials.

    app.get(
      "/auth/session",
      { config: { patrolRoles: ["operator", "administrator"] } },
      async (request) => {
        const session = request.session!;
        return {
          operator: operatorJson(session.operator),
          session: sessionViewJson(session.session),
          csrfToken: session.session.csrfToken,
        };
      },
    );

    app.delete(
      "/auth/session",
      { config: { patrolRoles: ["operator", "administrator"] } },
      async (request, reply) => {
        const session = request.session!;
        const client = await pool.connect();
        try {
          await client.query("begin");
          await deleteSession(client, session.session.id);
          await recordSecurityEvent(
            client,
            {
              operatorId: session.operator.id,
              kind: "session_revoked",
              detail: { on: "logout" },
            },
            config.now(),
          );
          await client.query("commit");
        } catch (error) {
          await client.query("rollback").catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
        // The browser must drop the cookie with the row, or every later
        // request carries a token naming nothing.
        reply.header("set-cookie", clearedSessionCookie(config));
        reply.status(204);
        return null;
      },
    );

    app.get(
      "/auth/sessions",
      { config: { patrolRoles: ["operator", "administrator"] } },
      async (request) => {
        const session = request.session!;
        return sessionsPage(pool, session.operator.id, request.query as Record<string, unknown>);
      },
    );

    app.delete(
      "/auth/sessions/:sessionId",
      { config: { patrolRoles: ["operator", "administrator"] } },
      async (request, reply) => {
        const session = request.session!;
        const sessionId = (request.params as { sessionId: string }).sessionId;
        const client = await pool.connect();
        try {
          await client.query("begin");
          const deleted = await deleteSession(
            client,
            sessionId,
            session.operator.id,
          );
          if (!deleted) {
            await client.query("rollback");
            throw new ApiError(404, "not_found");
          }
          await recordSecurityEvent(
            client,
            {
              operatorId: session.operator.id,
              kind: "session_revoked",
              detail: { sessionId, on: "self" },
            },
            config.now(),
          );
          await client.query("commit");
        } catch (error) {
          await client.query("rollback").catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
        reply.status(204);
        return null;
      },
    );

    app.post(
      "/auth/password",
      { config: { patrolRoles: ["operator", "administrator"] } },
      async (request, reply) => {
        const session = request.session!;
        const body = app.validate(request.body, "PasswordChangeRequest") as {
          currentPassword: string;
          newPassword: string;
          currentCode: string;
        };
        await assertCurrentCredentials(
          session.operator,
          body.currentPassword,
          body.currentCode,
        );
        const policyError = passwordPolicyError(body.newPassword, request.locale);
        if (policyError) {
          throw policyError;
        }
        const now = config.now();
        const client = await pool.connect();
        try {
          await client.query("begin");
          await client.query(
            "update operators set password_hash = $1, updated_at = $2 where id = $3",
            [
              await hashPassword(body.newPassword),
              now.toISOString(),
              session.operator.id,
            ],
          );
          // Every other session is revoked (contract), in the same
          // transaction as the credential change (implementation rules).
          const revoked = await revokeOperatorSessions(client, session.operator.id, {
            exceptSessionId: session.session.id,
          });
          if (revoked > 0) {
            await recordSecurityEvent(
              client,
              {
                operatorId: session.operator.id,
                kind: "session_revoked",
                detail: { on: "password_change", count: revoked },
              },
              now,
            );
          }
          await recordSecurityEvent(
            client,
            { operatorId: session.operator.id, kind: "password_changed" },
            now,
          );
          await client.query("commit");
        } catch (error) {
          await client.query("rollback").catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
        reply.status(204);
        return null;
      },
    );

    app.post(
      "/auth/email",
      { config: { patrolRoles: ["operator", "administrator"] } },
      async (request, reply) => {
        const session = request.session!;
        const body = app.validate(request.body, "EmailChangeRequest") as {
          newEmail: string;
          currentPassword: string;
          currentCode: string;
        };
        await assertCurrentCredentials(
          session.operator,
          body.currentPassword,
          body.currentCode,
        );
        const existing = await findOperatorRow(pool, { email: body.newEmail });
        if (existing !== null && existing.id !== session.operator.id) {
          throw new ApiError(409, "duplicate_entity");
        }
        const now = config.now();
        const client = await pool.connect();
        try {
          await client.query("begin");
          await client.query(
            "update operators set email = $1, updated_at = $2 where id = $3",
            [body.newEmail, now.toISOString(), session.operator.id],
          );
          const revoked = await revokeOperatorSessions(client, session.operator.id, {
            exceptSessionId: session.session.id,
          });
          if (revoked > 0) {
            await recordSecurityEvent(
              client,
              {
                operatorId: session.operator.id,
                kind: "session_revoked",
                detail: { on: "email_change", count: revoked },
              },
              now,
            );
          }
          await recordSecurityEvent(
            client,
            { operatorId: session.operator.id, kind: "email_changed" },
            now,
          );
          await client.query("commit");
        } catch (error) {
          await client.query("rollback").catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
        reply.status(204);
        return null;
      },
    );

    app.patch(
      "/auth/preferences",
      { config: { patrolRoles: ["operator", "administrator"] } },
      async (request) => {
        const session = request.session!;
        const body = app.validate(request.body, "UpdatePreferencesRequest") as {
          language: "en" | "ru";
        };
        const now = config.now();
        await pool.query(
          "update operators set preferred_language = $1, updated_at = $2 where id = $3",
          [body.language, now.toISOString(), session.operator.id],
        );
        const updated = await findOperatorById(pool, session.operator.id);
        return operatorJson(updated ?? session.operator);
      },
    );

    // -----------------------------------------------------------------
    // Second-factor re-enrolment.

    app.post(
      "/auth/totp",
      { config: { patrolRoles: ["operator", "administrator"] } },
      async (request) => {
        const session = request.session!;
        const body = app.validate(request.body, "ReenrollmentRequest") as {
          password: string;
          currentCode: string;
        };
        await assertCurrentCredentials(
          session.operator,
          body.password,
          body.currentCode,
        );
        const now = config.now();
        const secret = generateTotpSecret();
        const expiresAt = new Date(now.getTime() + REENROLLMENT_PENDING_TTL_MS);
        await pool.query(
          `insert into totp_enrollment
             (operator_id, enrollment_token_hash, enrollment_expires_at,
              pending_secret, pending_started_at, created_at, updated_at)
           values ($1, $2, $3, $4, $5, $5, $5)
           on conflict (operator_id) do update set
             enrollment_token_hash = excluded.enrollment_token_hash,
             enrollment_expires_at = excluded.enrollment_expires_at,
             pending_secret = excluded.pending_secret,
             pending_started_at = excluded.pending_started_at,
             updated_at = excluded.updated_at`,
          [
            session.operator.id,
            sha256Hex(newOpaqueToken()),
            expiresAt.toISOString(),
            secret,
            now.toISOString(),
          ],
        );
        return {
          secret,
          otpauthUri: otpauthUri(secret, session.operator.email),
          expiresAt: expiresAt.toISOString(),
        };
      },
    );

    app.post(
      "/auth/totp/confirmation",
      { config: { patrolRoles: ["operator", "administrator"] } },
      async (request) => {
        const session = request.session!;
        const body = app.validate(request.body, "ReenrollmentConfirmation") as {
          code: string;
        };
        const now = config.now();
        const found = await pool.query<{
          pending_secret: string | null;
          enrollment_expires_at: Date;
        }>(
          "select pending_secret, enrollment_expires_at from totp_enrollment where operator_id = $1",
          [session.operator.id],
        );
        const row = found.rows[0];
        if (!row || row.pending_secret === null) {
          throw new ApiError(422, "state_conflict");
        }
        if (row.enrollment_expires_at.getTime() <= now.getTime()) {
          throw new ApiError(401, "challenge_expired");
        }
        if (!verifyTotpCode(row.pending_secret, body.code, now)) {
          throw new ApiError(401, "invalid_second_factor");
        }
        const recoveryCodes = generateRecoveryCodes();
        const client = await pool.connect();
        try {
          await client.query("begin");
          await client.query(
            "update operators set totp_secret = $1, totp_enrolled_at = $2, updated_at = $2 where id = $3",
            [row.pending_secret, now.toISOString(), session.operator.id],
          );
          await client.query(
            "delete from totp_enrollment where operator_id = $1",
            [session.operator.id],
          );
          await client.query(
            "delete from recovery_codes where operator_id = $1",
            [session.operator.id],
          );
          for (const code of recoveryCodes) {
            await client.query(
              "insert into recovery_codes (operator_id, code_hash, created_at) values ($1, $2, $3)",
              [
                session.operator.id,
                hashRecoveryCode(code, config.recoveryPepper),
                now.toISOString(),
              ],
            );
          }
          const revoked = await revokeOperatorSessions(client, session.operator.id, {
            exceptSessionId: session.session.id,
          });
          if (revoked > 0) {
            await recordSecurityEvent(
              client,
              {
                operatorId: session.operator.id,
                kind: "session_revoked",
                detail: { on: "totp_reenrollment", count: revoked },
              },
              now,
            );
          }
          await recordSecurityEvent(
            client,
            { operatorId: session.operator.id, kind: "totp_reenrolled" },
            now,
          );
          await recordSecurityEvent(
            client,
            { operatorId: session.operator.id, kind: "recovery_codes_issued" },
            now,
          );
          await client.query("commit");
          return { recoveryCodes };
        } catch (error) {
          await client.query("rollback").catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
      },
    );
  };
}
