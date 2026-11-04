/** Mapping from database rows to the contract's catalogue shapes. */

export function iso(value: unknown): string {
  return new Date(value as string).toISOString();
}

export function parseArray(value: unknown): string[] {
  if (typeof value !== "string" || value.length === 0) {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export function toTitleGroup(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    name: String(row.name),
    locales: parseArray(row.locales),
    scanTime: String(row.scan_time),
    priority: String(row.priority),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export function toTrackedTitle(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    titleGroupId: String(row.title_group_id),
    releaseYear: Number(row.release_year),
    titleType: String(row.title_type),
    runtimeMinutes:
      row.runtime_minutes === null || row.runtime_minutes === undefined
        ? undefined
        : Number(row.runtime_minutes),
    originalVariantId: String(row.original_variant_id ?? ""),
    paused: Boolean(row.paused),
    mergedIntoTitleId: (row.merged_into_title_id as string | null) ?? undefined,
    provenance: {
      source: String(row.source),
      enteredBy: String(row.entered_by),
      enteredAt: iso(row.entered_at),
      updatedBy: String(row.updated_by),
    },
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export function toTitleVariant(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    trackedTitleId: String(row.tracked_title_id),
    text: String(row.text),
    normalizedText: String(row.normalized_text),
    kind: String(row.kind),
    language: String(row.language),
    script: String(row.script),
    territory: (row.territory as string | null) ?? undefined,
    source: String(row.source),
    addedBy: String(row.added_by),
    addedAt: iso(row.added_at),
  };
}

export function toExternalIdentifier(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    trackedTitleId: String(row.tracked_title_id),
    scheme: String(row.scheme),
    value: String(row.value),
    source: String(row.source),
    retrievedAt: iso(row.retrieved_at),
  };
}

export function toAllowlistEntry(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    kind: String(row.kind),
    matchKind: String(row.match_kind),
    value: String(row.value),
    scope: String(row.scope),
    titleGroupId: (row.title_group_id as string | null) ?? undefined,
    trackedTitleId: (row.tracked_title_id as string | null) ?? undefined,
    territory: (row.territory as string | null) ?? undefined,
    origin: String(row.origin),
    proposedByDecisionId:
      (row.proposed_by_decision_id as string | null) ?? undefined,
    confirmedBy: String(row.confirmed_by),
    confirmedAt: iso(row.confirmed_at),
  };
}

export function toRecipientProfile(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    recipient: String(row.recipient),
    channel: String(row.channel),
    account: String(row.account),
    contactEmail: (row.contact_email as string | null) ?? undefined,
    compositionTrigger: String(row.composition_trigger),
    windowTime: (row.window_time as string | null) ?? undefined,
    eligibleTerritories: parseArray(row.eligible_territories),
    maxUrlsPerNotice:
      row.max_urls_per_notice === null || row.max_urls_per_notice === undefined
        ? undefined
        : Number(row.max_urls_per_notice),
    maxUrlsPerFile:
      row.max_urls_per_file === null || row.max_urls_per_file === undefined
        ? undefined
        : Number(row.max_urls_per_file),
    maxUrlsPerDay:
      row.max_urls_per_day === null || row.max_urls_per_day === undefined
        ? undefined
        : Number(row.max_urls_per_day),
    lastObservedMaxUrlsPerFile: optionalNumber(
      row.last_observed_max_urls_per_file,
    ),
    lastObservedDailyQuota: optionalNumber(row.last_observed_daily_quota),
    paused: Boolean(row.paused),
    pauseReason: (row.pause_reason as string | null) ?? undefined,
    recentSubmissions: {
      windowSize: Number(row.window_size ?? 0),
      rejected: Number(row.rejected ?? 0),
      failed: Number(row.failed ?? 0),
      thresholdExceeded: Boolean(row.threshold_exceeded),
    },
    version: Number(row.version),
    updatedBy: String(row.updated_by),
    updatedAt: iso(row.updated_at),
  };
}

function optionalNumber(value: unknown): number | undefined {
  return value === null || value === undefined ? undefined : Number(value);
}
