import { sql } from "drizzle-orm";
import {
  boolean,
  doublePrecision,
  index,
  integer,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// The identity tables. The migration runner applies the numbered SQL files;
// this schema documents the same shape for drizzle-kit generation.

export const operatorAccount = pgTable(
  "operator_account",
  {
    id: text("id").notNull(),
    email: text("email").notNull(),
    role: text("role").notNull(),
    state: text("state").notNull(),
    preferredLanguage: text("preferred_language"),
    passwordHash: text("password_hash"),
    totpSecret: text("totp_secret"),
    pendingTotpSecret: text("pending_totp_secret"),
    totpEnrolledAt: timestamp("totp_enrolled_at", { withTimezone: true }),
    lastSignInAt: timestamp("last_sign_in_at", { withTimezone: true }),
    failedAttempts: integer("failed_attempts").notNull().default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    disabledBy: text("disabled_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [uniqueIndex("operator_account_email_key").on(table.email)],
);

export const operatorSession = pgTable("operator_session", {
  id: text("id").notNull(),
  operatorId: text("operator_id").notNull(),
  tokenSha256: text("token_sha256").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
  idleExpiresAt: timestamp("idle_expires_at", { withTimezone: true }).notNull(),
  absoluteExpiresAt: timestamp("absolute_expires_at", {
    withTimezone: true,
  }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  userAgent: text("user_agent"),
  coarseIp: text("coarse_ip"),
});

export const rightsHolder = pgTable("rights_holder", {
  id: text("id").notNull(),
  legalName: text("legal_name").notNull(),
  country: text("country").notNull(),
  address: text("address").notNull(),
  roleMailbox: text("role_mailbox").notNull(),
  phone: text("phone"),
  signatoryName: text("signatory_name"),
  signatoryAuthorityBasis: text("signatory_authority_basis"),
  signatoryEmail: text("signatory_email"),
  signatoryPhone: text("signatory_phone"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});

export const invitation = pgTable("invitation", {
  id: text("id").notNull(),
  email: text("email").notNull(),
  role: text("role").notNull(),
  tokenHash: text("token_hash").notNull(),
  invitedBy: text("invited_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

export const recoveryCode = pgTable("recovery_code", {
  id: text("id").notNull(),
  operatorId: text("operator_id").notNull(),
  codeHash: text("code_hash").notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});

export const setupToken = pgTable("setup_token", {
  id: text("id").notNull(),
  tokenHash: text("token_hash").notNull(),
  operatorId: text("operator_id").notNull(),
  purpose: text("purpose").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});

export const enrollmentToken = pgTable("enrollment_token", {
  id: text("id").notNull(),
  tokenHash: text("token_hash").notNull(),
  operatorId: text("operator_id").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});

export const loginChallenge = pgTable("login_challenge", {
  id: text("id").notNull(),
  operatorId: text("operator_id").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});

export const securityEvent = pgTable("security_event", {
  id: text("id").notNull(),
  kind: text("kind").notNull(),
  operatorId: text("operator_id"),
  email: text("email"),
  coarseIp: text("coarse_ip"),
  userAgent: text("user_agent"),
  detail: text("detail"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});

export const identitySchema = {
  operatorAccount,
  operatorSession,
  rightsHolder,
  invitation,
  recoveryCode,
  setupToken,
  enrollmentToken,
  loginChallenge,
  securityEvent,
};

export const titleGroup = pgTable("title_group", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  locales: text("locales").notNull(),
  scanTime: text("scan_time").notNull(),
  priority: text("priority").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});

export const trackedTitle = pgTable("tracked_title", {
  id: text("id").primaryKey(),
  titleGroupId: text("title_group_id").notNull(),
  releaseYear: integer("release_year").notNull(),
  titleType: text("title_type").notNull(),
  runtimeMinutes: integer("runtime_minutes"),
  originalVariantId: text("original_variant_id"),
  paused: boolean("paused").notNull().default(false),
  mergedIntoTitleId: text("merged_into_title_id"),
  source: text("source").notNull(),
  enteredBy: text("entered_by").notNull(),
  enteredAt: timestamp("entered_at", { withTimezone: true }).notNull(),
  updatedBy: text("updated_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});

export const titleVariant = pgTable(
  "title_variant",
  {
    id: text("id").primaryKey(),
    trackedTitleId: text("tracked_title_id").notNull(),
    text: text("text").notNull(),
    normalizedText: text("normalized_text").notNull(),
    kind: text("kind").notNull(),
    language: text("language").notNull(),
    script: text("script").notNull(),
    territory: text("territory"),
    source: text("source").notNull(),
    addedBy: text("added_by").notNull(),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("title_variant_text_key").on(
      table.trackedTitleId,
      table.normalizedText,
    ),
  ],
);

export const externalIdentifier = pgTable(
  "external_identifier",
  {
    id: text("id").primaryKey(),
    trackedTitleId: text("tracked_title_id").notNull(),
    scheme: text("scheme").notNull(),
    value: text("value").notNull(),
    source: text("source").notNull(),
    retrievedAt: timestamp("retrieved_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("external_identifier_scheme_value_key").on(
      table.scheme,
      table.value,
    ),
  ],
);

export const allowlistEntry = pgTable("allowlist_entry", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  matchKind: text("match_kind").notNull(),
  value: text("value").notNull(),
  scope: text("scope").notNull(),
  titleGroupId: text("title_group_id"),
  trackedTitleId: text("tracked_title_id"),
  territory: text("territory"),
  origin: text("origin").notNull(),
  proposedByDecisionId: text("proposed_by_decision_id"),
  confirmedBy: text("confirmed_by").notNull(),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }).notNull(),
  removedBy: text("removed_by"),
  removedAt: timestamp("removed_at", { withTimezone: true }),
});

export const acquisitionBudget = pgTable("acquisition_budget", {
  engine: text("engine").primaryKey(),
  currency: text("currency").notNull(),
  monthlyCapMinor: integer("monthly_cap_minor").notNull(),
});

export const applicationSetting = pgTable("application_setting", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const quotaLedger = pgTable(
  "quota_ledger",
  {
    id: text("id").primaryKey(),
    engine: text("engine").notNull(),
    monthStart: text("month_start").notNull(),
    allowanceUnits: integer("allowance_units").notNull(),
    scanReserved: integer("scan_reserved").notNull(),
    scanCommitted: integer("scan_committed").notNull(),
    recheckReserved: integer("recheck_reserved").notNull(),
    recheckCommitted: integer("recheck_committed").notNull(),
  },
  (table) => [
    uniqueIndex("quota_ledger_month_engine_key").on(
      table.engine,
      table.monthStart,
    ),
  ],
);

export const recipientProfile = pgTable(
  "recipient_profile",
  {
    id: text("id").primaryKey(),
    recipient: text("recipient").notNull(),
    channel: text("channel").notNull(),
    account: text("account").notNull(),
    contactEmail: text("contact_email"),
    compositionTrigger: text("composition_trigger").notNull(),
    windowTime: text("window_time"),
    eligibleTerritories: text("eligible_territories").notNull(),
    maxUrlsPerNotice: integer("max_urls_per_notice"),
    maxUrlsPerFile: integer("max_urls_per_file"),
    maxUrlsPerDay: integer("max_urls_per_day"),
    formUrl: text("form_url"),
    lastObservedMaxUrlsPerFile: integer("last_observed_max_urls_per_file"),
    lastObservedDailyQuota: integer("last_observed_daily_quota"),
    paused: boolean("paused").notNull().default(false),
    pauseReason: text("pause_reason"),
    version: integer("version").notNull(),
    updatedBy: text("updated_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
    clearedBy: text("cleared_by"),
    clearedAt: timestamp("cleared_at", { withTimezone: true }),
    clearanceReason: text("clearance_reason"),
  },
  (table) => [
    uniqueIndex("recipient_profile_recipient_key").on(table.recipient),
  ],
);

export const submission = pgTable(
  "submission",
  {
    id: text("id").primaryKey(),
    recipientProfileId: text("recipient_profile_id").notNull(),
    state: text("state").notNull(),
    noticeId: text("notice_id"),
    channel: text("channel"),
    packLanguage: text("pack_language"),
    attemptCount: integer("attempt_count").notNull().default(0),
    packRef: text("pack_ref"),
    packSha256: text("pack_sha256"),
    packGeneratedAt: timestamp("pack_generated_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    deliveredBy: text("delivered_by"),
    attestation: text("attestation"),
    acknowledgement: text("acknowledgement"),
    failure: text("failure"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }),
  },
  (table) => [uniqueIndex("submission_notice_key").on(table.noticeId)],
);

export const noticeTemplate = pgTable(
  "notice_template",
  {
    id: text("id").primaryKey(),
    recipient: text("recipient").notNull(),
    language: text("language").notNull(),
    major: integer("major").notNull(),
    hash: text("hash").notNull(),
    statements: text("statements").notNull(),
    sourceUrls: text("source_urls").notNull(),
    accessedAt: timestamp("accessed_at", { withTimezone: true }).notNull(),
    verifiedBy: text("verified_by"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    supersedes: text("supersedes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("notice_template_revision_key").on(
      table.recipient,
      table.language,
      table.major,
    ),
  ],
);

export const notice = pgTable(
  "notice",
  {
    id: text("id").primaryKey(),
    recipient: text("recipient").notNull(),
    recipientProfileId: text("recipient_profile_id").notNull(),
    channel: text("channel").notNull(),
    state: text("state").notNull(),
    templateVersion: text("template_version").notNull(),
    content: text("content"),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
    approvedBy: text("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    rightsHolderSnapshot: text("rights_holder_snapshot"),
    signatorySnapshot: text("signatory_snapshot"),
    profileSnapshot: text("profile_snapshot"),
    packLanguage: text("pack_language"),
    withdrawnBy: text("withdrawn_by"),
    withdrawnAt: timestamp("withdrawn_at", { withTimezone: true }),
    withdrawalReason: text("withdrawal_reason"),
    supersededBy: text("superseded_by"),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    supersededByNoticeId: text("superseded_by_notice_id"),
    secondOperatorCheck: text("second_operator_check"),
  },
  (table) => [
    index("notice_state_idx").on(table.state, table.createdAt),
    index("notice_profile_idx").on(table.recipientProfileId, table.state),
  ],
);

export const noticeCitation = pgTable(
  "notice_citation",
  {
    noticeId: text("notice_id").notNull(),
    violationId: text("violation_id").notNull(),
    evidenceIds: text("evidence_ids").notNull(),
    citedAt: timestamp("cited_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("notice_citation_key").on(table.noticeId, table.violationId),
    index("notice_citation_violation_idx").on(table.violationId),
  ],
);

export const noticeWork = pgTable(
  "notice_work",
  {
    noticeId: text("notice_id").notNull(),
    trackedTitleId: text("tracked_title_id").notNull(),
    displayTitle: text("display_title").notNull(),
    releaseYear: integer("release_year").notNull(),
    titleType: text("title_type").notNull(),
    authorizedExampleUrl: text("authorized_example_url"),
  },
  (table) => [
    uniqueIndex("notice_work_key").on(table.noticeId, table.trackedTitleId),
  ],
);

export const noticeResolvedField = pgTable(
  "notice_resolved_field",
  {
    noticeId: text("notice_id").notNull(),
    ordinal: integer("ordinal").notNull(),
    name: text("name").notNull(),
    value: text("value").notNull(),
    required: boolean("required").notNull(),
    maxLength: integer("max_length"),
  },
  (table) => [
    uniqueIndex("notice_resolved_field_key").on(table.noticeId, table.ordinal),
  ],
);

export const noticeStatement = pgTable(
  "notice_statement",
  {
    noticeId: text("notice_id").notNull(),
    ordinal: integer("ordinal").notNull(),
    key: text("key").notNull(),
    text: text("text").notNull(),
    templateVersion: text("template_version").notNull(),
  },
  (table) => [
    uniqueIndex("notice_statement_key").on(table.noticeId, table.key),
  ],
);

export const noticePackArtifact = pgTable(
  "notice_pack_artifact",
  {
    submissionId: text("submission_id").notNull(),
    kind: text("kind").notNull(),
    fileName: text("file_name").notNull(),
    contentType: text("content_type").notNull(),
    byteSize: integer("byte_size").notNull(),
    sha256: text("sha256").notNull(),
    objectKey: text("object_key").notNull(),
    objectVersion: text("object_version"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("notice_pack_artifact_key").on(table.submissionId, table.kind),
  ],
);

export const candidate = pgTable(
  "candidate",
  {
    id: text("id").primaryKey(),
    trackedTitleId: text("tracked_title_id").notNull(),
    state: text("state").notNull(),
    url: text("url"),
    normalizedUrl: text("normalized_url"),
    finalUrl: text("final_url"),
    host: text("host"),
    registrableDomain: text("registrable_domain"),
    source: text("source"),
    engine: text("engine"),
    rank: integer("rank"),
    queryText: text("query_text"),
    locale: text("locale"),
    territory: text("territory"),
    matchedVariantId: text("matched_variant_id"),
    matchedVariant: text("matched_variant"),
    score: doublePrecision("score"),
    scoreComponents: text("score_components"),
    reputation: text("reputation"),
    allowlistEntryId: text("allowlist_entry_id"),
    firstObservedAt: timestamp("first_observed_at", { withTimezone: true }),
    lastObservedAt: timestamp("last_observed_at", { withTimezone: true }),
    reviewDecisionId: text("review_decision_id"),
    violationId: text("violation_id"),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    episodeMax: integer("episode_max"),
    dismissal: text("dismissal"),
    dismissalSignals: text("dismissal_signals"),
    dismissalEpisodeMax: integer("dismissal_episode_max"),
    dismissalRegistrableDomain: text("dismissal_registrable_domain"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("candidate_pair_key").on(
      table.normalizedUrl,
      table.trackedTitleId,
    ),
    index("candidate_queue_idx").on(
      table.state,
      table.score,
      table.rank,
      table.lastObservedAt,
    ),
  ],
);

export const violation = pgTable(
  "violation",
  {
    id: text("id").primaryKey(),
    trackedTitleId: text("tracked_title_id").notNull(),
    state: text("state").notNull(),
    candidateId: text("candidate_id"),
    reviewDecisionId: text("review_decision_id"),
    url: text("url"),
    normalizedUrl: text("normalized_url"),
    host: text("host"),
    hostSource: text("host_source"),
    registrableDomain: text("registrable_domain"),
    detectedAt: timestamp("detected_at", { withTimezone: true }),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    confirmedBy: text("confirmed_by"),
    predecessorViolationId: text("predecessor_violation_id"),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closureReason: text("closure_reason"),
    closureEvidenceId: text("closure_evidence_id"),
    closedBy: text("closed_by"),
    closureNote: text("closure_note"),
  },
  (table) => [
    uniqueIndex("violation_open_pair_key")
      .on(table.normalizedUrl, table.trackedTitleId)
      .where(sql`state = 'open'`),
    index("violation_state_idx").on(table.state, table.confirmedAt),
  ],
);

export const reviewDecision = pgTable(
  "review_decision",
  {
    id: text("id").primaryKey(),
    candidateId: text("candidate_id").notNull(),
    action: text("action").notNull(),
    operatorId: text("operator_id").notNull(),
    decidedAt: timestamp("decided_at", { withTimezone: true }).notNull(),
    note: text("note"),
    evidenceIds: text("evidence_ids").notNull(),
    violationId: text("violation_id"),
    rematchedTrackedTitleId: text("rematched_tracked_title_id"),
    proposedAllowlistEntryId: text("proposed_allowlist_entry_id"),
    scoreSnapshot: text("score_snapshot"),
    signalsSnapshot: text("signals_snapshot"),
    episodeMax: integer("episode_max"),
    registrableDomain: text("registrable_domain"),
  },
  (table) => [
    index("review_decision_candidate_idx").on(
      table.candidateId,
      table.decidedAt,
    ),
  ],
);

export const violationEvidence = pgTable(
  "violation_evidence",
  {
    violationId: text("violation_id").notNull(),
    evidenceId: text("evidence_id").notNull(),
    role: text("role").notNull(),
    citedAt: timestamp("cited_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("violation_evidence_key").on(
      table.violationId,
      table.evidenceId,
    ),
  ],
);

export const captureRequest = pgTable(
  "capture_request",
  {
    id: text("id").primaryKey(),
    url: text("url").notNull(),
    normalizedUrl: text("normalized_url").notNull(),
    reason: text("reason").notNull(),
    candidateId: text("candidate_id"),
    violationId: text("violation_id"),
    trackedTitleId: text("tracked_title_id"),
    titleGroupId: text("title_group_id"),
    capturePoint: text("capture_point"),
    state: text("state").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    queuedAt: timestamp("queued_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [
    index("capture_request_pending_idx").on(table.state, table.createdAt),
  ],
);

export const blocklist = pgTable("blocklist", {
  domain: text("domain").primaryKey(),
  reason: text("reason"),
  addedAt: timestamp("added_at", { withTimezone: true }).notNull(),
});

export const catalogueSchema = {
  titleGroup,
  trackedTitle,
  titleVariant,
  externalIdentifier,
  allowlistEntry,
  acquisitionBudget,
  applicationSetting,
  quotaLedger,
  recipientProfile,
  submission,
  candidate,
  violation,
};

export const scan = pgTable(
  "scan",
  {
    id: text("id").primaryKey(),
    titleGroupId: text("title_group_id").notNull(),
    engine: text("engine").notNull(),
    trigger: text("trigger").notNull(),
    dueDate: text("due_date").notNull(),
    requestedBy: text("requested_by"),
    trackedTitleId: text("tracked_title_id"),
    plannedQueries: integer("planned_queries").notNull().default(0),
    queryPlan: text("query_plan"),
    state: text("state").notNull(),
    queuedAt: timestamp("queued_at", { withTimezone: true }).notNull(),
    queuedReason: text("queued_reason"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    issuedQueries: integer("issued_queries"),
    failureReason: text("failure_reason"),
    failures: text("failures"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("scan_identity_key").on(
      table.titleGroupId,
      table.engine,
      table.dueDate,
    ),
  ],
);

export const scanQuery = pgTable("scan_query", {
  id: text("id").primaryKey(),
  scanId: text("scan_id").notNull(),
  trackedTitleId: text("tracked_title_id").notNull(),
  locale: text("locale").notNull(),
  kind: text("kind").notNull(),
  text: text("text").notNull(),
  variantId: text("variant_id"),
  intentPhraseText: text("intent_phrase_text"),
  intentPhraseVersion: integer("intent_phrase_version"),
  ordinal: integer("ordinal").notNull(),
});

export const searchResult = pgTable("search_result", {
  id: text("id").primaryKey(),
  scanId: text("scan_id").notNull(),
  queryId: text("query_id").notNull(),
  engine: text("engine").notNull(),
  url: text("url").notNull(),
  normalizedUrl: text("normalized_url").notNull(),
  rank: integer("rank").notNull(),
  title: text("title").notNull(),
  snippet: text("snippet").notNull(),
  locale: text("locale").notNull(),
  territory: text("territory"),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
  rawPayloadRef: text("raw_payload_ref").notNull(),
  host: text("host").notNull(),
  registrableDomain: text("registrable_domain").notNull(),
  candidateId: text("candidate_id"),
});

export const serpPayload = pgTable("serp_payload", {
  id: text("id").primaryKey(),
  scanId: text("scan_id").notNull(),
  engine: text("engine").notNull(),
  body: text("body").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});

export const budgetReservation = pgTable("budget_reservation", {
  id: text("id").primaryKey(),
  scanId: text("scan_id").notNull(),
  engine: text("engine").notNull(),
  bucket: text("bucket").notNull(),
  units: integer("units").notNull(),
  monthStart: text("month_start").notNull(),
  state: text("state").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  settledAt: timestamp("settled_at", { withTimezone: true }),
  committedUnits: integer("committed_units"),
  releasedUnits: integer("released_units"),
});

export const recheckSchedule = pgTable(
  "recheck_schedule",
  {
    id: text("id").primaryKey(),
    titleGroupId: text("title_group_id").notNull(),
    engine: text("engine").notNull(),
    rung: integer("rung").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    nextDueAt: timestamp("next_due_at", { withTimezone: true }).notNull(),
    active: boolean("active").notNull(),
    startedByScanId: text("started_by_scan_id"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("recheck_schedule_pair_key").on(
      table.titleGroupId,
      table.engine,
    ),
  ],
);

export const engineRoute = pgTable("engine_route", {
  engine: text("engine").primaryKey(),
  disabledAt: timestamp("disabled_at", { withTimezone: true }),
  disabledReason: text("disabled_reason"),
  lastProbeAt: timestamp("last_probe_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});

export const budgetAlert = pgTable(
  "budget_alert",
  {
    id: text("id").primaryKey(),
    engine: text("engine").notNull(),
    bucket: text("bucket").notNull(),
    threshold: text("threshold").notNull(),
    level: text("level").notNull(),
    percentUsed: real("percent_used").notNull(),
    message: text("message").notNull(),
    groupsNotScanned: integer("groups_not_scanned").notNull(),
    monthStart: text("month_start").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("budget_alert_key").on(
      table.engine,
      table.bucket,
      table.threshold,
      table.monthStart,
    ),
  ],
);

export const intentPhrase = pgTable(
  "intent_phrase",
  {
    id: text("id").primaryKey(),
    locale: text("locale").notNull(),
    text: text("text").notNull(),
    version: integer("version").notNull(),
  },
  (table) => [uniqueIndex("intent_phrase_text_key").on(table.locale, table.text)],
);

export const schedulingSchema = {
  scan,
  scanQuery,
  searchResult,
  serpPayload,
  budgetReservation,
  recheckSchedule,
  engineRoute,
  budgetAlert,
  intentPhrase,
};

export const evidence = pgTable("evidence", {
  id: text("id").primaryKey(),
  trackedTitleId: text("tracked_title_id"),
  titleGroupId: text("title_group_id"),
  requestedUrl: text("requested_url").notNull(),
  normalizedRequestedUrl: text("normalized_requested_url").notNull(),
  redirectChain: text("redirect_chain").notNull(),
  finalUrl: text("final_url"),
  host: text("host"),
  hostSource: text("host_source"),
  reason: text("reason").notNull(),
  capturePoint: text("capture_point"),
  outcome: text("outcome").notNull(),
  httpStatus: integer("http_status"),
  failureReason: text("failure_reason"),
  attemptNumber: integer("attempt_number").notNull(),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
  profile: text("profile").notNull(),
  purgedAt: timestamp("purged_at", { withTimezone: true }),
  purgeReason: text("purge_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});

export const evidenceArtifact = pgTable(
  "evidence_artifact",
  {
    evidenceId: text("evidence_id").notNull(),
    kind: text("kind").notNull(),
    sha256: text("sha256").notNull(),
    byteSize: integer("byte_size").notNull(),
    contentType: text("content_type").notNull(),
    width: integer("width"),
    height: integer("height"),
    truncated: boolean("truncated").notNull(),
    objectKey: text("object_key").notNull(),
    objectVersion: text("object_version"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("evidence_artifact_key").on(
      table.evidenceId,
      table.kind,
      table.sha256,
    ),
  ],
);

export const hostObjection = pgTable("host_objection", {
  id: text("id").primaryKey(),
  host: text("host").notNull(),
  registrableDomain: text("registrable_domain").notNull(),
  reason: text("reason").notNull(),
  source: text("source").notNull(),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
  recordedBy: text("recorded_by"),
  affectedCandidateCount: integer("affected_candidate_count").notNull(),
  clearedAt: timestamp("cleared_at", { withTimezone: true }),
  clearedBy: text("cleared_by"),
  clearanceReason: text("clearance_reason"),
});

export const evidenceSchema = {
  evidence,
  evidenceArtifact,
  hostObjection,
};
