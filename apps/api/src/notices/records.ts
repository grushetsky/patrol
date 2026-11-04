import { iso } from "../catalogue/records.js";

export function parseObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "string" || value.length === 0) {
    return {};
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function parseObjects(value: unknown): Array<Record<string, unknown>> {
  if (typeof value !== "string" || value.length === 0) {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter(
          (item): item is Record<string, unknown> =>
            item !== null && typeof item === "object" && !Array.isArray(item),
        )
      : [];
  } catch {
    return [];
  }
}

export function noticeLifecycle(row: Record<string, unknown>) {
  const state = String(row.state);
  if (state === "approved") {
    return {
      state: "approved",
      approvedBy: String(row.approved_by),
      approvedAt: iso(row.approved_at),
      rightsHolder: parseObject(row.rights_holder_snapshot),
      signatory: parseObject(row.signatory_snapshot),
      profile: parseObject(row.profile_snapshot),
    };
  }
  if (state === "withdrawn") {
    return {
      state: "withdrawn",
      withdrawnBy: String(row.withdrawn_by),
      withdrawnAt: iso(row.withdrawn_at),
      ...(row.withdrawal_reason
        ? { reason: String(row.withdrawal_reason) }
        : {}),
    };
  }
  if (state === "superseded") {
    return {
      state: "superseded",
      supersededBy: String(row.superseded_by),
      supersededAt: iso(row.superseded_at),
      supersededByNoticeId: String(row.superseded_by_notice_id),
    };
  }
  return { state: "draft", updatedAt: iso(row.updated_at ?? row.created_at) };
}

export function noticeContent(
  row: Record<string, unknown>,
  citations: Array<Record<string, unknown>>,
  works: Array<Record<string, unknown>>,
  statements: Array<Record<string, unknown>>,
  fields: Array<Record<string, unknown>>,
) {
  const frozen = parseObject(row.content);
  if (Object.keys(frozen).length > 0) {
    return frozen;
  }
  return {
    recipient: String(row.recipient),
    recipientProfileId: String(row.recipient_profile_id),
    channel: String(row.channel),
    citedViolations: citations.map((citation) => ({
      violationId: String(citation.violation_id),
      evidence: parseObjects(citation.evidence_ids).map((evidence) => ({
        evidenceId: String(evidence.evidenceId),
        capturedAt: String(evidence.capturedAt),
        reason: String(evidence.reason),
      })),
    })),
    workIdentifications: works.map((work) => ({
      trackedTitleId: String(work.tracked_title_id),
      displayTitle: String(work.display_title),
      releaseYear: Number(work.release_year),
      titleType: String(work.title_type),
      ...(work.authorized_example_url
        ? { authorizedExampleUrl: String(work.authorized_example_url) }
        : {}),
    })),
    statements: statements
      .slice()
      .sort((left, right) => Number(left.ordinal) - Number(right.ordinal))
      .map((statement) => ({
        key: String(statement.key),
        text: String(statement.text),
        templateVersion: String(statement.template_version),
      })),
    resolvedFields: fields
      .slice()
      .sort((left, right) => Number(left.ordinal) - Number(right.ordinal))
      .map((field) => ({
        name: String(field.name),
        value: String(field.value),
        required: Boolean(field.required),
        ...(field.max_length === null || field.max_length === undefined
          ? {}
          : { maxLength: Number(field.max_length) }),
      })),
    templateVersion: String(row.template_version),
  };
}

export function toNotice(
  row: Record<string, unknown>,
  citations: Array<Record<string, unknown>> = [],
  works: Array<Record<string, unknown>> = [],
  statements: Array<Record<string, unknown>> = [],
  fields: Array<Record<string, unknown>> = [],
) {
  return {
    id: String(row.id),
    content: noticeContent(row, citations, works, statements, fields),
    createdBy: String(row.created_by),
    createdAt: iso(row.created_at),
    lifecycle: noticeLifecycle(row),
  };
}

export function noticeStatus(
  noticeRow: Record<string, unknown>,
  submissionRow: Record<string, unknown> | undefined,
): string {
  const noticeState = String(noticeRow.state);
  if (noticeState === "withdrawn" || noticeState === "superseded") {
    return noticeState;
  }
  if (noticeState === "draft") {
    return "draft";
  }
  if (!submissionRow) {
    return "approved";
  }
  const submissionState = String(submissionRow.state);
  return submissionState === "pending" ? "approved" : submissionState;
}

export function submissionLifecycle(row: Record<string, unknown>) {
  const state = String(row.state);
  if (state === "delivered") {
    return {
      state: "delivered",
      operatorId: String(row.delivered_by),
      deliveredAt: iso(row.delivered_at),
      attestation: parseObject(row.attestation),
    };
  }
  if (state === "acknowledged") {
    return {
      state: "acknowledged",
      operatorId: String(row.delivered_by),
      deliveredAt: iso(row.delivered_at),
      attestation: parseObject(row.attestation),
      acknowledgement: parseObject(row.acknowledgement),
    };
  }
  if (state === "rejected") {
    return {
      state: "rejected",
      operatorId: String(row.delivered_by),
      decidedAt: iso(row.updated_at ?? row.created_at),
      failure: parseObject(row.failure),
    };
  }
  if (state === "failed") {
    return {
      state: "failed",
      operatorId: String(row.delivered_by),
      failedAt: iso(row.updated_at ?? row.created_at),
      failure: parseObject(row.failure),
    };
  }
  return { state: "pending" };
}

export function toSubmission(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    noticeId: String(row.notice_id),
    channel: String(row.channel),
    recipientProfileId: String(row.recipient_profile_id),
    packLanguage: String(row.pack_language),
    attemptCount: Number(row.attempt_count ?? 0),
    ...(row.pack_ref ? { packRef: String(row.pack_ref) } : {}),
    ...(row.pack_sha256 ? { packSha256: String(row.pack_sha256) } : {}),
    createdAt: iso(row.created_at),
    ...(row.cancelled_at ? { cancelledAt: iso(row.cancelled_at) } : {}),
    lifecycle: submissionLifecycle(row),
  };
}

export function toNoticeCard(
  row: Record<string, unknown>,
  status: string,
  packAvailable: boolean,
) {
  const signatory = parseObject(row.signatory_snapshot);
  return {
    id: String(row.id),
    recipient: String(row.recipient),
    violationCount: Number(row.violation_count ?? 0),
    ...(signatory.fullLegalName
      ? { signatoryName: String(signatory.fullLegalName) }
      : {}),
    createdAt: iso(row.created_at),
    status,
    packAvailable,
  };
}

export function toNoticeRef(
  row: Record<string, unknown>,
  status: string,
) {
  return {
    id: String(row.id),
    recipient: String(row.recipient),
    status,
    createdAt: iso(row.created_at),
  };
}
