import {
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
