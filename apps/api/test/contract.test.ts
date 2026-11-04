import { describe, expect, it } from "vitest";
import { loadContract } from "../src/contract.js";

const bundle = new URL("../../../contract/generated/json-schema/patrol", import.meta.url);

describe("contract validation", () => {
  it("accepts a well-formed review decision", async () => {
    const contract = await loadContract(bundle);

    const result = contract.validate("ReviewDecisionRequest", {
      action: "violation",
      evidenceIds: ["018f4c8e-1c2a-7c3e-9b1f-2b6d9f0a3c09"],
    });

    expect(result).toEqual({ valid: true, issues: [] });
  });

  it("rejects an unknown action and points at the field", async () => {
    const contract = await loadContract(bundle);

    const result = contract.validate("ReviewDecisionRequest", {
      action: "remove",
      evidenceIds: [],
    });

    expect(result.valid).toBe(false);
    expect(result.issues.some((issue) => issue.path === "/action")).toBe(true);
  });
});
