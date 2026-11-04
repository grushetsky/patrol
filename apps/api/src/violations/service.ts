import type { Connectable } from "../db/migrations.js";
import { ApiError, unprocessable } from "../errors.js";
import { newId } from "../auth/tokens.js";
import { pageOf, type Page } from "../http.js";
import { iso } from "../catalogue/records.js";
import {
  toEvidenceSummary,
  toReviewDecision,
  toViolation,
} from "../review/records.js";

export interface ViolationFilters {
  trackedTitleId?: string;
  state?: string;
  noticeId?: string;
}

export interface ViolationClosureInput {
  reason: string;
  note?: string;
  evidenceId?: string;
}

/** Violation reads, review captures, and terminal closure. */
export class ViolationService {
  constructor(
    private readonly db: Connectable,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async list(filters: ViolationFilters, page: Page) {
    if (filters.noticeId !== undefined) {
      return pageOf([], page);
    }
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (filters.trackedTitleId) {
      values.push(filters.trackedTitleId);
      conditions.push(`v.tracked_title_id = $${values.length}`);
    }
    if (filters.state) {
      values.push(filters.state);
      conditions.push(`v.state = $${values.length}`);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = (
      await this.db.query(
        `SELECT v.*, t.release_year, t.title_type, t.original_variant_id,
                d.text AS display_title
           FROM violation v
           JOIN tracked_title t ON t.id = v.tracked_title_id
           LEFT JOIN title_variant d ON d.id = t.original_variant_id
           ${where}
          ORDER BY v.confirmed_at DESC`,
        values,
      )
    ).rows;
    const items = [];
    for (const row of rows) {
      items.push(await this.toRow(row));
    }
    return pageOf(items, page);
  }

  async read(id: string) {
    const row = await this.load(id);
    const citations = (
      await this.db.query(
        `SELECT ve.role, ve.cited_at, ve.evidence_id, e.*
           FROM violation_evidence ve
           JOIN evidence e ON e.id = ve.evidence_id
          WHERE ve.violation_id = $1
          ORDER BY e.observed_at DESC`,
        [id],
      )
    ).rows;
    const evidence = [];
    for (const citation of citations) {
      const thumbnail = (
        await this.db.query(
          "SELECT * FROM evidence_artifact WHERE evidence_id = $1 AND kind = 'thumbnail' LIMIT 1",
          [citation.evidence_id],
        )
      ).rows[0];
      evidence.push({
        evidence: toEvidenceSummary(citation, thumbnail),
        role: String(citation.role),
        citedAt: iso(citation.cited_at),
      });
    }
    const decision = (
      await this.db.query("SELECT * FROM review_decision WHERE id = $1", [
        row.review_decision_id,
      ])
    ).rows[0];
    const newest = (
      await this.db.query(
        "SELECT * FROM evidence WHERE normalized_requested_url = $1 ORDER BY observed_at DESC LIMIT 1",
        [row.normalized_url],
      )
    ).rows[0];
    return {
      violation: toViolation(row),
      displayTitle: String(row.display_title ?? ""),
      releaseYear: Number(row.release_year),
      titleType: String(row.title_type),
      evidence,
      decision: decision ? toReviewDecision(decision) : undefined,
      ...(newest ? { newestCaptureOutcome: String(newest.outcome) } : {}),
    };
  }

  async capture(id: string, reason: string) {
    const row = await this.load(id);
    if (row.state !== "open") {
      throw new ApiError(
        409,
        "state_conflict",
        "Only an open violation can be captured.",
        undefined,
        { currentState: String(row.state) },
      );
    }
    const objection = (
      await this.db.query(
        "SELECT id FROM host_objection WHERE host = $1 AND cleared_at IS NULL",
        [row.host],
      )
    ).rows[0];
    if (objection) {
      throw new ApiError(
        409,
        "host_objection",
        "The host objects to capture.",
        undefined,
        { hostObjectionId: String(objection.id) },
      );
    }
    const now = this.clock();
    await this.db.query(
      `INSERT INTO capture_request
        (id, url, normalized_url, reason, violation_id, tracked_title_id,
         title_group_id, state, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8)`,
      [
        newId(),
        row.url,
        row.normalized_url,
        reason,
        id,
        row.tracked_title_id,
        row.title_group_id ?? null,
        now,
      ],
    );
    return { queuedAt: now.toISOString(), reason };
  }

  async close(id: string, input: ViolationClosureInput, operatorId: string) {
    const row = await this.load(id);
    if (row.state !== "open") {
      throw new ApiError(
        409,
        "state_conflict",
        "The violation is already closed.",
        undefined,
        { currentState: String(row.state) },
      );
    }
    const now = this.clock();
    if (input.reason === "url_removed") {
      if (input.evidenceId) {
        const evidence = (
          await this.db.query("SELECT * FROM evidence WHERE id = $1", [
            input.evidenceId,
          ])
        ).rows[0];
        if (
          !evidence ||
          String(evidence.normalized_requested_url) !== String(row.normalized_url)
        ) {
          throw unprocessable([
            {
              path: "/evidenceId",
              message: "The capture must be of the violation's URL.",
            },
          ]);
        }
      }
      await this.db.query(
        `UPDATE violation
            SET state = 'removed', closed_at = $2, closure_reason = 'url_removed',
                closure_evidence_id = $3, closed_by = $4, closure_note = $5
          WHERE id = $1`,
        [id, now, input.evidenceId ?? null, operatorId, input.note ?? null],
      );
    } else if (input.reason === "operator_closed") {
      if (!input.note || input.note.trim() === "") {
        throw new ApiError(
          422,
          "note_required",
          "Closing a violation requires a note.",
        );
      }
      await this.db.query(
        `UPDATE violation
            SET state = 'closed', closed_at = $2, closure_reason = 'operator_closed',
                closed_by = $3, closure_note = $4
          WHERE id = $1`,
        [id, now, operatorId, input.note.trim()],
      );
    } else {
      throw unprocessable([
        { path: "/reason", message: "Unknown closure reason." },
      ]);
    }
    await this.db.query(
      `UPDATE candidate
          SET state = 'pending', review_decision_id = NULL,
              violation_id = NULL, confirmed_at = NULL
        WHERE id = $1 AND state = 'confirmed'`,
      [row.candidate_id],
    );
    const updated = await this.load(id);
    return toViolation(updated);
  }

  private async toRow(row: Record<string, unknown>) {
    const newest = (
      await this.db.query(
        "SELECT * FROM evidence WHERE normalized_requested_url = $1 ORDER BY observed_at DESC LIMIT 1",
        [row.normalized_url],
      )
    ).rows[0];
    const thumbnail = newest
      ? (
          await this.db.query(
            "SELECT * FROM evidence_artifact WHERE evidence_id = $1 AND kind = 'thumbnail' LIMIT 1",
            [newest.id],
          )
        ).rows[0]
      : undefined;
    return {
      violation: toViolation(row),
      displayTitle: String(row.display_title ?? ""),
      releaseYear: Number(row.release_year),
      titleType: String(row.title_type),
      ...(newest
        ? { newestEvidence: toEvidenceSummary(newest, thumbnail) }
        : {}),
    };
  }

  private async load(id: string) {
    const row = (
      await this.db.query(
        `SELECT v.*, t.release_year, t.title_type, t.title_group_id,
                t.original_variant_id, d.text AS display_title
           FROM violation v
           JOIN tracked_title t ON t.id = v.tracked_title_id
           LEFT JOIN title_variant d ON d.id = t.original_variant_id
          WHERE v.id = $1`,
        [id],
      )
    ).rows[0];
    if (!row) {
      throw new ApiError(404, "not_found", "The violation does not exist.");
    }
    return row;
  }
}
