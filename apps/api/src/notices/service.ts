import { createHash } from "node:crypto";
import type { Connectable, Queryable } from "../db/migrations.js";
import { ApiError, unprocessable } from "../errors.js";
import { newId } from "../auth/tokens.js";
import { pageOf, type Page } from "../http.js";
import { iso, parseArray } from "../catalogue/records.js";
import type { ArtifactStore } from "../evidence/store.js";
import { toViolation } from "../review/records.js";
import {
  ensureTemplates,
  findTemplate,
  SYSTEM_OPERATOR_ID,
} from "./templates.js";
import {
  noticeStatus,
  parseObject,
  parseObjects,
  toNotice,
  toNoticeCard,
  toSubmission,
} from "./records.js";

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const YANDEX_ELIGIBLE_COUNTRIES: Record<string, true> = Object.fromEntries(
  [
    "US", "DE", "FR", "IT", "ES", "NL", "PL", "SE", "IE", "AT", "BE", "BG",
    "HR", "CY", "CZ", "DK", "EE", "FI", "GR", "HU", "LV", "LT", "LU", "MT",
    "PT", "RO", "SK", "SI", "CH",
  ].map((country) => [country, true]),
);
const RECIPIENT_SLUG: Record<string, string> = {
  google: "google-search",
  bing: "bing",
  yandex: "yandex",
};
export interface NoticeFilters {
  state?: string;
  recipient?: string;
}

export interface ComposeInput {
  recipient: string;
  recipientProfileId: string;
  violationIds: string[];
}

export interface ApprovalInput {
  statementVersion: string;
  attestation: {
    reviewedViolations: boolean;
    currentStatements: boolean;
    authorizedSignatory: boolean;
  };
}

export interface SupersessionInput {
  citedViolationIds: string[];
}

interface ResolvedViolation {
  violation: Record<string, unknown>;
  title: Record<string, unknown>;
  evidence: Array<Record<string, unknown>>;
}

/** Notice composition, approval, the frozen pack, withdrawal, and supersession. */
export class NoticeService {
  constructor(
    private readonly db: Connectable,
    private readonly store: ArtifactStore,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /** Compose drafts for every scheduled profile whose window has opened today. */
  async composeScheduled(now: Date = this.clock()): Promise<number> {
    await ensureTemplates(this.db, this.clock);
    const profiles = (
      await this.db.query(
        "SELECT * FROM recipient_profile WHERE composition_trigger = 'scheduled' AND paused = false",
      )
    ).rows;
    let composed = 0;
    for (const profile of profiles) {
      const key = `notice_window:${profile.id}`;
      const marker = (
        await this.db.query(
          "SELECT value FROM application_setting WHERE key = $1",
          [key],
        )
      ).rows[0];
      const today = now.toISOString().slice(0, 10);
      if (marker && String(marker.value) === today) {
        continue;
      }
      const window = String(profile.window_time ?? "07:00:00").split(":");
      const windowStart = new Date(
        Date.UTC(
          now.getUTCFullYear(),
          now.getUTCMonth(),
          now.getUTCDate(),
          Number(window[0] ?? 7),
          Number(window[1] ?? 0),
          0,
        ),
      );
      if (now < windowStart) {
        continue;
      }
      const since = marker?.value
        ? new Date(`${String(marker.value)}T00:00:00.000Z`)
        : new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const violations = (
        await this.db.query(
          `SELECT v.id FROM violation v
            WHERE v.state = 'open' AND v.confirmed_at >= $1
              AND NOT EXISTS (
                SELECT 1 FROM notice_citation c
                  JOIN notice n ON n.id = c.notice_id
                 WHERE c.violation_id = v.id
                   AND n.state IN ('draft', 'approved')
              )
            ORDER BY v.confirmed_at ASC`,
          [since],
        )
      ).rows.map((row) => String(row.id));
      if (violations.length === 0) {
        await this.markWindow(key, today);
        continue;
      }
      try {
        await this.compose(
          {
            recipient: String(profile.recipient),
            recipientProfileId: String(profile.id),
            violationIds: violations,
          },
          SYSTEM_OPERATOR_ID,
        );
        await this.markWindow(key, today);
        composed += 1;
      } catch (error) {
        if (
          !(error instanceof ApiError) ||
          !["violation_reserved", "duplicate_entity"].includes(error.code)
        ) {
          throw error;
        }
      }
    }
    return composed;
  }

  async list(filters: NoticeFilters, page: Page) {
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (filters.state) {
      values.push(filters.state);
      conditions.push(`n.state = $${values.length}`);
    }
    if (filters.recipient) {
      values.push(filters.recipient);
      conditions.push(`n.recipient = $${values.length}`);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = (
      await this.db.query(
        `SELECT n.* FROM notice n
           ${where}
          ORDER BY n.created_at DESC`,
        values,
      )
    ).rows;
    const items = [];
    for (const row of rows) {
      const submission = await this.submissionFor(String(row.id));
      const count = (
        await this.db.query(
          "SELECT COUNT(*)::int AS count FROM notice_citation WHERE notice_id = $1",
          [row.id],
        )
      ).rows[0]?.count;
      items.push(
        toNoticeCard(
          { ...row, violation_count: count },
          noticeStatus(row, submission),
          Boolean(submission?.pack_ref),
        ),
      );
    }
    return pageOf(items, page);
  }

  async read(id: string) {
    const row = await this.load(id);
    return this.detail(row);
  }

  async compose(input: ComposeInput, operatorId: string) {
    await ensureTemplates(this.db, this.clock);
    const profile = await this.profile(input.recipientProfileId);
    if (String(profile.recipient) !== input.recipient) {
      throw unprocessable([
        {
          path: "/recipient",
          message: "The recipient does not match the profile.",
        },
      ]);
    }
    const slug = RECIPIENT_SLUG[String(profile.recipient)];
    const template = await findTemplate(this.db, slug, "en");
    if (!template) {
      throw new ApiError(
        422,
        "not_supported",
        "No verified statement template exists for this recipient.",
      );
    }
    const holder = await this.holder();
    this.ensureEligible(String(profile.recipient), profile, holder);

    const uniqueIds = [...new Set(input.violationIds)];
    if (uniqueIds.length === 0) {
      throw new ApiError(422, "empty_citation", "At least one violation is required.");
    }
    const violations = await this.loadViolations(uniqueIds);
    if (violations.length !== uniqueIds.length) {
      throw unprocessable([
        { path: "/violationIds", message: "Every violation must exist." },
      ]);
    }
    for (const resolved of violations) {
      if (String(resolved.violation.state) !== "open") {
        throw new ApiError(
          409,
          "state_conflict",
          "Only open violations can be cited.",
          undefined,
          { currentState: String(resolved.violation.state) },
        );
      }
      const reserved = await this.reservation(
        String(profile.id),
        resolved,
        undefined,
      );
      if (reserved) {
        throw new ApiError(
          409,
          reserved.duplicate ? "duplicate_entity" : "violation_reserved",
          reserved.duplicate
            ? "The recipient already has an active notice for this URL and title."
            : "The violation is reserved by another notice.",
          undefined,
          {
            conflictingViolationIds: [String(resolved.violation.id)],
            existingNoticeId: reserved.noticeId,
          },
        );
      }
    }

    const groups = this.group(String(profile.recipient), profile, violations);
    const created = await this.withClient(async (db) => {
      const ids: string[] = [];
      for (const group of groups) {
        ids.push(
          await this.createDraft(db, profile, template, group, operatorId),
        );
      }
      return ids;
    });
    return this.read(created[0]);
  }

  async approve(id: string, input: ApprovalInput, operatorId: string) {
    await ensureTemplates(this.db, this.clock);
    const row = await this.load(id);
    if (String(row.state) !== "draft") {
      throw new ApiError(
        409,
        "state_conflict",
        "Only a draft can be approved.",
        undefined,
        { currentState: String(row.state) },
      );
    }
    if (input.statementVersion !== String(row.template_version)) {
      throw unprocessable([
        {
          path: "/statementVersion",
          message: "The approved template version does not match the notice.",
        },
      ]);
    }
    if (
      !input.attestation.reviewedViolations ||
      !input.attestation.currentStatements ||
      !input.attestation.authorizedSignatory
    ) {
      throw unprocessable([
        {
          path: "/attestation",
          message: "All three approvals are required.",
        },
      ]);
    }
    const template = await this.templateRow(String(row.template_version));
    await this.assertTemplateUsable(template);
    const profile = await this.profile(String(row.recipient_profile_id));
    const holder = await this.holder();
    const signatory = this.signatory(holder);
    const citations = await this.citations(id);
    if (citations.length === 0) {
      throw new ApiError(422, "empty_citation", "The notice cites no violations.");
    }
    const forbidden = await this.allowlistViolations(citations);
    if (forbidden.length > 0) {
      throw new ApiError(
        422,
        "allowlist_hit",
        "An allowlisted violation cannot be cited in a notice.",
        undefined,
        { conflictingViolationIds: forbidden },
      );
    }

    const now = this.clock();
    const content = await this.freezeContent(
      id,
      row,
      profile,
      holder,
      signatory,
      now,
    );
    const rightsHolder = rightsHolderSnapshot(holder, now);
    const profileSnapshotValue = profileSnapshot(profile, now);
    const queuedCaptures = await this.queuePreHandoff(citations, now);
    const submissionId = newId();
    const packLanguage = String(
      (await this.operatorLanguage(operatorId)) ?? "en",
    );
    const secondOperator = await this.secondOperatorCheck(
      id,
      profile,
      operatorId,
      now,
    );
    await this.withClient(async (db) => {
      await db.query(
        "UPDATE notice_template SET verified_by = $2, verified_at = $3 WHERE id = $1",
        [String(row.template_version), operatorId, now],
      );
      for (const [index, citation] of citations.entries()) {
        await db.query(
          `UPDATE notice_citation SET evidence_ids = $2
            WHERE notice_id = $1 AND violation_id = $3`,
          [
            id,
            JSON.stringify(content.citedViolations[index]?.evidence ?? []),
            citation.violation_id,
          ],
        );
      }
      await db.query(
        `UPDATE notice
            SET state = 'approved', content = $2, approved_by = $3,
                approved_at = $4, rights_holder_snapshot = $5,
                signatory_snapshot = $6, profile_snapshot = $7,
                pack_language = $8, second_operator_check = $9,
                updated_at = $4
          WHERE id = $1`,
        [
          id,
          JSON.stringify(content),
          operatorId,
          now,
          JSON.stringify(rightsHolder),
          JSON.stringify(signatory),
          JSON.stringify(profileSnapshotValue),
          packLanguage,
          JSON.stringify(secondOperator),
        ],
      );
      await db.query(
        `INSERT INTO submission
          (id, recipient_profile_id, state, notice_id, channel, pack_language,
           attempt_count, created_at, updated_at)
         VALUES ($1, $2, 'pending', $3, $4, $5, 1, $6, $6)`,
        [submissionId, profile.id, id, profile.channel, packLanguage, now],
      );
    });
    const approved = await this.load(id);
    const submission = await this.submissionFor(id);
    if (this.store.put && queuedCaptures === 0) {
      await this.ensurePack(submissionId);
    }
    return {
      notice: (await this.detail(approved)).notice,
      status: noticeStatus(approved, submission),
      queuedCaptures,
      ...(queuedCaptures === 0 && submission
        ? { submission: toSubmission((await this.submissionRow(submissionId))!) }
        : {}),
    };
  }

  async pack(id: string) {
    const submission = await this.submissionFor(id);
    if (!submission) {
      throw new ApiError(409, "pack_not_ready", "The notice has no submission yet.");
    }
    await this.ensurePack(String(submission.id));
    const row = (await this.submissionRow(String(submission.id)))!;
    const artifacts = await this.packArtifacts(String(submission.id));
    const notice = await this.load(id);
    const citations = await this.citations(id);
    return {
      submissionId: String(row.id),
      packRef: String(row.pack_ref),
      packSha256: String(row.pack_sha256),
      generatedAt: iso(row.pack_generated_at),
      packLanguage: String(row.pack_language),
      formUrl: await this.formUrl(notice),
      artifacts: await Promise.all(
        artifacts.map(async (artifact) => {
          const signed = await this.store.signedUrl(
            String(artifact.object_key),
            (artifact.object_version as string | null) ?? null,
          );
          return {
            kind: String(artifact.kind),
            fileName: String(artifact.file_name),
            contentType: String(artifact.content_type),
            byteSize: Number(artifact.byte_size),
            downloadUrl: signed.url,
          };
        }),
      ),
      captureFlags: await this.captureFlags(citations),
    };
  }

  async withdraw(id: string, reason: string | undefined, operatorId: string) {
    const row = await this.load(id);
    const now = this.clock();
    if (String(row.state) === "draft") {
      await this.db.query(
        `UPDATE notice
            SET state = 'withdrawn', withdrawn_by = $2, withdrawn_at = $3,
                withdrawal_reason = $4, updated_at = $3
          WHERE id = $1`,
        [id, operatorId, now, reason ?? null],
      );
    } else if (String(row.state) === "approved") {
      const submission = await this.submissionFor(id);
      if (!submission || String(submission.state) !== "pending" || submission.cancelled_at) {
        throw new ApiError(
          409,
          "notice_not_withdrawable",
          "The notice can no longer be withdrawn.",
        );
      }
      await this.withClient(async (db) => {
        await db.query(
          `UPDATE notice
              SET state = 'withdrawn', withdrawn_by = $2, withdrawn_at = $3,
                  withdrawal_reason = $4, updated_at = $3
            WHERE id = $1`,
          [id, operatorId, now, reason ?? null],
        );
        await db.query(
          "UPDATE submission SET cancelled_at = $2, updated_at = $2 WHERE id = $1",
          [submission.id, now],
        );
      });
    } else {
      throw new ApiError(
        409,
        "notice_not_withdrawable",
        "The notice can no longer be withdrawn.",
        undefined,
        { currentState: String(row.state) },
      );
    }
    return (await this.detail(await this.load(id))).notice;
  }

  async supersede(id: string, input: SupersessionInput, operatorId: string) {
    const row = await this.load(id);
    if (String(row.state) !== "approved") {
      throw new ApiError(
        409,
        "state_conflict",
        "Only an approved notice can be superseded.",
      );
    }
    const submission = await this.submissionFor(id);
    if (!submission || String(submission.state) !== "pending" || submission.cancelled_at) {
      throw new ApiError(
        409,
        "submission_not_pending",
        "Only a pending submission can be superseded.",
      );
    }
    const current = (await this.citations(id)).map((citation) =>
      String(citation.violation_id),
    );
    const next = [...new Set(input.citedViolationIds)];
    if (
      next.length === 0 ||
      (next.length === current.length &&
        next.every((violationId) => current.includes(violationId)))
    ) {
      throw new ApiError(
        422,
        "empty_citation",
        "The replacement citation set must differ.",
      );
    }
    const profile = await this.profile(String(row.recipient_profile_id));
    const template = await findTemplate(
      this.db,
      RECIPIENT_SLUG[String(row.recipient)] ?? String(row.recipient),
      "en",
    );
    if (!template) {
      throw new ApiError(
        422,
        "not_supported",
        "No verified statement template exists for the replacement.",
      );
    }
    this.ensureEligible(
      String(row.recipient),
      profile,
      await this.holder(),
    );
    const replacementViolations = await this.loadViolations(next);
    if (
      replacementViolations.length !== next.length ||
      replacementViolations.some(
        (resolved) => String(resolved.violation.state) !== "open",
      )
    ) {
      throw new ApiError(
        409,
        "state_conflict",
        "Every replacement citation must be an open violation.",
      );
    }
    const now = this.clock();
    await this.withClient(async (db) => {
      await db.query(
        `UPDATE notice
            SET state = 'superseded', superseded_by = $2, superseded_at = $3,
                updated_at = $3
          WHERE id = $1`,
        [id, operatorId, now],
      );
      await db.query(
        "UPDATE submission SET cancelled_at = $2, updated_at = $2 WHERE id = $1",
        [submission.id, now],
      );
    });
    let replacement: { notice: { id: string } } & Record<string, unknown>;
    try {
      replacement = await this.compose(
        {
          recipient: String(row.recipient),
          recipientProfileId: String(row.recipient_profile_id),
          violationIds: next,
        },
        operatorId,
      );
    } catch (error) {
      await this.db.query(
        `UPDATE notice
            SET state = 'approved', superseded_by = NULL, superseded_at = NULL,
                updated_at = $2
          WHERE id = $1`,
        [id, now],
      );
      await this.db.query(
        "UPDATE submission SET cancelled_at = NULL, updated_at = $2 WHERE id = $1",
        [submission.id, now],
      );
      throw error;
    }
    await this.db.query(
      "UPDATE notice SET superseded_by_notice_id = $2 WHERE id = $1",
      [id, replacement.notice.id],
    );
    return { superseded: toNotice(await this.load(id)), draft: replacement };
  }

  private async detail(row: Record<string, unknown>) {
    const citations = await this.citations(String(row.id));
    const works = await this.works(String(row.id));
    const statements = await this.statements(String(row.id));
    const fields = await this.fields(String(row.id));
    const submission = await this.submissionFor(String(row.id));
    const template = await this.templateSummary(String(row.template_version));
    const citedViolations = [];
    for (const citation of citations) {
      const violation = (
        await this.db.query(
          `SELECT v.*, t.release_year, t.title_type, t.original_variant_id,
                  d.text AS display_title
             FROM violation v
             JOIN tracked_title t ON t.id = v.tracked_title_id
             LEFT JOIN title_variant d ON d.id = t.original_variant_id
            WHERE v.id = $1`,
          [citation.violation_id],
        )
      ).rows[0];
      const evidence = [];
      for (const evidenceId of parseObjects(citation.evidence_ids)) {
        const evidenceRow = (
          await this.db.query("SELECT * FROM evidence WHERE id = $1", [
            String(evidenceId.evidenceId),
          ])
        ).rows[0];
        if (evidenceRow) {
          evidence.push(evidenceSummary(evidenceRow));
        }
      }
      if (violation) {
        citedViolations.push({
          violation: toViolation(violation),
          displayTitle: String(violation.display_title ?? ""),
          releaseYear: Number(violation.release_year),
          titleType: String(violation.title_type),
          evidence,
        });
      }
    }
    return {
      notice: toNotice(row, citations, works, statements, fields),
      status: noticeStatus(row, submission),
      citedViolations,
      ...(submission
        ? { submission: toSubmission((await this.submissionRow(String(submission.id)))!) }
        : {}),
      packAvailable: Boolean(submission?.pack_ref),
      template,
    };
  }

  private async createDraft(
    db: Queryable,
    profile: Record<string, unknown>,
    template: Record<string, unknown>,
    group: ResolvedViolation[],
    operatorId: string,
  ) {
    const id = newId();
    const now = this.clock();
    const templateId = String(template.id);
    await db.query(
      `INSERT INTO notice
        (id, recipient, recipient_profile_id, channel, state, template_version,
         content, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'draft', $5, NULL, $6, $7, $7)`,
      [
        id,
        profile.recipient,
        profile.id,
        profile.channel,
        templateId,
        operatorId,
        now,
      ],
    );
    for (const resolved of group) {
      await db.query(
        `INSERT INTO notice_citation
          (notice_id, violation_id, evidence_ids, cited_at)
         VALUES ($1, $2, $3, $4)`,
        [
          id,
          resolved.violation.id,
          JSON.stringify(this.citationEvidence(resolved.evidence)),
          now,
        ],
      );
    }
    const titles = new Map<string, Record<string, unknown>>();
    for (const resolved of group) {
      titles.set(String(resolved.title.id), resolved.title);
    }
    for (const title of titles.values()) {
      await db.query(
        `INSERT INTO notice_work
          (notice_id, tracked_title_id, display_title, release_year,
           title_type, authorized_example_url)
         VALUES ($1, $2, $3, $4, $5, NULL)`,
        [
          id,
          title.id,
          title.display_title,
          title.release_year,
          title.title_type,
        ],
      );
    }
    const statements = parseObjects(template.statements);
    for (const [ordinal, statement] of statements.entries()) {
      await db.query(
        `INSERT INTO notice_statement
          (notice_id, ordinal, key, text, template_version)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          id,
          ordinal,
          statement.key,
          statement.text,
          templateId,
        ],
      );
    }
    for (const [ordinal, field] of this.resolvedFields(profile).entries()) {
      await db.query(
        `INSERT INTO notice_resolved_field
          (notice_id, ordinal, name, value, required, max_length)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, ordinal, field.name, field.value, field.required, field.maxLength ?? null],
      );
    }
    return id;
  }

  private async freezeContent(
    id: string,
    row: Record<string, unknown>,
    profile: Record<string, unknown>,
    holder: Record<string, unknown>,
    signatory: Record<string, unknown>,
    now: Date,
  ) {
    const citations = await this.citations(id);
    const frozenCitations = [];
    for (const citation of citations) {
      const violation = (
        await this.db.query("SELECT * FROM violation WHERE id = $1", [
          citation.violation_id,
        ])
      ).rows[0];
      const evidence = await this.evidenceFor(
        String(violation?.normalized_url ?? ""),
        now,
      );
      frozenCitations.push({
        violationId: String(citation.violation_id),
        evidence: evidence.map((item) => ({
          evidenceId: String(item.id),
          capturedAt: iso(item.observed_at),
          reason: String(item.reason),
        })),
      });
    }
    const works = (await this.works(id)).map((work) => ({
      trackedTitleId: String(work.tracked_title_id),
      displayTitle: String(work.display_title),
      releaseYear: Number(work.release_year),
      titleType: String(work.title_type),
      ...(work.authorized_example_url
        ? { authorizedExampleUrl: String(work.authorized_example_url) }
        : {}),
    }));
    const statements = (await this.statements(id)).map((statement) => ({
      key: String(statement.key),
      text: String(statement.text),
      templateVersion: String(statement.template_version),
    }));
    const fields = this.resolvedFieldsFor(profile, holder, signatory);
    return {
      recipient: String(row.recipient),
      recipientProfileId: String(row.recipient_profile_id),
      channel: String(row.channel),
      citedViolations: frozenCitations,
      workIdentifications: works,
      statements,
      resolvedFields: fields,
      templateVersion: String(row.template_version),
    };
  }

  private async queuePreHandoff(
    citations: Array<Record<string, unknown>>,
    now: Date,
  ): Promise<number> {
    let queued = 0;
    for (const citation of citations) {
      const violation = (
        await this.db.query("SELECT * FROM violation WHERE id = $1", [
          citation.violation_id,
        ])
      ).rows[0];
      if (!violation) {
        continue;
      }
      const newest = (
        await this.db.query(
          `SELECT * FROM evidence
            WHERE normalized_requested_url = $1 AND outcome = 'captured'
            ORDER BY observed_at DESC LIMIT 1`,
          [violation.normalized_url],
        )
      ).rows[0];
      if (
        newest &&
        now.getTime() - new Date(String(newest.observed_at)).getTime() <
          SEVEN_DAYS_MS
      ) {
        continue;
      }
      await this.db.query(
        `INSERT INTO capture_request
          (id, url, normalized_url, reason, violation_id, tracked_title_id,
           title_group_id, capture_point, state, created_at)
         VALUES ($1, $2, $3, 'pre_handoff', $4, $5, $6, $7, 'pending', $8)`,
        [
          newId(),
          violation.url,
          violation.normalized_url,
          violation.id,
          violation.tracked_title_id,
          violation.title_group_id,
          `pre_handoff:${citation.notice_id}:${violation.id}`,
          now,
        ],
      );
      queued += 1;
    }
    return queued;
  }

  private async ensurePack(submissionId: string) {
    const submission = await this.submissionRow(submissionId);
    if (!submission) {
      throw new ApiError(404, "not_found", "The submission does not exist.");
    }
    if (submission.pack_ref) {
      return;
    }
    const pending = (
      await this.db.query(
        `SELECT 1 FROM capture_request
          WHERE capture_point LIKE $1 AND state IN ('pending', 'queued')
          LIMIT 1`,
        [`pre_handoff:${String(submission.notice_id)}:%`],
      )
    ).rows[0];
    if (pending) {
      throw new ApiError(
        409,
        "pack_not_ready",
        "The pre-handoff captures have not settled.",
      );
    }
    if (!this.store.put) {
      throw new ApiError(
        503,
        "not_supported",
        "Pack storage is not configured.",
      );
    }
    const notice = await this.load(String(submission.notice_id));
    const content = parseObject(notice.content);
    const citations = await this.citations(String(notice.id));
    const flags = await this.captureFlags(citations);
    const upload = await this.uploadEntries(citations);
    const formUrl = await this.formUrl(notice);
    const artifacts = this.renderPack(notice, content, flags, upload, formUrl);
    const now = this.clock();
    const manifest = [];
    for (const artifact of artifacts) {
      const sha256 = createHash("sha256").update(artifact.body).digest("hex");
      const key = `packs/${submissionId}/${sha256}-${artifact.fileName}`;
      const version = await this.store.put(key, artifact.body, artifact.contentType);
      await this.db.query(
        `INSERT INTO notice_pack_artifact
          (submission_id, kind, file_name, content_type, byte_size, sha256,
           object_key, object_version, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          submissionId,
          artifact.kind,
          artifact.fileName,
          artifact.contentType,
          artifact.body.byteLength,
          sha256,
          key,
          version,
          now,
        ],
      );
      manifest.push({ kind: artifact.kind, fileName: artifact.fileName, sha256 });
    }
    const packSha256 = createHash("sha256")
      .update(JSON.stringify(manifest))
      .digest("hex");
    await this.db.query(
      `UPDATE submission
          SET pack_ref = $2, pack_sha256 = $3, pack_generated_at = $4,
              updated_at = $4
        WHERE id = $1`,
      [submissionId, `packs/${submissionId}/${packSha256}`, packSha256, now],
    );
  }

  private renderPack(
    notice: Record<string, unknown>,
    content: Record<string, unknown>,
    flags: Array<Record<string, unknown>>,
    uploadEntries: Array<{ title: string; url: string }>,
    formUrl: string,
  ) {
    const fields = [
      ...((content.resolvedFields ?? []) as Array<Record<string, unknown>>),
      {
        name: "notice_date",
        value: new Date().toISOString().slice(0, 10),
        required: true,
      },
    ];
    const statements = (content.statements ?? []) as Array<Record<string, unknown>>;
    const works = (content.workIdentifications ?? []) as Array<Record<string, unknown>>;
    const packLanguage = String(notice.pack_language ?? "en");
    const publicStatement =
      String(notice.recipient) === "google"
        ? "<p>Google may publish qualifying notices through Lumen.</p>"
        : "";
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Notice ${notice.id}</title></head><body>
<h1>Notice to ${notice.recipient}</h1>
${publicStatement}
<h2>Work identification</h2>
${works.map((work) => `<p>${escapeHtml(String(work.displayTitle))} (${work.releaseYear}, ${work.titleType})</p>`).join("\n")}
<h2>Fields</h2>
${fields.map((field) => `<p><strong>${escapeHtml(String(field.name))}</strong>: ${escapeHtml(String(field.value))}${field.required ? " (required)" : ""}</p>`).join("\n")}
<h2>Statements</h2>
${statements.map((statement) => `<p>${escapeHtml(String(statement.text))}</p>`).join("\n")}
<h2>URLs</h2>
${uploadEntries.map((entry) => `<p>${escapeHtml(entry.url)}</p>`).join("\n")}
</body></html>`;
    const upload = uploadFile(notice, uploadEntries);
    const handoff = handoffMarkdown(
      notice,
      content,
      flags,
      packLanguage,
      formUrl,
      fields,
    );
    const artifacts = [
      {
        kind: "notice_html",
        fileName: "notice.html",
        contentType: "text/html; charset=utf-8",
        body: Buffer.from(html, "utf8"),
      },
      {
        kind: "fields_json",
        fileName: "fields.json",
        contentType: "application/json",
        body: Buffer.from(JSON.stringify(fields, null, 2), "utf8"),
      },
      {
        kind: "handoff_markdown",
        fileName: "handoff.md",
        contentType: "text/markdown; charset=utf-8",
        body: Buffer.from(handoff, "utf8"),
      },
    ];
    if (upload) {
      artifacts.push({
        kind: "upload_file",
        fileName: "urls.txt",
        contentType: "text/plain; charset=utf-8",
        body: Buffer.from(upload, "utf8"),
      });
    }
    return artifacts;
  }

  private async uploadEntries(citations: Array<Record<string, unknown>>) {
    const entries: Array<{ title: string; url: string }> = [];
    for (const citation of citations) {
      const row = (
        await this.db.query(
          `SELECT v.url, d.text AS display_title
             FROM violation v
             JOIN tracked_title t ON t.id = v.tracked_title_id
             LEFT JOIN title_variant d ON d.id = t.original_variant_id
            WHERE v.id = $1`,
          [citation.violation_id],
        )
      ).rows[0];
      if (row) {
        entries.push({
          title: String(row.display_title ?? ""),
          url: String(row.url),
        });
      }
    }
    return entries;
  }

  private async captureFlags(citations: Array<Record<string, unknown>>) {
    const flags = [];
    for (const citation of citations) {
      const violation = (
        await this.db.query("SELECT * FROM violation WHERE id = $1", [
          citation.violation_id,
        ])
      ).rows[0];
      if (!violation) {
        continue;
      }
      const newest = (
        await this.db.query(
          "SELECT * FROM evidence WHERE normalized_requested_url = $1 ORDER BY observed_at DESC LIMIT 1",
          [violation.normalized_url],
        )
      ).rows[0];
      if (!newest) {
        continue;
      }
      const earlier = (
        await this.db.query(
          `SELECT id FROM evidence
            WHERE normalized_requested_url = $1 AND outcome = 'captured'
            ORDER BY observed_at DESC LIMIT 1`,
          [violation.normalized_url],
        )
      ).rows[0];
      flags.push({
        violationId: String(violation.id),
        url: String(violation.url),
        newestEvidenceId: String(newest.id),
        newestOutcome: String(newest.outcome),
        ...(earlier ? { earlierLiveEvidenceId: String(earlier.id) } : {}),
      });
    }
    return flags;
  }

  private group(
    recipient: string,
    profile: Record<string, unknown>,
    violations: ResolvedViolation[],
  ): ResolvedViolation[][] {
    if (recipient === "yandex") {
      return violations.map((violation) => [violation]);
    }
    const cap =
      recipient === "google"
        ? Number(
            profile.last_observed_max_urls_per_file ??
              profile.max_urls_per_file ??
              profile.max_urls_per_notice ??
              500,
          )
        : Number(profile.max_urls_per_file ?? 1_000);
    if (recipient === "bing") {
      const byTitle = new Map<string, ResolvedViolation[]>();
      for (const violation of violations) {
        const titleId = String(violation.title.id);
        byTitle.set(titleId, [...(byTitle.get(titleId) ?? []), violation]);
      }
      const groups: ResolvedViolation[][] = [];
      for (const titleViolations of byTitle.values()) {
        for (let index = 0; index < titleViolations.length; index += cap) {
          groups.push(titleViolations.slice(index, index + cap));
        }
      }
      return groups;
    }
    const groups: ResolvedViolation[][] = [];
    for (let index = 0; index < violations.length; index += cap) {
      groups.push(violations.slice(index, index + cap));
    }
    return groups;
  }

  private async reservation(
    profileId: string,
    resolved: ResolvedViolation,
    excludeNoticeId: string | undefined,
  ) {
    const duplicate = (
      await this.db.query(
        `SELECT n.id
           FROM notice_citation c
           JOIN notice n ON n.id = c.notice_id
           JOIN violation v ON v.id = c.violation_id
           LEFT JOIN submission s ON s.notice_id = n.id
          WHERE n.recipient_profile_id = $1
            AND v.normalized_url = $2
            AND v.tracked_title_id = $3
            AND n.state IN ('draft', 'approved')
            AND COALESCE(s.state, 'pending') NOT IN ('rejected', 'failed')
            AND c.violation_id <> $5
            AND ($4::text IS NULL OR n.id <> $4)
          LIMIT 1`,
        [
          profileId,
          resolved.violation.normalized_url,
          resolved.violation.tracked_title_id,
          excludeNoticeId ?? null,
          resolved.violation.id,
        ],
      )
    ).rows[0];
    if (duplicate) {
      return { noticeId: String(duplicate.id), duplicate: true };
    }
    const row = (
      await this.db.query(
        `SELECT n.id
           FROM notice_citation c
           JOIN notice n ON n.id = c.notice_id
           LEFT JOIN submission s ON s.notice_id = n.id
          WHERE c.violation_id = $1
            AND n.state IN ('draft', 'approved')
            AND COALESCE(s.state, 'pending') NOT IN ('rejected', 'failed')
            AND ($2::text IS NULL OR n.id <> $2)
          LIMIT 1`,
        [resolved.violation.id, excludeNoticeId ?? null],
      )
    ).rows[0];
    if (!row) {
      return undefined;
    }
    return { noticeId: String(row.id), duplicate: false };
  }

  private async allowlistViolations(citations: Array<Record<string, unknown>>) {
    const blocked: string[] = [];
    for (const citation of citations) {
      const violation = (
        await this.db.query("SELECT * FROM violation WHERE id = $1", [
          citation.violation_id,
        ])
      ).rows[0];
      if (!violation) {
        continue;
      }
      const candidate = (
        await this.db.query(
          "SELECT allowlist_entry_id FROM candidate WHERE normalized_url = $1 AND tracked_title_id = $2",
          [violation.normalized_url, violation.tracked_title_id],
        )
      ).rows[0];
      if (candidate?.allowlist_entry_id) {
        blocked.push(String(violation.id));
      }
    }
    return blocked;
  }

  private async secondOperatorCheck(
    id: string,
    profile: Record<string, unknown>,
    operatorId: string,
    now: Date,
  ) {
    const approved = (
      await this.db.query(
        "SELECT COUNT(*)::int AS count FROM notice WHERE recipient_profile_id = $1 AND state = 'approved'",
        [profile.id],
      )
    ).rows[0]?.count;
    const other = (
      await this.db.query(
        "SELECT id FROM operator_account WHERE id <> $1 AND state = 'active' LIMIT 1",
        [operatorId],
      )
    ).rows[0];
    return {
      required: Number(approved ?? 0) < 5,
      secondOperatorExists: other !== undefined,
      approvedBy: operatorId,
      recordedAt: now.toISOString(),
    };
  }

  private async assertTemplateUsable(template: Record<string, unknown>) {
    if (!template.verified_by || !template.verified_at) {
      throw new ApiError(
        422,
        "not_supported",
        "The statement template has not been verified.",
      );
    }
    const age =
      this.clock().getTime() - new Date(String(template.verified_at)).getTime();
    if (age > NINETY_DAYS_MS) {
      throw new ApiError(
        409,
        "state_conflict",
        "The statement template is older than ninety days.",
      );
    }
    const newer = (
      await this.db.query(
        `SELECT id FROM notice_template
          WHERE recipient = $1 AND language = $2 AND major > $3 LIMIT 1`,
        [template.recipient, template.language, template.major],
      )
    ).rows[0];
    if (newer) {
      throw new ApiError(
        409,
        "state_conflict",
        "A newer statement template revision exists.",
      );
    }
  }

  private async templateSummary(version: string) {
    const template = (
      await this.db.query("SELECT * FROM notice_template WHERE id = $1", [
        version,
      ])
    ).rows[0];
    if (!template) {
      return {
        version,
        sourceUrls: [],
        accessedAt: iso(0),
        stale: true,
      };
    }
    const newer = (
      await this.db.query(
        "SELECT id FROM notice_template WHERE recipient = $1 AND language = $2 AND major > $3 LIMIT 1",
        [template.recipient, template.language, template.major],
      )
    ).rows[0];
    const stale =
      !template.verified_at ||
      this.clock().getTime() - new Date(String(template.verified_at)).getTime() >
        NINETY_DAYS_MS ||
      newer !== undefined;
    return {
      version: String(template.id),
      sourceUrls: parseArray(template.source_urls),
      accessedAt: iso(template.accessed_at),
      ...(template.verified_by ? { verifiedBy: String(template.verified_by) } : {}),
      ...(template.verified_at ? { verifiedAt: iso(template.verified_at) } : {}),
      stale,
    };
  }

  private resolvedFields(profile: Record<string, unknown>) {
    return [
      { name: "rights_holder_legal_name", value: "", required: true, maxLength: 200 },
      { name: "contact_email", value: String(profile.contact_email ?? profile.account ?? ""), required: true },
      { name: "signatory_name", value: "", required: true, maxLength: 200 },
      { name: "signatory_authority", value: "", required: true },
    ];
  }

  private resolvedFieldsFor(
    profile: Record<string, unknown>,
    holder: Record<string, unknown>,
    signatory: Record<string, unknown>,
  ) {
    return [
      {
        name: "rights_holder_legal_name",
        value: String(holder.legal_name ?? ""),
        required: true,
        maxLength: 200,
      },
      {
        name: "rights_holder_country",
        value: String(holder.country ?? ""),
        required: true,
      },
      {
        name: "contact_email",
        value: String(
          holder.role_mailbox ?? profile.contact_email ?? profile.account ?? "",
        ),
        required: true,
      },
      {
        name: "signatory_name",
        value: String(signatory.fullLegalName ?? ""),
        required: true,
        maxLength: 200,
      },
      {
        name: "signatory_authority",
        value: String(signatory.authorityBasis ?? ""),
        required: true,
      },
    ];
  }

  private async formUrl(notice: Record<string, unknown>) {
    const profile = (
      await this.db.query("SELECT form_url FROM recipient_profile WHERE id = $1", [
        notice.recipient_profile_id,
      ])
    ).rows[0];
    if (profile?.form_url) {
      return String(profile.form_url);
    }
    const template = (
      await this.db.query("SELECT source_urls FROM notice_template WHERE id = $1", [
        notice.template_version,
      ])
    ).rows[0];
    const urls = template ? parseArray(template.source_urls) : [];
    if (urls[0]) {
      return urls[0];
    }
    throw new ApiError(
      422,
      "not_supported",
      "No form URL is configured for this recipient.",
    );
  }

  private async evidenceFor(normalizedUrl: string, before: Date) {
    const rows = (
      await this.db.query(
        `SELECT * FROM evidence
          WHERE normalized_requested_url = $1 AND observed_at <= $2
          ORDER BY observed_at DESC`,
        [normalizedUrl, before],
      )
    ).rows;
    const live = rows.filter((row) => String(row.outcome) === "captured");
    return live.length > 0 ? [live[0]] : rows.slice(0, 1);
  }

  private citationEvidence(evidence: Array<Record<string, unknown>>) {
    return evidence.map((row) => ({
      evidenceId: String(row.id),
      capturedAt: iso(row.observed_at),
      reason: String(row.reason),
    }));
  }

  private async loadViolations(ids: string[]) {
    const resolved: ResolvedViolation[] = [];
    for (const id of ids) {
      const violation = (
        await this.db.query("SELECT * FROM violation WHERE id = $1", [id])
      ).rows[0];
      if (!violation) {
        continue;
      }
      const title = (
        await this.db.query(
          `SELECT t.*, d.text AS display_title
             FROM tracked_title t
             LEFT JOIN title_variant d ON d.id = t.original_variant_id
            WHERE t.id = $1`,
          [violation.tracked_title_id],
        )
      ).rows[0];
      if (!title) {
        continue;
      }
      const evidence = await this.evidenceFor(
        String(violation.normalized_url),
        this.clock(),
      );
      resolved.push({ violation, title, evidence });
    }
    return resolved;
  }

  private async profile(id: string) {
    const row = (
      await this.db.query("SELECT * FROM recipient_profile WHERE id = $1", [id])
    ).rows[0];
    if (!row) {
      throw new ApiError(404, "not_found", "The recipient profile does not exist.");
    }
    return row;
  }

  private async holder() {
    const row = (await this.db.query("SELECT * FROM rights_holder LIMIT 1")).rows[0];
    if (!row) {
      throw new ApiError(404, "not_found", "The rights holder is not configured.");
    }
    return row;
  }

  private signatory(holder: Record<string, unknown>) {
    return {
      fullLegalName: String(holder.signatory_name ?? ""),
      authorityBasis: String(holder.signatory_authority_basis ?? ""),
      contactEmail: String(holder.signatory_email ?? holder.role_mailbox ?? ""),
      ...(holder.signatory_phone
        ? { contactPhone: String(holder.signatory_phone) }
        : {}),
      capturedAt: this.clock().toISOString(),
    };
  }

  private ensureEligible(
    recipient: string,
    profile: Record<string, unknown>,
    holder: Record<string, unknown>,
  ) {
    if (recipient === "google" && !String(profile.account ?? "").trim()) {
      throw new ApiError(
        422,
        "recipient_ineligible",
        "A Google account is required for the Google form.",
      );
    }
    if (
      recipient === "bing" &&
      !String(profile.contact_email ?? "").trim() &&
      !String(profile.account ?? "").trim()
    ) {
      throw new ApiError(
        422,
        "recipient_ineligible",
        "A contact mailbox is required for the Bing form.",
      );
    }
    if (recipient !== "yandex") {
      return;
    }
    if (!YANDEX_ELIGIBLE_COUNTRIES[String(holder.country)]) {
      throw new ApiError(
        422,
        "recipient_ineligible",
        "The rights holder is not eligible for the Yandex form.",
      );
    }
  }

  private async templateRow(version: string) {
    const row = (
      await this.db.query("SELECT * FROM notice_template WHERE id = $1", [version])
    ).rows[0];
    if (!row) {
      throw new ApiError(404, "not_found", "The statement template does not exist.");
    }
    return row;
  }

  private async operatorLanguage(operatorId: string) {
    const row = (
      await this.db.query(
        "SELECT preferred_language FROM operator_account WHERE id = $1",
        [operatorId],
      )
    ).rows[0];
    return row?.preferred_language;
  }

  private async load(id: string) {
    const row = (
      await this.db.query("SELECT * FROM notice WHERE id = $1", [id])
    ).rows[0];
    if (!row) {
      throw new ApiError(404, "not_found", "The notice does not exist.");
    }
    return row;
  }

  private async submissionFor(noticeId: string) {
    return (
      await this.db.query("SELECT * FROM submission WHERE notice_id = $1", [noticeId])
    ).rows[0];
  }

  private async submissionRow(id: string) {
    return (
      await this.db.query("SELECT * FROM submission WHERE id = $1", [id])
    ).rows[0];
  }

  private async citations(id: string) {
    return (
      await this.db.query(
        "SELECT * FROM notice_citation WHERE notice_id = $1 ORDER BY cited_at ASC",
        [id],
      )
    ).rows;
  }

  private async works(id: string) {
    return (
      await this.db.query(
        "SELECT * FROM notice_work WHERE notice_id = $1 ORDER BY display_title ASC",
        [id],
      )
    ).rows;
  }

  private async statements(id: string) {
    return (
      await this.db.query(
        "SELECT * FROM notice_statement WHERE notice_id = $1 ORDER BY ordinal ASC",
        [id],
      )
    ).rows;
  }

  private async fields(id: string) {
    return (
      await this.db.query(
        "SELECT * FROM notice_resolved_field WHERE notice_id = $1 ORDER BY ordinal ASC",
        [id],
      )
    ).rows;
  }

  private async packArtifacts(submissionId: string) {
    return (
      await this.db.query(
        "SELECT * FROM notice_pack_artifact WHERE submission_id = $1 ORDER BY kind ASC",
        [submissionId],
      )
    ).rows;
  }

  private async markWindow(key: string, value: string) {
    const existing = (
      await this.db.query("SELECT key FROM application_setting WHERE key = $1", [
        key,
      ])
    ).rows[0];
    if (existing) {
      await this.db.query(
        "UPDATE application_setting SET value = $2 WHERE key = $1",
        [key, value],
      );
      return;
    }
    await this.db.query(
      "INSERT INTO application_setting (key, value) VALUES ($1, $2)",
      [key, value],
    );
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

function evidenceSummary(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    reason: String(row.reason),
    outcome: String(row.outcome),
    observedAt: iso(row.observed_at),
    ...(row.http_status === null || row.http_status === undefined
      ? {}
      : { httpStatus: Number(row.http_status) }),
    ...(row.final_url ? { finalUrl: String(row.final_url) } : {}),
    ...(row.host ? { host: String(row.host) } : {}),
    purged: row.purged_at !== null && row.purged_at !== undefined,
  };
}

function rightsHolderSnapshot(holder: Record<string, unknown>, now: Date) {
  return {
    legalName: String(holder.legal_name),
    country: String(holder.country),
    address: parseObject(holder.address),
    roleMailbox: String(holder.role_mailbox),
    ...(holder.phone ? { phone: String(holder.phone) } : {}),
    capturedAt: now.toISOString(),
  };
}

function profileSnapshot(profile: Record<string, unknown>, now: Date) {
  return {
    profileId: String(profile.id),
    version: Number(profile.version),
    channel: String(profile.channel),
    account: String(profile.account),
    ...(profile.form_url ? { formUrl: String(profile.form_url) } : {}),
    ...(profile.max_urls_per_notice
      ? { maxUrlsPerNotice: Number(profile.max_urls_per_notice) }
      : {}),
    ...(profile.max_urls_per_file
      ? { maxUrlsPerFile: Number(profile.max_urls_per_file) }
      : {}),
    capturedAt: now.toISOString(),
  };
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function escapeMarkdown(value: string) {
  return value.replaceAll("|", "\\|");
}

function uploadFile(
  notice: Record<string, unknown>,
  entries: Array<{ title: string; url: string }>,
) {
  if (String(notice.recipient) === "yandex") {
    return undefined;
  }
  const byTitle = new Map<string, string[]>();
  for (const entry of entries) {
    byTitle.set(entry.title, [...(byTitle.get(entry.title) ?? []), entry.url]);
  }
  const lines = [];
  for (const [title, urls] of byTitle) {
    if (String(notice.recipient) === "google") {
      lines.push(`# ${escapeMarkdown(title)}`);
    }
    lines.push(...[...new Set(urls)]);
  }
  return `${lines.join("\n")}\n`;
}

function handoffMarkdown(
  notice: Record<string, unknown>,
  content: Record<string, unknown>,
  flags: Array<Record<string, unknown>>,
  packLanguage: string,
  formUrl: string,
  fields: Array<Record<string, unknown>>,
) {
  const statements = (content.statements ?? []) as Array<Record<string, unknown>>;
  const checklist =
    packLanguage === "ru"
      ? ["Откройте форму получателя.", "Скопируйте поля из fields.json.", "Отметьте каждое заявление.", "Отправьте и запишите ответ."]
      : ["Open the recipient form.", "Copy the fields from fields.json.", "Tick every statement.", "File and record the recipient's answer."];
  const recipient = String(notice.recipient);
  const signIn =
    recipient === "google"
      ? "Sign in with the Google account in the profile."
      : recipient === "bing"
        ? "No sign-in is required; provide the contact mailbox."
        : "Open the Yandex form.";
  const acknowledgement =
    recipient === "google"
      ? "Return the reference number and the Removals Dashboard URL."
      : recipient === "bing"
        ? "Return the TicketId and the ticket-details URL."
        : "Return the reply Message-ID and the reply date.";
  return [
    `# Handoff for ${recipient}`,
    `Form: ${formUrl}`,
    `Sign-in: ${signIn}`,
    "",
    "## Checklist",
    ...checklist.map((step, index) => `${index + 1}. ${step}`),
    "",
    "## Fields",
    ...fields.map((field) => `- ${field.name}: ${field.value}`),
    "",
    "## Statements",
    ...statements.map((statement) => `- ${statement.text}`),
    "",
    "## Acknowledgement",
    acknowledgement,
    "",
    "## Capture flags",
    ...flags.map(
      (flag) =>
        `- ${flag.url}: ${flag.newestOutcome}${flag.earlierLiveEvidenceId ? " (earlier live capture available)" : ""}`,
    ),
  ].join("\n");
}
