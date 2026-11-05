import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import type { Pool } from "pg";
import type { AppConfig } from "../config.js";
import {
  closeViolationRoute,
  listViolations,
  readViolationDetail,
} from "../domain/review/violations.js";
import { capturePort, captureViolationUrl } from "../domain/review/captures.js";
import { violationJson } from "../domain/review/serialize.js";
import {
  createLegalHoldRoute,
  listLegalHoldsPage,
  releaseLegalHoldRoute,
} from "../domain/legal-holds.js";
import { ApiError } from "../errors.js";
import { sendCaptureAnswer } from "./support.js";

/**
 * The Violations, and the LegalHolds interfaces (Patrol.Http): the list
 * with its filters (tracked title, state, notice), the detail with its
 * citations and confirming decision, the operator closure (terminal,
 * `state_conflict` on a closed or removed row), capture on demand for
 * review or handoff, and the legal holds that outrank every purge rule
 * until released. A violation is never reopened: a reappearing URL is a
 * new row with a predecessor, which the confirm path builds.
 */

export interface ViolationsRoutesDeps {
  config: AppConfig;
  pool: Pool;
  /** Wakes the worker's capture queue for one capture. */
  captureDispatch?: (captureId: string) => Promise<void>;
}

export function violationsRoutes(deps: ViolationsRoutesDeps): FastifyPluginAsync {
  const { config, pool } = deps;
  return async (app: FastifyInstance) => {
    const capture =
      deps.captureDispatch === undefined
        ? undefined
        : capturePort(pool, config.now, deps.captureDispatch);

    app.get("/violations", async (request) =>
      listViolations(pool, request.query as Record<string, unknown>),
    );

    app.get("/violations/:violationId", async (request) => {
      const { violationId } = request.params as { violationId: string };
      return readViolationDetail(pool, violationId);
    });

    app.post("/violations/:violationId/closure", async (request) => {
      const actor = request.session!;
      const { violationId } = request.params as { violationId: string };
      const body = app.validate(request.body, "ViolationClosureRequest") as {
        reason: "url_removed" | "operator_closed";
        note?: string;
        evidenceId?: string;
      };
      const violation = await closeViolationRoute(pool, config.now, actor.operator.id, violationId, {
        reason: body.reason,
        ...(body.note === undefined ? {} : { note: body.note }),
        ...(body.evidenceId === undefined ? {} : { evidenceId: body.evidenceId }),
      });
      return violationJson(violation);
    });

    app.post("/violations/:violationId/captures", async (request, reply) => {
      const { violationId } = request.params as { violationId: string };
      const body = app.validate(request.body, "CaptureRequest") as {
        reason: "detection" | "review" | "pre_handoff";
      };
      if (capture === undefined) {
        // Without a dispatch a capture cannot be queued; the honest answer
        // is the conflict, not a silent no-op.
        throw new ApiError(409, "state_conflict");
      }
      const answer = await captureViolationUrl(
        capture,
        pool,
        config.now,
        violationId,
        body.reason === "detection" ? "review" : body.reason,
      );
      return sendCaptureAnswer(reply, config.now, answer);
    });

    app.get("/legal-holds", async (request) =>
      listLegalHoldsPage(pool, request.query as Record<string, unknown>),
    );

    app.post("/legal-holds", async (request, reply) => {
      const actor = request.session!;
      const body = app.validate(request.body, "CreateLegalHoldRequest") as {
        reason: string;
        evidenceIds?: string[];
        violationIds?: string[];
        noticeIds?: string[];
      };
      const hold = await createLegalHoldRoute(
        { pool, now: config.now },
        actor.operator.id,
        body,
      );
      reply.status(201);
      return hold;
    });

    app.post("/legal-holds/:legalHoldId/release", async (request) => {
      const actor = request.session!;
      const { legalHoldId } = request.params as { legalHoldId: string };
      const body = app.validate(request.body, "ReleaseLegalHoldRequest") as {
        reason: string;
      };
      return releaseLegalHoldRoute(
        { pool, now: config.now },
        actor.operator.id,
        legalHoldId,
        body.reason,
      );
    });
  };
}
