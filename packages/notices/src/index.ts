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
export {
  buildPackFiles,
  packContentKey,
  packManifestHash,
  recipientFormUrl,
  recipientTakesUploadFile,
} from "./pack.js";
export type {
  BuiltPackFile,
  HandoffArtifactKind,
  HandoffPackInput,
  PackCaptureFlag,
  PackCitation,
} from "./pack.js";
export {
  approveNotice,
  SECOND_OPERATOR_FIRST_NOTICES,
  TEMPLATE_MAX_AGE_MS,
} from "./approval.js";
export type { ApprovalDeps, ApprovalInput, ApprovalOutcome, ApprovalRefusal } from "./approval.js";
export {
  buildHandoffPackIfMissing,
  createPendingSubmissionIfSettled,
  loadCaptureFlagsForCitations,
  loadPackInput,
  settlePreHandoffCapture,
  storePackFiles,
  TERMINAL_CAPTURE_STATES,
} from "./submission.js";
export type {
  PackBuildDeps,
  PackBuildOutcome,
  PackStore,
  SettleDeps,
  SubmissionCreation,
} from "./submission.js";
export { withdrawNotice } from "./withdrawal.js";
export type { WithdrawalDeps, WithdrawalInput, WithdrawalOutcome, WithdrawalRefusal } from "./withdrawal.js";
export { supersedeNotice } from "./supersession.js";
export type {
  SupersessionDeps,
  SupersessionInput,
  SupersessionOutcome,
  SupersessionRefusal,
} from "./supersession.js";
export {
  PAUSE_REASON_PREFIX,
  PAUSE_THRESHOLD,
  PAUSE_WINDOW,
  readPauseComputation,
  recomputeProfilePause,
} from "./pause.js";
export type { PauseComputation } from "./pause.js";
