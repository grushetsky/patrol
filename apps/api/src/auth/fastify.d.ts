import type { OperatorRecord, SessionRecord } from "./records.js";

declare module "fastify" {
  interface FastifyRequest {
    auth?: {
      operator: OperatorRecord;
      session: SessionRecord;
      csrfToken: string;
    };
  }
}
