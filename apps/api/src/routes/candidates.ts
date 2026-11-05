import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import type { Pool } from "pg";
import type { AppConfig } from "../config.js";
import {
  candidateJson,
  createManualCandidate,
  listCandidates,
  readCandidateDetail,
} from "../domain/candidates.js";

/**
 * The Candidates interface (Patrol.Http): the review queue with its fixed
 * order and filters, the manual pair creation whose deduplication key
 * answers 200-existing or 201-new, and the detail with its provenance and
 * evidence. The five dispositions, reopening, and capture-on-demand are
 * slice 5b's operations on the rows this slice stores.
 */

export interface CandidatesRoutesDeps {
  config: AppConfig;
  pool: Pool;
  /** The detection-capture enqueue port for a newly formed manual pair. */
  enqueueCapture?: (input: { url: string; reason: "detection" }) => Promise<unknown>;
}

export function candidatesRoutes(deps: CandidatesRoutesDeps): FastifyPluginAsync {
  const { config, pool } = deps;
  return async (app: FastifyInstance) => {
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
      return candidateJson(candidate);
    });

    app.get("/candidates/:candidateId", async (request) => {
      const { candidateId } = request.params as { candidateId: string };
      return readCandidateDetail(pool, candidateId);
    });
  };
}
