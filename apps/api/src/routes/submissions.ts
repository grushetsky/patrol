import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import type { Pool } from "pg";
import type { AppConfig } from "../config.js";
import type {
  AcknowledgementBody,
  SubmissionAttestationInput,
  SubmissionFailureReason,
} from "@patrol/notices";
import {
  acknowledgeSubmission,
  deliverSubmission,
  failSubmission,
  listSubmissions,
  readSubmissionDetail,
  retrySubmissionRoute,
} from "../domain/notices/submissions.js";

/**
 * The Submissions interface (Patrol.Http), slice 7's surface: the list and
 * detail read models, and the four operator acts that move the single
 * delivery attempt an approved notice owns — record the delivery with the
 * operator's attestation, record what the recipient returned (validated
 * per recipient), report a failure or refusal with its cause note, and
 * re-file a failed submission on the same row. No operation here contacts
 * a recipient: every act names the operator who performed it, and no
 * scheduler path reaches these routes.
 */

export interface SubmissionsRoutesDeps {
  config: AppConfig;
  pool: Pool;
}

export function submissionsRoutes(deps: SubmissionsRoutesDeps): FastifyPluginAsync {
  const { config, pool } = deps;
  return async (app: FastifyInstance) => {
    app.get("/submissions", async (request) =>
      listSubmissions(pool, config.now, request.query as Record<string, unknown>),
    );

    app.get("/submissions/:submissionId", async (request) => {
      const { submissionId } = request.params as { submissionId: string };
      return readSubmissionDetail(pool, submissionId);
    });

    app.post("/submissions/:submissionId/delivery", async (request) => {
      const actor = request.session!;
      const { submissionId } = request.params as { submissionId: string };
      const body = app.validate(request.body, "SubmissionDeliveryRequest") as {
        attestation: SubmissionAttestationInput;
      };
      return deliverSubmission(
        pool,
        config.now,
        actor.operator.id,
        submissionId,
        body.attestation,
      );
    });

    app.post("/submissions/:submissionId/acknowledgement", async (request) => {
      const actor = request.session!;
      const { submissionId } = request.params as { submissionId: string };
      const body = app.validate(request.body, "AcknowledgementRecordRequest") as {
        attestation: SubmissionAttestationInput;
        acknowledgement: AcknowledgementBody;
      };
      return acknowledgeSubmission(
        pool,
        config.now,
        actor.operator.id,
        submissionId,
        body.attestation,
        body.acknowledgement,
      );
    });

    app.post("/submissions/:submissionId/failure", async (request) => {
      const actor = request.session!;
      const { submissionId } = request.params as { submissionId: string };
      const body = app.validate(request.body, "SubmissionFailureRequest") as {
        reason: SubmissionFailureReason;
        note: string;
      };
      return failSubmission(pool, config.now, actor.operator.id, submissionId, {
        reason: body.reason,
        note: body.note,
      });
    });

    app.post("/submissions/:submissionId/retry", async (request) => {
      const { submissionId } = request.params as { submissionId: string };
      return retrySubmissionRoute(pool, config.now, submissionId);
    });
  };
}
