namespace Patrol.Domain;

// Discovery: the scan, its query plan, the result rows, the candidate pair, and
// the review decision that confirms or dismisses it.

@doc("One execution of discovery for one title group on one engine.")
model Scan {
  @doc("Patrol's own identifier.")
  id: ScanId;

  @doc("The title group the scan targets.")
  titleGroupId: TitleGroupId;

  @doc("The one engine the scan issues queries against.")
  engine: Engine;

  @doc("Why the scan ran.")
  trigger: ScanTrigger;

  @doc("The UTC date the scan is due on. A scan is idempotent on title group, engine, and due date.")
  dueDate: plainDate;

  @doc("The operator who requested a manual scan or re-check.")
  requestedBy?: OperatorId;

  @doc("The number of queries the plan issues. Priced before the scan starts.")
  @minValue(0)
  plannedQueries: int32;

  @doc("The plan derived when the scan starts. Absent while the scan is queued and before the plan exists.")
  queryPlan?: QueryPlan;

  @doc("When the scan row was created.")
  createdAt: utcDateTime;

  @doc("The scan's lifecycle state.")
  lifecycle: ScanLifecycle;
}

@doc("The scan state machine. Each state carries exactly the fields that state can have.")
union ScanLifecycle {
  @doc("Queued and not started, possibly waiting for budget or a slot.")
  QueuedScan,

  @doc("Running now.")
  RunningScan,

  @doc("Every query answered.")
  SucceededScan,

  @doc("At least one query answered and at least one failed.")
  PartialScan,

  @doc("No query answered, or the route was unavailable.")
  FailedScan,
}

@doc("A scan waiting to start.")
model QueuedScan {
  @doc("The literal state discriminator.")
  state: "queued";

  @doc("When the scan was queued.")
  queuedAt: utcDateTime;

  @doc("Why the scan is still queued, when it is waiting rather than next in line.")
  queuedReason?: ScanFailureReason;
}

@doc("A scan that is running.")
model RunningScan {
  @doc("The literal state discriminator.")
  state: "running";

  @doc("When the scan started.")
  startedAt: utcDateTime;
}

@doc("A scan whose every query answered.")
model SucceededScan {
  @doc("The literal state discriminator.")
  state: "succeeded";

  @doc("When the scan started.")
  startedAt: utcDateTime;

  @doc("When the scan finished.")
  finishedAt: utcDateTime;

  @doc("How many queries were actually issued.")
  @minValue(0)
  issuedQueries: int32;
}

@doc("A scan where some queries answered and some failed.")
model PartialScan {
  @doc("The literal state discriminator.")
  state: "partial";

  @doc("When the scan started.")
  startedAt: utcDateTime;

  @doc("When the scan finished.")
  finishedAt: utcDateTime;

  @doc("How many queries were actually issued.")
  @minValue(0)
  issuedQueries: int32;

  @doc("The queries that failed, with their reasons.")
  failures: QueryFailure[];
}

@doc("A scan where no query answered.")
model FailedScan {
  @doc("The literal state discriminator.")
  state: "failed";

  @doc("When the scan started, when it started at all.")
  startedAt?: utcDateTime;

  @doc("When the scan failed.")
  finishedAt: utcDateTime;

  @doc("Why the scan failed.")
  failureReason: ScanFailureReason;

  @doc("The queries that failed, where there were any.")
  failures?: QueryFailure[];
}

@doc("One failed query inside a scan.")
model QueryFailure {
  @doc("The query that failed.")
  queryId: SearchQueryId;

  @doc("The provider's error class or the adapter's reason.")
  reason: string;

  @doc("How many attempts the query consumed.")
  @minValue(0)
  attempts: int32;
}

@doc("The set of search queries one scan issues for one title group on one engine, derived when the scan starts.")
model QueryPlan {
  @doc("When the plan was derived.")
  generatedAt: utcDateTime;

  @doc("The queries in plan order. The plan never outlives its scan.")
  queries: SearchQuery[];
}

@doc("One query issued inside a scan, generated from a title variant for one tracked title and one locale.")
model SearchQuery {
  @doc("Patrol's own identifier for the query.")
  id: SearchQueryId;

  @doc("The tracked title the query was generated for.")
  trackedTitleId: TrackedTitleId;

  @doc("The locale the query was issued in.")
  locale: Locale;

  @doc("Whether the query is a bare variant or a display title plus an intent phrase.")
  kind: QueryKind;

  @doc("The exact text issued, after any length cap was applied.")
  text: string;

  @doc("The variant the query was generated from, present for a variant query.")
  variantId?: TitleVariantId;

  @doc("The intent phrase appended, present for an intent query.")
  intentPhrase?: IntentPhrase;
}

@doc("One ranked row returned for a search query. Never edited.")
model SearchResult {
  @doc("Patrol's own identifier.")
  id: SearchResultId;

  @doc("The scan that issued the query.")
  scanId: ScanId;

  @doc("The query that produced the row.")
  queryId: SearchQueryId;

  @doc("The engine that returned the row.")
  engine: Engine;

  @doc("The raw URL the engine returned, stored verbatim as provenance.")
  url: Url;

  @doc("The URL's deduplication key.")
  normalizedUrl: NormalizedUrl;

  @doc("The row's rank in the result set.")
  @minValue(1)
  rank: int32;

  @doc("The result title as the engine returned it.")
  title: string;

  @doc("The result snippet as the engine returned it.")
  snippet: string;

  @doc("The locale the query was issued in.")
  locale: Locale;

  @doc("The territory the query targeted, when one applied.")
  territory?: Territory;

  @doc("When the engine observed the row.")
  observedAt: utcDateTime;

  @doc("A reference to the stored vendor response, so the observation can be reproduced without re-querying.")
  rawPayloadRef: string;

  @doc("The row's host.")
  host: Host;

  @doc("The row's registrable domain.")
  registrableDomain: RegistrableDomain;

  @doc("The candidate this row was paired into, when the pair had not been dismissed.")
  candidateId?: CandidateId;
}

@doc("A URL paired with one tracked title, surfaced by at least one search result and not yet confirmed as a violation.")
model Candidate {
  @doc("Patrol's own identifier.")
  id: CandidateId;

  @doc("The tracked title the URL is paired with.")
  trackedTitleId: TrackedTitleId;

  @doc("The raw URL of the first observation.")
  url: Url;

  @doc("The URL's deduplication key. A candidate deduplicates across queries and engines on this key and the tracked title.")
  normalizedUrl: NormalizedUrl;

  @doc("The landing page's host after redirects.")
  host: Host;

  @doc("The landing page's registrable domain.")
  registrableDomain: RegistrableDomain;

  @doc("The variant whose query surfaced the candidate.")
  matchedVariantId: TitleVariantId;

  @doc("The matched variant as it was at observation time.")
  matchedVariant: VariantSnapshot;

  @doc("The candidate's score out of one.")
  @minValue(0)
  @maxValue(1)
  score: float32;

  @doc("Every score component, recorded so a decision can be reproduced.")
  scoreComponents: ScoreComponents;

  @doc("The host's reputation at scoring time.")
  reputation: ReputationSnapshot;

  @doc("The allowlist entry that hit this URL, when one did. An allowlisted URL is never captured.")
  allowlistEntryId?: AllowlistEntryId;

  @doc("When the pair was first observed.")
  firstObservedAt: utcDateTime;

  @doc("When the pair was last observed.")
  lastObservedAt: utcDateTime;

  @doc("Prior review decisions on this pair, newest first.")
  priorDecisionIds: ReviewDecisionId[];

  @doc("The candidate's lifecycle state.")
  lifecycle: CandidateLifecycle;
}

@doc("The variant fields a candidate needs to explain its match without joining the catalogue.")
model VariantSnapshot {
  @doc("The variant's identifier at observation time.")
  id: TitleVariantId;

  @doc("The variant text.")
  text: string;

  @doc("How the variant relates to the work.")
  kind: TitleVariantKind;

  @doc("The variant's language.")
  language: Locale;

  @doc("The variant's script.")
  script: ScriptCode;

  @doc("The variant's territory, when it is territory-specific.")
  territory?: Territory;
}

@doc("The candidate state machine.")
union CandidateLifecycle {
  @doc("A candidate awaiting a review decision.")
  PendingCandidate,

  @doc("A candidate confirmed as a violation.")
  ConfirmedCandidate,

  @doc("A candidate dismissed by a review decision.")
  DismissedCandidate,
}

@doc("A candidate awaiting review.")
model PendingCandidate {
  @doc("The literal state discriminator.")
  state: "pending";
}

@doc("A candidate confirmed as a violation.")
model ConfirmedCandidate {
  @doc("The literal state discriminator.")
  state: "confirmed";

  @doc("The decision that created the violation.")
  reviewDecisionId: ReviewDecisionId;

  @doc("The violation the decision created.")
  violationId: ViolationId;

  @doc("When the violation was confirmed.")
  confirmedAt: utcDateTime;
}

@doc("A candidate dismissed by a review decision.")
model DismissedCandidate {
  @doc("The literal state discriminator.")
  state: "dismissed";

  @doc("The decision that dismissed the pair.")
  reviewDecisionId: ReviewDecisionId;

  @doc("The dismissal, including the scope it suppresses.")
  dismissal: Dismissal;
}

@doc("A dismissal, which suppresses one URL and tracked-title pair only.")
model Dismissal {
  @doc("The review decision that dismissed the pair.")
  action: ReviewDecisionAction;

  @doc("The operator who decided.")
  operatorId: OperatorId;

  @doc("When the operator decided.")
  decidedAt: utcDateTime;

  @doc("The operator's note, when one was recorded.")
  note?: string;

  @doc("The evidence the operator relied on.")
  evidenceIds: EvidenceId[];

  @doc("The correct tracked title, when the decision was wrong work.")
  rematchedTrackedTitleId?: TrackedTitleId;

  @doc("The allowlist entry the decision proposed, when the decision was authorized here.")
  proposedAllowlistEntryId?: AllowlistEntryId;
}

@doc("The score out of one and the components behind it.")
model ScoreComponents {
  @doc("The title-match contribution: 0.70 for an exact variant, 0.60 for a partial or slug match, 0 otherwise.")
  titleMatch: float32;

  @doc("The strong signals that contributed.")
  signals: SignalContribution[];

  @doc("The reputation contribution, at most 0.10 and only alongside a strong signal.")
  reputation: float32;

}

@doc("One strong signal and what it added.")
model SignalContribution {
  @doc("Which signal fired.")
  kind: SignalKind;

  @doc("The score the signal added.")
  value: float32;
}

@doc("A host's reputation, aggregated at the registrable domain.")
model ReputationSnapshot {
  @doc("The registrable domain the reputation belongs to.")
  registrableDomain: RegistrableDomain;

  @doc("Confirmed violations at the domain in the last twelve months.")
  @minValue(0)
  confirmedViolations: int32;

  @doc("The bonus the count earned, before the cap.")
  bonus: float32;

  @doc("Whether a blocklist entry added its small contribution.")
  blocklisted: boolean;
}

@doc("An operator's disposition of a candidate.")
model ReviewDecision {
  @doc("Patrol's own identifier.")
  id: ReviewDecisionId;

  @doc("The candidate decided on.")
  candidateId: CandidateId;

  @doc("The disposition.")
  action: ReviewDecisionAction;

  @doc("The operator who decided.")
  operatorId: OperatorId;

  @doc("When the operator decided.")
  decidedAt: utcDateTime;

  @doc("The operator's note.")
  note?: string;

  @doc("The evidence the operator relied on, pinned at decision time.")
  evidenceIds: EvidenceId[];

  @doc("The violation created, when the action confirms one.")
  violationId?: ViolationId;

  @doc("The correct tracked title, when the action is wrong work.")
  rematchedTrackedTitleId?: TrackedTitleId;

  @doc("The allowlist entry proposed, when the action is authorized here.")
  proposedAllowlistEntryId?: AllowlistEntryId;
}
