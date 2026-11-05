import { describe, expect, it } from "vitest";
import {
  candidateDedupKey,
  initialCandidateScore,
  scoreFromPage,
  variantSnapshot,
  type FormationTitle,
} from "../../src/matching/formation.js";

/**
 * Seam 6's pure half, against docs/design/matching-and-classification-rules.md
 * "Candidate formation" and "Score and bands". A candidate pairs one URL with
 * one tracked title and deduplicates on that pair across queries and engines;
 * the score at formation is what the SERP row alone can support — the URL
 * slug — because signals come from the captured page, never from the snippet,
 * and the page title match deepens once the capture's sidecar lands.
 */

const TITLE: FormationTitle = {
  id: "t1",
  runtimeMinutes: 100,
  releaseYear: 2019,
  originalVariantId: "v-original",
  variants: [
    {
      id: "v-original",
      text: "Рассвет",
      kind: "original",
      language: "ru",
      script: "Cyrl",
    },
    {
      id: "v-en",
      text: "Sunrise",
      kind: "localized",
      language: "en",
      script: "Latn",
    },
  ],
};

const NOW = new Date("2026-11-04T00:00:00.000Z");

describe("the deduplication key", () => {
  it("pairs the normalized URL with the tracked title", () => {
    expect(candidateDedupKey("https://x.test/watch?a=1", "t1")).toEqual({
      normalizedUrl: "x.test/watch?a=1",
      trackedTitleId: "t1",
    });
  });

  it("folds scheme, www, tracking parameters, and fragment away", () => {
    expect(
      candidateDedupKey("http://www.x.test/watch?a=1&utm_source=g", "t1"),
    ).toEqual(candidateDedupKey("https://x.test/watch?a=1#frag", "t1"));
  });
});

describe("the score at formation", () => {
  it("a URL whose slug carries the variant scores the partial 0.60", () => {
    const scored = initialCandidateScore({
      title: TITLE,
      url: "https://stream.example.test/films/rassvet-2024",
    });
    expect(scored.components.titleMatch).toBe(0.6);
    expect(scored.components.signals).toEqual([]);
    expect(scored.components.reputation).toBe(0);
    expect(scored.score).toBe(0.6);
    expect(scored.band).toBe("c");
    expect(scored.match.variantId).toBe("v-original");
  });

  it("an unrelated URL scores nothing and lands in band C", () => {
    const scored = initialCandidateScore({
      title: TITLE,
      url: "https://other.example.test/watch/moonlight",
    });
    expect(scored.components.titleMatch).toBe(0);
    expect(scored.score).toBe(0);
    expect(scored.band).toBe("c");
    expect(scored.match.variantId).toBeNull();
  });

  it("carries no signals before a capture: the snippet is never a signal", () => {
    const scored = initialCandidateScore({
      title: TITLE,
      url: "https://stream.example.test/films/rassvet-torrent-download",
    });
    expect(scored.components.signals).toEqual([]);
  });
});

describe("the score once the capture's sidecar lands", () => {
  function sidecar(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      title: "Sunrise (2024) — watch online",
      h1: ["Sunrise full movie"],
      meta: {},
      jsonLd: [
        {
          "@type": "VideoObject",
          name: "Sunrise",
          contentUrl: "https://bad.example.test/v.mp4",
          duration: "PT1H40M",
        },
      ],
      iframes: [],
      videos: [],
      downloadAffordances: ["magnet:?xt=urn:btih:x"],
      ...overrides,
    });
  }

  it("an exact page-title match plus signals and reputation assembles per the document", () => {
    const scored = scoreFromPage({
      title: TITLE,
      url: "https://stream.example.test/films/rassvet-2024",
      sidecar: sidecar(),
      reputation: { confirmedViolations: 3, blocklisted: false },
      playerHostKnownBad: () => true,
      now: NOW,
    });
    expect(scored.match.kind).toBe("exact");
    expect(scored.components.titleMatch).toBe(0.7);
    expect(scored.components.signals).toEqual([
      { kind: "player", value: 0.25 },
      { kind: "duration", value: 0.05 },
      { kind: "download", value: 0 },
    ]);
    expect(scored.components.reputation).toBe(0.05);
    expect(scored.score).toBe(1);
    expect(scored.band).toBe("a");
  });

  it("keeps reputation at zero while no strong signal fired", () => {
    const scored = scoreFromPage({
      title: TITLE,
      url: "https://stream.example.test/films/rassvet-2024",
      sidecar: sidecar({
        jsonLd: [],
        downloadAffordances: [],
      }),
      reputation: { confirmedViolations: 10, blocklisted: true },
      playerHostKnownBad: () => false,
      now: NOW,
    });
    expect(scored.components.signals).toEqual([]);
    expect(scored.components.reputation).toBe(0);
    expect(scored.score).toBe(0.7);
  });

  it("a page with no variant on it loses the title contribution entirely", () => {
    const scored = scoreFromPage({
      title: TITLE,
      url: "https://stream.example.test/watch",
      sidecar: sidecar({ title: "Moonlight", h1: ["Moonlight"], jsonLd: [] }),
      reputation: { confirmedViolations: 0, blocklisted: false },
      playerHostKnownBad: () => true,
      now: NOW,
    });
    expect(scored.components.titleMatch).toBe(0);
    expect(scored.match.kind).toBe("none");
  });

  it("records the best-matching variant", () => {
    const scored = scoreFromPage({
      title: TITLE,
      url: "https://stream.example.test/films/rassvet-2024",
      sidecar: sidecar(),
      reputation: { confirmedViolations: 0, blocklisted: false },
      playerHostKnownBad: () => false,
      now: NOW,
    });
    expect(scored.match.variantId).toBe("v-en");
  });
});

describe("the variant snapshot", () => {
  it("freezes the variant fields a review row shows", () => {
    expect(variantSnapshot(TITLE.variants[1])).toEqual({
      id: "v-en",
      text: "Sunrise",
      kind: "localized",
      language: "en",
      script: "Latn",
      territory: undefined,
    });
  });
});
