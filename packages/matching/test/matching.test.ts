import { describe, expect, it } from "vitest";
import {
  bandFor,
  evaluateSignals,
  parseSidecar,
  reputationContribution,
  scoreCandidate,
  titleMatch,
} from "../src/index.js";

const sidecar = (overrides: Record<string, unknown> = {}) => ({
  title: "Fixture film",
  h1: ["Fixture film"],
  meta: {},
  jsonLd: [],
  iframes: [],
  videos: [],
  downloadAffordances: [],
  ...overrides,
});

describe("title match", () => {
  it("scores an exact page title at 0.70", () => {
    const facts = parseSidecar(sidecar());
    expect(titleMatch("Fixture film", facts, "https://example.test/fixture")).toEqual(
      { kind: "exact", value: 0.7 },
    );
  });

  it("scores a complete token sequence at 0.70", () => {
    const facts = parseSidecar(
      sidecar({ title: "Watch Fixture film online", h1: [] }),
    );
    expect(
      titleMatch("Fixture film", facts, "https://example.test/watch"),
    ).toEqual({ kind: "exact", value: 0.7 });
  });

  it("scores a URL slug at 0.60", () => {
    const facts = parseSidecar(sidecar({ title: "Unrelated", h1: [] }));
    expect(
      titleMatch(
        "Fixture film",
        facts,
        "https://example.test/fixture-film-2026",
      ),
    ).toEqual({ kind: "partial", value: 0.6 });
  });

  it("scores no occurrence at 0.00", () => {
    const facts = parseSidecar(sidecar({ title: "Unrelated", h1: [] }));
    expect(
      titleMatch("Fixture film", facts, "https://example.test/other"),
    ).toEqual({ kind: "none", value: 0 });
  });
});

describe("signals", () => {
  it("gives the first signal 0.25 and each additional 0.05 up to the cap", () => {
    const facts = parseSidecar(
      sidecar({
        jsonLd: [
          {
            "@type": "VideoObject",
            contentUrl: "https://player.example/embed/1",
            duration: "PT1H30M",
          },
        ],
        downloadAffordances: ["magnet:?xt=urn:btih:abc"],
        iframes: ["https://player.example/embed/1"],
      }),
    );
    const signals = evaluateSignals(facts, {
      variantText: "Fixture film",
      url: "https://example.test/fixture",
      runtimeMinutes: 90,
      playerHosts: ["player.example"],
      reputation: { confirmedViolations: 0, blocklisted: false },
    });
    expect(signals.map((signal) => signal.kind)).toEqual([
      "player",
      "duration",
      "download",
    ]);
    expect(signals.reduce((sum, signal) => sum + signal.value, 0)).toBe(0.3);
  });
});

describe("reputation", () => {
  it("maps confirmed violation counts to the documented bands", () => {
    expect(
      reputationContribution(
        { confirmedViolations: 1, blocklisted: false },
        true,
      ),
    ).toBe(0.02);
    expect(
      reputationContribution(
        { confirmedViolations: 3, blocklisted: false },
        true,
      ),
    ).toBe(0.05);
    expect(
      reputationContribution(
        { confirmedViolations: 10, blocklisted: false },
        true,
      ),
    ).toBe(0.1);
  });

  it("adds the blocklist bonus and caps the total at 0.10", () => {
    expect(
      reputationContribution(
        { confirmedViolations: 10, blocklisted: true },
        true,
      ),
    ).toBe(0.1);
  });

  it("contributes nothing without a strong signal", () => {
    expect(
      reputationContribution(
        { confirmedViolations: 10, blocklisted: true },
        false,
      ),
    ).toBe(0);
  });
});

describe("score and bands", () => {
  const facts = parseSidecar(
    sidecar({
      downloadAffordances: ["magnet:?xt=urn:btih:abc"],
    }),
  );

  it("sums title, signals, and reputation, capped at one", () => {
    const result = scoreCandidate(facts, {
      variantText: "Fixture film",
      url: "https://example.test/fixture",
      reputation: { confirmedViolations: 10, blocklisted: true },
    });
    expect(result.titleMatch).toBe(0.7);
    expect(result.reputation).toBe(0.1);
    expect(result.score).toBe(1);
    expect(result.band).toBe("a");
  });

  it("suppresses an allowlisted candidate regardless of score", () => {
    const result = scoreCandidate(facts, {
      variantText: "Fixture film",
      url: "https://example.test/fixture",
      reputation: { confirmedViolations: 10, blocklisted: false },
      allowlisted: true,
    });
    expect(result.band).toBe("c");
    expect(result.suppressed).toBe(true);
  });

  it("uses configurable band boundaries", () => {
    expect(bandFor(0.8, { bandA: 0.9, bandB: 0.75 })).toBe("b");
    expect(bandFor(0.74, { bandA: 0.9, bandB: 0.75 })).toBe("c");
  });
});

describe("sidecar parsing", () => {
  it("reads names, duration, episodes, and release tokens", () => {
    const facts = parseSidecar(
      {
        title: "Fixture film",
        h1: ["Fixture film"],
        meta: { "og:title": "Fixture film" },
        jsonLd: [
          {
            "@type": "VideoObject",
            name: "Fixture film",
            contentUrl: "https://player.example/embed/1",
            duration: "PT1H32M",
          },
        ],
        iframes: ["https://player.example/embed/1"],
        downloadAffordances: ["https://example.test/film.mkv"],
      },
      "S01E01 S01E02 S01E03 CAM",
    );
    expect(facts.names).toContain("Fixture film");
    expect(facts.durationSeconds).toBe(5520);
    expect(facts.episodeNumbers).toEqual([1, 2, 3]);
    expect(facts.releaseTokens).toEqual(["CAM"]);
  });
});
