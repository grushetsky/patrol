import { ApiError, unprocessable } from "../errors.js";
import type { Connectable } from "../db/migrations.js";
import { pageOf, type Page } from "../http.js";
import { newId } from "../auth/tokens.js";
import { iso, parseArray } from "../catalogue/records.js";
import type { ArtifactStore } from "./store.js";

export interface HostObjectionFilters {
  host?: string;
  active?: boolean;
}

export interface LegalHoldInput {
  reason: string;
  evidenceIds: string[];
  violationIds: string[];
  noticeIds: string[];
}

/** Evidence metadata, artifact downloads, and host objections. */
export class EvidenceService {
  constructor(
    private readonly db: Connectable,
    private readonly store: ArtifactStore,
  ) {}

  async read(id: string) {
    const evidence = (
      await this.db.query("SELECT * FROM evidence WHERE id = $1", [id])
    ).rows[0];
    if (!evidence) {
      throw new ApiError(404, "not_found", "The capture does not exist.");
    }
    const artifacts = (
      await this.db.query(
        "SELECT * FROM evidence_artifact WHERE evidence_id = $1 ORDER BY kind ASC",
        [id],
      )
    ).rows;
    return {
      evidence: toEvidence(evidence, artifacts),
      artifacts: artifacts.map(toArtifactSummary),
      downloadAvailable:
        (evidence.purged_at === null || evidence.purged_at === undefined) &&
        artifacts.length > 0,
    };
  }

  async download(id: string, sha256: string) {
    const evidence = (
      await this.db.query(
        "SELECT id, purged_at FROM evidence WHERE id = $1",
        [id],
      )
    ).rows[0];
    if (!evidence) {
      throw new ApiError(404, "not_found", "The capture does not exist.");
    }
    if (evidence.purged_at !== null && evidence.purged_at !== undefined) {
      throw new ApiError(
        410,
        "bytes_purged",
        "The artifact bytes were purged under retention.",
      );
    }
    const artifact = (
      await this.db.query(
        "SELECT * FROM evidence_artifact WHERE evidence_id = $1 AND sha256 = $2",
        [id, sha256],
      )
    ).rows[0];
    if (!artifact) {
      throw new ApiError(404, "not_found", "The artifact does not exist.");
    }
    const signed = await this.store.signedUrl(
      String(artifact.object_key),
      (artifact.object_version as string | null) ?? null,
    );
    return {
      url: signed.url,
      expiresAt: signed.expiresAt,
      sha256,
      contentType: String(artifact.content_type),
    };
  }

  async listObjections(filters: HostObjectionFilters, page: Page) {
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (filters.host) {
      values.push(filters.host);
      conditions.push(`host = $${values.length}`);
    }
    if (filters.active !== undefined) {
      conditions.push(
        filters.active ? "cleared_at IS NULL" : "cleared_at IS NOT NULL",
      );
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = (
      await this.db.query(
        `SELECT * FROM host_objection ${where} ORDER BY recorded_at DESC`,
        values,
      )
    ).rows;
    return pageOf(rows.map(toObjection), page);
  }

  async clearObjection(id: string, reason: string, operatorId: string) {
    const row = (
      await this.db.query("SELECT * FROM host_objection WHERE id = $1", [id])
    ).rows[0];
    if (!row) {
      throw new ApiError(404, "not_found", "The host objection does not exist.");
    }
    if (row.cleared_at) {
      throw new ApiError(
        409,
        "state_conflict",
        "The objection is already cleared.",
        undefined,
        { currentState: "cleared" },
      );
    }
    const trimmed = reason.trim();
    if (trimmed.length === 0) {
      throw unprocessable([
        { path: "/reason", message: "A clearance reason is required." },
      ]);
    }
    await this.db.query(
      `UPDATE host_objection
          SET cleared_at = $2, cleared_by = $3, clearance_reason = $4
        WHERE id = $1 AND cleared_at IS NULL`,
      [id, new Date(), operatorId, trimmed],
    );
    const updated = (
      await this.db.query("SELECT * FROM host_objection WHERE id = $1", [id])
    ).rows[0];
    return toObjection(updated);
  }

  async listHolds(page: Page) {
    const rows = (
      await this.db.query(
        "SELECT * FROM legal_hold ORDER BY created_at DESC",
      )
    ).rows;
    return pageOf(rows.map(toLegalHold), page);
  }

  async createHold(input: LegalHoldInput, operatorId: string) {
    const reason = input.reason.trim();
    if (reason.length === 0) {
      throw unprocessable([
        { path: "/reason", message: "A hold reason is required." },
      ]);
    }
    const evidenceIds = input.evidenceIds ?? [];
    const violationIds = input.violationIds ?? [];
    const noticeIds = input.noticeIds ?? [];
    if (
      evidenceIds.length === 0 &&
      violationIds.length === 0 &&
      noticeIds.length === 0
    ) {
      throw unprocessable([
        {
          path: "/evidenceIds",
          message: "A hold must cover at least one capture, violation, or notice.",
        },
      ]);
    }
    const id = newId();
    const now = new Date();
    await this.db.query(
      `INSERT INTO legal_hold
        (id, reason, created_by, created_at, evidence_ids, violation_ids,
         notice_ids, released_at, released_by, release_reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, NULL, NULL)`,
      [
        id,
        reason,
        operatorId,
        now,
        JSON.stringify(evidenceIds),
        JSON.stringify(violationIds),
        JSON.stringify(noticeIds),
      ],
    );
    const row = (
      await this.db.query("SELECT * FROM legal_hold WHERE id = $1", [id])
    ).rows[0];
    return toLegalHold(row);
  }

  async releaseHold(id: string, reason: string, operatorId: string) {
    const row = (
      await this.db.query("SELECT * FROM legal_hold WHERE id = $1", [id])
    ).rows[0];
    if (!row) {
      throw new ApiError(404, "not_found", "The legal hold does not exist.");
    }
    if (row.released_at) {
      throw new ApiError(
        409,
        "state_conflict",
        "The legal hold is already released.",
        undefined,
        { currentState: "released" },
      );
    }
    const trimmed = reason.trim();
    if (trimmed.length === 0) {
      throw unprocessable([
        { path: "/reason", message: "A release reason is required." },
      ]);
    }
    await this.db.query(
      `UPDATE legal_hold
          SET released_at = $2, released_by = $3, release_reason = $4
        WHERE id = $1 AND released_at IS NULL`,
      [id, new Date(), operatorId, trimmed],
    );
    const updated = (
      await this.db.query("SELECT * FROM legal_hold WHERE id = $1", [id])
    ).rows[0];
    return toLegalHold(updated);
  }
}

function toEvidence(
  row: Record<string, unknown>,
  artifacts: Array<Record<string, unknown>>,
) {
  return {
    id: String(row.id),
    requestedUrl: String(row.requested_url),
    normalizedRequestedUrl: String(row.normalized_requested_url),
    redirectChain: JSON.parse(String(row.redirect_chain)),
    finalUrl: (row.final_url as string | null) ?? undefined,
    host: (row.host as string | null) ?? undefined,
    hostSource: (row.host_source as string | null) ?? undefined,
    reason: String(row.reason),
    outcome: String(row.outcome),
    httpStatus:
      row.http_status === null || row.http_status === undefined
        ? undefined
        : Number(row.http_status),
    failureReason: (row.failure_reason as string | null) ?? undefined,
    attemptNumber: Number(row.attempt_number),
    observedAt: iso(row.observed_at),
    profile: JSON.parse(String(row.profile)),
    artifacts: artifacts.map(toArtifactSummary),
    purgedAt: (row.purged_at as string | null) ?? undefined,
    purgeReason: (row.purge_reason as string | null) ?? undefined,
  };
}

function toArtifactSummary(row: Record<string, unknown>) {
  return {
    kind: String(row.kind),
    sha256: String(row.sha256),
    byteSize: Number(row.byte_size),
    contentType: String(row.content_type),
    width:
      row.width === null || row.width === undefined
        ? undefined
        : Number(row.width),
    height:
      row.height === null || row.height === undefined
        ? undefined
        : Number(row.height),
    truncated: Boolean(row.truncated),
  };
}

function toObjection(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    host: String(row.host),
    registrableDomain: String(row.registrable_domain),
    reason: String(row.reason),
    source: String(row.source),
    recordedAt: iso(row.recorded_at),
    recordedBy: (row.recorded_by as string | null) ?? undefined,
    affectedCandidateCount: Number(row.affected_candidate_count),
    clearedAt:
      row.cleared_at === null || row.cleared_at === undefined
        ? undefined
        : iso(row.cleared_at),
    clearedBy: (row.cleared_by as string | null) ?? undefined,
    clearanceReason: (row.clearance_reason as string | null) ?? undefined,
  };
}

function toLegalHold(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    reason: String(row.reason),
    createdBy: String(row.created_by),
    createdAt: iso(row.created_at),
    evidenceIds: parseArray(row.evidence_ids),
    violationIds: parseArray(row.violation_ids),
    noticeIds: parseArray(row.notice_ids),
    ...(row.released_at
      ? { releasedAt: iso(row.released_at), releasedBy: String(row.released_by) }
      : {}),
  };
}
