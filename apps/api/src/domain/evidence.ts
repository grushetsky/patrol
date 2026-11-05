import type { Pool } from "pg";
import type {
  EvidenceArtifactRow,
  EvidenceRow,
  EvidenceStore,
  HostObjectionRow,
} from "@patrol/evidence";
import {
  clearHostObjection as clearObjection,
  listHostObjections as listObjections,
  readEvidence,
} from "@patrol/evidence";
import { ApiError } from "../errors.js";
import { pageParams } from "../routes/support.js";

/**
 * The EvidenceAccess and HostObjections interfaces' domain (Patrol.Http):
 * one capture with its artifact manifest, a signed content-pinned download
 * reference, the objection list with its filters, and the clearance that
 * reopens a host. No operation mutates a capture — the contract exposes
 * none, and the record's immutability is the point.
 */

/** The presigning half of the store is all the API needs. */
export type EvidencePresigner = Pick<EvidenceStore, "presignDownload">;

/** The contract's EvidenceArtifact shape (ArtifactSummary plus nothing). */
function artifactJson(artifact: EvidenceArtifactRow): Record<string, unknown> {
  return {
    kind: artifact.kind,
    sha256: artifact.sha256,
    contentType: artifact.contentType,
    byteSize: artifact.sizeBytes,
    ...(artifact.width === null ? {} : { width: artifact.width }),
    ...(artifact.height === null ? {} : { height: artifact.height }),
    truncated: artifact.truncated,
  };
}

/** The contract's Evidence shape. */
export function evidenceJson(evidence: EvidenceRow): Record<string, unknown> {
  return {
    id: evidence.id,
    requestedUrl: evidence.requestedUrl,
    normalizedRequestedUrl: evidence.normalizedUrl,
    redirectChain: evidence.redirectChain,
    ...(evidence.finalUrl === null ? {} : { finalUrl: evidence.finalUrl }),
    ...(evidence.host === null ? {} : { host: evidence.host }),
    ...(evidence.hostSource === null ? {} : { hostSource: evidence.hostSource }),
    reason: evidence.reason,
    outcome: evidence.outcome,
    ...(evidence.httpStatus === null ? {} : { httpStatus: evidence.httpStatus }),
    ...(evidence.failureReason === null ? {} : { failureReason: evidence.failureReason }),
    attemptNumber: evidence.attemptNumber,
    observedAt: evidence.observedAt.toISOString(),
    profile: evidence.profile,
    artifacts: [],
    ...(evidence.purgedAt === null ? {} : { purgedAt: evidence.purgedAt.toISOString() }),
    ...(evidence.purgeReason === null ? {} : { purgeReason: evidence.purgeReason }),
  };
}

/** The contract's HostObjection shape. */
export function hostObjectionJson(row: HostObjectionRow): Record<string, unknown> {
  return {
    id: row.id,
    host: row.host,
    registrableDomain: row.registrableDomain,
    reason: row.reason,
    source: row.source,
    recordedAt: row.recordedAt.toISOString(),
    ...(row.recordedBy === null ? {} : { recordedBy: row.recordedBy }),
    affectedCandidateCount: row.affectedCandidateCount,
    ...(row.clearedAt === null ? {} : { clearedAt: row.clearedAt.toISOString() }),
    ...(row.clearedBy === null ? {} : { clearedBy: row.clearedBy }),
    ...(row.clearanceReason === null ? {} : { clearanceReason: row.clearanceReason }),
  };
}

/**
 * GET /evidence/{id}: the capture's metadata and artifact manifest, with
 * whether the bytes still survive retention. Purged bytes are not a
 * failure of the read — the record survives and says what it contained.
 */
export async function readEvidenceDetail(
  pool: Pool,
  evidenceId: string,
): Promise<Record<string, unknown> | null> {
  const record = await readEvidence(pool, evidenceId);
  if (record === null) {
    return null;
  }
  return {
    evidence: {
      ...evidenceJson(record.evidence),
      artifacts: record.artifacts.map(artifactJson),
    },
    artifacts: record.artifacts.map(artifactJson),
    downloadAvailable: record.evidence.purgedAt === null && record.artifacts.length > 0,
  };
}

/**
 * GET /evidence/{id}/artifacts/{sha256}/download: a short-lived signed
 * reference pinned to the content hash (the contract's ArtifactDownloadRef).
 * Purged bytes answer 410 bytes_purged while the metadata survives.
 */
export async function artifactDownloadRef(
  deps: {
    pool: Pool;
    presigner: EvidencePresigner;
    now: () => Date;
    ttlSeconds: number;
  },
  evidenceId: string,
  sha256: string,
): Promise<Record<string, unknown>> {
  const record = await readEvidence(deps.pool, evidenceId);
  if (record === null) {
    throw new ApiError(404, "not_found");
  }
  const artifact = record.artifacts.find((row) => row.sha256 === sha256);
  if (artifact === undefined) {
    throw new ApiError(404, "not_found");
  }
  if (record.evidence.purgedAt !== null) {
    throw new ApiError(410, "bytes_purged");
  }
  const reference = await deps.presigner.presignDownload({
    kind: artifact.kind,
    sha256: artifact.sha256,
    contentType: artifact.contentType,
    ...(artifact.objectVersion === null ? {} : { objectVersion: artifact.objectVersion }),
    expiresInSeconds: deps.ttlSeconds,
  });
  return {
    url: reference.url,
    expiresAt: reference.expiresAt.toISOString(),
    sha256: artifact.sha256,
    contentType: artifact.contentType,
  };
}

/** GET /host-objections: every recorded objection, filtered by host or active state. */
export async function listObjectionsPage(
  pool: Pool,
  query: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { page, pageSize, limit, offset } = pageParams(query);
  const host = typeof query.host === "string" && query.host !== "" ? query.host : undefined;
  const active =
    query.active === undefined || query.active === ""
      ? undefined
      : query.active === "true";
  const { rows, total } = await listObjections(pool, { host, active }, { limit, offset });
  return {
    items: rows.map(hostObjectionJson),
    total,
    page,
    pageSize,
  };
}

/**
 * POST /host-objections/{id}/clearance: an operator's explicit decision to
 * reopen a host to capture. The clearance reason is required (the contract
 * validates it), the objection is never deleted, and clearing an already
 * cleared objection is a state conflict, not a second clearance.
 */
export async function clearObjectionRoute(
  deps: { pool: Pool; now: () => Date },
  actorId: string,
  hostObjectionId: string,
  reason: string,
): Promise<Record<string, unknown>> {
  const result = await clearObjection(deps.pool, deps.now, {
    hostObjectionId,
    operatorId: actorId,
    reason,
  });
  if (result.status === "absent") {
    throw new ApiError(404, "not_found");
  }
  if (result.status === "already_cleared") {
    throw new ApiError(409, "state_conflict");
  }
  return hostObjectionJson(result.row);
}
