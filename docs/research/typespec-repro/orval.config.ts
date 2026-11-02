import { defineConfig } from "orval";

export default defineConfig({
  patrolClient: {
    input: "generated/openapi/Patrol.openapi.yaml",
    output: {
      target: "generated/orval/patrol.ts",
      client: "react-query",
      mode: "single",
    },
  },
  patrolZod: {
    input: "generated/openapi/Patrol.openapi.yaml",
    output: {
      target: "generated/orval/zod.ts",
      client: "zod",
      mode: "single",
    },
  },
});
