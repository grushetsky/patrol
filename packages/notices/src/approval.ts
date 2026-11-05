import type { Pool, PoolClient } from "pg";
import { enqueueCapture } from "@patrol/evidence";
import {
  addressValue,
  resolveNoticeContent,
  type CitationFacts,
  type RightsHolderFacts,
  type TemplateFacts,
} from "./compose.js";
import { createPendingSubmissionIfSettled } from "./submission.js";
import { recipientFormUrl } from "./pack.js";
import type { Recipient } from "./statements.js";

/**
 * Approval (docs/design/notice-composition.md "Approval"; ADR 0021): the
 * attestation that freezes a draft. One transaction holds the whole freeze —
 * the template gates, the second-operator first-five control, the content
 * recomputed from LIVE rights-holder, signatory, and profile reads (a
 * draft's stored values are never trusted as the frozen content), the
 * citation pins refreshed to the captures that exist now (a later capture
 * never changes what an approved notice claims), the three snapshots, the
 * approving operator's language frozen beside them (the pack renders in it
 * whenever it is later built), and the pre-handoff captures queued for URLs
 * whose newest live capture is older than seven days. The submission is
 * created once those captures settle — inline when there was nothing to
 * wait on — as a database row alone; the pack's bytes are the API's to
 * build (the topology grants the object store to it alone).
 */

/** The approval's database, clock, and capture dispatch. */
export interface ApprovalDeps {
  pool: Pool;
  now: () => Date;
  dispatch: (captureId: string) => Promise<void>;
}

/** Every refusal approval can answer, in the API's error vocabulary. */
export type ApprovalRefusal =
  | { status: "absent" }
  | { status: "state_conflict"; currentState: string }
  | { status: "statement_version_mismatch"; noticeVersion: string }
  | { status: "template_absent" }
  | { status: "template_superseded"; newerVersion: string }
  | { status: "template_stale"; lastVerification: string }
  | { status: "second_operator_required" };

export type ApprovalOutcome =
  | {
      status: "approved";
      noticeId: string;
      /** How many pre-handoff captures the approval queued. */
      queuedCaptures: number;
      /** The submission, present when every capture had already settled. */
      submissionId: string | null;
    }
  | { status: "refused"; refusal: ApprovalRefusal };

/** The approving input; the attestations were validated upstream. */
export interface ApprovalInput {
  noticeId: string;
  operatorId: string;
  /** The statement template version the operator confirmed. */
  statementVersion: string;
}

/** The ninety-day approval gate (implementation rules "Approval gate"). */
export const TEMPLATE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

/** The design's second-operator window: a profile's first five notices. */
export const SECOND_OPERATOR_FIRST_NOTICES = 5;

interface NoticeRow {
  id: string;
  recipient: Recipient;
  recipient_profile_id: string;
  channel: "web_form" | "trusted_program";
  state: "draft" | "approved" | "withdrawn" | "superseded";
  template_version: string;
  language: string;
  composed_by: string;
}

/** Reads the live rights holder with its signatory profile. */
async function loadRightsHolder(
  client: PoolClient,
): Promise<
  (RightsHolderFacts & {
    signatoryAuthorityBasis: string | null;
    signatoryContactEmail: string | null;
    signatoryContactPhone: string | null;
    addressLine1: string | null;
    addressLine2: string | null;
    addressCity: string | null;
    addressRegion: string | null;
    addressPostalCode: string | null;
  }) | null
> {
  const result = await client.query<{
    legal_name: string;
    country: string;
    address_line1: string | null;
    address_line2: string | null;
    address_city: string | null;
    address_region: string | null;
    address_postal_code: string | null;
    role_mailbox: string | null;
    phone: string | null;
    signatory_full_legal_name: string | null;
    signatory_authority_basis: string | null;
    signatory_contact_email: string | null;
    signatory_contact_phone: string | null;
  }>(
    `select legal_name, country, address_line1, address_line2, address_city, address_region,
            address_postal_code, role_mailbox, phone, signatory_full_legal_name,
            signatory_authority_basis, signatory_contact_email, signatory_contact_phone
     from rights_holder limit 1`,
  );
  const row = result.rows[0];
  if (row === undefined) {
    return null;
  }
  return {
    legalName: row.legal_name,
    country: row.country,
    address: addressValue(row),
    roleMailbox: row.role_mailbox,
    phone: row.phone,
    signatoryFullLegalName: row.signatory_full_legal_name,
    signatoryAuthorityBasis: row.signatory_authority_basis,
    signatoryContactEmail: row.signatory_contact_email,
    signatoryContactPhone: row.signatory_contact_phone,
    addressLine1: row.address_line1,
    addressLine2: row.address_line2,
    addressCity: row.address_city,
    addressRegion: row.address_region,
    addressPostalCode: row.address_postal_code,
  };
}

/** The citations with the work facts content resolution reads. */
async function loadCitations(
  client: PoolClient,
  noticeId: string,
): Promise<
  Array<
    CitationFacts & {
      violationId: string;
      url: string;
      normalizedUrl: string;
      /** The tracked title's group — the allowlist context's scope. */
      titleGroupId: string;
    }
  >
> {
  const result = await client.query<{
    violation_id: string;
    tracked_title_id: string;
    title_group_id: string;
    url: string;
    normalized_url: string;
    display_title: string;
    release_year: number;
    title_type: CitationFacts["titleType"];
  }>(
    `select c.violation_id, c.tracked_title_id, t.title_group_id, c.url, c.normalized_url,
            ov.text as display_title, t.release_year, t.title_type
     from notice_citations c
     join tracked_titles t on t.id = c.tracked_title_id
     join title_variants ov on ov.id = t.original_variant_id
     where c.notice_id = $1
     order by c.position`,
    [noticeId],
  );
  return result.rows.map((row) => ({
    violationId: row.violation_id,
    trackedTitleId: row.tracked_title_id,
    titleGroupId: row.title_group_id,
    url: row.url,
    normalizedUrl: row.normalized_url,
    displayTitle: row.display_title,
    releaseYear: Number(row.release_year),
    titleType: row.title_type,
  }));
}

/** Refreshes the citation pins from the violation evidence that exists NOW. */
async function repinCitations(
  client: PoolClient,
  noticeId: string,
): Promise<void> {
  const rows = await client.query<{
    violation_id: string;
    evidence: Array<{ evidenceId: string; capturedAt: string; reason: string }>;
  }>(
    `select ve.violation_id, coalesce(jsonb_agg(jsonb_build_object(
              'evidenceId', ve.evidence_id::text,
              'capturedAt', to_char(ve.cited_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
              'reason', ve.role
            ) order by ve.cited_at desc), '[]'::jsonb) as evidence
     from violation_evidence ve
     join notice_citations c on c.violation_id = ve.violation_id
     where c.notice_id = $1
     group by ve.violation_id`,
    [noticeId],
  );
  for (const row of rows.rows) {
    await client.query(
      `update notice_citations set state = 'approved', evidence = $3::jsonb
        where notice_id = $1 and violation_id = $2`,
      [noticeId, row.violation_id, JSON.stringify(row.evidence)],
    );
  }
}

/** Rewrites one child table's rows inside the caller's transaction. */
async function rewriteChildren(
  client: PoolClient,
  noticeId: string,
  table: "notice_resolved_fields" | "notice_work_identifications",
  rows: Array<Record<string, unknown>>,
): Promise<void> {
  await client.query(`delete from ${table} where notice_id = $1`, [noticeId]);
  if (rows.length === 0) {
    return;
  }
  const columns = Object.keys(rows[0]);
  const width = columns.length + 1; // notice_id plus the row's own columns
  const placeholders = rows.map(
    (_, rowIndex) =>
      `(${Array.from({ length: width }, (_, index) => `$${rowIndex * width + index + 1}`).join(", ")})`,
  );
  await client.query(
    `insert into ${table} (${["notice_id", ...columns].join(", ")})
     values ${placeholders.join(", ")}`,
    rows.flatMap((row) => [noticeId, ...columns.map((column) => row[column])]),
  );
}

/**
 * Approves a draft. The whole freeze lands in one transaction; the capture
 * enqueues ride it (a rolled-back approval leaves no queued captures), and
 * the submission is created after the commit when nothing was queued.
 */
export async function approveNotice(
  deps: ApprovalDeps,
  input: ApprovalInput,
): Promise<ApprovalOutcome> {
  const client = await deps.pool.connect();
  try {
    await client.query("begin");
    const outcome = await approveInTransaction(client, deps, input);
    if (outcome.status === "refused") {
      await client.query("rollback");
      return outcome;
    }
    await client.query("commit");

    // The submission, once every queued capture has settled: inline when
    // the approval queued none. The row alone — the pack's bytes are built
    // by the API on the first pack read.
    let submissionId: string | null = null;
    if (outcome.queuedCaptures === 0) {
      const created = await createPendingSubmissionIfSettled(
        { pool: deps.pool, now: deps.now },
        input.noticeId,
      );
      submissionId = created.submissionId;
    }
    return { status: "approved", noticeId: input.noticeId, queuedCaptures: outcome.queuedCaptures, submissionId };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function approveInTransaction(
  client: PoolClient,
  deps: ApprovalDeps,
  input: ApprovalInput,
): Promise<{ status: "approved"; queuedCaptures: number } | { status: "refused"; refusal: ApprovalRefusal }> {
  const noticeResult = await client.query<NoticeRow>(
    `select id, recipient, recipient_profile_id, channel, state, template_version, language, composed_by
     from notices where id = $1 for update`,
    [input.noticeId],
  );
  const notice = noticeResult.rows[0];
  if (notice === undefined) {
    return { status: "refused", refusal: { status: "absent" } };
  }
  if (notice.state !== "draft") {
    return {
      status: "refused",
      refusal: { status: "state_conflict", currentState: notice.state },
    };
  }
  if (input.statementVersion !== notice.template_version) {
    return {
      status: "refused",
      refusal: { status: "statement_version_mismatch", noticeVersion: notice.template_version },
    };
  }

  // The template gates: the set must exist, be the newest revision, and have
  // been verified (or at least read from its sources) inside ninety days.
  const template = await client.query<{
    identifier: string;
    recipient: Recipient;
    language: string;
    major: number;
    active: boolean;
    verified_at: Date | null;
    accessed_at: Date;
    statements: unknown;
    fields: unknown;
  }>(
    `select identifier, recipient, language, major, active, verified_at, accessed_at, statements, fields
     from notice_templates where identifier = $1`,
    [notice.template_version],
  );
  const tpl = template.rows[0];
  if (tpl === undefined || !tpl.active || !Array.isArray(tpl.statements)) {
    return { status: "refused", refusal: { status: "template_absent" } };
  }
  const newer = await client.query<{ identifier: string }>(
    `select identifier from notice_templates
      where recipient = $1 and language = $2 and major > $3 and active
      order by major desc limit 1`,
    [tpl.recipient, tpl.language, tpl.major],
  );
  if (newer.rows.length > 0) {
    return {
      status: "refused",
      refusal: { status: "template_superseded", newerVersion: newer.rows[0].identifier },
    };
  }
  const lastVerification = tpl.verified_at ?? tpl.accessed_at;
  if (deps.now().getTime() - lastVerification.getTime() > TEMPLATE_MAX_AGE_MS) {
    return {
      status: "refused",
      refusal: { status: "template_stale", lastVerification: lastVerification.toISOString() },
    };
  }

  // The second-operator first-five control: among a profile's first five
  // notices, the drafter cannot approve their own draft where a second
  // operator exists. The check applies and is recorded either way.
  const priorNotices = await client.query<{ count: string }>(
    "select count(*) as count from notices where recipient_profile_id = $1 and id <> $2",
    [notice.recipient_profile_id, notice.id],
  );
  const withinFirstFive = Number(priorNotices.rows[0].count) < SECOND_OPERATOR_FIRST_NOTICES;
  const secondOperator = await client.query<{ exists: boolean }>(
    "select exists(select 1 from operators where state = 'active' and id <> $1) as exists",
    [notice.composed_by],
  );
  const secondExists = secondOperator.rows[0].exists;
  if (withinFirstFive && secondExists && input.operatorId === notice.composed_by) {
    return { status: "refused", refusal: { status: "second_operator_required" } };
  }

  // The freeze recomputes the content from LIVE reads.
  const rightsHolder = await loadRightsHolder(client);
  const profileRow = await client.query<{
    id: string;
    version: number;
    channel: "web_form" | "trusted_program";
    account: string;
    max_urls_per_notice: number | null;
    max_urls_per_file: number | null;
  }>(
    `select id, version, channel, account, max_urls_per_notice, max_urls_per_file
     from recipient_profiles where id = $1 for update`,
    [notice.recipient_profile_id],
  );
  const profile = profileRow.rows[0];
  if (rightsHolder === null || profile === undefined) {
    return { status: "refused", refusal: { status: "absent" } };
  }

  const citations = await loadCitations(client, notice.id);
  const content = resolveNoticeContent({
    recipient: notice.recipient,
    template: { identifier: tpl.identifier, statements: tpl.statements as TemplateFacts["statements"] },
    rightsHolder,
    citations,
  });

  await rewriteChildren(
    client,
    notice.id,
    "notice_work_identifications",
    content.workIdentifications.map((work, index) => ({
      tracked_title_id: work.trackedTitleId,
      display_title: work.displayTitle,
      release_year: work.releaseYear,
      title_type: work.titleType,
      position: index,
    })),
  );
  await rewriteChildren(
    client,
    notice.id,
    "notice_resolved_fields",
    content.resolvedFields.map((field, index) => ({
      position: index + 1,
      name: field.name,
      value: field.value,
      required: field.required,
      max_length: field.maxLength ?? null,
    })),
  );

  // The pins refresh to the captures that exist now, and the citations join
  // the approved state (the reservation holds through delivery).
  await repinCitations(client, notice.id);

  // The three snapshots, in the contract's shapes, from the LIVE reads.
  const capturedAt = deps.now().toISOString();
  const rightsHolderSnapshot = {
    legalName: rightsHolder.legalName,
    country: rightsHolder.country,
    address: {
      line1: rightsHolder.addressLine1 ?? "",
      ...(rightsHolder.addressLine2 === null ? {} : { line2: rightsHolder.addressLine2 }),
      city: rightsHolder.addressCity ?? "",
      ...(rightsHolder.addressRegion === null ? {} : { region: rightsHolder.addressRegion }),
      postalCode: rightsHolder.addressPostalCode ?? "",
      country: rightsHolder.country,
    },
    roleMailbox: rightsHolder.roleMailbox ?? "",
    ...(rightsHolder.phone === null ? {} : { phone: rightsHolder.phone }),
    capturedAt,
  };
  const signatorySnapshot = {
    fullLegalName: rightsHolder.signatoryFullLegalName ?? "",
    authorityBasis: rightsHolder.signatoryAuthorityBasis ?? "",
    contactEmail: rightsHolder.signatoryContactEmail ?? "",
    ...(rightsHolder.signatoryContactPhone === null
      ? {}
      : { contactPhone: rightsHolder.signatoryContactPhone }),
    capturedAt,
  };
  const profileSnapshot = {
    profileId: profile.id,
    version: profile.version,
    channel: profile.channel,
    account: profile.account,
    formUrl: recipientFormUrl(notice.recipient),
    ...(profile.max_urls_per_notice === null
      ? {}
      : { maxUrlsPerNotice: profile.max_urls_per_notice }),
    ...(profile.max_urls_per_file === null ? {} : { maxUrlsPerFile: profile.max_urls_per_file }),
    capturedAt,
  };

  // The approver's language, read ONCE here and frozen on the row: the pack
  // renders in it whenever it is built, so a preference change after
  // approval never rewrites the checklist the handoff operator reads.
  const approverLanguage = await client.query<{ preferred_language: "en" | "ru" | null }>(
    "select preferred_language from operators where id = $1",
    [input.operatorId],
  );
  const approvalLanguage = approverLanguage.rows[0]?.preferred_language ?? "en";

  await client.query(
    `update notices set
        state = 'approved',
        approved_by = $2,
        approved_at = $3,
        rights_holder_snapshot = $4::jsonb,
        signatory_snapshot = $5::jsonb,
        profile_snapshot = $6::jsonb,
        second_operator_required = $7,
        approval_language = $8,
        updated_at = $3
      where id = $1`,
    [
      notice.id,
      input.operatorId,
      capturedAt,
      JSON.stringify(rightsHolderSnapshot),
      JSON.stringify(signatorySnapshot),
      JSON.stringify(profileSnapshot),
      withinFirstFive && secondExists,
      approvalLanguage,
    ],
  );

  // The currentStatements attestation stamps the verification the operator
  // just re-read (implementation rules "Verification").
  await client.query(
    `update notice_templates set verified_by = $2, verified_at = $3 where identifier = $1`,
    [tpl.identifier, input.operatorId, capturedAt],
  );

  // The pre-handoff captures: one enqueue per cited URL whose newest live
  // capture is older than seven days. The enqueue's own guards decide; a
  // fresh or refused URL leaves nothing to wait on. Each enqueue carries the
  // citation's title context, so a title-group- or tracked-title-scoped
  // allowlist entry blocks the pre-handoff fetch exactly as it blocked the
  // candidate's formation capture (territory null, as at formation: the
  // pre-handoff observation claims no territory the citation does not).
  let queued = 0;
  const seenUrls = new Set<string>();
  for (const citation of citations) {
    if (seenUrls.has(citation.normalizedUrl)) {
      continue;
    }
    seenUrls.add(citation.normalizedUrl);
    const result = await enqueueCapture(
      { pool: client, now: deps.now, dispatch: deps.dispatch },
      {
        url: citation.url,
        reason: "pre_handoff",
        context: {
          titleGroupId: citation.titleGroupId,
          trackedTitleId: citation.trackedTitleId,
          territory: null,
        },
      },
    );
    const waiting =
      result.status === "queued" ||
      (result.status === "exists" && (result.state === "pending" || result.state === "running"));
    if (!waiting) {
      continue;
    }
    await client.query(
      `insert into notice_pre_handoff_captures (notice_id, capture_id)
       values ($1, $2) on conflict do nothing`,
      [notice.id, result.captureId],
    );
    queued += 1;
  }
  return { status: "approved", queuedCaptures: queued };
}
