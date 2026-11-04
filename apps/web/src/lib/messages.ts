import type { MessageKey } from "@patrol/i18n";

/**
 * Lookup tables for wire values the UI renders through the catalogue:
 * template-literal key building cannot satisfy MessageKey's union, so each
 * enum-to-key map is a const record checked against the union at compile
 * time. A new wire value without a row here fails the build instead of
 * rendering a raw key.
 */

export const TITLE_TYPE_MESSAGES = {
  film: "web.catalogue.titleType.film",
  series: "web.catalogue.titleType.series",
  miniseries: "web.catalogue.titleType.miniseries",
  other: "web.catalogue.titleType.other",
} as const satisfies Record<string, MessageKey>;

export const SOURCE_MESSAGES = {
  rights_holder_record: "web.catalogue.source.rights_holder_record",
  operator_knowledge: "web.catalogue.source.operator_knowledge",
  wikidata: "web.catalogue.source.wikidata",
} as const satisfies Record<string, MessageKey>;

export const VARIANT_KIND_MESSAGES = {
  original: "web.catalogue.variantKind.original",
  localized: "web.catalogue.variantKind.localized",
  transliterated: "web.catalogue.variantKind.transliterated",
  alternate: "web.catalogue.variantKind.alternate",
} as const satisfies Record<string, MessageKey>;

export const PRIORITY_MESSAGES = {
  high: "web.catalogue.priority.high",
  normal: "web.catalogue.priority.normal",
  low: "web.catalogue.priority.low",
} as const satisfies Record<string, MessageKey>;

export const CADENCE_MESSAGES = {
  daily: "web.settings.cadence.daily",
  every_other_day: "web.settings.cadence.every_other_day",
  weekly: "web.settings.cadence.weekly",
} as const satisfies Record<string, MessageKey>;

export const ALLOWLIST_KIND_MESSAGES = {
  official_domain: "web.allowlist.kind.official_domain",
  licensed_destination: "web.allowlist.kind.licensed_destination",
  neutral_source: "web.allowlist.kind.neutral_source",
} as const satisfies Record<string, MessageKey>;

export const ALLOWLIST_MATCH_MESSAGES = {
  host: "web.allowlist.matchKind.host",
  url_prefix: "web.allowlist.matchKind.url_prefix",
} as const satisfies Record<string, MessageKey>;

export const ALLOWLIST_SCOPE_MESSAGES = {
  rights_holder: "web.allowlist.scope.rights_holder",
  title_group: "web.allowlist.scope.title_group",
  tracked_title: "web.allowlist.scope.tracked_title",
} as const satisfies Record<string, MessageKey>;

export const CHANNEL_MESSAGES = {
  web_form: "web.settings.channel.web_form",
  trusted_program: "web.settings.channel.trusted_program",
} as const satisfies Record<string, MessageKey>;

export const TRIGGER_MESSAGES = {
  scheduled: "web.settings.trigger.scheduled",
  on_demand: "web.settings.trigger.on_demand",
} as const satisfies Record<string, MessageKey>;
