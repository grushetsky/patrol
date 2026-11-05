import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import type { Pool } from "pg";
import type { AppConfig } from "../config.js";
import {
  candidateJson,
  createManualCandidate,
  listCandidates,
  readCandidateDetail,
  reviewDecisionsFor,
} from "../domain/candidates.js";
import {
  recordReviewDecision,
  type ProposedAllowlistEntryInput,
} from "../domain/review/dispositions.js";
import { reopenCandidateRoute } from "../domain/review/reopen.js";
import {
  captureCandidateUrl,
  capturePort,
  queueReviewCaptureOnOpen,
} from "../domain/review/captures.js";
import { ApiError } from "../errors.js";
import { sendCaptureAnswer } from "./support.js";

/**
 * The Candidates interface (Patrol.Http): the review queue with its fixed
 * order and filters, the manual pair creation whose deduplication key
 * answers 200-existing or 201-new, the detail with its provenance,
 * evidence, and decision history, the five dispositions, the operator
 * reopen, and capture on demand. The detail read also queues a review
 * capture for a pending pair whose newest live capture is stale — a side
 * effect of a read that never blocks the response.
 */

export interface CandidatesRoutesDeps {
  config: AppConfig;
  pool: Pool;
  /** The detection-capture enqueue port for a newly formed manual pair. */
  enqueueCapture?: (input: { url: string; reason: "detection" }) => Promise<unknown>;
  /** Wakes the worker's capture queue for one capture. */
  captureDispatch?: (captureId: string) => Promise<void>;
}

export function candidatesRoutes(deps: CandidatesRoutesDeps): FastifyPluginAsync {
  const { config, pool } = deps;
  return async (app: FastifyInstance) => {
    const capture =
      deps.captureDispatch === undefined
        ? undefined
        : capturePort(pool, config.now, deps.captureDispatch);

    app.get("/candidates", async (request) =>
      listCandidates(pool, request.query as Record<string, unknown>),
    );

    app.post("/candidates", async (request, reply) => {
      const actor = request.session!;
      const body = app.validate(request.body, "ManualCandidateRequest") as {
        url: string;
        trackedTitleId: string;
      };
      const { candidate, created } = await createManualCandidate(pool, config.now, {
        operatorId: actor.operator.id,
        url: body.url,
        trackedTitleId: body.trackedTitleId,
        ...(deps.enqueueCapture === undefined
          ? {}
          : { enqueueCapture: deps.enqueueCapture }),
      });
      reply.status(created ? 201 : 200);
      if (!created) {
        // A pair that already stands may carry its decision history; the
        // record the route returns names it.
        const decisions = await reviewDecisionsFor(pool, {
          normalizedUrl: candidate.normalizedUrl,
          trackedTitleId: candidate.trackedTitleId,
        });
        return candidateJson(
          candidate,
          decisions.map((decision) => decision.id),
        );
      }
      return candidateJson(candidate);
    });

    app.get("/candidates/:candidateId", async (request) => {
      const { candidateId } = request.params as { candidateId: string };
      const detail = await readCandidateDetail(pool, candidateId);
      if (capture !== undefined) {
        // The review capture point: an operator opening a pending pair
        // refreshes stale evidence. Never awaited into the response.
        void queueReviewCaptureOnOpen(capture, pool, detail.candidate);
      }
      return detail.body;
    });

    app.post("/candidates/:candidateId/review-decisions", async (request, reply) => {
      const actor = request.session!;
      const { candidateId } = request.params as { candidateId: string };
      const body = app.validate(request.body, "ReviewDecisionRequest") as {
        action: "violation" | "not_a_violation" | "wrong_work" | "authorized_here" | "page_dead";
        note?: string;
        evidenceIds: string[];
        rematchedTrackedTitleId?: string;
        allowlistEntry?: ProposedAllowlistEntryInput;
      };
      const result = await recordReviewDecision(
        pool,
        config.now,
        actor.operator.id,
        candidateId,
        {
          action: body.action,
          ...(body.note === undefined ? {} : { note: body.note }),
          evidenceIds: body.evidenceIds,
          ...(body.rematchedTrackedTitleId === undefined
            ? {}
            : { rematchedTrackedTitleId: body.rematchedTrackedTitleId }),
          ...(body.allowlistEntry === undefined
            ? {}
            : { allowlistEntry: body.allowlistEntry }),
        },
        capture === undefined ? undefined : (input) => capture.enqueue(input),
      );
      reply.status(201);
      return result;
    });

    app.post("/candidates/:candidateId/reopen", async (request) => {
      const actor = request.session!;
      const { candidateId } = request.params as { candidateId: string };
      const body = app.validate(request.body ?? {}, "CandidateReopenRequest") as {
        note?: string;
      };
      return reopenCandidateRoute(pool, config.now, actor.operator.id, candidateId, body.note);
    });

    app.post("/candidates/:candidateId/captures", async (request, reply) => {
      const { candidateId } = request.params as { candidateId: string };
      const body = app.validate(request.body, "CaptureRequest") as {
        reason: "detection" | "review" | "pre_handoff";
      };
      if (capture === undefined) {
        // Without a dispatch a capture cannot be queued; the honest answer
        // is the conflict, not a silent no-op.
        throw new ApiError(409, "state_conflict");
      }
      const answer = await captureCandidateUrl(
        capture,
        pool,
        config.now,
        candidateId,
        body.reason === "detection" ? "review" : body.reason,
      );
      return sendCaptureAnswer(reply, config.now, answer);
    });
  };
}
