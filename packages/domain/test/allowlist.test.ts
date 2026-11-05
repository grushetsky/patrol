import { describe, expect, it } from "vitest";
import {
  ALLOWLIST_TIER_ORDER,
  allowlistTier,
  entryMatchesUrl,
  findAllowlistHit,
  normalizeAllowlistValue,
} from "../src/allowlist.js";

/**
 * The pure allowlist matching the capture worker reuses as its guard
 * before any fetch (implementation rules "Allowlist before capture"): a
 * URL that matches an entry is never fetched. The tiers decide which hit
 * wins when several match, and the values normalize the way URL keys do,
 * so a `www.` host never escapes its own allowlist entry.
 */

describe("allowlist tier order", () => {
  it("orders official before neutral before learned before blocklist", () => {
    expect(ALLOWLIST_TIER_ORDER).toEqual([
      "official",
      "neutral",
      "learned",
      "blocklist",
    ]);
    expect(allowlistTier("official_domain")).toBe("official");
    expect(allowlistTier("neutral_source")).toBe("neutral");
    expect(allowlistTier("licensed_destination")).toBe("learned");
  });
});

describe("value normalization", () => {
  it("lowercases a host and drops a leading www", () => {
    expect(normalizeAllowlistValue("host", "WWW.Example.COM")).toBe(
      "example.com",
    );
  });

  it("normalizes a URL prefix into a URL key", () => {
    expect(
      normalizeAllowlistValue("url_prefix", "https://www.example.com/path/"),
    ).toBe("example.com/path");
  });

  it("refuses a value that is neither a host nor a URL prefix", () => {
    expect(() => normalizeAllowlistValue("host", "not a host")).toThrow();
    expect(() => normalizeAllowlistValue("url_prefix", "::not a url")).toThrow();
  });
});

describe("entry matching", () => {
  it("matches a host case-insensitively and exactly", () => {
    expect(
      entryMatchesUrl({ matchKind: "host", value: "shop.example.com" }, "https://SHOP.example.com/x"),
    ).toBe(true);
    expect(
      entryMatchesUrl({ matchKind: "host", value: "shop.example.com" }, "https://other.example.com"),
    ).toBe(false);
  });

  it("matches a URL prefix and its paths, not a longer prefix", () => {
    expect(
      entryMatchesUrl(
        { matchKind: "url_prefix", value: "example.com/media" },
        "https://example.com/media/watch?q=1",
      ),
    ).toBe(true);
    expect(
      entryMatchesUrl(
        { matchKind: "url_prefix", value: "example.com/media" },
        "https://example.com/mediation",
      ),
    ).toBe(false);
  });
});

describe("finding the winning hit", () => {
  const entries = [
    { kind: "licensed_destination", matchKind: "host", value: "stream.example.com" },
    { kind: "official_domain", matchKind: "url_prefix", value: "example.com" },
    { kind: "neutral_source", matchKind: "host", value: "wiki.example.org" },
  ] as const;

  it("prefers the highest-precedence tier among matches", () => {
    const hit = findAllowlistHit(entries, "https://stream.example.com/watch");
    expect(hit).toEqual({
      kind: "licensed_destination",
      matchKind: "host",
      value: "stream.example.com",
    });
  });

  it("falls back to the next tier when the best one does not match", () => {
    const hit = findAllowlistHit(entries, "https://example.com/media/x");
    expect(hit).toEqual({
      kind: "official_domain",
      matchKind: "url_prefix",
      value: "example.com",
    });
  });

  it("returns null when nothing matches", () => {
    expect(findAllowlistHit(entries, "https://elsewhere.example.net/")).toBeNull();
  });
});
