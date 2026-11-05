import type { Pool } from "pg";
import { ApiError } from "../../errors.js";
import { pageParams } from "../../routes/support.js";
import { violationJson } from "../review/serialize.js";
import { mapViolation } from "@patrol/scans";

/**
 * The Notices interface's read models (Patrol.Http `list` and `read`): the
 * card page the notices screen renders, and the detail with the notice's
 * content — cited violations with the pinned evidence, work
 * identification, the statement set with its template version, and the
 * resolved field map. The derived status is the notice's own state in this
 * slice; the submission-derived statuses (delivered, acknowledged,
 * rejected, failed) extend it when submissions land.
 */

/** The contract's NoticeStatus for a notice no submission has moved. */
export function noticeStatus(state: "draft" | "approved" | "withdrawn" | "superseded"): string {
  return state;
}

interface NoticeRow {
  id: string;
  recipient: "google" | "bing" | "yandex";
  recipient_profile_id: string;
  channel: "web_form" | "trusted_program";
  state: "draft" | "approved" | "withdrawn" | "superseded";
  template_version: string;
  language: string;
  composed_at: Date;
  composed_by: string;
  trigger_kind: "scheduled" | "on_demand";
  updated_at: Date | null;
  approved_by: string | null;
  approved_at: Date | null;
  rights_holder_snapshot: Record<string, unknown> | null;
  signatory_snapshot: { fullLegalName?: string } | null;
  profile_snapshot: Record<string, unknown> | null;
  withdrawn_by: string | null;
  withdrawn_at: Date | null;
  withdrawal_reason: string | null;
  superseded_at: Date | null;
  superseded_by_notice_id: string | null;
}

const NOTICE_COLUMNS = `id, recipient, recipient_profile_id, channel, state, template_version,
  language, composed_at, composed_by, trigger_kind, updated_at, approved_by, approved_at,
  rights_holder_snapshot, signatory_snapshot, profile_snapshot, withdrawn_by, withdrawn_at,
  withdrawal_reason, superseded_at, superseded_by_notice_id`;

/** The list filters GET /notices declares. */
export interface NoticeListFilter {
  state?: "draft" | "approved" | "withdrawn" | "superseded";
  recipient?: "google" | "bing" | "yandex";
}

/** GET /notices: the card page, newest first. */
export async function listNotices(
  pool: Pool,
  query: Record<string, unknown>,
): Promise<{
  items: Record<string, unknown>[];
  total: number;
  page: number;
  pageSize: number;
}> {
  const { page, pageSize, limit, offset } = pageParams(query);
  const enumFilter = <T extends string>(value: unknown, allowed: readonly T[]): T | undefined =>
    typeof value === "string" && (allowed as readonly string[]).includes(value)
      ? (value as T)
      : undefined;
  const filter: NoticeListFilter = {
    state: enumFilter(query.state, ["draft", "approved", "withdrawn", "superseded"] as const),
    recipient: enumFilter(query.recipient, ["google", "bing", "yandex"] as const),
  };

  const conditions: string[] = [];
  const values: unknown[] = [];
  if (filter.state !== undefined) {
    values.push(filter.state);
    conditions.push(`n.state = $${values.length}`);
  }
  if (filter.recipient !== undefined) {
    values.push(filter.recipient);
    conditions.push(`n.recipient = $${values.length}`);
  }
  const where = conditions.length === 0 ? "" : `where ${conditions.join(" and ")}`;

  const rows = await pool.query<NoticeRow & { violation_count: number; signatory_name: string | null }>(
    `select n.id, n.recipient, n.recipient_profile_id, n.channel, n.state, n.template_version,
            n.language, n.composed_at, n.composed_by, n.trigger_kind, n.updated_at, n.approved_by,
            n.approved_at, n.rights_holder_snapshot, n.signatory_snapshot, n.profile_snapshot,
            n.withdrawn_by, n.withdrawn_at, n.withdrawal_reason, n.superseded_at, n.superseded_by_notice_id,
            (select count(*)::int from notice_citations c where c.notice_id = n.id) as violation_count,
            (n.signatory_snapshot ->> 'fullLegalName') as signatory_name
     from notices n ${where}
     order by n.composed_at desc, n.id
     limit $${values.length + 1} offset $${values.length + 2}`,
    [...values, limit, offset],
  );
  const total = await pool.query<{ count: string }>(
    `select count(*) as count from notices n ${where}`,
    values,
  );
  return {
    items: rows.rows.map((row) => ({
      id: row.id,
      recipient: row.recipient,
      violationCount: row.violation_count,
      // The signatory's name reaches the card only once approval snapshots it.
      ...(row.signatory_name === null ? {} : { signatoryName: row.signatory_name }),
      createdAt: row.composed_at.toISOString(),
      status: noticeStatus(row.state),
      // The handoff pack is generated at approval; a draft has none.
      packAvailable: false,
    })),
    total: Number(total.rows[0].count),
    page,
    pageSize,
  };
}

async function readNoticeRow(pool: Pool, noticeId: string): Promise<NoticeRow> {
  const result = await pool.query<NoticeRow>(
    `select ${NOTICE_COLUMNS} from notices where id = $1`,
    [noticeId],
  );
  if (result.rows.length === 0) {
    throw new ApiError(404, "not_found");
  }
  return result.rows[0];
}

/**
 * The contract's NoticeLifecycle union, serialized from the row's columns.
 * The superseded branch's actor is the one piece the row does not hold:
 * 6b's supersession write path records the correcting operator.
 */
type LifecycleJson =
  | { state: "draft"; updatedAt?: string }
  | {
      state: "approved";
      approvedBy: string;
      approvedAt: string;
      rightsHolder: Record<string, unknown>;
      signatory: Record<string, unknown>;
      profile: Record<string, unknown>;
    }
  | { state: "withdrawn"; withdrawnBy: string; withdrawnAt: string; reason?: string }
  | {
      state: "superseded";
      /**
       * The operator who superseded the notice. No 6a write path records
       * one, so the wire shape is untested until 6b; it stands null until
       * the supersession writes it. TODO(slice-6b).
       */
      supersededBy: string | null;
      supersededAt: string;
      supersededByNoticeId: string;
    };

/** The contract's NoticeLifecycle, serialized from the row's columns. */
function lifecycleJson(row: NoticeRow): LifecycleJson {
  switch (row.state) {
    case "draft":
      return {
        state: "draft",
        ...(row.updated_at === null ? {} : { updatedAt: row.updated_at.toISOString() }),
      };
    case "approved":
      return {
        state: "approved",
        approvedBy: row.approved_by!,
        approvedAt: row.approved_at!.toISOString(),
        rightsHolder: row.rights_holder_snapshot!,
        signatory: row.signatory_snapshot!,
        profile: row.profile_snapshot!,
      };
    case "withdrawn":
      return {
        state: "withdrawn",
        withdrawnBy: row.withdrawn_by!,
        withdrawnAt: row.withdrawn_at!.toISOString(),
        ...(row.withdrawal_reason === null ? {} : { reason: row.withdrawal_reason }),
      };
    case "superseded":
      return {
        state: "superseded",
        supersededBy: null,
        supersededAt: row.superseded_at!.toISOString(),
        supersededByNoticeId: row.superseded_by_notice_id!,
      };
  }
}

/** The contract's NoticeTemplateSummary, with the ninety-day stale flag. */
async function templateSummary(
  pool: Pool,
  row: NoticeRow,
  now: () => Date,
): Promise<Record<string, unknown>> {
  const template = await pool.query<{
    identifier: string;
    source_urls: string[];
    accessed_at: Date;
    verified_by: string | null;
    verified_at: Date | null;
    major: number;
  }>(
    `select identifier, source_urls, accessed_at, verified_by, verified_at, major
       from notice_templates where identifier = $1`,
    [row.template_version],
  );
  const tpl = template.rows[0];
  if (tpl === undefined) {
    throw new ApiError(404, "not_found");
  }
  const newer = await pool.query<{ count: string }>(
    `select count(*) as count from notice_templates
      where recipient = (select recipient from notice_templates where identifier = $1)
        and language = (select language from notice_templates where identifier = $1)
        and major > (select major from notice_templates where identifier = $1)`,
    [row.template_version],
  );
  const lastVerification = tpl.verified_at ?? tpl.accessed_at;
  const ninetyDays = 90 * 24 * 60 * 60 * 1000;
  const stale =
    Number(newer.rows[0].count) > 0 || now().getTime() - lastVerification.getTime() > ninetyDays;
  return {
    version: tpl.identifier,
    sourceUrls: tpl.source_urls,
    accessedAt: tpl.accessed_at.toISOString(),
    ...(tpl.verified_by === null ? {} : { verifiedBy: tpl.verified_by }),
    ...(tpl.verified_at === null ? {} : { verifiedAt: tpl.verified_at.toISOString() }),
    stale,
  };
}

/** GET /notices/{id}: the detail with the notice's content and citations. */
export async function readNoticeDetail(
  pool: Pool,
  now: () => Date,
  noticeId: string,
): Promise<Record<string, unknown>> {
  const row = await readNoticeRow(pool, noticeId);

  const citations = await pool.query<{
    violation_id: string;
    position: number;
    evidence: Array<{ evidenceId: string; capturedAt: string; reason: string }>;
  }>(
    "select violation_id, position, evidence from notice_citations where notice_id = $1 order by position",
    [noticeId],
  );

  // The cited violations, joined with the full violation rows the detail
  // carries and the work facts the identifications hold.
  const violationIds = citations.rows.map((citation) => citation.violation_id);
  const violationRows =
    violationIds.length === 0
      ? []
      : (
          await pool.query(
            `select v.*, t.release_year, t.title_type, ov.text as display_title
             from violations v
             join tracked_titles t on t.id = v.tracked_title_id
             join title_variants ov on ov.id = t.original_variant_id
             where v.id = any($1::uuid[])`,
            [violationIds],
          )
        ).rows;
  const violationsById = new Map(
    violationRows.map((raw) => {
      const mapped = mapViolation(raw);
      return [mapped.id, { mapped, raw }];
    }),
  );

  // Evidence summaries for the pinned captures, resolved through the
  // evidence rows the pins name.
  const pinnedIds = citations.rows.flatMap((citation) =>
    citation.evidence.map((entry) => entry.evidenceId),
  );
  const evidenceRows =
    pinnedIds.length === 0
      ? []
      : (
          await pool.query(
            "select * from evidence where id = any($1::uuid[])",
            [pinnedIds],
          )
        ).rows;
  const evidenceById = new Map(evidenceRows.map((raw) => [raw.id as string, raw]));

  const evidenceSummary = (raw: Record<string, unknown>): Record<string, unknown> => ({
    id: raw.id,
    reason: raw.reason,
    outcome: raw.outcome,
    observedAt: (raw.observed_at as Date).toISOString(),
    ...(raw.http_status === null ? {} : { httpStatus: raw.http_status }),
    ...(raw.final_url === null ? {} : { finalUrl: raw.final_url }),
    ...(raw.host === null ? {} : { host: raw.host }),
    purged: raw.purged_at !== null,
  });

  const works = await pool.query<{
    tracked_title_id: string;
    display_title: string;
    release_year: number;
    title_type: string;
    authorized_example_url: string | null;
  }>(
    `select tracked_title_id, display_title, release_year, title_type, authorized_example_url
       from notice_work_identifications where notice_id = $1 order by position`,
    [noticeId],
  );

  const statements = await pool.query<{ key: string; text: string; template_version: string }>(
    "select key, text, template_version from notice_statements where notice_id = $1 order by position",
    [noticeId],
  );

  const fields = await pool.query<{
    name: string;
    value: string;
    required: boolean;
    max_length: number | null;
  }>(
    "select name, value, required, max_length from notice_resolved_fields where notice_id = $1 order by position",
    [noticeId],
  );

  const citedViolations = citations.rows.map((citation) => {
    const entry = violationsById.get(citation.violation_id)!;
    return {
      violation: violationJson(entry.mapped),
      displayTitle: entry.raw.display_title as string,
      releaseYear: Number(entry.raw.release_year),
      titleType: entry.raw.title_type as string,
      evidence: citation.evidence.flatMap((pin) => {
        const raw = evidenceById.get(pin.evidenceId);
        return raw === undefined ? [] : [evidenceSummary(raw)];
      }),
    };
  });

  return {
    notice: {
      id: row.id,
      content: {
        recipient: row.recipient,
        recipientProfileId: row.recipient_profile_id,
        channel: row.channel,
        citedViolations: citations.rows.map((citation) => {
          const pins = citation.evidence;
          return {
            violationId: citation.violation_id,
            evidence: pins.map((pin) => ({
              evidenceId: pin.evidenceId,
              capturedAt: pin.capturedAt,
              reason: pin.reason,
            })),
          };
        }),
        workIdentifications: works.rows.map((work) => ({
          trackedTitleId: work.tracked_title_id,
          displayTitle: work.display_title,
          releaseYear: Number(work.release_year),
          titleType: work.title_type,
          ...(work.authorized_example_url === null
            ? {}
            : { authorizedExampleUrl: work.authorized_example_url }),
        })),
        statements: statements.rows.map((statement) => ({
          key: statement.key,
          text: statement.text,
          templateVersion: statement.template_version,
        })),
        resolvedFields: fields.rows.map((field) => ({
          name: field.name,
          value: field.value,
          required: field.required,
          ...(field.max_length === null ? {} : { maxLength: field.max_length }),
        })),
        templateVersion: row.template_version,
      },
      createdBy: row.composed_by,
      createdAt: row.composed_at.toISOString(),
      lifecycle: lifecycleJson(row),
    },
    status: noticeStatus(row.state),
    citedViolations,
    // The submission and its pack arrive with approval (6b).
    packAvailable: false,
    template: await templateSummary(pool, row, now),
  };
}
