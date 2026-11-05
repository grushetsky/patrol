import { describe, expect, it } from "vitest";
import {
  GOOGLE_DEFAULT_URL_CAP,
  fitsSingleNotice,
  googleUrlCap,
  groupViolations,
} from "../src/grouping.js";

/**
 * Seam 3 (grouping per recipient) and seam 10 (the Google cap override):
 * Google takes many works and splits at its URL cap — the default 500,
 * lowered by the profile's published per-notice/per-file caps and the
 * server-discovered cap; Bing is one tracked title per notice, splitting
 * a title over 1,000 URLs into numbered notices; Yandex is one violation,
 * one URL, per notice.
 */

interface Seed {
  violationId: string;
  trackedTitleId: string;
  normalizedUrl: string;
}

function urls(prefix: string, count: number, titleId = "title-1"): Seed[] {
  return Array.from({ length: count }, (_, index) => ({
    violationId: `${prefix}-${index + 1}`,
    trackedTitleId: titleId,
    normalizedUrl: `example.net/${prefix}/${index + 1}`,
  }));
}

describe("Google's URL cap", () => {
  it("defaults to 500 and never hard-codes a lower number", () => {
    expect(GOOGLE_DEFAULT_URL_CAP).toBe(500);
    expect(googleUrlCap({})).toBe(500);
  });

  it("lowers to the profile's published per-notice cap", () => {
    expect(googleUrlCap({ maxUrlsPerNotice: 350 })).toBe(350);
  });

  it("lowers to the profile's published per-file cap", () => {
    expect(googleUrlCap({ maxUrlsPerFile: 300 })).toBe(300);
  });

  it("lowers to the server-discovered cap the form's error text supplied", () => {
    expect(googleUrlCap({ lastObservedMaxUrlsPerFile: 120 })).toBe(120);
  });

  it("takes the lowest of default, published, and discovered caps", () => {
    expect(googleUrlCap({ maxUrlsPerFile: 300, lastObservedMaxUrlsPerFile: 200 })).toBe(200);
    expect(googleUrlCap({ maxUrlsPerFile: 900, lastObservedMaxUrlsPerFile: 800 })).toBe(500);
    expect(
      googleUrlCap({ maxUrlsPerNotice: 400, maxUrlsPerFile: 300, lastObservedMaxUrlsPerFile: 250 }),
    ).toBe(250);
    expect(googleUrlCap({ maxUrlsPerNotice: 150, maxUrlsPerFile: 300 })).toBe(150);
  });

  it("ignores caps below one", () => {
    expect(googleUrlCap({ maxUrlsPerFile: 0, lastObservedMaxUrlsPerFile: -5 })).toBe(500);
  });
});

describe("grouping", () => {
  it("Google: 600 URLs split into two notices of 500 and 100", () => {
    const batches = groupViolations("google", urls("g", 600), {});
    expect(batches.map((batch) => batch.length)).toEqual([500, 100]);
    // Order preserved: the first violation of the input leads the first batch.
    expect(batches[0][0].violationId).toBe("g-1");
    expect(batches[1][0].violationId).toBe("g-501");
  });

  it("Google: a batch at the cap stays one notice", () => {
    expect(groupViolations("google", urls("g", 500), {})).toHaveLength(1);
  });

  it("Google: the profile's lowered cap is respected (seam 10)", () => {
    const batches = groupViolations("google", urls("g", 600), { maxUrlsPerFile: 250 });
    expect(batches.map((batch) => batch.length)).toEqual([250, 250, 100]);
    const discovered = groupViolations("google", urls("g", 700), {
      lastObservedMaxUrlsPerFile: 300,
    });
    expect(discovered.map((batch) => batch.length)).toEqual([300, 300, 100]);
  });

  it("Google: many works ride one notice", () => {
    const twoTitles = [
      ...urls("a", 3, "title-1"),
      ...urls("b", 2, "title-2"),
    ];
    expect(groupViolations("google", twoTitles, {})).toHaveLength(1);
  });

  it("Bing: two tracked titles become two notices, one title each", () => {
    const batch = [
      ...urls("a", 2, "title-1"),
      ...urls("b", 1, "title-2"),
    ];
    const batches = groupViolations("bing", batch, {});
    expect(batches).toHaveLength(2);
    expect(batches[0].every((row) => row.trackedTitleId === "title-1")).toBe(true);
    expect(batches[1].every((row) => row.trackedTitleId === "title-2")).toBe(true);
  });

  it("Bing: one title under 1,000 URLs stays one notice; 1,001 splits", () => {
    expect(groupViolations("bing", urls("b", 1000), {})).toHaveLength(1);
    const batches = groupViolations("bing", urls("b", 1001), {});
    expect(batches.map((part) => part.length)).toEqual([1000, 1]);
  });

  it("Yandex: every violation is its own notice", () => {
    const batches = groupViolations("yandex", urls("y", 2), {});
    expect(batches).toHaveLength(2);
    expect(batches.every((batch) => batch.length === 1)).toBe(true);
  });

  it("an empty selection groups into nothing", () => {
    expect(groupViolations("google", [], {})).toEqual([]);
    expect(groupViolations("yandex", [], {})).toEqual([]);
  });
});

describe("the on-demand single-notice rule", () => {
  it("accepts a Google selection at the cap", () => {
    expect(fitsSingleNotice("google", urls("g", 500), {})).toBe(true);
  });

  it("refuses a Google selection over the cap — splitting is the scheduled path", () => {
    expect(fitsSingleNotice("google", urls("g", 501), {})).toBe(false);
    expect(fitsSingleNotice("google", urls("g", 600), { maxUrlsPerFile: 250 })).toBe(false);
  });

  it("accepts a Bing selection of one title within 1,000 URLs", () => {
    expect(fitsSingleNotice("bing", urls("b", 1000), {})).toBe(true);
  });

  it("refuses a Bing selection spanning two titles or over 1,000 URLs", () => {
    expect(
      fitsSingleNotice("bing", [...urls("a", 1, "title-1"), ...urls("b", 1, "title-2")], {}),
    ).toBe(false);
    expect(fitsSingleNotice("bing", urls("b", 1001), {})).toBe(false);
  });

  it("refuses a Yandex selection of more than one violation", () => {
    expect(fitsSingleNotice("yandex", urls("y", 1), {})).toBe(true);
    expect(fitsSingleNotice("yandex", urls("y", 2), {})).toBe(false);
  });

  it("refuses an empty selection", () => {
    expect(fitsSingleNotice("google", [], {})).toBe(false);
  });
});
