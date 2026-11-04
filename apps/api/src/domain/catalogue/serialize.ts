/**
 * Row types and JSON mappers for the catalogue and settings read models.
 * Every mapper emits the contract's shape (Patrol.Domain models); omitted
 * optionals stay absent rather than null.
 */

export interface TitleGroupRow {
  id: string;
  name: string;
  locales: string[];
  scan_time: string;
  priority: "high" | "normal" | "low";
  created_at: Date;
  updated_at: Date;
}

export interface TrackedTitleRow {
  id: string;
  title_group_id: string;
  release_year: number;
  title_type: "film" | "series" | "miniseries" | "other";
  runtime_minutes: number | null;
  original_variant_id: string | null;
  paused: boolean;
  merged_into_title_id: string | null;
  source: "rights_holder_record" | "operator_knowledge" | "wikidata";
  entered_by: string;
  entered_at: Date;
  updated_by: string;
  created_at: Date;
  updated_at: Date;
}

export interface TitleVariantRow {
  id: string;
  tracked_title_id: string;
  text: string;
  normalized_text: string;
  kind: "original" | "localized" | "transliterated" | "alternate";
  language: string;
  script: string;
  territory: string | null;
  source: "rights_holder_record" | "operator_knowledge" | "wikidata";
  added_by: string;
  added_at: Date;
}

export interface ExternalIdentifierRow {
  id: string;
  tracked_title_id: string;
  scheme: "wikidata" | "imdb" | "kinopoisk";
  value: string;
  source: "rights_holder_record" | "operator_knowledge" | "wikidata";
  retrieved_at: Date;
}

export interface AllowlistEntryRow {
  id: string;
  kind: "official_domain" | "licensed_destination" | "neutral_source";
  match_kind: "host" | "url_prefix";
  value: string;
  scope: "rights_holder" | "title_group" | "tracked_title";
  title_group_id: string | null;
  tracked_title_id: string | null;
  territory: string | null;
  origin: "operator" | "review_decision";
  proposed_by_decision_id: string | null;
  confirmed_by: string;
  confirmed_at: Date;
}

export interface RightsHolderRow {
  id: string;
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
  budget_google_monthly_cap_minor: number;
  budget_yandex_monthly_cap_minor: number;
  budget_bing_monthly_cap_minor: number;
  budget_recheck_share_percent: number;
  created_at: Date;
  updated_at: Date;
}

export interface RecipientProfileRow {
  id: string;
  recipient: "google" | "bing" | "yandex";
  channel: "web_form" | "trusted_program";
  account: string;
  contact_email: string | null;
  composition_trigger: "scheduled" | "on_demand";
  window_time: string | null;
  eligible_territories: string[];
  max_urls_per_notice: number | null;
  max_urls_per_file: number | null;
  max_urls_per_day: number | null;
  last_observed_max_urls_per_file: number | null;
  last_observed_daily_quota: number | null;
  paused: boolean;
  pause_reason: string | null;
  cleared_reason: string | null;
  cleared_by: string | null;
  cleared_at: Date | null;
  recent_window_size: number;
  recent_rejected: number;
  recent_failed: number;
  version: number;
  updated_by: string;
  updated_at: Date;
}

/** A time column as the contract's plainTime: HH:MM:SSZ. */
export function plainTimeJson(value: string): string {
  return `${value}Z`;
}

/** The contract's TitleGroup shape. */
export function titleGroupJson(row: TitleGroupRow): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    locales: row.locales,
    scanTime: plainTimeJson(row.scan_time),
    priority: row.priority,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * The contract's TrackedTitle shape. The display title is not part of it —
 * the detail and card models carry it beside the title — and
 * originalVariantId is omitted rather than faked with "" on the impossible
 * null (a committed title always has its original variant).
 */
export function trackedTitleJson(row: TrackedTitleRow): Record<string, unknown> {
  return {
    id: row.id,
    titleGroupId: row.title_group_id,
    releaseYear: row.release_year,
    titleType: row.title_type,
    ...(row.runtime_minutes !== null
      ? { runtimeMinutes: row.runtime_minutes }
      : {}),
    ...(row.original_variant_id !== null
      ? { originalVariantId: row.original_variant_id }
      : {}),
    paused: row.paused,
    ...(row.merged_into_title_id !== null
      ? { mergedIntoTitleId: row.merged_into_title_id }
      : {}),
    provenance: {
      source: row.source,
      enteredBy: row.entered_by,
      enteredAt: row.entered_at.toISOString(),
      updatedBy: row.updated_by,
    },
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/** The contract's TitleVariant shape. */
export function titleVariantJson(row: TitleVariantRow): Record<string, unknown> {
  return {
    id: row.id,
    trackedTitleId: row.tracked_title_id,
    text: row.text,
    normalizedText: row.normalized_text,
    kind: row.kind,
    language: row.language,
    script: row.script,
    ...(row.territory !== null ? { territory: row.territory } : {}),
    source: row.source,
    addedBy: row.added_by,
    addedAt: row.added_at.toISOString(),
  };
}

/** The contract's VariantSnapshot shape, as the suggestion carries it. */
export function variantSnapshotJson(row: TitleVariantRow): Record<string, unknown> {
  return {
    id: row.id,
    text: row.text,
    kind: row.kind,
    language: row.language,
    script: row.script,
    ...(row.territory !== null ? { territory: row.territory } : {}),
  };
}

/** The contract's ExternalIdentifier shape. */
export function externalIdentifierJson(
  row: ExternalIdentifierRow,
): Record<string, unknown> {
  return {
    id: row.id,
    trackedTitleId: row.tracked_title_id,
    scheme: row.scheme,
    value: row.value,
    source: row.source,
    retrievedAt: row.retrieved_at.toISOString(),
  };
}

/** The contract's AllowlistEntry shape. */
export function allowlistEntryJson(row: AllowlistEntryRow): Record<string, unknown> {
  return {
    id: row.id,
    kind: row.kind,
    matchKind: row.match_kind,
    value: row.value,
    scope: row.scope,
    ...(row.title_group_id !== null ? { titleGroupId: row.title_group_id } : {}),
    ...(row.tracked_title_id !== null
      ? { trackedTitleId: row.tracked_title_id }
      : {}),
    ...(row.territory !== null ? { territory: row.territory } : {}),
    origin: row.origin,
    ...(row.proposed_by_decision_id !== null
      ? { proposedByDecisionId: row.proposed_by_decision_id }
      : {}),
    confirmedBy: row.confirmed_by,
    confirmedAt: row.confirmed_at.toISOString(),
  };
}

/**
 * The contract's RightsHolder shape. Bootstrap records only the legal name
 * and country; the address, contact, and signatory composites appear once
 * settings writes them, and stay absent rather than half-null until then.
 */
export function rightsHolderJson(row: RightsHolderRow): Record<string, unknown> {
  const addressComplete =
    row.address_line1 !== null &&
    row.address_city !== null &&
    row.address_postal_code !== null;
  const signatoryComplete =
    row.signatory_full_legal_name !== null &&
    row.signatory_authority_basis !== null &&
    row.signatory_contact_email !== null;
  return {
    id: row.id,
    legalName: row.legal_name,
    country: row.country,
    ...(addressComplete
      ? {
          address: {
            line1: row.address_line1,
            ...(row.address_line2 !== null ? { line2: row.address_line2 } : {}),
            city: row.address_city,
            ...(row.address_region !== null ? { region: row.address_region } : {}),
            postalCode: row.address_postal_code,
            country: row.country,
          },
        }
      : {}),
    ...(row.role_mailbox !== null ? { roleMailbox: row.role_mailbox } : {}),
    ...(row.phone !== null ? { phone: row.phone } : {}),
    ...(signatoryComplete
      ? {
          signatory: {
            fullLegalName: row.signatory_full_legal_name,
            authorityBasis: row.signatory_authority_basis,
            contactEmail: row.signatory_contact_email,
            ...(row.signatory_contact_phone !== null
              ? { contactPhone: row.signatory_contact_phone }
              : {}),
          },
        }
      : {}),
    acquisitionBudget: {
      engineCaps: [
        {
          engine: "google",
          currency: "usd",
          monthlyCapMinor: row.budget_google_monthly_cap_minor,
        },
        {
          engine: "bing",
          currency: "usd",
          monthlyCapMinor: row.budget_bing_monthly_cap_minor,
        },
        {
          engine: "yandex",
          currency: "usd",
          monthlyCapMinor: row.budget_yandex_monthly_cap_minor,
        },
      ],
      recheckSharePercent: row.budget_recheck_share_percent,
    },
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/** The share of the recent window the pause threshold reads. */
export function thresholdExceeded(row: RecipientProfileRow): boolean {
  if (row.recent_window_size === 0) {
    return false;
  }
  return (row.recent_rejected + row.recent_failed) / row.recent_window_size > 0.1;
}

/** The contract's RecipientProfile shape. */
export function recipientProfileJson(row: RecipientProfileRow): Record<string, unknown> {
  return {
    id: row.id,
    recipient: row.recipient,
    channel: row.channel,
    account: row.account,
    ...(row.contact_email !== null ? { contactEmail: row.contact_email } : {}),
    compositionTrigger: row.composition_trigger,
    ...(row.window_time !== null ? { windowTime: plainTimeJson(row.window_time) } : {}),
    eligibleTerritories: row.eligible_territories,
    ...(row.max_urls_per_notice !== null
      ? { maxUrlsPerNotice: row.max_urls_per_notice }
      : {}),
    ...(row.max_urls_per_file !== null
      ? { maxUrlsPerFile: row.max_urls_per_file }
      : {}),
    ...(row.max_urls_per_day !== null
      ? { maxUrlsPerDay: row.max_urls_per_day }
      : {}),
    ...(row.last_observed_max_urls_per_file !== null
      ? { lastObservedMaxUrlsPerFile: row.last_observed_max_urls_per_file }
      : {}),
    ...(row.last_observed_daily_quota !== null
      ? { lastObservedDailyQuota: row.last_observed_daily_quota }
      : {}),
    paused: row.paused,
    ...(row.pause_reason !== null ? { pauseReason: row.pause_reason } : {}),
    recentSubmissions: {
      windowSize: row.recent_window_size,
      rejected: row.recent_rejected,
      failed: row.recent_failed,
      thresholdExceeded: thresholdExceeded(row),
    },
    version: row.version,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at.toISOString(),
  };
}
