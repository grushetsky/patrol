namespace Patrol.Domain;

// Explicit string values only. Implicit TypeSpec enums serialize with member
// names, which makes the wire format an accident of the source.

@doc("The kind of work a tracked title is.")
enum TitleType {
  Film: "film",
  Series: "series",
  Miniseries: "miniseries",
  Other: "other",
}

@doc("How a title variant relates to the work.")
enum TitleVariantKind {
  Original: "original",
  Localized: "localized",
  Transliterated: "transliterated",
  Alternate: "alternate",
}

@doc("Where a catalogue value came from.")
enum CatalogueSource {
  RightsHolderRecord: "rights_holder_record",
  OperatorKnowledge: "operator_knowledge",
  Wikidata: "wikidata",
}

@doc("The external identifier schemes Patrol accepts.")
enum ExternalIdentifierScheme {
  Wikidata: "wikidata",
  Imdb: "imdb",
  Kinopoisk: "kinopoisk",
}

@doc("Why a host or URL prefix is allowed.")
enum AllowlistKind {
  OfficialDomain: "official_domain",
  LicensedDestination: "licensed_destination",
  NeutralSource: "neutral_source",
}

@doc("How an allowlist value matches a URL.")
enum AllowlistMatchKind {
  Host: "host",
  UrlPrefix: "url_prefix",
}

@doc("What an allowlist entry covers.")
enum AllowlistScope {
  RightsHolder: "rights_holder",
  TitleGroup: "title_group",
  TrackedTitle: "tracked_title",
}

@doc("How an allowlist entry came to exist.")
enum AllowlistOrigin {
  Operator: "operator",
  ReviewDecision: "review_decision",
}

@doc("A search source that returns results for a query.")
enum Engine {
  Google: "google",
  Bing: "bing",
  Yandex: "yandex",
}

@doc("An organisation to which Patrol submits notices.")
enum Recipient {
  Google: "google",
  Bing: "bing",
  Yandex: "yandex",
}

@doc("Why a scan ran when it did.")
enum ScanTrigger {
  Scheduled: "scheduled",
  Manual: "manual",
  Recheck: "recheck",
  ManualRecheck: "manual_recheck",
}

@doc("The scan lifecycle states.")
enum ScanState {
  Queued: "queued",
  Running: "running",
  Succeeded: "succeeded",
  Partial: "partial",
  Failed: "failed",
}

@doc("Why a scan did not run, or did not finish cleanly.")
enum ScanFailureReason {
  BudgetExhausted: "budget_exhausted",
  RouteUnavailable: "route_unavailable",
  ProviderError: "provider_error",
  WorkerCrash: "worker_crash",
}

@doc("How a query was generated from a title.")
enum QueryKind {
  Variant: "variant",
  Intent: "intent",
}

@doc("A page property that counts as a strong matching signal.")
enum SignalKind {
  Player: "player",
  Duration: "duration",
  Download: "download",
  Release: "release",
  Episodes: "episodes",
}

@doc("The candidate lifecycle states.")
enum CandidateState {
  Pending: "pending",
  Confirmed: "confirmed",
  Dismissed: "dismissed",
}

@doc("An operator's disposition of a candidate.")
enum ReviewDecisionAction {
  Violation: "violation",
  NotAViolation: "not_a_violation",
  WrongWork: "wrong_work",
  AuthorizedHere: "authorized_here",
  PageDead: "page_dead",
}

@doc("The violation lifecycle states.")
enum ViolationState {
  Open: "open",
  Removed: "removed",
  Closed: "closed",
}

@doc("Why a violation left the open state.")
enum ViolationClosureReason {
  UrlRemoved: "url_removed",
  OperatorClosed: "operator_closed",
}

@doc("Why a capture was taken.")
enum CaptureReason {
  Detection: "detection",
  Review: "review",
  PreHandoff: "pre_handoff",
}

@doc("What a capture observed.")
enum CaptureOutcome {
  Captured: "captured",
  Dead: "dead",
  Blocked: "blocked",
  Error: "error",
}

@doc("Kinds of requests a capture blocks.")
enum ResourceKind {
  Media: "media",
  WebSocket: "websocket",
  ServiceWorker: "service_worker",
  Advertising: "advertising",
  ThirdPartyAnalytics: "third_party_analytics",
}

@doc("Where a violation's host was derived from.")
enum HostSource {
  LandingPage: "landing_page",
  SubmittedUrl: "submitted_url",
}

@doc("The notice lifecycle states.")
enum NoticeState {
  Draft: "draft",
  Approved: "approved",
  Withdrawn: "withdrawn",
  Superseded: "superseded",
}

@doc("The submission lifecycle states.")
enum SubmissionState {
  Pending: "pending",
  Delivered: "delivered",
  Acknowledged: "acknowledged",
  Rejected: "rejected",
  Failed: "failed",
}

@doc("How a notice is handed to a recipient.")
enum RecipientChannel {
  WebForm: "web_form",
  TrustedProgram: "trusted_program",
}

@doc("When a recipient profile composes notice drafts.")
enum CompositionTrigger {
  Scheduled: "scheduled",
  OnDemand: "on_demand",
}

@doc("Why a submission failed or was refused.")
enum SubmissionFailureReason {
  RecipientError: "recipient_error",
  RecipientRejection: "recipient_rejection",
  OperatorReport: "operator_report",
}

@doc("The role an operator account holds.")
enum OperatorRole {
  Administrator: "administrator",
  Operator: "operator",
}

@doc("The state of an operator account.")
enum OperatorState {
  Invited: "invited",
  Active: "active",
  Disabled: "disabled",
}

@doc("The scheduling priority of a title group.")
enum GroupPriority {
  High: "high",
  Normal: "normal",
  Low: "low",
}

@doc("A currency Patrol's acquisition cap supports.")
enum Currency {
  Usd: "usd",
}

@doc("Which share of an engine allowance a reservation draws on.")
enum BudgetBucket {
  Scan: "scan",
  Recheck: "recheck",
}

@doc("The lifecycle of a budget reservation.")
enum ReservationState {
  Held: "held",
  Committed: "committed",
  Released: "released",
  Expired: "expired",
}
