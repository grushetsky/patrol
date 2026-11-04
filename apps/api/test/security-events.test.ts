import { beforeEach, describe, expect, it } from "vitest";
import {
  addOperator,
  bootstrapAdmin,
  harness,
  read,
  type Harness,
} from "./support/harness.js";

let h: Harness;
let adminSession: string;
let adminId: string;

beforeEach(async () => {
  h = await harness();
  const admin = await bootstrapAdmin(h);
  adminSession = admin.session;
  adminId = admin.operator.id;
});

describe("security events", () => {
  it("lists the append-only audit newest first for an administrator", async () => {
    const response = await read(h.app, adminSession, "/api/security-events");
    expect(response.statusCode).toBe(200);
    expect(response.json().total).toBeGreaterThan(0);
    expect(response.json().items[0].kind).toBeDefined();
    expect(response.json().items[0].createdAt).toBeDefined();
    expect(h.contract.validate("SecurityEventPage", response.json())).toEqual({
      valid: true,
      issues: [],
    });
  });

  it("filters by kind", async () => {
    const response = await read(
      h.app,
      adminSession,
      "/api/security-events?kind=operator_enrolled",
    );
    expect(response.statusCode).toBe(200);
    expect(response.json().total).toBeGreaterThan(0);
    expect(
      response.json().items.every(
        (item: { kind: string }) => item.kind === "operator_enrolled",
      ),
    ).toBe(true);
  });

  it("keeps a credential-reset reason out of the email field", async () => {
    await addOperator(h.auth, adminId, "target@example.test");
    await h.auth.recoverOperator("target@example.test", "Lost device", adminId);
    const response = await read(
      h.app,
      adminSession,
      "/api/security-events?kind=credential_reset_reason",
    );
    expect(response.statusCode).toBe(200);
    expect(response.json().items[0]).toMatchObject({ detail: "Lost device" });
    expect(response.json().items[0].email).toBeUndefined();
    expect(h.contract.validate("SecurityEventPage", response.json())).toEqual({
      valid: true,
      issues: [],
    });
  });

  it("refuses an operator", async () => {
    const operator = await addOperator(h.auth, adminId, "operator@example.test");
    const response = await read(
      h.app,
      operator.session,
      "/api/security-events",
    );
    expect(response.statusCode).toBe(403);
  });
});
