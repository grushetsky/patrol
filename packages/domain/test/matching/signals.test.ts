import { describe, expect, it } from "vitest";
import { evaluateSignals } from "../../src/matching/signals.js";
import { parseSidecar } from "../../src/matching/sidecar.js";

/**
 * Seam 3, against docs/design/matching-and-classification-rules.md "Strong
 * signals". Signals come from the captured page's extraction sidecar, never
 * from the SERP snippet, and a signal that cannot be evaluated contributes
 * nothing.
 */

const NOW = new Date("2026-11-04T00:00:00.000Z");

/** A minimal slice-4 sidecar, overridable per case. */
function sidecar(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    title: "Sunrise (2024) — watch online",
    h1: ["Sunrise full movie"],
    meta: { "og:title": "Sunrise" },
    jsonLd: [],
    iframes: [],
    videos: [],
    downloadAffordances: [],
    ...overrides,
  });
}

/** The evaluation input with the page facts precomputed from a sidecar. */
function input(
  factsJson: string,
  overrides: Record<string, unknown> = {},
): Parameters<typeof evaluateSignals>[0] {
  return {
    facts: parseSidecar(factsJson),
    titleOnPage: true,
    now: NOW,
    ...overrides,
  } as Parameters<typeof evaluateSignals>[0];
}

function kinds(input: Parameters<typeof evaluateSignals>[0]): string[] {
  return evaluateSignals(input).map((signal) => signal.kind);
}

describe("the sidecar parser", () => {
  it("reads the slice-4 extraction fields", () => {
    const facts = parseSidecar(
      sidecar({
        iframes: ["https://player.example.test/embed/1"],
        videos: [{ src: "https://cdn.example.test/v.mp4", duration: 6000 }],
        downloadAffordances: ["magnet:?xt=urn:btih:abc"],
      }),
    );
    expect(facts.pageTitle).toBe("Sunrise (2024) — watch online");
    expect(facts.h1s).toEqual(["Sunrise full movie"]);
    expect(facts.playerCandidates).toContain(
      "https://player.example.test/embed/1",
    );
    expect(facts.declaredDurationsSeconds).toEqual([6000]);
    expect(facts.downloadAffordances).toContain("magnet:?xt=urn:btih:abc");
  });

  it("survives a null or malformed sidecar with empty facts", () => {
    expect(parseSidecar(null).pageTitle).toBeNull();
    expect(parseSidecar("not json").pageTitle).toBeNull();
  });

  it("reads VideoObject contentUrl, embedUrl, name, and duration from JSON-LD", () => {
    const facts = parseSidecar(
      sidecar({
        jsonLd: [
          {
            "@type": "VideoObject",
            name: "Sunrise (2024)",
            contentUrl: "https://cdn.example.test/sunrise.mp4",
            embedUrl: "https://player.example.test/e/1",
            duration: "PT1H40M",
          },
        ],
      }),
    );
    expect(facts.structuredNames).toContain("Sunrise (2024)");
    expect(facts.playerCandidates).toContain("https://cdn.example.test/sunrise.mp4");
    expect(facts.playerCandidates).toContain("https://player.example.test/e/1");
    expect(facts.declaredDurationsSeconds).toContain(6000);
  });
});

describe("the player signal", () => {
  it("fires for a player host with a confirmed violation in the last 12 months", () => {
    const json = sidecar({ iframes: ["https://badhost.example.test/embed/1"] });
    expect(
      kinds(input(json, { playerHostKnownBad: (host: string) => host === "badhost.example.test" })),
    ).toEqual(["player"]);
  });

  it("fires for a player-oriented iframe the extractor marked as such", () => {
    const json = sidecar({ playerFrames: ["https://badhost.example.test/embed/2"] });
    expect(
      kinds(input(json, { playerHostKnownBad: (host: string) => host === "badhost.example.test" })),
    ).toEqual(["player"]);
  });

  it("does not fire for an advertising iframe at a known-bad host", () => {
    // An ad or analytics frame is not a player however bad its host's
    // reputation is: only the player-oriented frame set reads as a player
    // source, whichever sidecar field carried it.
    const legacy = sidecar({ iframes: ["https://badhost.example.test/ad-frame"] });
    expect(kinds(input(legacy, { playerHostKnownBad: () => true }))).toEqual([]);
    const extracted = sidecar({
      iframes: ["https://badhost.example.test/ad-frame"],
      playerFrames: [],
    });
    expect(kinds(input(extracted, { playerHostKnownBad: () => true }))).toEqual([]);
  });

  it("fires for a blocklisted player host", () => {
    const json = sidecar({
      jsonLd: [
        { "@type": "VideoObject", contentUrl: "https://blocklisted.test/v.mp4" },
      ],
    });
    expect(
      kinds(input(json, { playerHostKnownBad: (host: string) => host === "blocklisted.test" })),
    ).toEqual(["player"]);
  });

  it("does not fire when the player host is clean", () => {
    const json = sidecar({ iframes: ["https://clean.example.test/embed/1"] });
    expect(kinds(input(json, { playerHostKnownBad: () => false }))).toEqual([]);
  });

  it("does not fire without a title variant on the page", () => {
    const json = sidecar({ iframes: ["https://badhost.example.test/embed/1"] });
    expect(
      kinds(
        input(json, {
          titleOnPage: false,
          playerHostKnownBad: () => true,
        }),
      ),
    ).toEqual([]);
  });
});

describe("the duration signal (±10% of the runtime)", () => {
  const runtime = { runtimeMinutes: 100 };

  it("fires inside the band, boundaries included", () => {
    expect(
      kinds(input(sidecar({ videos: [{ src: "", duration: 6000 }] }), runtime)),
    ).toEqual(["duration"]);
    expect(
      kinds(input(sidecar({ videos: [{ src: "", duration: 6600 }] }), runtime)),
    ).toEqual(["duration"]);
    expect(
      kinds(input(sidecar({ videos: [{ src: "", duration: 5400 }] }), runtime)),
    ).toEqual(["duration"]);
  });

  it("stays silent just outside the band", () => {
    expect(
      kinds(input(sidecar({ videos: [{ src: "", duration: 6601 }] }), runtime)),
    ).toEqual([]);
    expect(
      kinds(input(sidecar({ videos: [{ src: "", duration: 5399 }] }), runtime)),
    ).toEqual([]);
  });

  it("reads an ISO 8601 duration from JSON-LD", () => {
    expect(
      kinds(
        input(
          sidecar({
            jsonLd: [{ "@type": "VideoObject", duration: "PT1H36M30S" }],
          }),
          runtime,
        ),
      ),
    ).toEqual(["duration"]);
  });

  it("contributes nothing when the catalogue has no runtime", () => {
    expect(
      kinds(input(sidecar({ videos: [{ src: "", duration: 6000 }] }), {})),
    ).toEqual([]);
  });
});

describe("the download signal", () => {
  it("fires on a magnet link", () => {
    expect(
      kinds(input(sidecar({ downloadAffordances: ["magnet:?xt=urn:btih:x"] }))),
    ).toEqual(["download"]);
  });

  it("fires on a torrent link", () => {
    expect(
      kinds(
        input(sidecar({ downloadAffordances: ["https://x.test/sunrise.torrent"] })),
      ),
    ).toEqual(["download"]);
  });

  it("fires on an mkv or mp4 link", () => {
    expect(
      kinds(
        input(sidecar({ downloadAffordances: ["https://x.test/sunrise-1080p.mkv"] })),
      ),
    ).toEqual(["download"]);
  });

  it("fires on a declared file size alone", () => {
    const facts = parseSidecar(sidecar());
    facts.linkTexts = ["Sunrise 2024 · 1.4 GB"];
    expect(kinds({ facts, titleOnPage: true, now: NOW })).toEqual(["download"]);
  });

  it("fires on a resolution paired with a release-source token", () => {
    const facts = parseSidecar(sidecar());
    facts.linkTexts = ["1080p WEBRip"];
    expect(kinds({ facts, titleOnPage: true, now: NOW })).toEqual(["download"]);
  });

  it("stays silent on a resolution without a release-source token", () => {
    const facts = parseSidecar(sidecar());
    facts.linkTexts = ["1080p"];
    expect(kinds({ facts, titleOnPage: true, now: NOW })).toEqual([]);
  });
});

describe("the release signal", () => {
  it("fires on a CAM token for a title not yet released", () => {
    expect(
      kinds(
        input(sidecar({ title: "Sunrise 2024 CAM HD" }), {
          releaseYear: 2027,
        }),
      ),
    ).toEqual(["release"]);
  });

  it("fires on a TELESYNC token for an unreleased title", () => {
    expect(
      kinds(
        input(sidecar({ h1: ["Sunrise TELESYNC"] }), { releaseYear: 2027 }),
      ),
    ).toEqual(["release"]);
  });

  it("stays silent for a title released years ago", () => {
    expect(
      kinds(input(sidecar({ title: "Sunrise 2024 CAM HD" }), { releaseYear: 2019 })),
    ).toEqual([]);
  });

  it("contributes nothing without a release year to compare against", () => {
    expect(kinds(input(sidecar({ title: "Sunrise 2024 CAM HD" }), {}))).toEqual(
      [],
    );
  });

  it("does not match the token inside a word", () => {
    expect(
      kinds(
        input(sidecar({ title: "Sunrise scam page" }), { releaseYear: 2027 }),
      ),
    ).toEqual([]);
  });
});

describe("the episodes signal", () => {
  function seasonSidecar(count: number, hrefOf = (index: number): string => `/video/s1e${index + 1}`): string {
    const entries = Array.from({ length: count }, (_, index) => ({
      label: `S01E${String(index + 1).padStart(2, "0")}`,
      href: hrefOf(index),
    }));
    return sidecar({ episodeLinks: entries });
  }

  it("fires when one season lists a season's worth of per-episode player links", () => {
    expect(kinds(input(seasonSidecar(8)))).toEqual(["episodes"]);
  });

  it("stays silent when the per-episode links are not player-plausible", () => {
    // Episode labels pointing at plain category pages are a listing, not a
    // selector of players: the hrefs must be player-oriented, the same
    // predicate the player signal's frames use.
    expect(kinds(input(seasonSidecar(8, (index) => `/catalog/season-1/${index + 1}`)))).toEqual(
      [],
    );
  });

  it("stays silent for a couple of stray episode links", () => {
    expect(kinds(input(seasonSidecar(2)))).toEqual([]);
  });

  it("counts distinct episodes of one season only", () => {
    const facts = parseSidecar(
      sidecar({
        episodeLinks: [
          { label: "S01E01", href: "/video/a" },
          { label: "S01E01 (mirror)", href: "/video/a2" },
          { label: "S01E02", href: "/video/b" },
          { label: "S02E01", href: "/video/c" },
        ],
      }),
    );
    expect(kinds({ facts, titleOnPage: true, now: NOW })).toEqual([]);
  });
});

describe("every fired signal is recorded with the kind that fired", () => {
  it("lists several signals at once", () => {
    const facts = parseSidecar(
      sidecar({
        iframes: ["https://badhost.example.test/embed/1"],
        videos: [{ src: "", duration: 6000 }],
        downloadAffordances: ["magnet:?xt=urn:btih:x"],
      }),
    );
    const fired = evaluateSignals({
      facts,
      titleOnPage: true,
      now: NOW,
      runtimeMinutes: 100,
      playerHostKnownBad: () => true,
    });
    expect(fired.map((signal) => signal.kind)).toEqual([
      "player",
      "duration",
      "download",
    ]);
  });
});
