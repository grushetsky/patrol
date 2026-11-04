import { createHash } from "node:crypto";
import { v7 as uuidv7 } from "uuid";
import type { Connectable, Queryable } from "../db.js";
import {
  hostOf,
  normalizeUrl,
  registrableDomainOf,
} from "../acquisition/normalize.js";
import { sanitiseHeaders } from "./headers.js";
import { HostLimiter } from "./limiter.js";
import type { CaptureStore } from "./store.js";
import {
  CAPTURE_USER_AGENT,
  EXTRACTOR_VERSION,
  VIEWPORT,
  type BrowserCapture,
  type BrowserCaptureResult,
  type CaptureOutcome,
  type CaptureReason,
} from "./types.js";

const REVIEW_FRESH_MS = 24 * 60 * 60 * 1000;
const HANDOFF_FRESH_MS = 7 * 24 * 60 * 60 * 1000;
const RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;
const RETRY_DELAYS_MS = [5 * 60 * 1000, 30 * 60 * 1000];
const MAX_ATTEMPTS = 3;

export interface CaptureInput {
  url: string;
  reason: CaptureReason;
  attempt?: number;
  trackedTitleId?: string;
  titleGroupId?: string;
  capturePoint?: string;
}

export type CaptureResult =
  | {
      captured: true;
      evidenceId: string;
      outcome: CaptureOutcome;
      observedAt: string;
      skipped?: undefined;
    }
  | {
      captured: false;
      evidenceId?: string;
      skipped: "allowlist" | "host_objection" | "fresh" | "duplicate";
      outcome?: undefined;
    };

export interface CaptureRunnerOptions {
  now?: () => Date;
  limiter?: HostLimiter;
}

/** One evidentiary fetch, its metadata row, and its content-addressed artifacts. */
export class CaptureRunner {
  private readonly now: () => Date;
  private readonly limiter: HostLimiter;

  constructor(
    private readonly db: Connectable,
    private readonly browser: BrowserCapture,
    private readonly store: CaptureStore,
    options: CaptureRunnerOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.limiter = options.limiter ?? new HostLimiter();
  }

  async capture(input: CaptureInput): Promise<CaptureResult> {
    const requestedUrl = input.url;
    const normalized = safeNormalize(requestedUrl);
    const host = safeHost(requestedUrl);
    const attempt = input.attempt ?? 1;

    if (host && (await this.objected(host))) {
      return { captured: false, skipped: "host_objection" };
    }
    if (await this.allowlisted(requestedUrl, host, input)) {
      return { captured: false, skipped: "allowlist" };
    }
    if (input.capturePoint) {
      const duplicate = (
        await this.db.query(
          "SELECT id FROM evidence WHERE normalized_requested_url = $1 AND capture_point = $2 LIMIT 1",
          [normalized, input.capturePoint],
        )
      ).rows[0];
      if (duplicate) {
        return {
          captured: false,
          skipped: "duplicate",
          evidenceId: String(duplicate.id),
        };
      }
    }
    const fresh = await this.freshEvidence(normalized, input.reason);
    if (fresh) {
      return { captured: false, skipped: "fresh", evidenceId: fresh };
    }

    let result: BrowserCaptureResult;
    try {
      result = await this.limiter.run(host ?? "unknown", () =>
        this.browser.capture(requestedUrl, input.reason),
      );
    } catch (error) {
      result = {
        outcome: "error",
        redirectChain: [],
        failureReason:
          error instanceof Error ? error.message : "capture crashed",
        domTruncated: false,
      };
    }

    const evidenceId = uuidv7();
    const observedAt = this.now();
    const artifacts = await this.uploadArtifacts(evidenceId, result);
    await this.insertEvidence(
      evidenceId,
      requestedUrl,
      normalized,
      result,
      input,
      attempt,
      observedAt,
      artifacts,
    );
    if (result.outcome === "blocked" && result.httpStatus === 451) {
      await this.recordObjection(requestedUrl);
    }
    return {
      captured: true,
      evidenceId,
      outcome: result.outcome,
      observedAt: observedAt.toISOString(),
    };
  }

  private async uploadArtifacts(
    evidenceId: string,
    result: BrowserCaptureResult,
  ): Promise<
    Array<{
      kind: string;
      sha256: string;
      byteSize: number;
      contentType: string;
      width: number | null;
      height: number | null;
      truncated: boolean;
      objectKey: string;
      objectVersion: string | null;
    }>
  > {
    if (
      result.outcome !== "captured" &&
      (!result.responseBody || result.responseBody.byteLength === 0)
    ) {
      return [];
    }
    const artifacts: Array<{
      kind: string;
      body: Buffer;
      contentType: string;
      width?: number;
      height?: number;
      truncated: boolean;
    }> = [];
    if (result.responseBody && result.responseBody.byteLength > 0) {
      artifacts.push({
        kind: "response_body",
        body: result.responseBody,
        contentType:
          result.headers?.["content-type"] ?? "application/octet-stream",
        truncated: false,
      });
    }
    const headers = result.headers
      ? sanitiseHeaders(result.headers)
      : undefined;
    if (headers) {
      artifacts.push({
        kind: "response_headers",
        body: Buffer.from(JSON.stringify(headers), "utf8"),
        contentType: "application/json",
        truncated: false,
      });
    }
    if (result.dom !== undefined) {
      artifacts.push({
        kind: "rendered_dom",
        body: Buffer.from(result.dom, "utf8"),
        contentType: "text/html; charset=utf-8",
        truncated: result.domTruncated,
      });
    }
    if (result.screenshot) {
      artifacts.push({
        kind: "screenshot",
        body: result.screenshot.bytes,
        contentType: "image/png",
        width: result.screenshot.width,
        height: result.screenshot.height,
        truncated: result.screenshot.truncated,
      });
    }
    if (result.thumbnail) {
      artifacts.push({
        kind: "thumbnail",
        body: result.thumbnail.bytes,
        contentType: "image/jpeg",
        width: result.thumbnail.width,
        height: result.thumbnail.height,
        truncated: result.thumbnail.truncated,
      });
    }
    if (result.sidecar) {
      artifacts.push({
        kind: "extraction_sidecar",
        body: Buffer.from(JSON.stringify(result.sidecar), "utf8"),
        contentType: "application/json",
        truncated: false,
      });
    }

    const uploaded = [];
    for (const artifact of artifacts) {
      const sha256 = createHash("sha256").update(artifact.body).digest("hex");
      const stored = await this.store.put({
        kind: artifact.kind,
        sha256,
        body: artifact.body,
        contentType: artifact.contentType,
        evidenceId,
        retainUntil: new Date(this.now().getTime() + 365 * 24 * 60 * 60 * 1000),
      });
      uploaded.push({
        kind: artifact.kind,
        sha256,
        byteSize: artifact.body.byteLength,
        contentType: artifact.contentType,
        width: artifact.width ?? null,
        height: artifact.height ?? null,
        truncated: artifact.truncated,
        objectKey: stored.key,
        objectVersion: stored.version,
      });
    }
    return uploaded;
  }

  private async insertEvidence(
    evidenceId: string,
    requestedUrl: string,
    normalized: string,
    result: BrowserCaptureResult,
    input: CaptureInput,
    attempt: number,
    observedAt: Date,
    artifacts: Array<{
      kind: string;
      sha256: string;
      byteSize: number;
      contentType: string;
      width: number | null;
      height: number | null;
      truncated: boolean;
      objectKey: string;
      objectVersion: string | null;
    }>,
  ): Promise<void> {
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO evidence
          (id, tracked_title_id, title_group_id, requested_url,
           normalized_requested_url, redirect_chain, final_url, host,
           host_source, reason, capture_point, outcome, http_status,
           failure_reason, attempt_number, observed_at, profile, purged_at,
           purge_reason, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
                 $14, $15, $16, $17, NULL, NULL, $18)`,
        [
          evidenceId,
          input.trackedTitleId ?? null,
          input.titleGroupId ?? null,
          requestedUrl,
          normalized,
          JSON.stringify(result.redirectChain),
          result.finalUrl ?? null,
          result.host ?? null,
          result.finalUrl ? "landing_page" : null,
          input.reason,
          input.capturePoint ?? null,
          result.outcome,
          result.httpStatus ?? null,
          result.failureReason ?? null,
          attempt,
          observedAt,
          JSON.stringify(profile()),
          observedAt,
        ],
      );
      for (const artifact of artifacts) {
        await client.query(
          `INSERT INTO evidence_artifact
            (evidence_id, kind, sha256, byte_size, content_type, width, height,
             truncated, object_key, object_version, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            evidenceId,
            artifact.kind,
            artifact.sha256,
            artifact.byteSize,
            artifact.contentType,
            artifact.width,
            artifact.height,
            artifact.truncated,
            artifact.objectKey,
            artifact.objectVersion,
            this.now(),
          ],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async recordObjection(requestedUrl: string): Promise<void> {
    const host = safeHost(requestedUrl);
    if (!host) {
      return;
    }
    const existing = (
      await this.db.query(
        "SELECT id FROM host_objection WHERE host = $1 AND cleared_at IS NULL LIMIT 1",
        [host],
      )
    ).rows[0];
    if (existing) {
      return;
    }
    try {
      await this.db.query(
        `INSERT INTO host_objection
          (id, host, registrable_domain, reason, source, recorded_at, recorded_by,
           affected_candidate_count, cleared_at, cleared_by, clearance_reason)
         VALUES ($1, $2, $3, 'HTTP 451 legal block', 'host_contact', $4, NULL, 0,
                 NULL, NULL, NULL)`,
        [uuidv7(), host, registrableDomainOf(requestedUrl), this.now()],
      );
    } catch {
      // A concurrent capture recorded the same objection first.
    }
  }

  private async objected(host: string): Promise<boolean> {
    return (
      (
        await this.db.query(
          "SELECT id FROM host_objection WHERE host = $1 AND cleared_at IS NULL LIMIT 1",
          [host],
        )
      ).rows.length > 0
    );
  }

  private async allowlisted(
    requestedUrl: string,
    host: string | undefined,
    input: CaptureInput,
  ): Promise<boolean> {
    if (!host) {
      return false;
    }
    const rows = (
      await this.db.query(
        `SELECT * FROM allowlist_entry
          WHERE removed_at IS NULL
            AND (scope = 'rights_holder'
              OR (scope = 'title_group' AND title_group_id = $1)
              OR (scope = 'tracked_title' AND tracked_title_id = $2))`,
        [input.titleGroupId ?? "", input.trackedTitleId ?? ""],
      )
    ).rows;
    return rows.some((row) => {
      const value = String(row.value).toLowerCase();
      if (row.match_kind === "host") {
        return host === value || host.endsWith(`.${value}`);
      }
      return requestedUrl.startsWith(String(row.value));
    });
  }

  private async freshEvidence(
    normalizedUrl: string,
    reason: CaptureReason,
  ): Promise<string | undefined> {
    if (reason === "detection") {
      return undefined;
    }
    const newest = (
      await this.db.query(
        `SELECT id, observed_at FROM evidence
          WHERE normalized_requested_url = $1 AND outcome = 'captured'
          ORDER BY observed_at DESC LIMIT 1`,
        [normalizedUrl],
      )
    ).rows[0];
    if (!newest) {
      return undefined;
    }
    const age = this.now().getTime() - new Date(String(newest.observed_at)).getTime();
    const threshold =
      reason === "review" ? REVIEW_FRESH_MS : HANDOFF_FRESH_MS;
    return age < threshold ? String(newest.id) : undefined;
  }
}

export function retryDelay(
  outcome: CaptureOutcome,
  attempt: number,
  observedAt: Date,
  now: Date,
): number | undefined {
  if (outcome === "captured" || outcome === "dead") {
    return undefined;
  }
  if (attempt >= MAX_ATTEMPTS) {
    return undefined;
  }
  if (now.getTime() - observedAt.getTime() > RETRY_WINDOW_MS) {
    return undefined;
  }
  return RETRY_DELAYS_MS[attempt - 1];
}


function profile() {
  return {
    userAgent: CAPTURE_USER_AGENT,
    viewportWidth: VIEWPORT.width,
    viewportHeight: VIEWPORT.height,
    locale: "en-US",
    timezone: "UTC",
    javascriptEnabled: true,
    blockedResourceKinds: [
      "media",
      "websocket",
      "service_worker",
      "advertising",
      "third_party_analytics",
    ],
    navigationPolicy: "load plus 2s settle",
    extractorVersion: EXTRACTOR_VERSION,
  };
}

function safeNormalize(url: string): string {
  try {
    return normalizeUrl(url);
  } catch {
    return url;
  }
}

function safeHost(url: string): string | undefined {
  try {
    return hostOf(url);
  } catch {
    return undefined;
  }
}
