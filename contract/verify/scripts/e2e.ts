import type { AddressInfo } from "node:net";
import createClient from "openapi-fetch";
import type { paths } from "../src/generated/openapi";
import { createStubServer } from "../src/server/stub.ts";
import {
  malformedReviewDecisionResult,
  reviewDecisionRequest,
} from "../src/server/fixtures.ts";
import { validateReviewDecisionResult } from "../src/server/validators.ts";

const server = createStubServer();
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address() as AddressInfo;
const api = createClient<paths>({ baseUrl: `http://127.0.0.1:${port}` });

const candidateId = "018f4c8e-1c2a-7c3e-9b1f-2b6d9f0a3c21";
const csrfToken = "csrf-token";
const failures: string[] = [];

try {
  const accepted = await api.POST(
    "/candidates/{candidateId}/review-decisions",
    {
      params: {
        path: { candidateId },
        header: { "X-Patrol-CSRF": csrfToken },
      },
      body: reviewDecisionRequest,
    },
  );
  if (accepted.response.status !== 201 || accepted.data?.decision.action !== "violation") {
    failures.push(`valid request answered ${accepted.response.status}`);
  } else {
    console.log("ok    valid request answered 201 with the schema-validated result");
  }

  const rejected = await api.POST(
    "/candidates/{candidateId}/review-decisions",
    {
      params: {
        path: { candidateId },
        header: { "X-Patrol-CSRF": csrfToken },
      },
      // Deliberately invalid: the server must reject it against the emitted schema.
      body: { action: "remove", evidenceIds: [] } as never,
    },
  );
  if (
    rejected.response.status !== 400 ||
    rejected.error?.code !== "validation_failed"
  ) {
    failures.push(
      `invalid request answered ${rejected.response.status} ${rejected.error?.code ?? "no code"}`,
    );
  } else {
    console.log("ok    invalid request answered 400 validation_failed");
  }

  if (!validateReviewDecisionResult(malformedReviewDecisionResult)) {
    console.log("ok    malformed response rejected by the Node-side validator");
  } else {
    failures.push("malformed response passed the Node-side validator");
  }
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("contract client and validator agree in both directions");
