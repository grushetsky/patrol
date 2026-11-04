import { setTimeout as delay } from "node:timers/promises";
import { sanitiseHeaders } from "./headers.js";
import { chromium, type Browser, type Page, type Response } from "playwright-core";
import {
  CAPTURE_USER_AGENT,
  DOM_CEILING_BYTES,
  NAVIGATION_TIMEOUT_MS,
  SCREENSHOT_HEIGHT_CEILING,
  SETTLE_MS,
  TOTAL_TIMEOUT_MS,
  VIEWPORT,
  type BrowserCapture,
  type BrowserCaptureResult,
  type CaptureReason,
  type ImageArtifact,
  type RedirectHop,
} from "./types.js";

const BLOCKED_HOSTS = [
  "doubleclick.net",
  "googlesyndication.com",
  "google-analytics.com",
  "googletagmanager.com",
  "hotjar.com",
  "facebook.net",
  "scorecardresearch.com",
  "criteo.com",
  "adnxs.com",
  "taboola.com",
  "outbrain.com",
];

const BLOCKED_RESOURCE_TYPES: Record<string, true> = {
  media: true,
  websocket: true,
  serviceworker: true,
};

const CHALLENGE_MARKERS = [
  "captcha",
  "just a moment",
  "attention required",
  "cf-challenge",
  "access denied",
  "verify you are human",
];

/** Playwright capture with the design's navigation, settle, and ceiling rules. */
export class PlaywrightCapture implements BrowserCapture {
  private browserPromise?: Promise<Browser>;

  constructor(
    private readonly executablePath =
      process.env.PATROL_CHROMIUM_PATH || undefined,
  ) {}

  async capture(
    url: string,
    _reason: CaptureReason,
  ): Promise<BrowserCaptureResult> {
    const browser = await this.browser();
    const context = await browser.newContext({
      userAgent: CAPTURE_USER_AGENT,
      viewport: VIEWPORT,
      locale: "en-US",
      timezoneId: "UTC",
      javaScriptEnabled: true,
      serviceWorkers: "block",
    });
    const page = await context.newPage();
    const startedAt = Date.now();
    try {
      await this.blockResources(page);
      let response: Response | null = null;
      try {
        response = await page.goto(url, {
          waitUntil: "load",
          timeout: NAVIGATION_TIMEOUT_MS,
        });
      } catch (error) {
        return failed(
          classifyNavigationError(error),
          [],
          errorMessage(error),
        );
      }
      if (!response) {
        return failed("error", [], "navigation returned no response");
      }

      const collect = async (): Promise<BrowserCaptureResult> => {
        await page.waitForTimeout(SETTLE_MS);
        const redirectChain = await buildRedirectChain(response);
        const httpStatus = response.status();
        const headers = sanitiseHeaders(response.headers());
        let responseBody: Buffer | undefined;
        let bodyFailed = false;
        try {
          responseBody = await response.body();
        } catch {
          responseBody = undefined;
          bodyFailed = true;
        }

        const rawDom = await page.content();
        const domBuffer = Buffer.from(rawDom, "utf8");
        const domTruncated = domBuffer.byteLength > DOM_CEILING_BYTES;
        const dom = (
          domTruncated
            ? domBuffer.subarray(0, DOM_CEILING_BYTES)
            : domBuffer
        ).toString("utf8");

        const contentHeight = await page.evaluate(() =>
          Math.max(
            document.documentElement.scrollHeight,
            document.body?.scrollHeight ?? 0,
          ),
        );
        const screenshot = await this.screenshot(page, contentHeight);
        const thumbnail = await this.thumbnail(page);
        const sidecar = await extract(page);
        const finalUrl = response.url();
        const host = new URL(finalUrl).hostname.toLowerCase();

        const blocked = [401, 403, 429, 451].includes(httpStatus);
        const dead =
          [404, 410].includes(httpStatus) ||
          (responseBody !== undefined && responseBody.byteLength === 0);
        const challenged = CHALLENGE_MARKERS.some((marker) =>
          `${dom} ${JSON.stringify(sidecar)}`.toLowerCase().includes(marker),
        );

        let outcome: BrowserCaptureResult["outcome"] = "captured";
        let failureReason: string | undefined;
        if (blocked || challenged) {
          outcome = "blocked";
          failureReason = challenged ? "challenge" : `http_${httpStatus}`;
        } else if (dead) {
          outcome = "dead";
          failureReason =
            responseBody?.byteLength === 0 ? "empty_body" : `http_${httpStatus}`;
        } else if (bodyFailed) {
          outcome = "error";
          failureReason = "body_unavailable";
        } else if (httpStatus < 200 || httpStatus >= 300) {
          outcome = "error";
          failureReason = `http_${httpStatus}`;
        }

        return {
          outcome,
          redirectChain,
          finalUrl,
          host,
          httpStatus,
          failureReason,
          headers,
          responseBody,
          dom,
          domTruncated,
          screenshot,
          thumbnail,
          sidecar,
        };
      };

      try {
        return await withDeadline(
          collect(),
          TOTAL_TIMEOUT_MS - (Date.now() - startedAt),
        );
      } catch (error) {
        if (errorMessage(error).includes("deadline")) {
          return failed("error", [], "total timeout");
        }
        throw error;
      }
    } finally {
      await context.close().catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    const browser = await this.browserPromise?.catch(() => undefined);
    await browser?.close();
  }

  private browser(): Promise<Browser> {
    this.browserPromise ??= chromium.launch({
      headless: true,
      ...(this.executablePath ? { executablePath: this.executablePath } : {}),
    });
    return this.browserPromise;
  }

  private async blockResources(page: Page): Promise<void> {
    await page.routeWebSocket(/.*/, (webSocket) => webSocket.close());
    await page.route("**/*", async (route) => {
      const request = route.request();
      if (BLOCKED_RESOURCE_TYPES[request.resourceType()]) {
        await route.abort();
        return;
      }
      try {
        const host = new URL(request.url()).hostname;
        if (BLOCKED_HOSTS.some((blocked) => host.endsWith(blocked))) {
          await route.abort();
          return;
        }
      } catch {
        // A non-URL request is allowed through.
      }
      await route.continue();
    });
  }

  private async screenshot(
    page: Page,
    contentHeight: number,
  ): Promise<ImageArtifact> {
    const height = Math.min(contentHeight, SCREENSHOT_HEIGHT_CEILING);
    const truncated = contentHeight > SCREENSHOT_HEIGHT_CEILING;
    try {
      const session = await page.context().newCDPSession(page);
      const result = (await session.send("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: true,
        clip: { x: 0, y: 0, width: VIEWPORT.width, height, scale: 1 },
      })) as { data: string };
      await session.detach();
      return {
        bytes: Buffer.from(result.data, "base64"),
        width: VIEWPORT.width,
        height,
        truncated,
      };
    } catch {
      const bytes = await page.screenshot({
        type: "png",
        clip: { x: 0, y: 0, width: VIEWPORT.width, height: VIEWPORT.height },
        animations: "disabled",
        timeout: 30_000,
      });
      return {
        bytes,
        width: VIEWPORT.width,
        height: VIEWPORT.height,
        truncated: truncated || contentHeight > VIEWPORT.height,
      };
    }
  }

  private async thumbnail(page: Page): Promise<ImageArtifact> {
    const bytes = await page.screenshot({
      type: "jpeg",
      quality: 70,
      animations: "disabled",
      timeout: 30_000,
    });
    return {
      bytes,
      width: VIEWPORT.width,
      height: VIEWPORT.height,
      truncated: false,
    };
  }
}

async function buildRedirectChain(final: Response): Promise<RedirectHop[]> {
  const responses: Response[] = [];
  let current: Response | null = final;
  while (current) {
    responses.push(current);
    const previous = current.request().redirectedFrom();
    current = previous ? await previous.response() : null;
  }
  return responses.reverse().map((response) => {
    const location = response.headers()["location"];
    return {
      url: response.url(),
      statusCode: response.status(),
      ...(location ? { location } : {}),
    };
  });
}


async function extract(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(() => {
    const text = (element: Element | null) =>
      element?.textContent?.replace(/\s+/g, " ").trim() ?? "";
    const meta: Record<string, string> = {};
    for (const element of document.querySelectorAll("meta")) {
      const name =
        element.getAttribute("property") ??
        element.getAttribute("name") ??
        element.getAttribute("itemprop");
      const content = element.getAttribute("content");
      if (name && content) {
        meta[name] = content;
      }
    }
    const jsonLd: unknown[] = [];
    for (const script of document.querySelectorAll(
      'script[type="application/ld+json"]',
    )) {
      try {
        jsonLd.push(JSON.parse(script.textContent ?? "null"));
      } catch {
        // A malformed block is recorded by omission.
      }
    }
    const downloadAffordances: string[] = [];
    for (const anchor of document.querySelectorAll("a[href]")) {
      const href = anchor.getAttribute("href") ?? "";
      const download = anchor.hasAttribute("download");
      if (
        download ||
        href.startsWith("magnet:") ||
        /\.(torrent|mkv|mp4)(\?|$)/i.test(href)
      ) {
        downloadAffordances.push(href);
      }
    }
    return {
      title: document.title,
      h1: [...document.querySelectorAll("h1")].map(text),
      meta,
      jsonLd,
      iframes: [...document.querySelectorAll("iframe[src]")].map(
        (element) => element.getAttribute("src") ?? "",
      ),
      videos: [...document.querySelectorAll("video, source")].map(
        (element) => element.getAttribute("src") ?? "",
      ),
      downloadAffordances,
    };
  }) as Promise<Record<string, unknown>>;
}

function classifyNavigationError(error: unknown): "dead" | "error" {
  const message = errorMessage(error);
  return /ERR_NAME_NOT_RESOLVED|ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|ERR_EMPTY_RESPONSE|ERR_ADDRESS_UNREACHABLE/i.test(
    message,
  )
    ? "dead"
    : "error";
}

function failed(
  outcome: "dead" | "error",
  redirectChain: RedirectHop[],
  failureReason: string,
): BrowserCaptureResult {
  return {
    outcome,
    redirectChain,
    failureReason,
    domTruncated: false,
  };
}

async function withDeadline<T>(work: Promise<T>, milliseconds: number): Promise<T> {
  const timeout = (async () => {
    await delay(Math.max(1, milliseconds), undefined, { ref: false });
    throw new Error("total deadline exceeded");
  })();
  return Promise.race([work, timeout]);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
