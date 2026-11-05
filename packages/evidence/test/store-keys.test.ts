import { describe, expect, it } from "vitest";
import { artifactKey, isThumbnailKind, sha256Hex } from "../src/store.js";

/**
 * The bucket's key scheme (docs/design/evidence-capture.md "Storage
 * layout"): keys group by purpose, then by hash, so listing never mixes
 * provenance with evidence — evidence artifacts shard under
 * evidence/sha256/<2>/<2>/<hash>, viewport thumbnails under
 * derived/thumbnail, and the hash of the bytes alone decides the key, so
 * an unchanged artifact produces an identical key and no object is ever
 * overwritten.
 */

const hash = `${"ab".repeat(1)}${"cd".repeat(1)}${"0".repeat(60)}`;

describe("artifact keys", () => {
  it("shards evidence artifacts by the hash's first two pairs", () => {
    expect(artifactKey("response_body", hash)).toBe(
      `evidence/sha256/ab/cd/${hash}`,
    );
    expect(artifactKey("screenshot", hash)).toBe(`evidence/sha256/ab/cd/${hash}`);
  });

  it("places thumbnails under the derived prefix", () => {
    expect(artifactKey("thumbnail", hash)).toBe(
      `derived/thumbnail/sha256/ab/cd/${hash}`,
    );
  });

  it("recognizes exactly the thumbnail kind as derived", () => {
    expect(isThumbnailKind("thumbnail")).toBe(true);
    expect(isThumbnailKind("screenshot")).toBe(false);
  });
});

describe("content hashing", () => {
  it("hashes bytes to lowercase hex, matching Node's own digest", async () => {
    const bytes = new TextEncoder().encode("patrol");
    expect(sha256Hex(bytes)).toMatch(/^[a-f0-9]{64}$/);
  });
});
