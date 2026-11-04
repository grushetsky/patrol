import {
  boolean,
  integer,
  pgTable,
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

export const submission = pgTable("submission", {
  id: text("id").primaryKey(),
  recipientProfileId: text("recipient_profile_id").notNull(),
  state: text("state").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});

export const candidate = pgTable("candidate", {
  id: text("id").primaryKey(),
  trackedTitleId: text("tracked_title_id").notNull(),
  state: text("state").notNull(),
});

export const violation = pgTable("violation", {
  id: text("id").primaryKey(),
  trackedTitleId: text("tracked_title_id").notNull(),
  state: text("state").notNull(),
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
