import { describe, expect, it } from "vitest";
import {
  ALLOWLIST_TIER_ORDER,
  allowlistTier,
  entryMatchesUrl,
  findAllowlistHit,
  normalizeAllowlistValue,
} from "../src/domain/catalogue/allowlist.js";
import { deriveScanTime } from "../src/domain/catalogue/title-groups.js";
import { isValidIdentifierValue } from "../src/domain/catalogue/identifiers.js";

/**
 * The allowlist's pure matching layer (docs/design/matching-and-
 * classification-rules.md precedence): rights-holder official domains,
 * then global neutral sources, then learned entries, then reputation
 * blocklists — with blocklists never vetoing a per-URL match (the tier
 * arrives with slice 5).
 */
describe("allowlist matching", () => {
  it("orders the precedence tiers official, neutral, learned, blocklist", () => {
    expect(ALLOWLIST_TIER_ORDER).toEqual([
      "official",
      "neutral",
      "learned",
      "blocklist",
    ]);
    expect(allowlistTier("official_domain")).toBe("official");
    expect(allowlistTier("neutral_source")).toBe("neutral");
    // A licensed destination is learned whichever way it was confirmed.
    expect(allowlistTier("licensed_destination")).toBe("learned");
  });

  it("matches a host exactly and a url prefix on the normalized key", () => {
    expect(
      entryMatchesUrl({ matchKind: "host", value: "shop.example.com" }, "https://SHOP.example.com/x"),
    ).toBe(true);
    expect(
      entryMatchesUrl({ matchKind: "host", value: "shop.example.com" }, "https://other.example.com"),
    ).toBe(false);
    expect(
      entryMatchesUrl(
        { matchKind: "url_prefix", value: "partner.example/library" },
        "https://www.partner.example/library/film?utm_source=x",
      ),
    ).toBe(true);
    expect(
      entryMatchesUrl(
        { matchKind: "url_prefix", value: "partner.example/library" },
        "https://partner.example/other",
      ),
    ).toBe(false);
  });

  it("normalizes entry values into their matching form", () => {
    expect(normalizeAllowlistValue("host", "WWW.Example.COM")).toBe(
      "example.com",
    );
    expect(
      normalizeAllowlistValue("url_prefix", "https://www.example.com/path/"),
    ).toBe("example.com/path");
  });

  it("prefers the highest-precedence entry that matches a URL", () => {
    const hit = findAllowlistHit(
      [
        { kind: "licensed_destination", origin: "operator", matchKind: "host", value: "stream.example.com" },
        { kind: "official_domain", origin: "operator", matchKind: "host", value: "stream.example.com" },
        { kind: "neutral_source", origin: "operator", matchKind: "host", value: "stream.example.com" },
      ],
      "https://stream.example.com/watch",
    );
    expect(hit).toEqual({ matchKind: "host", value: "stream.example.com" });
    // The official tier won among three matching entries of every tier;
    // verify the discriminator by dropping it.
    const withoutOfficial = findAllowlistHit(
      [
        { kind: "licensed_destination", origin: "operator", matchKind: "host", value: "stream.example.com" },
        { kind: "neutral_source", origin: "operator", matchKind: "url_prefix", value: "stream.example.com/watch" },
      ],
      "https://stream.example.com/watch",
    );
    expect(withoutOfficial).toEqual({
      matchKind: "url_prefix",
      value: "stream.example.com/watch",
    });
    expect(
      findAllowlistHit(
        [{ kind: "official_domain", origin: "operator", matchKind: "host", value: "other.example" }],
        "https://stream.example.com/watch",
      ),
    ).toBeNull();
  });
});

/**
 * The scan-time derivation (docs/design/scan-scheduling.md): a group's
 * default scan_time spreads deterministically inside the 02:00-05:59 UTC
 * window from the group's identity, so the same group always lands on the
 * same minute. The spread reads the id's random tail, not its timestamp
 * head — groups created in the same hours must not share a minute.
 */
describe("deriveScanTime", () => {
  it("derives a deterministic time inside the 02:00-05:59 window", () => {
    for (const id of [
      "018f6a1c-9e2b-7a3d-8b4c-5d6e7f80901a",
      "ffffffff-ffff-ffff-ffff-ffffffffffff",
      "00000000-0000-0000-0000-000000000001",
    ]) {
      const derived = deriveScanTime(id);
      expect(deriveScanTime(id)).toBe(derived);
      const [hours, minutes] = derived.split(":").map(Number);
      const minuteOfDay = hours * 60 + minutes;
      expect(minuteOfDay).toBeGreaterThanOrEqual(2 * 60);
      expect(minuteOfDay).toBeLessThan(6 * 60);
    }
  });

  it("spreads ids that share one timestamp head across the window", () => {
    // One hundred UUIDv7-shaped ids with an identical 48-bit timestamp
    // (the pathological case the derivation exists for: ids minted inside
    // the same hours). A deterministic LCG feeds the random tail so the
    // sample itself never flakes.
    const ids: string[] = [];
    let state = 0x2a; // 42
    for (let index = 0; index < 100; index += 1) {
      state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
      const tail = state.toString(16).padStart(8, "0") + "7a3d8b4c5d6e7f8";
      ids.push(`018f6a1c-9e2b-${tail.slice(0, 4)}-${tail.slice(4, 8)}-${tail.slice(8)}`);
    }
    const minutes = new Set(ids.map((id) => deriveScanTime(id)));
    // Distinct ids land on many distinct minutes, never on one shared
    // minute: with 240 minutes in the window, a uniform spread of a hundred
    // ids covers dozens of them, while a timestamp-head derivation would
    // collapse to a single value.
    expect(minutes.size).toBeGreaterThanOrEqual(50);
    for (const time of minutes) {
      const [hours, minute] = time.split(":").map(Number);
      const minuteOfDay = hours * 60 + minute;
      expect(minuteOfDay).toBeGreaterThanOrEqual(2 * 60);
      expect(minuteOfDay).toBeLessThan(6 * 60);
    }
  });
});

/** The identifier shapes the design accepts, as anchored facts. */
describe("identifier shapes", () => {
  it("accepts Q+digits, tt+>=7 digits, and digits", () => {
    expect(isValidIdentifierValue("wikidata", "Q123")).toBe(true);
    expect(isValidIdentifierValue("wikidata", "q123")).toBe(false);
    expect(isValidIdentifierValue("wikidata", "QT12")).toBe(false);
    expect(isValidIdentifierValue("imdb", "tt1234567")).toBe(true);
    expect(isValidIdentifierValue("imdb", "tt12345678")).toBe(true);
    expect(isValidIdentifierValue("imdb", "tt123")).toBe(false);
    expect(isValidIdentifierValue("kinopoisk", "45678")).toBe(true);
    expect(isValidIdentifierValue("kinopoisk", "45a78")).toBe(false);
  });
});
