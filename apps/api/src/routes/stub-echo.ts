import type { FastifyPluginAsync } from "fastify";

/**
 * TEMPORARY slice-0 scaffolding, deleted in slice 1. It exists only to prove
 * the generated client and the Ajv-over-bundle validator round-trip through a
 * real fastify route before any domain operation exists. The body validates
 * against ReviewDecisionRequest, a real emitted schema with required fields.
 */
export const stubEchoRoutes: FastifyPluginAsync = async (app) => {
  // No fastify JSON schema option here: contract routes never use fastify's
  // built-in body validation; the validator plugin owns it.
  app.post("/__stub/echo", async (request, reply) => {
    const body = app.validate(request.body, "ReviewDecisionRequest");
    reply.status(200);
    return body;
  });
};
