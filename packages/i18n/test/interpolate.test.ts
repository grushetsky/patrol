import { describe, expect, it } from "vitest";
import { interpolate, t, TEST_LOCALE } from "../src/index";

/**
 * The one `{param}` substitution rule every message-composing caller
 * renders through (the web's screens, the budget alert messages, the mail
 * templates).
 */
describe("interpolate", () => {
  it("fills the placeholders a value covers", () => {
    expect(interpolate("{count} d ago", { count: "12" })).toBe("12 d ago");
    expect(
      interpolate(t(TEST_LOCALE, "budget.alert.exhausted"), {
        engine: "google",
        bucket: "scan",
        percent: "100",
      }),
    ).toBe(
      "google's scan bucket is spent. New work in it queues with budget_exhausted; nothing is truncated or silently skipped.",
    );
  });

  it("leaves a placeholder no value covers as written", () => {
    expect(interpolate("{a} and {b}", { a: "1" })).toBe("1 and {b}");
  });

  it("does not touch braces around non-word content", () => {
    expect(interpolate("a { not-a-placeholder } b", {})).toBe(
      "a { not-a-placeholder } b",
    );
  });
});
