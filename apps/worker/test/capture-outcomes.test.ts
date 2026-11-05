import { describe, expect, it } from "vitest";
import {
  CAPTURE_RETRY_DELAYS_MS,
  classifyNavigationError,
  classifyStatus,
  isBlockedHost,
  isMediaUrl,
  looksLikeChallenge,
  namesPatrolObjection,
  outcomeIsTerminal,
  retryDelayMs,
  sanitizeHeaders,
} from "../src/capture/outcomes.js";

/**
 * Seams 6 and 8, pure halves: the retry matrix (dead and captured never
 * retry; blocked and error retry up to three attempts with backoff inside
 * 24 hours), the outcome classification of statuses and navigation
 * failures, the header sanitizer that carries no credentials, and the
 * documented heuristics for media URLs, ad hosts, challenges, and a host
 * naming Patrol in an objection.
 */

describe("the retry matrix", () => {
  it("never retries captured or dead", () => {
    expect(outcomeIsTerminal("captured")).toBe(true);
    expect(outcomeIsTerminal("dead")).toBe(true);
    expect(outcomeIsTerminal("blocked")).toBe(false);
    expect(outcomeIsTerminal("error")).toBe(false);
  });

  it("allows exactly three attempts with backoff inside 24 hours", () => {
    expect(retryDelayMs(1)).toBe(CAPTURE_RETRY_DELAYS_MS[0]);
    expect(retryDelayMs(2)).toBe(CAPTURE_RETRY_DELAYS_MS[1]);
    expect(retryDelayMs(3)).toBeNull();
    const total = CAPTURE_RETRY_DELAYS_MS.reduce((sum, delay) => sum + delay, 0);
    expect(total).toBeLessThan(24 * 60 * 60 * 1000);
  });

  it("honours an injected schedule", () => {
    expect(retryDelayMs(1, [60_000])).toBe(60_000);
    expect(retryDelayMs(2, [60_000])).toBeNull();
  });
});

describe("status classification", () => {
  it("files the dead and blocked statuses and nothing else", () => {
    expect(classifyStatus(404)).toBe("dead");
    expect(classifyStatus(410)).toBe("dead");
    expect(classifyStatus(401)).toBe("blocked");
    expect(classifyStatus(403)).toBe("blocked");
    expect(classifyStatus(429)).toBe("blocked");
    expect(classifyStatus(451)).toBe("blocked");
    expect(classifyStatus(200)).toBeNull();
    expect(classifyStatus(500)).toBeNull();
  });
});

describe("navigation failure classification", () => {
  it("treats DNS failures and refused connections as dead", () => {
    expect(classifyNavigationError("net::ERR_NAME_NOT_RESOLVED at https://x", { timedOut: false, budgetExceeded: false })).toEqual({
      outcome: "dead",
      failureReason: "dns_failure",
    });
    expect(classifyNavigationError("net::ERR_CONNECTION_REFUSED", { timedOut: false, budgetExceeded: false })).toEqual({
      outcome: "dead",
      failureReason: "connection_refused",
    });
  });

  it("treats timeouts, TLS failures, and the total budget as error", () => {
    expect(classifyNavigationError("Timeout 30000ms exceeded", { timedOut: true, budgetExceeded: false })).toEqual({
      outcome: "error",
      failureReason: "timeout_navigation",
    });
    expect(classifyNavigationError("net::ERR_CERT_AUTHORITY_INVALID", { timedOut: false, budgetExceeded: false })).toEqual({
      outcome: "error",
      failureReason: "tls_failure",
    });
    expect(classifyNavigationError("Target closed", { timedOut: false, budgetExceeded: true })).toEqual({
      outcome: "error",
      failureReason: "timeout_total",
    });
  });
});

describe("header sanitization (seam 8)", () => {
  it("drops Set-Cookie, Cookie, and Authorization whatever their case", () => {
    expect(
      sanitizeHeaders({
        "Content-Type": "text/html",
        "Set-Cookie": "sid=secret",
        "set-cookie": "sid=secret",
        COOKIE: "sid=secret",
        Authorization: "Bearer x",
        "aUtHoRiZaTiOn": "Bearer x",
        Server: "nginx",
      }),
    ).toEqual({ "Content-Type": "text/html", Server: "nginx" });
  });
});

describe("the documented heuristics", () => {
  it("recognizes media URLs and advertising hosts", () => {
    expect(isMediaUrl("https://cdn.example.test/video.mp4?token=1")).toBe(true);
    expect(isMediaUrl("https://cdn.example.test/playlist.m3u8")).toBe(true);
    expect(isMediaUrl("https://example.test/watch")).toBe(false);
    expect(isBlockedHost("https://mc.yandex.ru/watch/1")).toBe(true);
    expect(isBlockedHost("https://www.googletagmanager.com/gtm.js?id=1")).toBe(true);
    // Fonts and stylesheets — and ordinary hosts — stay allowed.
    expect(isBlockedHost("https://example.test/style.css")).toBe(false);
    expect(isBlockedHost("https://fonts.example.net/font.woff2")).toBe(false);
  });

  it("recognizes a challenge page by its fingerprint", () => {
    expect(looksLikeChallenge("Please complete the CAPTCHA", null)).toBe(true);
    expect(looksLikeChallenge("Just a moment...", null)).toBe(true);
    expect(looksLikeChallenge("Fixture Work — Watch Online", "A normal page body")).toBe(false);
  });

  it("recognizes Patrol's host objecting by name", () => {
    expect(
      namesPatrolObjection("This page is offline following a cease and desist notice naming Patrol."),
    ).toBe(true);
    expect(namesPatrolObjection("cease and desist notice to someone else")).toBe(false);
    expect(namesPatrolObjection("Patrol was here")).toBe(false);
    expect(namesPatrailAbsent()).toBe(false);
    function namesPatrailAbsent(): boolean {
      return namesPatrolObjection(null);
    }
  });
});
