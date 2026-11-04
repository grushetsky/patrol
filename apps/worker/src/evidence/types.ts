export type CaptureReason = "detection" | "review" | "pre_handoff";
export type CaptureOutcome = "captured" | "dead" | "blocked" | "error";

export interface RedirectHop {
  url: string;
  statusCode: number;
  location?: string;
}

export interface ImageArtifact {
  bytes: Buffer;
  width: number;
  height: number;
  truncated: boolean;
}

export interface BrowserCaptureResult {
  outcome: CaptureOutcome;
  redirectChain: RedirectHop[];
  finalUrl?: string;
  host?: string;
  httpStatus?: number;
  failureReason?: string;
  headers?: Record<string, string>;
  responseBody?: Buffer;
  dom?: string;
  domTruncated: boolean;
  screenshot?: ImageArtifact;
  thumbnail?: ImageArtifact;
  sidecar?: Record<string, unknown>;
}

export interface BrowserCapture {
  capture(url: string, reason: CaptureReason): Promise<BrowserCaptureResult>;
}

export const EXTRACTOR_VERSION = "1";
export const CAPTURE_USER_AGENT =
  "PatrolBot/0.1 (+https://patrol.example/legal; evidence capture)";
export const VIEWPORT = { width: 1365, height: 900 } as const;
export const NAVIGATION_TIMEOUT_MS = 25_000;
export const TOTAL_TIMEOUT_MS = 45_000;
export const SETTLE_MS = 2_000;
export const DOM_CEILING_BYTES = 10 * 1024 * 1024;
export const SCREENSHOT_HEIGHT_CEILING = 16_000;
