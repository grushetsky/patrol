import { createHash } from "node:crypto";
import { randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { AppConfig } from "../config.js";

/**
 * Server-side sessions (Authentication "Sessions"): 256 random bits, stored
 * only as a SHA-256, an eight-hour idle timeout, a seven-day absolute
 * lifetime, and rotation at re-authentication. The cookie name and its
 * `Secure` flag follow the deployment environment; only production may carry
 * the `__Host-` prefix, which browsers reject unless `Secure` is set.
 */

export const IDLE_SESSION_MS = 8 * 60 * 60 * 1000;
export const ABSOLUTE_SESSION_MS = 7 * 24 * 60 * 60 * 1000;

/** A 256-bit token, base64url — the session, CSRF, ceremony, and challenge material. */
export function newOpaqueToken(): string {
  return randomBytes(32).toString("base64url");
}

/** The session token specifically; same shape, named for readability. */
export function newSessionToken(): string {
  return newOpaqueToken();
}

/** The only at-rest representation of any token. */
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export interface SessionExpiry {
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
}

/** Idle and absolute expiry for a session created at `now`. */
export function sessionExpiry(now: Date): SessionExpiry {
  return {
    idleExpiresAt: new Date(now.getTime() + IDLE_SESSION_MS),
    absoluteExpiresAt: new Date(now.getTime() + ABSOLUTE_SESSION_MS),
  };
}

/** The cookie value the API sets for a session token, per environment. */
export function sessionCookie(config: AppConfig, token: string): string {
  const name =
    config.env === "production" ? "__Host-patrol_session" : "patrol_session";
  const secure = config.env === "production" ? "; Secure" : "";
  return `${name}=${token}; Path=/; HttpOnly; SameSite=Lax${secure}`;
}

/**
 * The `Set-Cookie` value that clears the session cookie on logout responses;
 * mirrors `sessionCookie` with an empty value and an instant expiry.
 */
export function clearedSessionCookie(config: AppConfig): string {
  const name =
    config.env === "production" ? "__Host-patrol_session" : "patrol_session";
  const secure = config.env === "production" ? "; Secure" : "";
  return `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

/** The anonymous CSRF cookie name, shared by every environment. */
export const CSRF_COOKIE_NAME = "patrol_csrf";

/** The CSRF cookie is double-submit: the browser must read it, so not HttpOnly. */
export function csrfCookie(token: string): string {
  return `${CSRF_COOKIE_NAME}=${token}; Path=/; SameSite=Lax`;
}

// ---------------------------------------------------------------------------
// Session rows. Every timestamp comes from the injected clock so the idle and
// absolute lifetimes are testable; no database-side now() is trusted.

/** One operator row as the identity tables store it. */
export interface OperatorRecord {
  id: string;
  email: string;
  passwordHash: string | null;
  role: "operator" | "administrator";
  state: "invited" | "active" | "disabled";
  preferredLanguage: "en" | "ru" | null;
  failedAttempts: number;
  lockedUntil: Date | null;
  lastSignInAt: Date | null;
  totpSecret: string | null;
  totpEnrolledAt: Date | null;
  disabledAt: Date | null;
  disabledBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** The operators table's column shape, as pg returns it (snake_case). */
export interface OperatorRow {
  id: string;
  email: string;
  password_hash: string | null;
  role: "operator" | "administrator";
  state: "invited" | "active" | "disabled";
  preferred_language: "en" | "ru" | null;
  failed_attempts: number;
  locked_until: Date | null;
  last_sign_in_at: Date | null;
  totp_secret: string | null;
  totp_enrolled_at: Date | null;
  disabled_at: Date | null;
  disabled_by: string | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * The one mapper from an operators row to its domain record. Every reader —
 * the auth routes, the operator routes, the session join — goes through
 * here, so a new column is mapped exactly once.
 */
export function toOperatorRecord(row: OperatorRow): OperatorRecord {
  return {
    id: row.id,
    email: row.email,
    passwordHash: row.password_hash,
    role: row.role,
    state: row.state,
    preferredLanguage: row.preferred_language,
    failedAttempts: Number(row.failed_attempts),
    lockedUntil: row.locked_until,
    lastSignInAt: row.last_sign_in_at,
    totpSecret: row.totp_secret,
    totpEnrolledAt: row.totp_enrolled_at,
    disabledAt: row.disabled_at,
    disabledBy: row.disabled_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** One session row joined with its operator. */
export interface SessionWithOperator {
  session: {
    id: string;
    operatorId: string;
    createdAt: Date;
    lastSeenAt: Date;
    idleExpiresAt: Date;
    absoluteExpiresAt: Date;
    userAgent: string;
    coarseIp: string | null;
    /** The double-submit token mutations echo in X-Patrol-CSRF. */
    csrfToken: string;
  };
  operator: OperatorRecord;
}

export interface CreateSessionInput {
  operatorId: string;
  userAgent: string;
  coarseIp: string | null;
}

export interface IssuedSession {
  token: string;
  csrfToken: string;
  row: SessionWithOperator["session"];
}

/**
 * Creates a session row and returns the plaintext tokens exactly once: the
 * session token for the cookie, the CSRF token for mutations.
 */
export async function createSession(
  client: Pool | PoolClient,
  config: AppConfig,
  input: CreateSessionInput,
): Promise<IssuedSession> {
  const token = newSessionToken();
  const csrfToken = newOpaqueToken();
  const now = config.now();
  const { idleExpiresAt, absoluteExpiresAt } = sessionExpiry(now);
  const result = await client.query<{ id: string }>(
    `insert into operator_sessions
       (operator_id, token_hash, csrf_token, created_at, last_seen_at,
        idle_expires_at, absolute_expires_at, user_agent, coarse_ip)
     values ($1, $2, $3, $4, $4, $5, $6, $7, $8)
     returning id`,
    [
      input.operatorId,
      sha256Hex(token),
      csrfToken,
      now.toISOString(),
      idleExpiresAt.toISOString(),
      absoluteExpiresAt.toISOString(),
      input.userAgent,
      input.coarseIp,
    ],
  );
  return {
    token,
    csrfToken,
    row: {
      id: result.rows[0].id,
      operatorId: input.operatorId,
      createdAt: now,
      lastSeenAt: now,
      idleExpiresAt,
      absoluteExpiresAt,
      userAgent: input.userAgent,
      coarseIp: input.coarseIp,
      csrfToken,
    },
  };
}

const SESSION_SELECT = `
  select s.id, o.id as operator_id, s.created_at, s.last_seen_at,
         s.idle_expires_at, s.absolute_expires_at, s.user_agent, s.coarse_ip,
         s.csrf_token,
         o.email, o.password_hash, o.role, o.state,
         o.preferred_language, o.failed_attempts, o.locked_until,
         o.last_sign_in_at, o.totp_secret, o.totp_enrolled_at,
         o.disabled_at, o.disabled_by, o.created_at as operator_created_at,
         o.updated_at as operator_updated_at
  from operator_sessions s
  join operators o on o.id = s.operator_id
`;

interface SessionRow extends Omit<OperatorRow, "id" | "created_at" | "updated_at"> {
  id: string;
  operator_id: string;
  created_at: Date;
  last_seen_at: Date;
  idle_expires_at: Date;
  absolute_expires_at: Date;
  user_agent: string;
  coarse_ip: string | null;
  csrf_token: string;
  operator_created_at: Date;
  operator_updated_at: Date;
}

function toSessionWithOperator(row: SessionRow): SessionWithOperator {
  return {
    session: {
      id: row.id,
      operatorId: row.operator_id,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
      idleExpiresAt: row.idle_expires_at,
      absoluteExpiresAt: row.absolute_expires_at,
      userAgent: row.user_agent,
      coarseIp: row.coarse_ip,
      csrfToken: row.csrf_token,
    },
    operator: toOperatorRecord({
      ...row,
      id: row.operator_id,
      created_at: row.operator_created_at,
      updated_at: row.operator_updated_at,
    }),
  };
}

/**
 * Loads the session a cookie names, enforcing the idle and absolute
 * lifetimes against the injected clock; expired rows load as null (revoked
 * rows are deleted outright). The row's last-seen and idle window slide by
 * one call.
 */
export async function loadSession(
  pool: Pool | PoolClient,
  config: AppConfig,
  token: string | undefined,
): Promise<SessionWithOperator | null> {
  if (!token) {
    return null;
  }
  const now = config.now();
  const result = await pool.query<SessionRow>(
    `${SESSION_SELECT}
     where s.token_hash = $1
       and s.absolute_expires_at > $2 and s.idle_expires_at > $2`,
    [sha256Hex(token), now.toISOString()],
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  const idleExpiresAt = new Date(now.getTime() + IDLE_SESSION_MS);
  await pool.query(
    `update operator_sessions set last_seen_at = $1, idle_expires_at = $2 where id = $3`,
    [now.toISOString(), idleExpiresAt.toISOString(), row.id],
  );
  const loaded = toSessionWithOperator(row);
  loaded.session.lastSeenAt = now;
  loaded.session.idleExpiresAt = idleExpiresAt;
  return loaded;
}

/** Deletes one session row by its id, scoped to one operator unless null. */
export async function deleteSession(
  client: Pool | PoolClient,
  sessionId: string,
  operatorId?: string,
): Promise<boolean> {
  const result = await client.query(
    `delete from operator_sessions where id = $1 and ($2::uuid is null or operator_id = $2)`,
    [sessionId, operatorId ?? null],
  );
  return result.rowCount === 1;
}

/**
 * A revocation trigger (Authentication "Revocation"): deletes the affected
 * rows. `exceptSessionId` keeps the caller's own session across a password,
 * email, or TOTP change, which revoke every other session.
 */
export async function revokeOperatorSessions(
  client: Pool | PoolClient,
  operatorId: string,
  options: { exceptSessionId?: string } = {},
): Promise<number> {
  const result = await client.query(
    `delete from operator_sessions
     where operator_id = $1
       and ($2::uuid is null or id <> $2)`,
    [operatorId, options.exceptSessionId ?? null],
  );
  return result.rowCount ?? 0;
}
