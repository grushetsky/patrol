const id = (n: number) =>
  `018f4c8e-1c2a-7c3e-9b1f-2b6d9f0a3c${String(n).padStart(2, "0")}`;

const at = "2026-11-03T10:00:00Z";

/** A request body that satisfies the emitted ReviewDecisionRequest schema. */
export const reviewDecisionRequest = {
  action: "violation" as const,
  evidenceIds: [id(9)],
};

/** A response body that satisfies the emitted ReviewDecisionResult schema. */
export const reviewDecisionResult = {
  decision: {
    id: id(20),
    candidateId: id(21),
    action: "violation" as const,
    operatorId: id(1),
    decidedAt: at,
    evidenceIds: [id(9)],
    violationId: id(22),
  },
  candidate: {
    id: id(21),
    trackedTitleId: id(7),
    url: "https://www.example.test/watch/1",
    normalizedUrl: "example.test/watch/1",
    host: "example.test",
    registrableDomain: "example.test",
    matchedVariantId: id(6),
    matchedVariant: {
      id: id(6),
      text: "Пример",
      kind: "original" as const,
      language: "ru",
      script: "Cyrl",
    },
    score: 0.95,
    scoreComponents: {
      titleMatch: 0.7,
      signals: [{ kind: "player" as const, value: 0.25 }],
      reputation: 0,
    },
    reputation: {
      registrableDomain: "example.test",
      confirmedViolations: 0,
      bonus: 0,
      blocklisted: false,
    },
    firstObservedAt: at,
    lastObservedAt: at,
    priorDecisionIds: [],
    lifecycle: { state: "pending" as const },
  },
};

/** A response body that is deliberately malformed. */
export const malformedReviewDecisionResult = {
  decision: { id: id(20), action: "remove" },
  candidate: {},
};
