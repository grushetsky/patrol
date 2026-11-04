import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";

/**
 * Stamps the request id fastify generated (a crypto.randomUUID through
 * genReqId in app.ts) onto every response, so an operator can correlate a
 * browser error with the pino line that carries the same id. Wrapped with
 * fastify-plugin so the hook covers every scope.
 */
export const requestIdPlugin: FastifyPluginAsync = fp(async (app) => {
  app.addHook("onSend", async (request, reply) => {
    reply.header("x-request-id", request.id);
  });
});
