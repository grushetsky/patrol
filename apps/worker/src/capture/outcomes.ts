import type { CaptureOutcome } from "@patrol/evidence";

/**
 * The pure outcome vocabulary of a capture (docs/design/evidence-capture.md
 * "Outcomes and retries", "Ceilings", "Blocked resources"): status and
 * navigation-error classification, the challenge and objection heuristics,
 * the header sanitizer, and the retry schedule. Everything here is a
 * documented constant or a pure function so the runner stays a sequence of
 * decisions a test can drive without a browser.
 */

/**
 * The ceilings (implementation rules "Ceilings"): a 25-second navigation
 * budget, readiness as `load` plus a two-second settle, a 45-second total
 * budget, a 10 MB DOM ceiling, and a screenshot capped at 16 000 pixels of
 * height because Chromium's full-page capture fails above 16 384. These are
 * the production constants; tests shrink them through the capture options,
 * never by editing them.
 */
export const NAVIGATION_BUDGET_MS = 25_000;
export const SETTLE_MS = 2_000;
export const TOTAL_BUDGET_MS = 45_000;
export const DOM_CEILING_BYTES = 10 * 1024 * 1024;
export const SCREENSHOT_HEIGHT_CAP = 16_000;

/**
 * The retry matrix (implementation rules "Retries"): `dead` and `captured`
 * never retry; `blocked` and `error` retry up to three attempts with
 * backoff inside 24 hours. The delays below sit between attempts two and
 * three, so a first attempt at midnight makes its last attempt by 02:15 —
 * the whole window inside the day the design allows. Retries never change
 * posture: no proxy rotation, no user-agent rotation, no challenge solving.
 */
export const MAX_CAPTURE_ATTEMPTS = 3;
export const CAPTURE_RETRY_DELAYS_MS: readonly number[] = [
  15 * 60_000,
  2 * 60 * 60_000,
];

/**
 * The delay before the next attempt, or null when the attempt just
 * finished was the last allowed one.
 */
export function retryDelayMs(
  attemptJustFinished: number,
  delays: readonly number[] = CAPTURE_RETRY_DELAYS_MS,
): number | null {
  // Attempt 1 waits delays[0] before attempt 2; attempt 2 waits delays[1]
  // before attempt 3; attempt 3 is the last.
  return attemptJustFinished <= delays.length ? delays[attemptJustFinished - 1] : null;
}

/** True when an outcome is final: no further attempt is ever taken. */
export function outcomeIsTerminal(outcome: CaptureOutcome): boolean {
  return outcome === "captured" || outcome === "dead";
}

/** The status codes that make a page dead: it answered "gone". */
export const DEAD_STATUSES: ReadonlySet<number> = new Set([404, 410]);

/**
 * The status codes that make a page blocked (implementation rules
 * "Outcomes"): the host refused Patrol individually — authentication
 * demanded, access forbidden, rate limited, or legally walled.
 */
export const BLOCKED_STATUSES: ReadonlySet<number> = new Set([401, 403, 429, 451]);

/**
 * The headers a capture never records (the design's bundle table): the
 * full header map minus `Set-Cookie`, `Cookie`, and `Authorization`, so
 * the record supports hosting and freshness claims without carrying
 * visitor credentials.
 */
const CREDENTIAL_HEADERS: ReadonlySet<string> = new Set([
  "set-cookie",
  "cookie",
  "authorization",
]);

/** Strips the credential-bearing headers, whatever their case. */
export function sanitizeHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const key of Object.keys(headers).sort()) {
    if (!CREDENTIAL_HEADERS.has(key.toLowerCase())) {
      kept[key] = headers[key];
    }
  }
  return kept;
}

/**
 * The challenge-page heuristic (documented, deliberately a fingerprint of
 * what an interstitial must say rather than a provider list): a title or
 * body carrying one of these markers reads as a CAPTCHA or interstitial
 * challenge, which the outcome table files under `blocked`.
 */
export const CHALLENGE_MARKERS: readonly string[] = [
  "captcha",
  "are you a robot",
  "verify you are human",
  "checking your browser",
  "just a moment",
  "attention required",
  "ddos protection",
  "cf-challenge",
  "доступ ограничен",
  "подтвердите, что вы не робот",
];

/** True when the page's title or body reads as a challenge interstitial. */
export function looksLikeChallenge(title: string | null, bodyText: string | null): boolean {
  const haystack = `${title ?? ""}\n${bodyText ?? ""}`.toLowerCase();
  return CHALLENGE_MARKERS.some((marker) => haystack.includes(marker));
}

/**
 * The objection heuristic (docs/design/evidence-capture.md "What the fetch
 * is, and is not"): a host that names Patrol in a cease-and-desist, a
 * block notice, or an abuse complaint has made the individualized objection
 * whose continued violation is the line *Facebook v. Power Ventures*
 * draws. The body must both carry the demand's language and name Patrol.
 */
export const OBJECTION_MARKERS: readonly string[] = [
  "cease and desist",
  "cease-and-desist",
  "abuse complaint",
  "block notice",
  "takedown demand",
];

/** True when a response's body reads as Patrol's host objecting. */
export function namesPatrolObjection(bodyText: string | null): boolean {
  if (bodyText === null) {
    return false;
  }
  const lowered = bodyText.toLowerCase();
  return lowered.includes("patrol") && OBJECTION_MARKERS.some((marker) => lowered.includes(marker));
}

/**
 * The media-extension heuristic that catches media served through script
 * fetches rather than media elements (the resource-type block sees only
 * the latter). Page media is never downloaded or hashed: fingerprinting is
 * out of scope and the screenshot is the only image Patrol stores.
 */
const MEDIA_EXTENSIONS: readonly string[] = [
  ".mp4", ".m4v", ".webm", ".mkv", ".avi", ".mov", ".flv", ".wmv",
  ".mp3", ".m4a", ".ogg", ".oga", ".wav", ".flac", ".aac",
  ".m3u8", ".mpd", ".ts",
];

/** True when a URL's path ends in a media file extension. */
export function isMediaUrl(url: string): boolean {
  let path: string;
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    return false;
  }
  return MEDIA_EXTENSIONS.some((extension) => path.endsWith(extension));
}

/**
 * The advertising and third-party analytics host blocklist — a documented
 * hostname-substring heuristic, not a provider census. Requests to these
 * hosts are blocked so a capture does not become a record of who visited
 * the pirate site; fonts and stylesheets stay allowed so the screenshot
 * matches what a visitor sees.
 */
export const BLOCKED_HOST_SUBSTRINGS: readonly string[] = [
  "doubleclick.net",
  "googlesyndication.com",
  "googletagmanager.com",
  "google-analytics.com",
  "analytics.google.com",
  "mc.yandex.ru",
  "an.yandex.ru",
  "adfox.ru",
  "connect.facebook.net",
  "facebook.net",
  "scorecardresearch.com",
  "hotjar.com",
  "hotjar.io",
  "criteo.com",
  "criteo.net",
  "taboola.com",
  "outbrain.com",
  "pubmatic.com",
  "rubiconproject.com",
  "openx.net",
  "smartadserver.com",
  "adsrvr.org",
  "amazon-adsystem.com",
  "adnxs.com",
  "adform.net",
  "moatads.com",
  "bidswitch.net",
  "sharethrough.com",
  "teads.tv",
];

/** True when a request's host carries an advertising/analytics signature. */
export function isBlockedHost(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return BLOCKED_HOST_SUBSTRINGS.some((substring) => host.includes(substring));
}

/**
 * The classified failure of a fetch that did not land as `captured`:
 * navigation errors classify as dead or error, a challenge page as
 * blocked. Null on an observation that captured.
 */
export interface NavigationFailure {
  outcome: "dead" | "blocked" | "error";
  failureReason: string;
}

/**
 * Classifies a navigation error by Playwright's failure text. DNS
 * failures, refused connections, and empty responses are the design's
 * `dead`; timeouts, TLS failures, and crashes are `error`. A total-budget
 * shutdown (the worker closed the context) is `error` by construction —
 * the page took too long, which is what `error` exists to record.
 */
export function classifyNavigationError(
  message: string,
  options: { timedOut: boolean; budgetExceeded: boolean },
): NavigationFailure {
  if (options.budgetExceeded) {
    return { outcome: "error", failureReason: "timeout_total" };
  }
  if (message.includes("net::ERR_NAME_NOT_RESOLVED")) {
    return { outcome: "dead", failureReason: "dns_failure" };
  }
  if (message.includes("net::ERR_CONNECTION_REFUSED")) {
    return { outcome: "dead", failureReason: "connection_refused" };
  }
  if (message.includes("net::ERR_EMPTY_RESPONSE") || message.includes("net::ERR_ABORTED")) {
    return { outcome: "dead", failureReason: "empty_response" };
  }
  if (options.timedOut || message.includes("net::ERR_TIMED_OUT")) {
    return { outcome: "error", failureReason: "timeout_navigation" };
  }
  if (
    message.includes("net::ERR_SSL_") ||
    message.includes("net::ERR_CERT_") ||
    message.includes("net::ERR_TLS_")
  ) {
    return { outcome: "error", failureReason: "tls_failure" };
  }
  return { outcome: "error", failureReason: "navigation_failed" };
}

/** What a response's status alone says about the capture's outcome. */
export function classifyStatus(status: number): CaptureOutcome | null {
  if (DEAD_STATUSES.has(status)) {
    return "dead";
  }
  if (BLOCKED_STATUSES.has(status)) {
    return "blocked";
  }
  return null;
}
