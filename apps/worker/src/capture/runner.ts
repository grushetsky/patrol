import type { Pool } from "pg";
import { hostForUrl, normalizeUrlKey } from "@patrol/domain";
import { rescoreCandidatesFromSidecar } from "@patrol/scans";
import {
  affectedSurfaceCount,
  allowlistHitForUrl,
  appendEvidence,
  beginCaptureAttempt,
  markCaptureFailed,
  markCaptureSkippedAtRun,
  activeObjectionForUrl,
  readCapture,
  recordHostObjection,
  sha256Hex,
  type CaptureOutcome,
  type CaptureProfileJson,
  type CaptureReason,
  type EvidenceStore,
  type NewEvidenceArtifact,
} from "@patrol/evidence";
import {
  CAPTURE_RETRY_DELAYS_MS,
  DOM_CEILING_BYTES,
  MAX_CAPTURE_ATTEMPTS,
  classifyStatus,
  namesPatrolObjection,
  outcomeIsTerminal,
  retryDelayMs,
  sanitizeHeaders,
} from "./outcomes.js";
import type { PageObservation } from "./browser.js";

/**
 * The capture runner (docs/design/evidence-capture.md): one attempt of one
 * queued capture — guards again at run time (an entry or an objection may
 * have landed between the enqueue and the fetch), one politeness-limited
 * fetch, the classified outcome, the content-addressed artifacts, and the
 * append-only record. `dead` and `captured` never retry; `blocked` and
 * `error` retry up to three attempts with backoff inside 24 hours through
 * the injected scheduler, and never with a different posture. A wake-up
 * ahead of the scheduled attempt stands down (the schedule owns the
 * timing), and a failure the observation cannot express marks the capture
 * failed for ops — the queue has no retry of its own, so nothing is ever
 * left stranded; the sweeper cron reaps what a dead process still leaves.
 */

export interface CaptureRunnerDeps {
  pool: Pool;
  now: () => Date;
  /** The content-addressed store the artifacts land in. */
  store: EvidenceStore;
  /** One fetch of one URL; the Playwright page in production, a fake in tests. */
  fetchPage: (url: string) => Promise<PageObservation>;
  /** Politeness: per-host serialization with spacing, overall cap. */
  limiter: { run: <T>(host: string, work: () => Promise<T>) => Promise<T> };
  /** Schedules the next attempt's queue wake-up after the backoff. */
  scheduleRetry: (captureId: string, delayMs: number) => Promise<void>;
  /** The profile every capture of this worker runs under. */
  profile: CaptureProfileJson;
  retryDelaysMs?: readonly number[];
  maxAttempts?: number;
}

type Log = (message: string, extra?: Record<string, unknown>) => void;

/** The kinds an artifact's bytes take, with their content types. */
interface AssembledArtifact {
  kind: NewEvidenceArtifact["kind"];
  bytes: Uint8Array;
  contentType: string;
  width?: number;
  height?: number;
  truncated: boolean;
}

/**
 * Assembles the artifact set an observation produced. A dead or blocked
 * capture still records its metadata — an absence is evidence too — and
 * carries blobs only when a body was actually returned; the rendered
 * bundle exists only for a captured page. The 10 MB DOM ceiling applies to
 * both byte forms of the page's HTML: the raw body is the same bytes the
 * DOM ceiling bounds, and a hostile page must not exhaust the store either
 * way — truncation is flagged, never silent.
 */
export function assembleArtifacts(
  observation: PageObservation,
  outcome: CaptureOutcome,
  viewportWidth: number,
): AssembledArtifact[] {
  const artifacts: AssembledArtifact[] = [];

  if (observation.headers !== null) {
    artifacts.push({
      kind: "response_headers",
      bytes: new TextEncoder().encode(JSON.stringify(sanitizeHeaders(observation.headers))),
      contentType: "application/json",
      truncated: false,
    });
  }

  if (observation.rawBody !== null && observation.rawBody.byteLength > 0) {
    const truncated = observation.rawBody.byteLength > DOM_CEILING_BYTES;
    artifacts.push({
      kind: "response_body",
      bytes: truncated
        ? observation.rawBody.subarray(0, DOM_CEILING_BYTES)
        : observation.rawBody,
      contentType: headerContentType(observation.headers),
      truncated,
    });
  }

  if (outcome !== "captured") {
    return artifacts;
  }

  if (observation.renderedDom !== null) {
    artifacts.push({
      kind: "rendered_dom",
      bytes: new TextEncoder().encode(observation.renderedDom),
      contentType: "text/html; charset=utf-8",
      truncated: observation.domTruncated,
    });
  }
  if (observation.screenshot !== null) {
    artifacts.push({
      kind: "screenshot",
      bytes: observation.screenshot,
      contentType: "image/png",
      truncated: observation.screenshotTruncated,
      width: observation.screenshotWidth ?? viewportWidth,
      height: observation.screenshotHeight ?? undefined,
    });
  }
  if (observation.thumbnail !== null) {
    artifacts.push({
      kind: "thumbnail",
      bytes: observation.thumbnail,
      contentType: "image/jpeg",
      truncated: false,
    });
  }
  if (observation.sidecar !== null) {
    artifacts.push({
      kind: "extraction_sidecar",
      bytes: new TextEncoder().encode(observation.sidecar),
      contentType: "application/json",
      truncated: false,
    });
  }
  return artifacts;
}

function headerContentType(headers: Record<string, string> | null): string {
  if (headers === null) {
    return "application/octet-stream";
  }
  const entry = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === "content-type",
  );
  return entry?.[1] ?? "application/octet-stream";
}

/**
 * Classifies one observation into the outcome the record carries. The
 * status decides dead and blocked; a challenge page is blocked; an empty
 * body on a nominal success is dead; a navigation failure carries its own
 * classification; everything else captured.
 */
export function classifyObservation(observation: PageObservation): {
  outcome: CaptureOutcome;
  failureReason: string | null;
} {
  if (observation.failure !== null) {
    return observation.failure;
  }
  if (observation.httpStatus !== null) {
    const byStatus = classifyStatus(observation.httpStatus);
    if (byStatus !== null) {
      return { outcome: byStatus, failureReason: `http_${observation.httpStatus}` };
    }
  }
  if (
    (observation.rawBody === null || observation.rawBody.byteLength === 0) &&
    observation.renderedDom === null
  ) {
    return { outcome: "dead", failureReason: "empty_body" };
  }
  return { outcome: "captured", failureReason: null };
}

/**
 * Runs one capture attempt end to end. The store writes happen before the
 * record: content-addressed bytes may orphan (an interrupted run leaves
 * orphaned bytes rather than dangling citations), but a rejected write
 * leaves every earlier evidence row intact and marks only the capture
 * failed for ops.
 */
export async function runCapture(
  deps: CaptureRunnerDeps,
  captureId: string,
  log: Log,
): Promise<void> {
  const row = await readCapture(deps.pool, captureId);
  if (row === null) {
    log("capture.run found no capture", { captureId });
    return;
  }
  if (row.state !== "pending") {
    log("capture.run left a non-pending capture alone", { captureId, state: row.state });
    return;
  }

  // A wake-up that arrives before the scheduled attempt is a duplicate
  // (the sweeper's re-dispatch racing the scheduled send): the scheduled
  // wake-up owns the timing, so an early one stands down rather than
  // pulling the retry's backoff forward.
  if (row.nextAttemptAt !== null && row.nextAttemptAt.getTime() > deps.now().getTime()) {
    log("capture.run stood down a wake-up ahead of the next attempt", {
      captureId,
      nextAttemptAt: row.nextAttemptAt.toISOString(),
    });
    return;
  }

  // From here to the record, a throw must not strand the row: the capture
  // queue carries no retry of its own (retryLimit 0), so a failure the
  // observation cannot express — a crashed browser under the fetch, a
  // database refusal mid-guard or mid-objection — marks the capture failed
  // for ops instead of leaving a row nothing will ever pick up again. The
  // sweeper cron reaps what a dead process still strands.
  let attempt: number;
  let observation: PageObservation;
  let outcome: CaptureOutcome;
  let failureReason: string | null;
  try {
    // The run-time guards: an allowlist entry or an objection may have
    // landed between the enqueue and the fetch, and both stop the fetch
    // exactly where the enqueue's guards would have.
    if ((await allowlistHitForUrl(deps.pool, row.requestedUrl)) !== null) {
      await markCaptureSkippedAtRun(deps.pool, captureId, "allowlist", deps.now);
      log("capture.run skipped an allowlisted URL without fetching", { captureId });
      return;
    }
    const objection = await activeObjectionForUrl(deps.pool, row.requestedUrl);
    if (objection !== null) {
      await markCaptureSkippedAtRun(deps.pool, captureId, "host_objection", deps.now);
      log("capture.run refused a host under objection without fetching", {
        captureId,
        hostObjectionId: objection.id,
      });
      return;
    }

    const claimed = await beginCaptureAttempt(deps.pool, captureId, deps.now);
    if (claimed === null) {
      return;
    }
    attempt = claimed;

    const host = hostForUrl(row.requestedUrl);
    observation = await deps.limiter.run(host, () => deps.fetchPage(row.requestedUrl));
    ({ outcome, failureReason } = classifyObservation(observation));

    // The host's individualized objection (ADR 0018): a blocked response
    // whose body names Patrol in a cease-and-desist suspends every further
    // capture of the host until an operator clears it. A bare 451 is a
    // block without an objection — the status alone does not say the host
    // is objecting to Patrol rather than to anyone else.
    if (
      outcome === "blocked" &&
      namesPatrolObjection(
        observation.rawBody === null ? null : decoder().decode(observation.rawBody),
      )
    ) {
      const objectionHost = observation.pageHost ?? host;
      const recorded = await recordHostObjection(deps.pool, deps.now, {
        host: objectionHost,
        source: "host_contact",
        reason: `The host's ${observation.httpStatus ?? ""} response named Patrol in a demand to stop capturing ${observation.finalUrl ?? row.requestedUrl}.`,
        affectedCandidateCount: await affectedSurfaceCount(deps.pool, objectionHost),
      });
      log("capture.run recorded a host objection", {
        host: recorded.host,
        hostObjectionId: recorded.id,
      });
    }
  } catch (error) {
    await markCaptureFailed(deps.pool, captureId, deps.now);
    log("capture.run failed mid-attempt; capture marked failed", {
      captureId,
      err: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  const artifacts = assembleArtifacts(
    observation,
    outcome,
    deps.profile.viewportWidth,
  );

  // Bytes first, record second: every artifact lands content-addressed,
  // an unchanged one skips its upload (the HEAD dedup), and the version
  // each write observed is what the artifact row pins.
  let stored: Array<{ artifact: AssembledArtifact; sha256: string; objectVersion: string | null }>;
  try {
    stored = [];
    for (const artifact of artifacts) {
      const sha256 = sha256Hex(artifact.bytes);
      const result = await deps.store.putArtifact({
        kind: artifact.kind,
        sha256,
        bytes: artifact.bytes,
        contentType: artifact.contentType,
      });
      stored.push({ artifact, sha256, objectVersion: result.objectVersion });
    }
  } catch (error) {
    await markCaptureFailed(deps.pool, captureId, deps.now);
    log("capture.run failed storing artifacts; capture marked failed", {
      captureId,
      err: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  const maxAttempts = deps.maxAttempts ?? MAX_CAPTURE_ATTEMPTS;
  const delays = deps.retryDelaysMs ?? CAPTURE_RETRY_DELAYS_MS;
  const terminal = outcomeIsTerminal(outcome) || attempt >= maxAttempts;
  const delay = retryDelayMs(attempt, delays);
  const nextAttemptAt =
    terminal || delay === null ? undefined : new Date(deps.now().getTime() + delay);

  try {
    await appendEvidence(
      deps.pool,
      deps.now,
      {
        captureId,
        requestedUrl: row.requestedUrl,
        normalizedUrl: row.normalizedUrl,
        redirectChain: observation.redirectChain,
        finalUrl: observation.finalUrl,
        httpStatus: observation.httpStatus,
        host: observation.pageHost,
        hostSource: observation.pageHost === null ? null : "landing_page",
        reason: row.reason as CaptureReason,
        outcome,
        failureReason,
        attemptNumber: attempt,
        observedAt: deps.now(),
        profile: deps.profile,
        artifacts: stored.map(({ artifact, sha256, objectVersion }) => ({
          kind: artifact.kind,
          sha256,
          sizeBytes: artifact.bytes.byteLength,
          contentType: artifact.contentType,
          ...(artifact.width === undefined ? {} : { width: artifact.width }),
          ...(artifact.height === undefined ? {} : { height: artifact.height }),
          truncated: artifact.truncated,
          objectVersion,
        })),
      },
      { terminal, ...(nextAttemptAt === undefined ? {} : { nextAttemptAt }) },
    );
  } catch (error) {
    await markCaptureFailed(deps.pool, captureId, deps.now);
    log("capture.run failed appending the evidence record; capture marked failed", {
      captureId,
      err: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  if (terminal) {
    // The score lifecycle (docs/design/matching-and-classification-rules.md
    // "Score and bands"): a captured page's extraction sidecar deepens the
    // pending candidates of the URL — the exact page-title match, the
    // signals the page's facts fire, reputation alongside a strong signal.
    // The evidence record already stands, so a rescore failure is logged
    // and never fails the capture; the next capture of the URL catches up.
    if (outcome === "captured" && observation.sidecar !== null) {
      try {
        const rescored = await rescoreCandidatesFromSidecar(deps.pool, deps.now, {
          normalizedUrl: row.normalizedUrl,
          sidecar: observation.sidecar,
        });
        if (rescored.length > 0) {
          log("capture.run deepened candidate scores from the sidecar", {
            captureId,
            candidates: rescored.length,
          });
        }
      } catch (error) {
        log("capture.run failed rescoring candidates from the sidecar", {
          captureId,
          err: error instanceof Error ? error.message : String(error),
        });
      }
    }
    log("capture.run finished a capture", {
      captureId,
      outcome,
      attempt,
      artifacts: stored.length,
    });
    return;
  }
  if (delay !== null) {
    try {
      await deps.scheduleRetry(captureId, delay);
    } catch (error) {
      // The attempt is recorded and the row is pending with its next
      // attempt's time: a lost wake-up makes the retry late, never lost —
      // the sweeper re-dispatches once the time comes due.
      log("capture.run failed scheduling the retry; the sweeper will re-dispatch it", {
        captureId,
        delayMs: delay,
        err: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    log("capture.run scheduled a retry", { captureId, outcome, attempt, delayMs: delay });
  }
}

let textDecoder: TextDecoder | null = null;
function decoder(): TextDecoder {
  textDecoder ??= new TextDecoder();
  return textDecoder;
}
