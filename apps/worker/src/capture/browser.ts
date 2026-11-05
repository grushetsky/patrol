import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import {
  BLOCKED_STATUSES,
  DEAD_STATUSES,
  DOM_CEILING_BYTES,
  NAVIGATION_BUDGET_MS,
  SCREENSHOT_HEIGHT_CAP,
  SETTLE_MS,
  TOTAL_BUDGET_MS,
  classifyNavigationError,
  isBlockedHost,
  isMediaUrl,
  looksLikeChallenge,
  type NavigationFailure,
} from "./outcomes.js";
import type { CaptureProfileJson, RedirectHopRow } from "@patrol/evidence";

/**
 * The Playwright capture page (ADR 0016, ADR 0018; docs/design/
 * evidence-capture.md "What a capture records", "Ceilings"): one browser
 * context per capture carrying the capture profile, the resource
 * blocking, and the budgets. Playwright runs on the host — Chromium is a
 * local dev tool here, installed once, and the container image carries it
 * in deployment.
 */

/**
 * Everything one fetch of one URL observed, in the artifact assembly's own
 * terms. `failure` is the classified failure when the fetch did not land as
 * captured; every other field is null exactly when the observation did
 * not produce it.
 */
export interface PageObservation {
  requestedUrl: string;
  /** The classified failure, when the fetch did not land as captured. */
  failure: NavigationFailure | null;
  redirectChain: RedirectHopRow[];
  finalUrl: string | null;
  httpStatus: number | null;
  /** The final response's headers, raw — sanitization is the runner's pure step. */
  headers: Record<string, string> | null;
  rawBody: Uint8Array | null;
  title: string | null;
  renderedDom: string | null;
  domTruncated: boolean;
  screenshot: Uint8Array | null;
  screenshotTruncated: boolean;
  /** The screenshot's width in CSS pixels — the viewport, or the page's scroll width when wider. */
  screenshotWidth: number | null;
  screenshotHeight: number | null;
  thumbnail: Uint8Array | null;
  /** The serialized extraction sidecar, deterministic in key order. */
  sidecar: string | null;
  /** The final URL's host, when a response was received. */
  pageHost: string | null;
  /** True when the 45-second budget closed the context mid-capture. */
  budgetExceeded: boolean;
}

/** The budgets one capture runs under; tests shrink them, production never. */
export interface CaptureBudgets {
  navigationMs: number;
  settleMs: number;
  totalMs: number;
}

export const PRODUCTION_BUDGETS: CaptureBudgets = {
  navigationMs: NAVIGATION_BUDGET_MS,
  settleMs: SETTLE_MS,
  totalMs: TOTAL_BUDGET_MS,
};

/** Launches the shared capture browser. */
export async function launchCaptureBrowser(): Promise<Browser> {
  return chromium.launch({ headless: true });
}

/**
 * The route-interception rule (implementation rules "Blocked resources"):
 * media, websocket, and service-worker requests are blocked by resource
 * type, advertising and third-party analytics hosts by the documented
 * blocklist heuristic, and media file extensions however the page loads
 * them. Fonts and stylesheets continue so the screenshot matches what a
 * visitor sees. Images continue for the same reason — the screenshot is
 * the only image Patrol stores, and it stores it as the page's appearance.
 */
function shouldBlockRequest(request: {
  url: () => string;
  resourceType: () => string;
}): boolean {
  const type = request.resourceType();
  if (type === "media" || type === "websocket" || type === "serviceworker") {
    return true;
  }
  const url = request.url();
  return isBlockedHost(url) || isMediaUrl(url);
}

/** The deterministic extraction sidecar (minimal; slice 5 deepens the parser). */
async function extractSidecar(page: Page): Promise<string> {
  const extracted = await page.evaluate(() => {
    const meta: Record<string, string> = {};
    for (const element of document.querySelectorAll("meta")) {
      const name = element.getAttribute("name") ?? element.getAttribute("property");
      if (name !== null && name !== "") {
        meta[name] = element.getAttribute("content") ?? "";
      }
    }
    const jsonLd: unknown[] = [];
    for (const element of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        jsonLd.push(JSON.parse(element.textContent ?? ""));
      } catch {
        // A malformed blob stays out; the sidecar records what parsed.
      }
    }
    return {
      title: document.title,
      h1: [...document.querySelectorAll("h1")].map((h1) => h1.textContent?.trim() ?? ""),
      meta,
      jsonLd,
      iframes: [...document.querySelectorAll("iframe")].map((iframe) => iframe.src).filter((src) => src !== ""),
      videos: [...document.querySelectorAll("video")].map((video) => ({
        src: video.src || video.querySelector("source")?.src || "",
        duration: Number.isFinite(video.duration) ? video.duration : null,
      })),
      downloadAffordances: [...document.querySelectorAll("a[download], a[href]")]
        .map((a) => (a as HTMLAnchorElement).href)
        .filter((href) => /\.(zip|rar|7z|torrent|magnet|mp4|mkv|avi)([?#].*)?$/i.test(href)),
    };
  });
  return JSON.stringify(extracted);
}

async function contextFor(
  browser: Browser,
  profile: CaptureProfileJson,
): Promise<BrowserContext> {
  const context = await browser.newContext({
    userAgent: profile.userAgent,
    viewport: { width: profile.viewportWidth, height: profile.viewportHeight },
    locale: profile.locale,
    timezoneId: profile.timezone,
    // Service workers are blocked outright: they are a cache Patrol must
    // not record from and a background the capture does not need.
    serviceWorkers: "block",
  });
  await context.route("**/*", (route) => {
    if (shouldBlockRequest(route.request())) {
      void route.abort();
      return;
    }
    void route.continue();
  });
  return context;
}

/**
 * Fetches one URL once and observes it (ADR 0018): navigate the requested
 * URL verbatim, record every redirect hop, land, then — only for a page
 * that answered — render the bundle. The total budget closes the context
 * when it runs out, which fails the in-flight step as `timeout_total`.
 */
export async function capturePage(
  browser: Browser,
  url: string,
  profile: CaptureProfileJson,
  budgets: CaptureBudgets = PRODUCTION_BUDGETS,
): Promise<PageObservation> {
  const observation: PageObservation = {
    requestedUrl: url,
    failure: null,
    redirectChain: [],
    finalUrl: null,
    httpStatus: null,
    headers: null,
    rawBody: null,
    title: null,
    renderedDom: null,
    domTruncated: false,
    screenshot: null,
    screenshotTruncated: false,
    screenshotWidth: null,
    screenshotHeight: null,
    thumbnail: null,
    sidecar: null,
    pageHost: null,
    budgetExceeded: false,
  };

  const context = await contextFor(browser, profile);
  const page = await context.newPage();

  // The redirect chain: every navigation response in order, with its
  // status and Location. The chain proves how one URL became the other;
  // the submitted URL is never rewritten by it.
  const navigationResponses: Array<{ url: string; status: number; location?: string }> = [];
  page.on("response", (response) => {
    const request = response.request();
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
      const location = response.headers()["location"];
      navigationResponses.push({
        url: response.url(),
        status: response.status(),
        ...(location === undefined || location === "" ? {} : { location }),
      });
    }
  });

  // The total budget's hard stop: closing the context fails whatever step
  // is in flight, and the flag turns that failure into timeout_total.
  let budgetExceeded = false;
  const budgetTimer = setTimeout(() => {
    budgetExceeded = true;
    void context.close().catch(() => undefined);
  }, budgets.totalMs);

  try {
    let response = null as Awaited<ReturnType<Page["goto"]>>;
    try {
      response = await page.goto(url, {
        timeout: budgets.navigationMs,
        waitUntil: "load",
      });
    } catch (error) {
      observation.budgetExceeded = budgetExceeded;
      observation.failure = classifyNavigationError(
        error instanceof Error ? error.message : String(error),
        { timedOut: error instanceof Error && error.name === "TimeoutError", budgetExceeded },
      );
      return observation;
    }
    if (response === null) {
      observation.failure = { outcome: "error", failureReason: "navigation_failed" };
      return observation;
    }

    observation.httpStatus = response.status();
    observation.finalUrl = page.url();
    observation.pageHost = safeHost(observation.finalUrl);
    observation.redirectChain = navigationResponses
      .filter((hop) => hop.status >= 300 && hop.status < 400 && hop.location !== undefined)
      .map((hop) => ({ url: hop.url, statusCode: hop.status, location: hop.location }));
    observation.headers = await response.allHeaders();
    try {
      observation.rawBody = new Uint8Array(await response.body());
    } catch {
      // The body is evidence only when the server actually returned one.
      observation.rawBody = null;
    }

    // A page that answered with a dead or blocked status records its
    // metadata — an absence is evidence too — and is never rendered. The
    // sets are the outcome vocabulary's own, so a status the classifier
    // files as dead or blocked can never be rendered here.
    const status = response.status();
    if (DEAD_STATUSES.has(status) || BLOCKED_STATUSES.has(status)) {
      return observation;
    }

    // Readiness: load plus the settle, never a network-idle heuristic.
    await page.waitForTimeout(budgets.settleMs);
    observation.title = await page.title();

    const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 20_000) ?? "");
    if (looksLikeChallenge(observation.title, bodyText)) {
      // A challenge page is blocked; its body and headers stay, its render
      // does not — Patrol does not interact with challenges at all.
      observation.failure = { outcome: "blocked", failureReason: "challenge" };
      return observation;
    }

    const metrics = await page.evaluate(() => ({
      scrollHeight: document.documentElement.scrollHeight,
      scrollWidth: Math.max(
        document.documentElement.scrollWidth,
        document.body?.scrollWidth ?? 0,
      ),
    }));

    // Rendered DOM with the 10 MB ceiling: serialize outerHTML, truncate
    // at the byte boundary when it exceeds the ceiling, flag it. Exceeding
    // a ceiling produces a truncated but honest artifact, never a silent
    // partial.
    const dom = await page.evaluate(() => document.documentElement.outerHTML);
    const domBytes = Buffer.from(dom, "utf8");
    if (domBytes.byteLength > DOM_CEILING_BYTES) {
      observation.renderedDom = domBytes.subarray(0, DOM_CEILING_BYTES).toString("utf8");
      observation.domTruncated = true;
    } else {
      observation.renderedDom = dom;
    }

    // Full-page screenshot with the 16 000-pixel height cap (Chromium's own
    // capture fails above 16 384): clip when the page is taller, and flag
    // the clip. The width is the viewport or the page's own scroll width
    // when it overflows — a horizontally scrolling page is captured across
    // what it actually shows, and the artifact records that width. The
    // thumbnail is the same settled viewport as a small JPEG, which is
    // what the review queue ships to the browser.
    const clipped = metrics.scrollHeight > SCREENSHOT_HEIGHT_CAP;
    const screenshotWidth = Math.max(profile.viewportWidth, metrics.scrollWidth);
    observation.screenshotTruncated = clipped;
    observation.screenshotWidth = screenshotWidth;
    observation.screenshotHeight = Math.min(metrics.scrollHeight, SCREENSHOT_HEIGHT_CAP);
    observation.screenshot = new Uint8Array(
      await page.screenshot({
        type: "png",
        ...(clipped
          ? {
              clip: {
                x: 0,
                y: 0,
                width: screenshotWidth,
                height: SCREENSHOT_HEIGHT_CAP,
              },
            }
          : { fullPage: true }),
      }),
    );
    observation.thumbnail = new Uint8Array(
      await page.screenshot({
        type: "jpeg",
        quality: 60,
        clip: {
          x: 0,
          y: 0,
          width: profile.viewportWidth,
          height: profile.viewportHeight,
        },
      }),
    );
    observation.sidecar = await extractSidecar(page);
    return observation;
  } catch (error) {
    // The total budget's context close lands here: whatever step was in
    // flight failed because the page took too long.
    const message = error instanceof Error ? error.message : String(error);
    observation.budgetExceeded = budgetExceeded;
    observation.failure = classifyNavigationError(message, {
      timedOut: false,
      budgetExceeded: budgetExceeded,
    });
    return observation;
  } finally {
    clearTimeout(budgetTimer);
    await context.close().catch(() => undefined);
  }
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}
