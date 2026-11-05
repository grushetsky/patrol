import { describe, expect, it } from "vitest";
import {
  reputationContribution,
  reputationSnapshot,
} from "../../src/matching/reputation.js";
import {
  DEFAULT_BAND_BOUNDARIES,
  assembleScore,
  bandForScore,
} from "../../src/matching/score.js";

/**
 * Seams 4 and 5, against docs/design/matching-and-classification-rules.md
 * "Score and bands". Every number is the document's own:
 *
 * - Reputation over the registrable domain, 12 months: 1–2 confirmed
 *   violations +0.02, 3–9 +0.05, 10 or more +0.10; a blocklist hit adds
 *   0.02; the total reputation contribution is capped at 0.10 and applies
 *   only alongside at least one strong signal.
 * - Signals: the first strong signal adds 0.25, each additional 0.05,
 *   capped at 0.30.
 * - Score: min(1, title + signals + reputation).
 * - Bands: A at 0.95 or above, B at 0.70–0.949, C below 0.70.
 */

describe("the reputation snapshot over the registrable domain", () => {
  it("zero violations earn no bonus", () => {
    expect(reputationSnapshot("example.test", 0, false)).toEqual({
      registrableDomain: "example.test",
      confirmedViolations: 0,
      bonus: 0,
      blocklisted: false,
    });
  });

  it("1–2 violations earn 0.02", () => {
    expect(reputationSnapshot("example.test", 1, false).bonus).toBe(0.02);
    expect(reputationSnapshot("example.test", 2, false).bonus).toBe(0.02);
  });

  it("3–9 violations earn 0.05", () => {
    expect(reputationSnapshot("example.test", 3, false).bonus).toBe(0.05);
    expect(reputationSnapshot("example.test", 9, false).bonus).toBe(0.05);
  });

  it("10 or more violations earn 0.10", () => {
    expect(reputationSnapshot("example.test", 10, false).bonus).toBe(0.1);
    expect(reputationSnapshot("example.test", 100, false).bonus).toBe(0.1);
  });
});

describe("the reputation contribution", () => {
  it("adds the blocklist's 0.02", () => {
    const snapshot = reputationSnapshot("example.test", 1, true);
    expect(reputationContribution(snapshot, true)).toBe(0.04);
  });

  it("caps the total at 0.10", () => {
    const snapshot = reputationSnapshot("example.test", 10, true);
    expect(snapshot.bonus).toBe(0.1);
    expect(reputationContribution(snapshot, true)).toBe(0.1);
  });

  it("applies only alongside at least one strong signal", () => {
    const snapshot = reputationSnapshot("example.test", 10, true);
    expect(reputationContribution(snapshot, false)).toBe(0);
  });

  it("is zero with nothing to add", () => {
    expect(reputationContribution(reputationSnapshot("example.test", 0, false), true)).toBe(0);
  });
});

describe("the signal weights", () => {
  it("the first strong signal adds 0.25", () => {
    const { components } = assembleScore({
      titleMatch: 0.7,
      signals: ["player"],
      reputation: reputationSnapshot("example.test", 0, false),
    });
    expect(components.signals).toEqual([{ kind: "player", value: 0.25 }]);
  });

  it("each additional signal adds 0.05", () => {
    const { components } = assembleScore({
      titleMatch: 0.7,
      signals: ["player", "duration"],
      reputation: reputationSnapshot("example.test", 0, false),
    });
    expect(components.signals).toEqual([
      { kind: "player", value: 0.25 },
      { kind: "duration", value: 0.05 },
    ]);
  });

  it("the signal total is capped at 0.30 and the tail is recorded as zero", () => {
    const { components } = assembleScore({
      titleMatch: 0.7,
      signals: ["player", "duration", "download"],
      reputation: reputationSnapshot("example.test", 0, false),
    });
    expect(components.signals).toEqual([
      { kind: "player", value: 0.25 },
      { kind: "duration", value: 0.05 },
      { kind: "download", value: 0 },
    ]);
  });
});

describe("the score formula", () => {
  it("min(1, title + signals + reputation)", () => {
    const { score } = assembleScore({
      titleMatch: 0.7,
      signals: ["player"],
      reputation: reputationSnapshot("example.test", 3, false),
    });
    expect(score).toBe(0.7 + 0.25 + 0.05);
  });

  it("caps the total at 1", () => {
    const { score } = assembleScore({
      titleMatch: 0.7,
      signals: ["player", "duration", "download", "release", "episodes"],
      reputation: reputationSnapshot("example.test", 10, true),
    });
    expect(score).toBe(1);
  });

  it("a strong signal without a title match cannot reach the approval band", () => {
    const { score } = assembleScore({
      titleMatch: 0,
      signals: ["player", "duration", "download"],
      reputation: reputationSnapshot("example.test", 10, true),
    });
    // 0 + 0.30 + 0.10: below 0.70 by construction.
    expect(score).toBe(0.4);
  });

  it("reputation alone never promotes a candidate", () => {
    const { score } = assembleScore({
      titleMatch: 0.6,
      signals: [],
      reputation: reputationSnapshot("example.test", 10, true),
    });
    expect(score).toBe(0.6);
  });
});

describe("the bands", () => {
  it("A at 0.95 and above, B down to 0.70, C below", () => {
    expect(bandForScore(0.95)).toBe("a");
    expect(bandForScore(1)).toBe("a");
    expect(bandForScore(0.949)).toBe("b");
    expect(bandForScore(0.70)).toBe("b");
    expect(bandForScore(0.699)).toBe("c");
    expect(bandForScore(0)).toBe("c");
  });

  it("the boundaries default to the document's 0.95 and 0.70", () => {
    expect(DEFAULT_BAND_BOUNDARIES).toEqual({ a: 0.95, b: 0.70 });
  });

  it("an engine may configure its own boundaries", () => {
    expect(bandForScore(0.93, { a: 0.90, b: 0.70 })).toBe("a");
    expect(bandForScore(0.79, { a: 0.90, b: 0.80 })).toBe("c");
  });
});
