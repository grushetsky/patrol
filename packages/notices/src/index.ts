export {
  canonicalSetJson,
  canonicalStatementText,
  loadStatementFixtures,
  recipientSlug,
  templateHash12,
  templateIdentifier,
  verifyStatementFixture,
} from "./registry.js";
export type {
  StatementFixture,
  StatementSeed,
  TemplateFieldLabel,
  TemplateSetIdentity,
} from "./registry.js";
export { STATEMENT_SETS, statementSetFor } from "./statements.js";
export type { Recipient, TemplateLanguage, VerifiedStatementSet } from "./statements.js";
export {
  BING_URL_CAP,
  GOOGLE_DEFAULT_URL_CAP,
  fitsSingleNotice,
  googleUrlCap,
  groupViolations,
} from "./grouping.js";
export type { GroupingCaps, GroupingViolation } from "./grouping.js";
export {
  compositionInterval,
  lastWindowOccurrence,
  previousWindowOccurrence,
} from "./window.js";
export {
  ACTIVE_CITATION_STATES,
  NOTICE_LANGUAGE,
  YANDEX_ELIGIBLE_TERRITORIES,
  addressValue,
  checkEligibility,
  composeNotices,
  resolveNoticeContent,
  resolvedFieldsFor,
} from "./compose.js";
export type {
  CitationFacts,
  ComposedNotice,
  ComposeDeps,
  ComposeOutcome,
  ComposeRefusal,
  ComposeSelection,
  NoticeContentInputs,
  ProfileFacts,
  ResolvedFieldSeed,
  ResolvedNoticeContent,
  RightsHolderFacts,
  TemplateFacts,
  WorkIdentificationSeed,
} from "./compose.js";
export { runScheduledComposition } from "./schedule.js";
export type { CompositionWindowOutcome, WindowSkipReason } from "./schedule.js";
