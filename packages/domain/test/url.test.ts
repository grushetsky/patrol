import { describe, expect, it } from "vitest";
import { hostForUrl, normalizeUrlKey } from "../src/url.js";

/**
 * The URL identity rules matrix (docs/design/query-strategy.md "URL
 * identity"): one row per rule, plus the combinations the rules produce.
 * The expected keys are transcribed from the design's table, never
 * recomputed by the code under test.
 */
describe("normalizeUrlKey", () => {
  it("drops the scheme so http and https twins collapse", () => {
    expect(normalizeUrlKey("https://example.com/watch")).toBe(
      "example.com/watch",
    );
    expect(normalizeUrlKey("http://example.com/watch")).toBe(
      "example.com/watch",
    );
  });

  it("lowercases the host and drops a leading www for the key only", () => {
    expect(normalizeUrlKey("https://www.Example.COM/watch")).toBe(
      "example.com/watch",
    );
    expect(normalizeUrlKey("https://shop.example.com/watch")).toBe(
      "shop.example.com/watch",
    );
  });

  it("trims the trailing slash", () => {
    expect(normalizeUrlKey("https://example.com/")).toBe("example.com");
    expect(normalizeUrlKey("https://example.com/page/")).toBe(
      "example.com/page",
    );
  });

  it("removes utm_* fbclid gclid and yclid parameters", () => {
    expect(
      normalizeUrlKey("https://example.com/p?utm_source=x&utm_medium=y&id=9"),
    ).toBe("example.com/p?id=9");
    expect(normalizeUrlKey("https://example.com/p?fbclid=abc")).toBe(
      "example.com/p",
    );
    expect(normalizeUrlKey("https://example.com/p?gclid=1&yclid=2")).toBe(
      "example.com/p",
    );
  });

  it("sorts the remaining query parameters by name", () => {
    expect(normalizeUrlKey("https://example.com/watch?b=2&a=1")).toBe(
      "example.com/watch?a=1&b=2",
    );
  });

  it("drops the fragment", () => {
    expect(normalizeUrlKey("https://example.com/p#player")).toBe(
      "example.com/p",
    );
    expect(normalizeUrlKey("https://example.com/p?a=1#player")).toBe(
      "example.com/p?a=1",
    );
  });

  it("combines every rule into one key", () => {
    expect(
      normalizeUrlKey(
        "HTTPS://WWW.example.com/Page/#frag?not-a-query",
      ),
    ).toBe("example.com/Page");
    expect(
      normalizeUrlKey("http://example.com/p/?z=26&a=1&utm_term=t"),
    ).toBe("example.com/p?a=1&z=26");
  });

  it("keeps an empty query absent when only tracked parameters existed", () => {
    expect(normalizeUrlKey("https://example.com/p?")).toBe("example.com/p");
    expect(normalizeUrlKey("https://example.com/p?utm_campaign=c")).toBe(
      "example.com/p",
    );
  });

  it("keeps an explicit non-default port, which is page identity", () => {
    // The design drops only the scheme; the port survives when the URL
    // states one, and a scheme-default port needs no suffix.
    expect(normalizeUrlKey("https://example.com:8443/watch")).toBe(
      "example.com:8443/watch",
    );
    expect(normalizeUrlKey("http://example.com:8080/watch")).toBe(
      "example.com:8080/watch",
    );
    expect(normalizeUrlKey("https://example.com:443/watch")).toBe(
      "example.com/watch",
    );
    expect(normalizeUrlKey("http://example.com:80/watch")).toBe(
      "example.com/watch",
    );
  });

  it("percent-encodes query values so distinct parameter tuples keep distinct keys", () => {
    // One parameter whose value contains a literal ampersand, versus two
    // parameters: decoding then re-joining without encoding would collapse
    // these into one key.
    expect(normalizeUrlKey("https://example.com/p?a=b%26c")).toBe(
      "example.com/p?a=b%26c",
    );
    expect(normalizeUrlKey("https://example.com/p?a=b&c=d")).toBe(
      "example.com/p?a=b&c=d",
    );
    // A value that already carries an equals sign survives re-encoding too.
    expect(normalizeUrlKey("https://example.com/p?x=a%3Db")).toBe(
      "example.com/p?x=a%3Db",
    );
    expect(normalizeUrlKey("https://example.com/p?x=a=b")).toBe(
      "example.com/p?x=a%3Db",
    );
  });
});

describe("hostForUrl", () => {
  it("returns the lowercased host without a leading www", () => {
    expect(hostForUrl("https://WWW.Example.co.uk/Page")).toBe(
      "example.co.uk",
    );
    expect(hostForUrl("http://cdn.example.com/x")).toBe("cdn.example.com");
  });
});
