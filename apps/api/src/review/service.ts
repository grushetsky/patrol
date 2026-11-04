import {
  bandFor,
  isShortener,
  normalizeUrl,
  parseSidecar,
  registrableDomainOf,
  scoreCandidate,
} from "@patrol/matching";
import type { Connectable, Queryable } from "../db/migrations.js";
import { ApiError, unprocessable } from "../errors.js";
import { newId } from "../auth/tokens.js";
import { pageOf, type Page } from "../http.js";
import { iso, toAllowlistEntry } from "../catalogue/records.js";
import {
  toCandidate,
  toEvidenceSummary,
  toReviewDecision,
  toReviewRow,
} from "./records.js";

export interface CandidateFilters {
  state?: string;
  titleGroupId?: string;
  engine?: string;
  band?: string;
  allowlistHit?: boolean;
  hostObjectionId?: string;
}

export interface ManualCandidateInput {
  url: string;
  trackedTitleId: string;
}

export interface ReviewDecisionInput {
  action: string;
  note?: string;
  evidenceIds: string[];
  rematchedTrackedTitleId?: string;
  allowlistEntry?: {
    kind: string;
    matchKind: string;
    value: string;
    scope: string;
    titleGroupId?: string;
    trackedTitleId?: string;
    territory?: string;
  };
}

interface CandidateRow extends Record<string, unknown> {
  id: string;
  tracked_title_id: string;
  state: string;
}

/** Candidate formation, the review queue, dispositions, and reopening. */
export class CandidateService {
  constructor(
    private readonly db: Connectable,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async list(filters: CandidateFilters, page: Page) {
    const conditions: string[] = [];
    const values: unknown[] = [];
    const filter = (column: string, value: string | undefined) => {
      if (value !== undefined) {
        values.push(value);
        conditions.push(`${column} = $${values.length}`);
      }
    };
    filter("c.state", filters.state);
    filter("t.title_group_id", filters.titleGroupId);
    filter("c.engine", filters.engine);
    if (filters.allowlistHit === true) {
      conditions.push("c.allowlist_entry_id IS NOT NULL");
    } else if (filters.allowlistHit === false) {
      conditions.push("c.allowlist_entry_id IS NULL");
    }
    if (filters.hostObjectionId !== undefined) {
      values.push(filters.hostObjectionId);
      conditions.push(
        `EXISTS (SELECT 1 FROM host_objection o
                  WHERE o.id = $${values.length} AND o.host = c.host)`,
      );
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = (
      await this.db.query(
        `SELECT c.*, t.release_year, t.title_type, t.original_variant_id,
                v.text AS display_title
           FROM candidate c
           JOIN tracked_title t ON t.id = c.tracked_title_id
           LEFT JOIN title_variant v ON v.id = t.original_variant_id
           ${where}
          ORDER BY c.score DESC NULLS LAST, c.rank ASC NULLS LAST,
                   c.last_observed_at DESC`,
        values,
      )
    ).rows;

    const items = [];
    for (const row of rows) {
      const score = Number(row.score ?? 0);
      const band =
        row.allowlist_entry_id || isShortener(String(row.host ?? ""))
          ? "c"
          : bandFor(score);
      if (filters.band !== undefined && filters.band !== band) {
        continue;
      }
      items.push(await this.toRow(row));
    }
    return pageOf(items, page);
  }

  async create(input: ManualCandidateInput, operatorId: string) {
    let parsed: URL;
    try {
      parsed = new URL(input.url);
    } catch {
      throw unprocessable([
        { path: "/url", message: "An absolute HTTP or HTTPS URL is required." },
      ]);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw unprocessable([
        { path: "/url", message: "Only HTTP and HTTPS URLs are supported." },
      ]);
    }
    const title = (
      await this.db.query("SELECT * FROM tracked_title WHERE id = $1", [
        input.trackedTitleId,
      ])
    ).rows[0];
    if (!title || title.merged_into_title_id) {
      throw unprocessable([
        { path: "/trackedTitleId", message: "No such tracked title." },
      ]);
    }
    const variant = await this.originalVariant(title);
    const normalized = normalizeUrl(input.url);
    const existing = (
      await this.db.query(
        "SELECT * FROM candidate WHERE normalized_url = $1 AND tracked_title_id = $2",
        [normalized, input.trackedTitleId],
      )
    ).rows[0];
    if (existing) {
      return { candidate: await this.serialize(existing), created: false };
    }

    const now = this.clock();
    const host = parsed.hostname.toLowerCase();
    const domain = registrableDomainOf(input.url);
    const reputation = await this.reputation(domain, now);
    const facts = parseSidecar({
      title: "",
      h1: [],
      meta: {},
      jsonLd: [],
      iframes: [],
      videos: [],
      downloadAffordances: [],
    });
    const scored = scoreCandidate(facts, {
      variantText: variant.text,
      variantLanguage: variant.language,
      url: input.url,
      reputation,
      shortener: isShortener(host),
    });
    const allowlist = await this.allowlistHit(
      input.url,
      host,
      String(title.title_group_id),
      input.trackedTitleId,
    );
    const objection = await this.objection(host);
    const id = newId();
    try {
      await this.db.query(
        `INSERT INTO candidate
          (id, tracked_title_id, state, url, normalized_url, host,
           registrable_domain, source, matched_variant_id, matched_variant,
           score, score_components, reputation, allowlist_entry_id,
           first_observed_at, last_observed_at, created_by, created_at)
         VALUES ($1, $2, 'pending', $3, $4, $5, $6, 'manual', $7, $8, $9,
                 $10, $11, $12, $13, $13, $14, $13)`,
        [
          id,
          input.trackedTitleId,
          input.url,
          normalized,
          host,
          domain,
          variant.id,
          JSON.stringify(variant),
          scored.score,
          JSON.stringify({
            titleMatch: scored.titleMatch,
            signals: scored.signals,
            reputation: scored.reputation,
          }),
          JSON.stringify({
            registrableDomain: domain,
            confirmedViolations: reputation.confirmedViolations,
            bonus: reputationBonus(reputation.confirmedViolations),
            blocklisted: reputation.blocklisted,
          }),
          allowlist?.id ?? null,
          now,
          operatorId,
        ],
      );
    } catch {
      const raced = (
        await this.db.query(
          "SELECT * FROM candidate WHERE normalized_url = $1 AND tracked_title_id = $2",
          [normalized, input.trackedTitleId],
        )
      ).rows[0];
      if (!raced) {
        throw new Error("The candidate could not be recorded.");
      }
      return { candidate: await this.serialize(raced), created: false };
    }
    if (!allowlist && !objection) {
      await this.queueCapture(
        input.url,
        normalized,
        "detection",
        id,
        undefined,
        input.trackedTitleId,
        String(title.title_group_id),
        now,
      );
    }
    const created = (
      await this.db.query("SELECT * FROM candidate WHERE id = $1", [id])
    ).rows[0];
    return { candidate: await this.serialize(created), created: true };
  }

  async read(id: string) {
    const row = await this.load(id);
    const observations = (
      await this.db.query(
        "SELECT * FROM search_result WHERE candidate_id = $1 ORDER BY observed_at DESC",
        [id],
      )
    ).rows.map((observation) => ({
      id: String(observation.id),
      scanId: String(observation.scan_id),
      queryId: String(observation.query_id),
      engine: String(observation.engine),
      url: String(observation.url),
      normalizedUrl: String(observation.normalized_url),
      rank: Number(observation.rank),
      title: String(observation.title),
      snippet: String(observation.snippet),
      locale: String(observation.locale),
      territory: (observation.territory as string | null) ?? undefined,
      observedAt: iso(observation.observed_at),
      rawPayloadRef: String(observation.raw_payload_ref),
      host: String(observation.host),
      registrableDomain: String(observation.registrable_domain),
      candidateId: String(observation.candidate_id),
    }));
    const evidence = await this.evidenceFor(String(row.normalized_url));
    const decisions = (
      await this.db.query(
        "SELECT * FROM review_decision WHERE candidate_id = $1 ORDER BY decided_at DESC",
        [id],
      )
    ).rows.map(toReviewDecision);
    const allowlistEntry = row.allowlist_entry_id
      ? (
          await this.db.query("SELECT * FROM allowlist_entry WHERE id = $1", [
            row.allowlist_entry_id,
          ])
        ).rows[0]
      : undefined;
    return {
      candidate: await this.serialize(row),
      displayTitle: String(row.display_title ?? ""),
      releaseYear: Number(row.release_year),
      titleType: String(row.title_type),
      observations,
      evidence,
      decisions,
      ...(allowlistEntry
        ? { allowlistEntry: toAllowlistEntry(allowlistEntry) }
        : {}),
    };
  }

  async decide(id: string, input: ReviewDecisionInput, operatorId: string) {
    const candidate = await this.load(id);
    if (candidate.state !== "pending") {
      throw new ApiError(
        409,
        "state_conflict",
        "The candidate is not awaiting review.",
        undefined,
        { currentState: String(candidate.state) },
      );
    }
    if (!Array.isArray(input.evidenceIds) || input.evidenceIds.length === 0) {
      throw unprocessable([
        { path: "/evidenceIds", message: "At least one capture is required." },
      ]);
    }
    const evidence = await this.loadEvidence(input.evidenceIds);
    if (evidence.length !== new Set(input.evidenceIds).size) {
      throw unprocessable([
        {
          path: "/evidenceIds",
          message: "Every cited capture must exist.",
        },
      ]);
    }
    if (
      evidence.some(
        (row) =>
          String(row.normalized_requested_url) !== String(candidate.normalized_url),
      )
    ) {
      throw unprocessable([
        {
          path: "/evidenceIds",
          message: "The cited captures must be of the candidate's URL.",
        },
      ]);
    }
    if (
      input.action === "wrong_work" &&
      !input.rematchedTrackedTitleId
    ) {
      throw unprocessable([
        {
          path: "/rematchedTrackedTitleId",
          message: "A wrong-work decision needs the correct tracked title.",
        },
      ]);
    }
    if (input.action === "authorized_here" && !input.allowlistEntry) {
      throw unprocessable([
        {
          path: "/allowlistEntry",
          message: "An authorized-here decision needs an allowlist entry.",
        },
      ]);
    }
    const allowlist = await this.allowlistHit(
      String(candidate.url),
      String(candidate.host),
      String(candidate.title_group_id ?? ""),
      String(candidate.tracked_title_id),
    );
    if (input.action === "violation" && allowlist) {
      throw new ApiError(
        422,
        "allowlist_hit",
        "An allowlisted URL cannot be confirmed as a violation.",
      );
    }
    const now = this.clock();
    const decisionId = newId();
    const note = input.note?.trim();
    const dismissal =
      input.action === "violation"
        ? undefined
        : {
            action: input.action,
            operatorId,
            decidedAt: now.toISOString(),
            ...(note ? { note } : {}),
            evidenceIds: input.evidenceIds,
            ...(input.rematchedTrackedTitleId
              ? { rematchedTrackedTitleId: input.rematchedTrackedTitleId }
              : {}),
          };

    return this.withClient(async (db) => {
      let violation: Record<string, unknown> | undefined;
      let allowlistEntry: Record<string, unknown> | undefined;
      if (input.action === "violation") {
        const newest = evidence[0];
        const host = String(newest?.host ?? candidate.host ?? "");
        const hostSource = newest?.host ? "landing_page" : "submitted_url";
        const open = (
          await db.query(
            "SELECT id FROM violation WHERE normalized_url = $1 AND tracked_title_id = $2 AND state = 'open'",
            [candidate.normalized_url, candidate.tracked_title_id],
          )
        ).rows[0];
        if (open) {
          throw new ApiError(
            409,
            "state_conflict",
            "An open violation already exists for this URL and title.",
            undefined,
            { currentState: "open" },
          );
        }
        const violationId = newId();
        const predecessor = (
          await db.query(
            `SELECT id FROM violation
              WHERE normalized_url = $1 AND tracked_title_id = $2
                AND state IN ('removed', 'closed')
              ORDER BY closed_at DESC LIMIT 1`,
            [candidate.normalized_url, candidate.tracked_title_id],
          )
        ).rows[0];
        try {
          await db.query(
            `INSERT INTO violation
              (id, tracked_title_id, state, candidate_id, review_decision_id,
               url, normalized_url, host, host_source, registrable_domain,
               detected_at, confirmed_at, confirmed_by, engine, title_group_id,
               predecessor_violation_id)
             VALUES ($1, $2, 'open', $3, $4, $5, $6, $7, $8, $9, $10, $11,
                     $12, $13, $14, $15)`,
            [
              violationId,
              candidate.tracked_title_id,
              candidate.id,
              decisionId,
              candidate.url,
              candidate.normalized_url,
              host,
              hostSource,
              candidate.registrable_domain,
              candidate.first_observed_at,
              now,
              operatorId,
              candidate.engine ?? null,
              candidate.title_group_id ?? null,
              predecessor ? String(predecessor.id) : null,
            ],
          );
        } catch (error) {
          if (
            /violation_open_pair_key|duplicate key/i.test(String(error))
          ) {
            throw new ApiError(
              409,
              "state_conflict",
              "An open violation already exists for this URL and title.",
              undefined,
              { currentState: "open" },
            );
          }
          throw error;
        }
        for (const cited of evidence) {
          await db.query(
            `INSERT INTO violation_evidence
              (violation_id, evidence_id, role, cited_at)
             VALUES ($1, $2, $3, $4)`,
            [violationId, cited.id, cited.reason, now],
          );
        }
        await this.startLadder(
          db,
          String(candidate.title_group_id ?? ""),
          String(candidate.engine ?? ""),
          now,
        );
        violation = (
          await db.query("SELECT * FROM violation WHERE id = $1", [violationId])
        ).rows[0];
      } else if (input.action === "authorized_here") {
        allowlistEntry = await this.createAllowlistFromDecision(
          db,
          decisionId,
          candidate,
          input,
          operatorId,
          now,
        );
      } else if (input.action === "wrong_work") {
        await this.rematch(
          db,
          candidate,
          String(input.rematchedTrackedTitleId),
          operatorId,
          now,
        );
      }

      await db.query(
        `INSERT INTO review_decision
          (id, candidate_id, action, operator_id, decided_at, note,
           evidence_ids, violation_id, rematched_tracked_title_id,
           proposed_allowlist_entry_id, score_snapshot, signals_snapshot,
           episode_max, registrable_domain)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [
          decisionId,
          candidate.id,
          input.action,
          operatorId,
          now,
          note ?? null,
          JSON.stringify(input.evidenceIds),
          violation ? String(violation.id) : null,
          input.rematchedTrackedTitleId ?? null,
          allowlistEntry ? String(allowlistEntry.id) : null,
          candidate.score_components,
          JSON.stringify(signalKinds(candidate.score_components)),
          candidate.episode_max ?? null,
          candidate.registrable_domain,
        ],
      );

      if (input.action === "violation") {
        const confirmed = await db.query(
          `UPDATE candidate
              SET state = 'confirmed', review_decision_id = $2,
                  violation_id = $3, confirmed_at = $4
            WHERE id = $1 AND state = 'pending'`,
          [candidate.id, decisionId, String(violation!.id), now],
        );
        if ((confirmed.rowCount ?? 0) === 0) {
          throw new ApiError(
            409,
            "state_conflict",
            "The candidate was already decided.",
          );
        }
      } else {
        const dismissed = await db.query(
          `UPDATE candidate
              SET state = 'dismissed', review_decision_id = $2,
                  dismissal = $3, dismissal_signals = $4,
                  dismissal_episode_max = $5,
                  dismissal_registrable_domain = $6
            WHERE id = $1 AND state = 'pending'`,
          [
            candidate.id,
            decisionId,
            JSON.stringify({
              ...dismissal,
              ...(allowlistEntry
                ? { proposedAllowlistEntryId: String(allowlistEntry.id) }
                : {}),
            }),
            JSON.stringify(signalKinds(candidate.score_components)),
            candidate.episode_max ?? 0,
            candidate.registrable_domain,
          ],
        );
        if ((dismissed.rowCount ?? 0) === 0) {
          throw new ApiError(
            409,
            "state_conflict",
            "The candidate was already decided.",
          );
        }
      }

      const updated = (
        await db.query("SELECT * FROM candidate WHERE id = $1", [candidate.id])
      ).rows[0];
      const decision = (
        await db.query("SELECT * FROM review_decision WHERE id = $1", [
          decisionId,
        ])
      ).rows[0];
      return {
        decision: toReviewDecision(decision),
        candidate: await this.serialize(updated),
        ...(violation
          ? { violation: toViolationRecord(violation) }
          : {}),
        ...(allowlistEntry
          ? { allowlistEntry: toAllowlistEntry(allowlistEntry) }
          : {}),
      };
    });
  }

  async reopen(id: string, note: string | undefined, _operatorId: string) {
    const candidate = await this.load(id);
    if (candidate.state !== "dismissed") {
      throw new ApiError(
        409,
        "state_conflict",
        "Only a dismissed pair can be reopened.",
        undefined,
        { currentState: String(candidate.state) },
      );
    }
    await this.db.query(
      `UPDATE candidate
          SET state = 'pending', dismissal = NULL, dismissal_signals = NULL,
              dismissal_episode_max = NULL,
              dismissal_registrable_domain = NULL,
              review_decision_id = NULL, violation_id = NULL,
              confirmed_at = NULL
        WHERE id = $1`,
      [id],
    );
    const updated = await this.load(id);
    return this.serialize(updated, note);
  }

  async capture(id: string, reason: string) {
    const candidate = await this.load(id);
    const allowlist = await this.allowlistHit(
      String(candidate.url),
      String(candidate.host),
      String(candidate.title_group_id ?? ""),
      String(candidate.tracked_title_id),
    );
    if (allowlist) {
      await this.db.query(
        "UPDATE candidate SET allowlist_entry_id = $2 WHERE id = $1",
        [id, allowlist.id],
      );
      throw new ApiError(
        422,
        "allowlist_hit",
        "An allowlisted URL is never captured.",
      );
    }
    if (candidate.allowlist_entry_id) {
      await this.db.query(
        "UPDATE candidate SET allowlist_entry_id = NULL WHERE id = $1",
        [id],
      );
    }
    const objection = (
      await this.db.query(
        "SELECT id FROM host_objection WHERE host = $1 AND cleared_at IS NULL",
        [candidate.host],
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
    await this.queueCapture(
      String(candidate.url),
      String(candidate.normalized_url),
      reason,
      id,
      undefined,
      String(candidate.tracked_title_id),
      String(candidate.title_group_id ?? ""),
      now,
    );
    return { queuedAt: now.toISOString(), reason };
  }

  private async toRow(row: Record<string, unknown>) {
    const candidate = await this.serialize(row);
    const allowlistEntry = row.allowlist_entry_id
      ? (
          await this.db.query("SELECT * FROM allowlist_entry WHERE id = $1", [
            row.allowlist_entry_id,
          ])
        ).rows[0]
      : undefined;
    const prior = (
      await this.db.query(
        "SELECT * FROM review_decision WHERE candidate_id = $1 ORDER BY decided_at DESC LIMIT 1",
        [row.id],
      )
    ).rows[0];
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
    return toReviewRow(row, {
      candidate,
      allowlistEntry,
      prior,
      newest,
      thumbnail,
    });
  }

  private async serialize(
    row: Record<string, unknown>,
    _note?: string,
  ) {
    const prior = (
      await this.db.query(
        "SELECT id FROM review_decision WHERE candidate_id = $1 ORDER BY decided_at DESC",
        [row.id],
      )
    ).rows.map((decision) => String(decision.id));
    return toCandidate(row, prior);
  }

  private async load(id: string): Promise<CandidateRow> {
    const row = (
      await this.db.query(
        `SELECT c.*, t.release_year, t.title_type, t.title_group_id,
                v.text AS display_title
           FROM candidate c
           JOIN tracked_title t ON t.id = c.tracked_title_id
           LEFT JOIN title_variant v ON v.id = t.original_variant_id
          WHERE c.id = $1`,
        [id],
      )
    ).rows[0];
    if (!row) {
      throw new ApiError(404, "not_found", "The candidate does not exist.");
    }
    return row as CandidateRow;
  }

  private async originalVariant(title: Record<string, unknown>) {
    const row = (
      await this.db.query("SELECT * FROM title_variant WHERE id = $1", [
        title.original_variant_id,
      ])
    ).rows[0];
    if (!row) {
      throw unprocessable([
        {
          path: "/trackedTitleId",
          message: "The tracked title has no original variant.",
        },
      ]);
    }
    return {
      id: String(row.id),
      text: String(row.text),
      kind: String(row.kind),
      language: String(row.language),
      script: String(row.script),
      ...(row.territory ? { territory: String(row.territory) } : {}),
    };
  }

  private async loadEvidence(ids: string[]) {
    const rows = [];
    for (const evidenceId of new Set(ids)) {
      const row = (
        await this.db.query("SELECT * FROM evidence WHERE id = $1", [
          evidenceId,
        ])
      ).rows[0];
      if (row) {
        rows.push(row);
      }
    }
    return rows.sort(
      (left, right) =>
        new Date(String(right.observed_at)).getTime() -
        new Date(String(left.observed_at)).getTime(),
    );
  }

  private async evidenceFor(normalizedUrl: string) {
    const rows = (
      await this.db.query(
        "SELECT * FROM evidence WHERE normalized_requested_url = $1 ORDER BY observed_at DESC",
        [normalizedUrl],
      )
    ).rows;
    const summaries = [];
    for (const row of rows) {
      const thumbnail = (
        await this.db.query(
          "SELECT * FROM evidence_artifact WHERE evidence_id = $1 AND kind = 'thumbnail' LIMIT 1",
          [row.id],
        )
      ).rows[0];
      summaries.push(toEvidenceSummary(row, thumbnail));
    }
    return summaries;
  }

  private async allowlistHit(
    url: string,
    host: string,
    titleGroupId: string,
    trackedTitleId: string,
  ) {
    const rows = (
      await this.db.query(
        `SELECT * FROM allowlist_entry
          WHERE removed_at IS NULL
            AND (scope = 'rights_holder'
              OR (scope = 'title_group' AND title_group_id = $1)
              OR (scope = 'tracked_title' AND tracked_title_id = $2))`,
        [titleGroupId, trackedTitleId],
      )
    ).rows;
    return rows.find((row) => {
      const value = String(row.value).toLowerCase();
      return row.match_kind === "host"
        ? host === value || host.endsWith(`.${value}`)
        : url.startsWith(String(row.value));
    });
  }

  private async objection(host: string) {
    return (
      await this.db.query(
        "SELECT id FROM host_objection WHERE host = $1 AND cleared_at IS NULL LIMIT 1",
        [host],
      )
    ).rows[0];
  }

  private async reputation(
    registrableDomain: string,
    now: Date,
  ): Promise<{ confirmedViolations: number; blocklisted: boolean }> {
    const since = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
    const count = (
      await this.db.query(
        "SELECT COUNT(*)::int AS count FROM violation WHERE registrable_domain = $1 AND confirmed_at >= $2",
        [registrableDomain, since],
      )
    ).rows[0]?.count;
    const blocklisted = (
      await this.db.query("SELECT domain FROM blocklist WHERE domain = $1", [
        registrableDomain,
      ])
    ).rows[0];
    return {
      confirmedViolations: Number(count ?? 0),
      blocklisted: blocklisted !== undefined,
    };
  }

  private async queueCapture(
    url: string,
    normalized: string,
    reason: string,
    candidateId: string,
    violationId: string | undefined,
    trackedTitleId: string,
    titleGroupId: string,
    now: Date,
    db: Queryable = this.db,
  ) {
    await db.query(
      `INSERT INTO capture_request
        (id, url, normalized_url, reason, candidate_id, violation_id,
         tracked_title_id, title_group_id, state, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9)`,
      [
        newId(),
        url,
        normalized,
        reason,
        candidateId,
        violationId ?? null,
        trackedTitleId,
        titleGroupId || null,
        now,
      ],
    );
  }

  private async createAllowlistFromDecision(
    db: Queryable,
    decisionId: string,
    candidate: CandidateRow,
    input: ReviewDecisionInput,
    operatorId: string,
    now: Date,
  ) {
    const proposed = input.allowlistEntry!;
    const value = proposed.value.trim();
    if (value.length === 0) {
      throw unprocessable([
        { path: "/allowlistEntry/value", message: "A value is required." },
      ]);
    }
    const scope = proposed.scope;
    const titleGroupId =
      proposed.titleGroupId ??
      (scope === "title_group" ? String(candidate.title_group_id) : undefined);
    const trackedTitleId =
      proposed.trackedTitleId ??
      (scope === "tracked_title" ? String(candidate.tracked_title_id) : undefined);
    if (scope === "title_group" && !titleGroupId) {
      throw unprocessable([
        { path: "/allowlistEntry/titleGroupId", message: "A group is required." },
      ]);
    }
    if (scope === "tracked_title" && !trackedTitleId) {
      throw unprocessable([
        { path: "/allowlistEntry/trackedTitleId", message: "A title is required." },
      ]);
    }
    if (proposed.kind === "licensed_destination" && !proposed.territory) {
      throw unprocessable([
        { path: "/allowlistEntry/territory", message: "A territory is required." },
      ]);
    }
    const id = newId();
    await db.query(
      `INSERT INTO allowlist_entry
        (id, kind, match_kind, value, scope, title_group_id, tracked_title_id,
         territory, origin, proposed_by_decision_id, confirmed_by, confirmed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'review_decision', $9, $10, $11)`,
      [
        id,
        proposed.kind,
        proposed.matchKind,
        proposed.matchKind === "host" ? value.toLowerCase() : value,
        scope,
        titleGroupId ?? null,
        trackedTitleId ?? null,
        proposed.kind === "licensed_destination"
          ? proposed.territory
          : null,
        decisionId,
        operatorId,
        now,
      ],
    );
    return (
      await db.query("SELECT * FROM allowlist_entry WHERE id = $1", [id])
    ).rows[0];
  }

  private async rematch(
    db: Queryable,
    candidate: CandidateRow,
    rematchedTrackedTitleId: string,
    operatorId: string,
    now: Date,
  ) {
    const title = (
      await db.query("SELECT * FROM tracked_title WHERE id = $1", [
        rematchedTrackedTitleId,
      ])
    ).rows[0];
    if (!title || title.merged_into_title_id) {
      throw unprocessable([
        {
          path: "/rematchedTrackedTitleId",
          message: "No such tracked title.",
        },
      ]);
    }
    const existing = (
      await db.query(
        "SELECT id FROM candidate WHERE normalized_url = $1 AND tracked_title_id = $2",
        [candidate.normalized_url, rematchedTrackedTitleId],
      )
    ).rows[0];
    if (existing) {
      return;
    }
    const variant = await this.originalVariant(title);
    const id = newId();
    await db.query(
      `INSERT INTO candidate
        (id, tracked_title_id, state, url, normalized_url, host,
         registrable_domain, source, matched_variant_id, matched_variant,
         score, score_components, reputation, first_observed_at,
         last_observed_at, created_by, created_at)
       VALUES ($1, $2, 'pending', $3, $4, $5, $6, 'manual', $7, $8, 0,
               $9, $10, $11, $11, $12, $11)`,
      [
        id,
        rematchedTrackedTitleId,
        candidate.url,
        candidate.normalized_url,
        candidate.host,
        candidate.registrable_domain,
        variant.id,
        JSON.stringify(variant),
        JSON.stringify({ titleMatch: 0, signals: [], reputation: 0 }),
        JSON.stringify({
          registrableDomain: String(candidate.registrable_domain),
          confirmedViolations: 0,
          bonus: 0,
          blocklisted: false,
        }),
        now,
        operatorId,
      ],
    );
    await this.queueCapture(
      String(candidate.url),
      String(candidate.normalized_url),
      "detection",
      id,
      undefined,
      rematchedTrackedTitleId,
      String(title.title_group_id),
      now,
      db,
    );
  }

  private async startLadder(
    db: Queryable,
    titleGroupId: string,
    engine: string,
    now: Date,
  ) {
    if (!titleGroupId || !engine) {
      return;
    }
    const existing = (
      await db.query(
        "SELECT id FROM recheck_schedule WHERE title_group_id = $1 AND engine = $2",
        [titleGroupId, engine],
      )
    ).rows[0];
    const nextDueAt = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
    if (existing) {
      await db.query(
        `UPDATE recheck_schedule
            SET rung = 1, started_at = $3, next_due_at = $4, active = true,
                started_by_scan_id = NULL, updated_at = $3
          WHERE title_group_id = $1 AND engine = $2`,
        [titleGroupId, engine, now, nextDueAt],
      );
      return;
    }
    try {
      await db.query(
        `INSERT INTO recheck_schedule
          (id, title_group_id, engine, rung, started_at, next_due_at, active,
           started_by_scan_id, updated_at)
         VALUES ($1, $2, $3, 1, $4, $5, true, NULL, $4)`,
        [newId(), titleGroupId, engine, now, nextDueAt],
      );
    } catch (error) {
      if (!/recheck_schedule_pair_key|duplicate key/i.test(String(error))) {
        throw error;
      }
      await db.query(
        `UPDATE recheck_schedule
            SET rung = 1, started_at = $3, next_due_at = $4, active = true,
                started_by_scan_id = NULL, updated_at = $3
          WHERE title_group_id = $1 AND engine = $2`,
        [titleGroupId, engine, now, nextDueAt],
      );
    }
  }

  private async withClient<T>(fn: (db: Queryable) => Promise<T>): Promise<T> {
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

function reputationBonus(count: number): number {
  return count >= 10 ? 0.1 : count >= 3 ? 0.05 : count >= 1 ? 0.02 : 0;
}

function signalKinds(value: unknown): string[] {
  if (typeof value !== "string" || value.length === 0) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(value);
    const signals = Array.isArray(parsed)
      ? parsed
      : parsed !== null &&
          typeof parsed === "object" &&
          "signals" in parsed &&
          Array.isArray(parsed.signals)
        ? parsed.signals
        : [];
    return signals
      .map((signal) => {
        if (signal !== null && typeof signal === "object" && "kind" in signal) {
          return String(signal.kind);
        }
        return "";
      })
      .filter((kind) => kind !== "");
  } catch {
    return [];
  }
}

function toViolationRecord(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    trackedTitleId: String(row.tracked_title_id),
    candidateId: String(row.candidate_id),
    reviewDecisionId: String(row.review_decision_id),
    url: String(row.url),
    normalizedUrl: String(row.normalized_url),
    host: String(row.host),
    hostSource: String(row.host_source),
    registrableDomain: String(row.registrable_domain),
    detectedAt: iso(row.detected_at),
    confirmedAt: iso(row.confirmed_at),
    confirmedBy: String(row.confirmed_by),
    ...(row.predecessor_violation_id
      ? { predecessorViolationId: String(row.predecessor_violation_id) }
      : {}),
    lifecycle: { state: "open", openedAt: iso(row.confirmed_at) },
  };
}
