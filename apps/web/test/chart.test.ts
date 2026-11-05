import { describe, expect, it } from "vitest";
import { axisStep } from "../src/lib/chart";

/**
 * The plot's axis rule (docs/design/dashboard-ui.md "Title chart"): four
 * equal ticks on a 1, 2, or 5 step above the series maximum — the smallest
 * (1|2|5)×10^k whose fourth multiple covers the maximum. The ladder of
 * candidates is 1, 2, 5, 10, 20, 50, … and each candidate c covers every
 * maximum up to 4c, so the boundaries below are exactly the multiples of
 * four the rule pivots on.
 */
describe("axisStep", () => {
  it("steps by one while four unit ticks cover the maximum", () => {
    expect(axisStep(0)).toBe(1);
    expect(axisStep(1)).toBe(1);
    expect(axisStep(4)).toBe(1);
  });

  it("doubles once four unit ticks fall short", () => {
    expect(axisStep(5)).toBe(2);
    expect(axisStep(8)).toBe(2);
  });

  it("walks the 1, 2, 5 ladder across magnitudes", () => {
    expect(axisStep(9)).toBe(5);
    expect(axisStep(20)).toBe(5);
    expect(axisStep(21)).toBe(10);
    expect(axisStep(40)).toBe(10);
    expect(axisStep(41)).toBe(20);
    expect(axisStep(80)).toBe(20);
    expect(axisStep(81)).toBe(50);
    expect(axisStep(200)).toBe(50);
    expect(axisStep(201)).toBe(100);
    expect(axisStep(400)).toBe(100);
    expect(axisStep(401)).toBe(200);
    expect(axisStep(800)).toBe(200);
    expect(axisStep(801)).toBe(500);
  });

  it("saturates at the largest step past the table's end", () => {
    // The candidate table ends at 5,000,000 (covering 20,000,000); beyond
    // that the largest step stands so the axis always has a unit.
    expect(axisStep(20_000_000)).toBe(5_000_000);
    expect(axisStep(21_000_000)).toBe(1_000_000);
  });
});
