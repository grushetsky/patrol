export { normalizeTitleText } from "./title.js";
export { hostForUrl, normalizeUrlKey, registrableDomainFor, registrableDomainForUrl } from "./url.js";
export {
  DEFAULT_INTENT_PHRASES,
  GOOGLE_DEPTH,
  QUERY_LENGTH_CAPS,
  UNITS_PER_QUERY,
  YANDEX_DOCS_IN_GROUP,
  YANDEX_GROUP_MODE,
  YANDEX_GROUPS_ON_PAGE,
  buildPlan,
  eligibleVariants,
  languageOf,
  localeRequestParams,
  pricePlan,
  sanitizeQueryText,
  truncateAtWordBoundary,
} from "./plan.js";
export type {
  BuiltPlan,
  IntentPhraseConfig,
  PlanEngine,
  PlanTitle,
  PlanVariant,
  PlannableVariantKind,
  PlannedQuery,
  PlannedQueryKind,
  LocaleRequestParams,
} from "./plan.js";
export {
  LADDER_RUNG_DAYS,
  degradationPolicy,
  orderQueue,
  rungDueAt,
  utcDate,
} from "./scheduling.js";
export type {
  DegradationPolicy,
  GroupPriorityName,
  QueueEntry,
  ScanTriggerName,
} from "./scheduling.js";
export { CAPTURE_QUEUE_NAME, ENGINE_QUEUE_NAMES } from "./queues.js";
export type { EngineQueueName } from "./queues.js";
export {
  ALLOWLIST_TIER_ORDER,
  allowlistTier,
  entryAppliesInTitleContext,
  entryMatchesUrl,
  findAllowlistHit,
  normalizeAllowlistValue,
} from "./allowlist.js";
export type {
  AllowlistHit,
  AllowlistKind,
  AllowlistMatchKind,
  AllowlistOrigin,
  AllowlistScope,
  AllowlistTier,
  AllowlistTitleContext,
} from "./allowlist.js";
export { matchingKey, normalizeForMatching } from "./matching/normalizer.js";
export {
  EXACT_MATCH_SCORE,
  NO_MATCH_SCORE,
  PARTIAL_MATCH_SCORE,
  bestVariantMatch,
  containsCompleteTokenSequence,
  matchVariant,
  urlSlugKey,
} from "./matching/matcher.js";
export type {
  MatchablePage,
  MatchableVariant,
  TitleMatch,
  TitleMatchKind,
} from "./matching/matcher.js";
export { isoDurationSeconds, isPlayerFrameUrl, parseSidecar } from "./matching/sidecar.js";
export type { PageFacts } from "./matching/sidecar.js";
export {
  DURATION_TOLERANCE,
  SEASON_EPISODE_THRESHOLD,
  evaluateSignals,
} from "./matching/signals.js";
export type {
  FiredSignal,
  SignalEvaluationInput,
  SignalKind,
} from "./matching/signals.js";
export {
  BLOCKLIST_BONUS,
  REPUTATION_CAP,
  reputationContribution,
  reputationSnapshot,
} from "./matching/reputation.js";
export type { ReputationSnapshot } from "./matching/reputation.js";
export {
  ADDITIONAL_SIGNAL_WEIGHT,
  DEFAULT_BAND_BOUNDARIES,
  FIRST_SIGNAL_WEIGHT,
  SIGNALS_CAP,
  assembleScore,
  bandForScore,
  roundScore,
} from "./matching/score.js";
export type {
  AssembledScore,
  BandBoundaries,
  ScoreBand,
  ScoreComponents,
} from "./matching/score.js";
export {
  candidateDedupKey,
  initialCandidateScore,
  scoreFromPage,
  variantSnapshot,
} from "./matching/formation.js";
export type {
  FormationTitle,
  FormationVariant,
  ReputationFacts,
  ScoredCandidate,
  VariantSnapshot,
} from "./matching/formation.js";
