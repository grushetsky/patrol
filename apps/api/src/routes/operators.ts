import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import type { Pool, PoolClient } from "pg";
import type { AppConfig } from "../config.js";
import { ApiError } from "../errors.js";
import { inviteLink, sendInvitationEmail, sendResetEmail } from "../mail/invite.js";
import type { MailTransport } from "../mail/transport.js";
import {
  revokeOperatorSessions,
  toOperatorRecord,
  type OperatorRow,
} from "../domain/session.js";

import {
  createInvitation,
  findInvitationById,
  invitationState,
  mapInvitationRow,
  type InvitationRow,
} from "../domain/invitation.js";
import { recordSecurityEvent } from "../domain/security-events.js";
import { operatorJson, pageParams, sessionsPage } from "./support.js";

/**
 * The Operators and Invitations interfaces (Patrol.Http): accounts, roles,
 * credential resets, any operator's sessions, and the invitation lifecycle.
 * Every operation requires the administrator role; the routes declare it
 * and the auth plugin's role guard enforces it.
 */

export interface OperatorRoutesDeps {
  config: AppConfig;
  pool: Pool;
  mail: MailTransport;
}

async function findOperatorRow(
  pool: Pool | PoolClient,
  id: string,
): Promise<OperatorRow | null> {
  const result = await pool.query<OperatorRow>(
    "select * from operators where id = $1",
    [id],
  );
  return result.rows[0] ?? null;
}

/** The rights holder's legal name, for the emails this interface sends. */
async function rightsHolderName(pool: Pool): Promise<string | null> {
  const result = await pool.query<{ legal_name: string }>(
    "select legal_name from rights_holder limit 1",
  );
  return result.rows[0]?.legal_name ?? null;
}

function invitationJson(row: ReturnType<typeof mapInvitationRow>): Record<string, unknown> {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    ...(row.invitedBy !== null ? { invitedBy: row.invitedBy } : {}),
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    ...(row.acceptedAt !== null
      ? { acceptedAt: row.acceptedAt.toISOString() }
      : {}),
    ...(row.revokedAt !== null ? { revokedAt: row.revokedAt.toISOString() } : {}),
  };
}

/** How many active administrators other than `excludeId` exist. */
async function otherActiveAdministrators(
  client: Pool | PoolClient,
  excludeId: string,
): Promise<number> {
  const result = await client.query<{ count: string }>(
    "select count(*) as count from operators where role = 'administrator' and state = 'active' and id <> $1",
    [excludeId],
  );
  return Number(result.rows[0].count);
}

export function operatorRoutes(deps: OperatorRoutesDeps): FastifyPluginAsync {
  const { config, pool, mail } = deps;

  return async (app: FastifyInstance) => {
    app.get(
      "/operators",
      { config: { patrolRoles: ["administrator"] } },
      async (request) => {
        const { page, pageSize, limit, offset } = pageParams(
          request.query as Record<string, unknown>,
        );
        const result = await pool.query<OperatorRow>(
          "select * from operators order by email limit $1 offset $2",
          [limit, offset],
        );
        const total = await pool.query<{ count: string }>(
          "select count(*) as count from operators",
        );
        return {
          items: result.rows.map((row) => operatorJson(toOperatorRecord(row))),
          total: Number(total.rows[0].count),
          page,
          pageSize,
        };
      },
    );

    app.patch(
      "/operators/:operatorId",
      { config: { patrolRoles: ["administrator"] } },
      async (request) => {
        const actor = request.session!;
        const operatorId = (request.params as { operatorId: string }).operatorId;
        const body = app.validate(request.body, "OperatorPatchRequest") as {
          role?: "operator" | "administrator";
          state?: "active" | "disabled";
        };
        const now = config.now();
        const client = await pool.connect();
        try {
          await client.query("begin");
          const target = await findOperatorRow(client, operatorId);
          if (target === null) {
            await client.query("rollback");
            throw new ApiError(404, "not_found");
          }
          const demotes =
            body.role !== undefined && body.role !== target.role && target.role === "administrator";
          const disables =
            body.state === "disabled" && target.state !== "disabled";
          if (target.role === "administrator" && target.state === "active" && (demotes || disables)) {
            // The last administrator cannot be demoted or disabled.
            if ((await otherActiveAdministrators(client, target.id)) === 0) {
              await client.query("rollback");
              throw new ApiError(409, "last_administrator");
            }
          }
          const nextRole = body.role ?? target.role;
          const nextState = body.state ?? target.state;
          const roleChanged = nextRole !== target.role;
          const stateChanged = nextState !== target.state;
          await client.query(
            `update operators set role = $1, state = $2,
               disabled_at = case when $2 = 'disabled' then $3::timestamptz else null::timestamptz end,
               disabled_by = case when $2 = 'disabled' then $4::uuid else null::uuid end,
               updated_at = $3::timestamptz
             where id = $5`,
            [nextRole, nextState, now.toISOString(), actor.operator.id, target.id],
          );
          // Every role change and a disable revoke the account's sessions.
          if (roleChanged || disables) {
            const revoked = await revokeOperatorSessions(client, target.id);
            if (revoked > 0) {
              await recordSecurityEvent(
                client,
                {
                  operatorId: target.id,
                  kind: "session_revoked",
                  detail: { on: roleChanged ? "role_change" : "disable", count: revoked },
                },
                now,
              );
            }
          }
          if (roleChanged) {
            await recordSecurityEvent(
              client,
              {
                operatorId: target.id,
                kind: "role_changed",
                detail: { from: target.role, to: nextRole, by: actor.operator.id },
              },
              now,
            );
          }
          if (disables) {
            await recordSecurityEvent(
              client,
              {
                operatorId: target.id,
                kind: "operator_disabled",
                detail: { by: actor.operator.id },
              },
              now,
            );
          } else if (stateChanged) {
            await recordSecurityEvent(
              client,
              { operatorId: target.id, kind: "operator_reinstated" },
              now,
            );
          }
          await client.query("commit");
          // A role or state change can alter which administrators are
          // active, which the setup gate reads.
          app.invalidateSetupStateCache();
          const updated = await findOperatorRow(pool, operatorId);
          return operatorJson(toOperatorRecord(updated!));
        } catch (error) {
          await client.query("rollback").catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
      },
    );

    app.post(
      "/operators/:operatorId/credential-reset",
      { config: { patrolRoles: ["administrator"] } },
      async (request, reply) => {
        const actor = request.session!;
        const operatorId = (request.params as { operatorId: string }).operatorId;
        const body = app.validate(request.body, "CredentialResetRequest") as {
          reason?: string;
        };
        const now = config.now();
        const client = await pool.connect();
        let email = "";
        let role: "operator" | "administrator" = "operator";
        let preferred: "en" | "ru" | null = null;
        let token = "";
        try {
          await client.query("begin");
          const target = await findOperatorRow(client, operatorId);
          if (target === null) {
            await client.query("rollback");
            throw new ApiError(404, "not_found");
          }
          email = target.email;
          role = target.role;
          preferred = target.preferred_language;
          // Force re-enrolment and end every session the account held. The
          // disabled markers clear with the credentials: the account returns
          // to the invited state, which carries no disablement.
          await client.query(
            `update operators set password_hash = null, totp_secret = null,
               totp_enrolled_at = null, state = 'invited', failed_attempts = 0,
               locked_until = null, disabled_at = null, disabled_by = null,
               updated_at = $1
             where id = $2`,
            [now.toISOString(), target.id],
          );
          await client.query(
            "delete from recovery_codes where operator_id = $1",
            [target.id],
          );
          const revoked = await revokeOperatorSessions(client, target.id);
          if (revoked > 0) {
            await recordSecurityEvent(
              client,
              {
                operatorId: target.id,
                kind: "session_revoked",
                detail: { on: "credential_reset", count: revoked },
              },
              now,
            );
          }
          const invitation = await createInvitation(client, config, {
            email: target.email,
            role: target.role,
            invitedBy: actor.operator.id,
          });
          token = invitation.token;
          await recordSecurityEvent(
            client,
            {
              operatorId: target.id,
              kind: "credential_reset",
              detail: { by: actor.operator.id, reason: body.reason ?? null },
            },
            now,
          );
          await recordSecurityEvent(
            client,
            {
              operatorId: target.id,
              kind: "invitation_created",
              detail: { on: "credential_reset" },
            },
            now,
          );
          await client.query("commit");
          app.invalidateSetupStateCache();
        } catch (error) {
          await client.query("rollback").catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
        // The reset email goes out after the commit; a failed send is logged
        // by the transport and never rolls the reset back.
        await sendResetEmail(mail, {
          to: email,
          locale: preferred,
          link: inviteLink(config, token),
          rightsHolderName: await rightsHolderName(pool),
        });
        const updated = await findOperatorRow(pool, operatorId);
        reply.status(202);
        return {
          operator: operatorJson(toOperatorRecord(updated!)),
          resetAt: now.toISOString(),
          reenrollmentRequired: true,
        };
      },
    );

    app.get(
      "/operators/:operatorId/sessions",
      { config: { patrolRoles: ["administrator"] } },
      async (request) => {
        const operatorId = (request.params as { operatorId: string }).operatorId;
        const target = await findOperatorRow(pool, operatorId);
        if (target === null) {
          throw new ApiError(404, "not_found");
        }
        return sessionsPage(pool, operatorId, request.query as Record<string, unknown>);
      },
    );

    app.delete(
      "/operators/:operatorId/sessions/:sessionId",
      { config: { patrolRoles: ["administrator"] } },
      async (request, reply) => {
        const actor = request.session!;
        const { operatorId, sessionId } = request.params as {
          operatorId: string;
          sessionId: string;
        };
        const now = config.now();
        const client = await pool.connect();
        try {
          await client.query("begin");
          const deleted = await client.query(
            "delete from operator_sessions where id = $1 and operator_id = $2",
            [sessionId, operatorId],
          );
          if (deleted.rowCount !== 1) {
            await client.query("rollback");
            throw new ApiError(404, "not_found");
          }
          await recordSecurityEvent(
            client,
            {
              operatorId,
              kind: "session_revoked",
              detail: { sessionId, on: "administrator", by: actor.operator.id },
            },
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

    // -----------------------------------------------------------------
    // Invitations.

    app.get(
      "/invitations",
      { config: { patrolRoles: ["administrator"] } },
      async (request) => {
        const { page, pageSize, limit, offset } = pageParams(
          request.query as Record<string, unknown>,
        );
        // `invited_by` is null only on the bootstrap invitation, which no
        // operator issued. The contract's Invitation carries a required
        // invitedBy, so the read model resolves that null to the bootstrap
        // administrator — the account the bootstrap invitation created.
        // Nobody can read this list before that account exists: listing
        // requires an authenticated administrator.
        const result = await pool.query(
          `select i.id, i.email, i.role,
                  coalesce(
                    i.invited_by,
                    (select o.id from operators o
                     where o.role = 'administrator'
                     order by o.created_at asc limit 1)
                  ) as invited_by,
                  i.created_at, i.expires_at, i.accepted_at, i.revoked_at
           from invitations i
           order by i.created_at desc limit $1 offset $2`,
          [limit, offset],
        );
        const total = await pool.query<{ count: string }>(
          "select count(*) as count from invitations",
        );
        const now = config.now();
        return {
          items: result.rows.map((row) => {
            const mapped = mapInvitationRow(row);
            return {
              invitation: invitationJson(mapped),
              state: invitationState(mapped, now),
            };
          }),
          total: Number(total.rows[0].count),
          page,
          pageSize,
        };
      },
    );

    app.post(
      "/invitations",
      { config: { patrolRoles: ["administrator"] } },
      async (request, reply) => {
        const actor = request.session!;
        const body = app.validate(request.body, "CreateInvitationRequest") as {
          email: string;
          role: "operator" | "administrator";
        };
        const now = config.now();
        let token = "";
        let created: InvitationRow | null = null;
        const client = await pool.connect();
        try {
          await client.query("begin");
          const invitation = await createInvitation(client, config, {
            email: body.email,
            role: body.role,
            invitedBy: actor.operator.id,
          });
          token = invitation.token;
          created = invitation.row;
          await recordSecurityEvent(
            client,
            {
              operatorId: actor.operator.id,
              kind: "invitation_created",
              detail: { email: body.email, role: body.role },
            },
            now,
          );
          await client.query("commit");
        } catch (error) {
          await client.query("rollback").catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
        // Pre-preference email rule: a new invitation has no account (or a
        // reset one), so English unless the invited account holds one.
        const invited = await pool.query<{ preferred_language: "en" | "ru" | null }>(
          "select preferred_language from operators where email = $1",
          [body.email],
        );
        await sendInvitationEmail(mail, {
          to: body.email,
          locale: invited.rows[0]?.preferred_language ?? null,
          link: inviteLink(config, token),
          rightsHolderName: await rightsHolderName(pool),
        });
        // The insert already returned the row; no second read is needed.
        const mapped = created!;
        reply.status(201);
        return {
          invitation: invitationJson(mapped),
          state: invitationState(mapped, config.now()),
        };
      },
    );

    app.delete(
      "/invitations/:invitationId",
      { config: { patrolRoles: ["administrator"] } },
      async (request, reply) => {
        const actor = request.session!;
        const invitationId = (request.params as { invitationId: string })
          .invitationId;
        const now = config.now();
        const client = await pool.connect();
        try {
          await client.query("begin");
          const row = await findInvitationById(client, invitationId);
          if (row === null) {
            await client.query("rollback");
            throw new ApiError(404, "not_found");
          }
          // Revocation is a transition out of pending only: an accepted or
          // already-revoked invitation is a conflict, and no second
          // invitation_revoked event is recorded for either.
          if (row.acceptedAt !== null || row.revokedAt !== null) {
            await client.query("rollback");
            throw new ApiError(409, "state_conflict");
          }
          await client.query(
            "update invitations set revoked_at = $1 where id = $2",
            [now.toISOString(), invitationId],
          );
          await recordSecurityEvent(
            client,
            {
              operatorId: actor.operator.id,
              kind: "invitation_revoked",
              detail: { invitationId },
            },
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
  };
}
