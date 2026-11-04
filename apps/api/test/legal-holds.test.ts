import { beforeEach, describe, expect, it } from "vitest";
import {
  addOperator,
  bootstrapAdmin,
  harness,
  mutate,
  read,
  type Harness,
} from "./support/harness.js";

const EVIDENCE_ID = "01900000-0000-7000-8000-000000004001";
const VIOLATION_ID = "01900000-0000-7000-8000-000000004002";
const NOTICE_ID = "01900000-0000-7000-8000-000000004003";

let h: Harness;
let adminSession: string;
let adminId: string;

beforeEach(async () => {
  h = await harness();
  const admin = await bootstrapAdmin(h);
  adminSession = admin.session;
  adminId = admin.operator.id;
});

function holdBody(overrides: Record<string, unknown> = {}) {
  return {
    reason: "A counter-notice is expected.",
    evidenceIds: [EVIDENCE_ID],
    violationIds: [],
    noticeIds: [],
    ...overrides,
  };
}

describe("legal holds", () => {
  it("records a hold over captures, violations, or notices", async () => {
    const response = await mutate(
      h.app,
      adminSession,
      "POST",
      "/api/legal-holds",
      holdBody({
        violationIds: [VIOLATION_ID],
        noticeIds: [NOTICE_ID],
      }),
    );
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      id: expect.any(String),
      reason: "A counter-notice is expected.",
      createdBy: adminId,
      evidenceIds: [EVIDENCE_ID],
      violationIds: [VIOLATION_ID],
      noticeIds: [NOTICE_ID],
    });
    expect(response.json().createdAt).toBeDefined();
    expect(h.contract.validate("LegalHold", response.json())).toEqual({
      valid: true,
      issues: [],
    });
  });

  it("refuses a hold with no scope or no reason", async () => {
    const noScope = await mutate(
      h.app,
      adminSession,
      "POST",
      "/api/legal-holds",
      holdBody({ evidenceIds: [], violationIds: [], noticeIds: [] }),
    );
    expect(noScope.statusCode).toBe(422);

    const noReason = await mutate(
      h.app,
      adminSession,
      "POST",
      "/api/legal-holds",
      holdBody({ reason: " " }),
    );
    expect(noReason.statusCode).toBe(422);
  });

  it("lists holds newest first", async () => {
    for (const reason of ["First", "Second"]) {
      expect(
        (
          await mutate(
            h.app,
            adminSession,
            "POST",
            "/api/legal-holds",
            holdBody({ reason }),
          )
        ).statusCode,
      ).toBe(201);
    }
    const response = await read(h.app, adminSession, "/api/legal-holds");
    expect(response.statusCode).toBe(200);
    expect(response.json().total).toBe(2);
    expect(response.json().items.map((item: { reason: string }) => item.reason)).toEqual([
      "Second",
      "First",
    ]);
    expect(h.contract.validate("LegalHoldPage", response.json())).toEqual({
      valid: true,
      issues: [],
    });
  });

  it("releases a hold only for an administrator and only once", async () => {
    const created = await mutate(
      h.app,
      adminSession,
      "POST",
      "/api/legal-holds",
      holdBody(),
    );
    const id = created.json().id as string;
    const operator = await addOperator(h.auth, adminId, "operator@example.test");

    const forbidden = await mutate(
      h.app,
      operator.session,
      "POST",
      `/api/legal-holds/${id}/release`,
      { reason: "The dispute settled." },
    );
    expect(forbidden.statusCode).toBe(403);

    const released = await mutate(
      h.app,
      adminSession,
      "POST",
      `/api/legal-holds/${id}/release`,
      { reason: "The dispute settled." },
    );
    expect(released.statusCode).toBe(200);
    expect(released.json().releasedAt).toBeDefined();
    expect(released.json().releasedBy).toBe(adminId);

    const again = await mutate(
      h.app,
      adminSession,
      "POST",
      `/api/legal-holds/${id}/release`,
      { reason: "Already released." },
    );
    expect(again.statusCode).toBe(409);
  });
});
