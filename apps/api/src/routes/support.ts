import type { FastifyReply } from "fastify";
import type { Pool } from "pg";
import type { OperatorRecord, SessionWithOperator } from "../domain/session.js";
import type { CaptureAnswer } from "../domain/review/captures.js";
import { ApiError } from "../errors.js";

/**
 * Mappers and request plumbing shared by the routes. Nothing here exposes
 * credential material: the contract's Operator, SessionView, and the
 * authenticated payloads never carry a hash, a secret, or a token.
 */

/** The contract's Operator shape (Patrol.Domain.Operator). */
export function operatorJson(operator: OperatorRecord): Record<string, unknown> {
  return {
    id: operator.id,
    email: operator.email,
    role: operator.role,
    state: operator.state,
    ...(operator.preferredLanguage !== null
      ? { preferredLanguage: operator.preferredLanguage }
      : {}),
    createdAt: operator.createdAt.toISOString(),
    updatedAt: operator.updatedAt.toISOString(),
    ...(operator.lastSignInAt !== null
      ? { lastSignInAt: operator.lastSignInAt.toISOString() }
      : {}),
    ...(operator.totpEnrolledAt !== null
      ? { totpEnrolledAt: operator.totpEnrolledAt.toISOString() }
      : {}),
    ...(operator.disabledAt !== null
      ? { disabledAt: operator.disabledAt.toISOString() }
      : {}),
    ...(operator.disabledBy !== null ? { disabledBy: operator.disabledBy } : {}),
  };
}

/** The contract's SessionView shape. */
export function sessionViewJson(
  session: SessionWithOperator["session"],
): Record<string, unknown> {
  return {
    id: session.id,
    createdAt: session.createdAt.toISOString(),
    lastSeenAt: session.lastSeenAt.toISOString(),
    idleExpiresAt: session.idleExpiresAt.toISOString(),
    absoluteExpiresAt: session.absoluteExpiresAt.toISOString(),
    userAgent: session.userAgent,
    ...(session.coarseIp !== null ? { coarseIp: session.coarseIp } : {}),
  };
}

/** Page-request parsing: one-based page, default fifty, capped at two hundred. */
export function pageParams(query: Record<string, unknown>): {
  page: number;
  pageSize: number;
  limit: number;
  offset: number;
} {
  const requestedPage = Number.parseInt(String(query.page ?? "1"), 10);
  const requestedSize = Number.parseInt(String(query.pageSize ?? "50"), 10);
  const page = Number.isInteger(requestedPage) && requestedPage >= 1 ? requestedPage : 1;
  const pageSize =
    Number.isInteger(requestedSize) && requestedSize >= 1
      ? Math.min(requestedSize, 200)
      : 50;
  return { page, pageSize, limit: pageSize, offset: (page - 1) * pageSize };
}

/**
 * The one answer every on-demand capture route gives: the port's refusal
 * codes (an allowlisted URL is never captured; a host under an objection
 * suspends captures) mapped onto their 409s, and the accepted answer as
 * 202 with the queued reason — the same contract reply for the candidate
 * and the violation capture endpoints alike.
 */
export function sendCaptureAnswer(
  reply: FastifyReply,
  now: () => Date,
  answer: CaptureAnswer,
): Record<string, unknown> {
  if (answer.status === "allowlist") {
    throw new ApiError(409, "allowlist_hit");
  }
  if (answer.status === "objection") {
    throw new ApiError(409, "host_objection", { hostObjectionId: answer.hostObjectionId });
  }
  reply.status(202);
  return { queuedAt: now().toISOString(), reason: answer.reason };
}

interface SessionPageRow {
  id: string;
  created_at: Date;
  last_seen_at: Date;
  idle_expires_at: Date;
  absolute_expires_at: Date;
  user_agent: string;
  coarse_ip: string | null;
}

/**
 * One operator's sessions as the contract's OperatorSessionPage: the one
 * query both /auth/sessions and /operators/{id}/sessions ask. Revoked
 * sessions are deleted rows, so every surviving row is live.
 */
export async function sessionsPage(
  pool: Pool,
  operatorId: string,
  query: Record<string, unknown>,
): Promise<{
  items: Record<string, unknown>[];
  total: number;
  page: number;
  pageSize: number;
}> {
  const { page, pageSize, limit, offset } = pageParams(query);
  const result = await pool.query<SessionPageRow>(
    `select id, created_at, last_seen_at, idle_expires_at,
            absolute_expires_at, user_agent, coarse_ip
     from operator_sessions where operator_id = $1
     order by created_at desc limit $2 offset $3`,
    [operatorId, limit, offset],
  );
  const total = await pool.query<{ count: string }>(
    "select count(*) as count from operator_sessions where operator_id = $1",
    [operatorId],
  );
  return {
    items: result.rows.map((row) => ({
      id: row.id,
      createdAt: row.created_at.toISOString(),
      lastSeenAt: row.last_seen_at.toISOString(),
      idleExpiresAt: row.idle_expires_at.toISOString(),
      absoluteExpiresAt: row.absolute_expires_at.toISOString(),
      userAgent: row.user_agent,
      ...(row.coarse_ip !== null ? { coarseIp: row.coarse_ip } : {}),
    })),
    total: Number(total.rows[0].count),
    page,
    pageSize,
  };
}

/** The request's coarse IP and user agent, for session rows and events. */
export function requestMeta(request: {
  headers: Record<string, unknown>;
  ip?: string;
}): { userAgent: string; coarseIp: string | null } {
  const rawAgent = request.headers["user-agent"];
  const userAgent = Array.isArray(rawAgent) ? String(rawAgent[0]) : String(rawAgent ?? "");
  // The API trusts the proxy (compose, ALB), so request.ip is the client's.
  const ip = request.ip ?? null;
  if (ip === null) {
    return { userAgent: userAgent.slice(0, 512), coarseIp: null };
  }
  return {
    userAgent: userAgent.slice(0, 512),
    coarseIp: ip.includes(":")
      ? `${ip.split(":").slice(0, 4).join(":")}::`
      : ip.split(".").slice(0, 3).join(".") + ".0",
  };
}
