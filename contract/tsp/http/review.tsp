namespace Patrol.Http;

using TypeSpec.Http;
using TypeSpec.OpenAPI;
using Patrol.Domain;

// The review queue: candidates, the read model a row needs, the five
// dispositions, reopening, and capture on demand.

@doc("The scoring band a candidate falls into. Band C is suppressed and never reaches the queue.")
enum ScoreBand {
  A: "a",
  B: "b",
  C: "c",
}

@doc("How a candidate came to exist.")
enum CandidateSource {
  Serp: "serp",
  Manual: "manual",
}

@doc("A prior review decision on the pair, shown on the row as a flag.")
model PriorDecisionSummary {
  @doc("The decision's identifier.")
  id: ReviewDecisionId;

  @doc("The disposition the operator chose.")
  action: ReviewDecisionAction;

  @doc("The operator who decided.")
  operatorId: OperatorId;

  @doc("When the operator decided.")
  decidedAt: utcDateTime;

  @doc("The operator's note, when one was recorded.")
  note?: string;
}

@doc("One review-queue row: everything an operator needs to judge a candidate without opening it.")
model CandidateReviewRow {
  @doc("The candidate's identifier.")
  id: CandidateId;

  @doc("The tracked title the URL is paired with.")
  trackedTitleId: TrackedTitleId;

  @doc("The tracked title's display title.")
  displayTitle: string;

  @doc("The tracked title's release year.")
  releaseYear: int32;

  @doc("The tracked title's kind of work.")
  titleType: TitleType;

  @doc("The variant whose query surfaced the pair, frozen at observation time.")
  matchedVariant: VariantSnapshot;

  @doc("The requested URL, stored verbatim.")
  url: Url;

  @doc("The landing page's final URL, when a capture followed redirects.")
  finalUrl?: Url;

  @doc("The landing page's host.")
  host: Host;

  @doc("The landing page's registrable domain.")
  registrableDomain: RegistrableDomain;

  @doc("Whether a search result or an operator's manual entry produced the candidate.")
  source: CandidateSource;

  @doc("The engine whose result first surfaced the pair, absent for a manual entry.")
  engine?: Engine;

  @doc("The result's rank, absent for a manual entry.")
  rank?: int32;

  @doc("The query text that surfaced the pair, absent for a manual entry.")
  queryText?: string;

  @doc("The locale the query was issued in, absent for a manual entry.")
  locale?: Locale;

  @doc("The territory the query targeted, when one applied.")
  territory?: Territory;

  @doc("The candidate's score out of one.")
  score: float32;

  @doc("Every score component, recorded so the decision can be reproduced.")
  scoreComponents: ScoreComponents;

  @doc("The host's reputation at scoring time.")
  reputation: ReputationSnapshot;

  @doc("The allowlist entry that hit this URL, when one did. An allowlisted URL is never captured and cannot be confirmed.")
  allowlistEntry?: AllowlistEntrySummary;

  @doc("The most recent prior decision on this pair, when one exists.")
  priorDecision?: PriorDecisionSummary;

  @doc("The newest capture of the URL, when one exists.")
  newestEvidence?: EvidenceSummary;

  @doc("When the pair was first observed.")
  firstObservedAt: utcDateTime;

  @doc("When the pair was last observed.")
  lastObservedAt: utcDateTime;

  @doc("The candidate's lifecycle state.")
  lifecycle: CandidateLifecycle;
}

@doc("A page of review-queue rows, ordered by score descending, then result rank ascending, then observation time descending.")
model CandidatePage {
  @doc("The rows on this page.")
  items: CandidateReviewRow[];

  @doc("How many candidates match the filter in total.")
  total: int32;

  @doc("The one-based page number.")
  page: int32;

  @doc("The page size.")
  pageSize: int32;
}

@doc("A candidate with its provenance, evidence, prior decisions, and allowlist state.")
model CandidateDetail {
  @doc("The candidate record.")
  candidate: Candidate;

  @doc("The display title of the paired tracked title.")
  displayTitle: string;

  @doc("The paired title's release year.")
  releaseYear: int32;

  @doc("The paired title's kind of work.")
  titleType: TitleType;

  @doc("The search results that observed the pair, newest first.")
  observations: SearchResult[];

  @doc("The captures of the URL, newest first.")
  evidence: EvidenceSummary[];

  @doc("Every review decision recorded on the pair, newest first.")
  decisions: ReviewDecision[];

  @doc("The allowlist entry that hit the URL, when one did.")
  allowlistEntry?: AllowlistEntry;
}

@doc("A URL an operator typed, paired with one tracked title.")
model ManualCandidateRequest {
  @doc("The URL to pair. It must be an absolute HTTP or HTTPS URL.")
  url: Url;

  @doc("The tracked title the URL copies.")
  trackedTitleId: TrackedTitleId;
}

@doc("The new candidate, or the existing one the deduplication key already names.")
model CandidateCreated {
  @statusCode statusCode: 201;
  @body body: Candidate;
}

@doc("One allowlist entry an authorized-here decision proposes.")
model ProposedAllowlistEntry {
  @doc("Why the host or URL prefix is allowed.")
  kind: AllowlistKind;

  @doc("How the value matches a URL.")
  matchKind: AllowlistMatchKind;

  @doc("The host or URL prefix the entry matches.")
  value: string;

  @doc("What the entry covers.")
  scope: AllowlistScope;

  @doc("The title group the entry is scoped to, required when the scope is a title group.")
  titleGroupId?: TitleGroupId;

  @doc("The tracked title the entry is scoped to, required when the scope is a tracked title.")
  trackedTitleId?: TrackedTitleId;

  @doc("The territory the entry applies to. Required for a licensed destination.")
  territory?: Territory;
}

@doc("One operator disposition of a candidate.")
model ReviewDecisionRequest {
  @doc("The disposition.")
  action: ReviewDecisionAction;

  @doc("The operator's note. A note is required for a dismissal.")
  note?: string;

  @doc("The captures the decision relies on. At least one is required.")
  evidenceIds: EvidenceId[];

  @doc("The correct tracked title, required when the action is wrong work.")
  rematchedTrackedTitleId?: TrackedTitleId;

  @doc("The allowlist entry to create, required when the action is authorized here.")
  allowlistEntry?: ProposedAllowlistEntry;
}

@doc("The decision, the candidate's new state, and any violation or allowlist entry the decision created.")
model ReviewDecisionResult {
  @doc("The recorded decision.")
  decision: ReviewDecision;

  @doc("The candidate after the transition.")
  candidate: Candidate;

  @doc("The violation the decision created, present when the action confirms one.")
  violation?: Violation;

  @doc("The allowlist entry the decision created or proposed, present when the action is authorized here.")
  allowlistEntry?: AllowlistEntry;
}

@doc("The decision was recorded.")
model ReviewDecisionRecorded {
  @statusCode statusCode: 201;
  @body body: ReviewDecisionResult;
}

@doc("An operator's reason for reopening a dismissed pair.")
model CandidateReopenRequest {
  @doc("Why the pair should be reviewed again.")
  note?: string;
}

@doc("A capture request for one URL.")
model CaptureRequest {
  @doc("Why the capture is being requested.")
  reason: CaptureReason;
}

@doc("The capture was queued. The evidence row appears when the worker has fetched the URL.")
model CaptureQueued {
  @doc("When the request was accepted.")
  queuedAt: utcDateTime;

  @doc("The reason the capture will record.")
  reason: CaptureReason;
}

@doc("The capture request was accepted.")
model CaptureAccepted {
  @statusCode statusCode: 202;
  @body body: CaptureQueued;
}

@doc("The review queue and the five dispositions a candidate can receive.")
@tag("Review")
@useAuth(SessionCookie)
@route("/candidates")
interface Candidates {
  @doc("The review queue, filtered by state, engine, group, or band. An allowlist hit can be filtered separately.")
  @extension("x-patrol-roles", #["operator", "administrator"])
  @get
  op list(...PageRequest, @query state?: CandidateState, @query titleGroupId?: TitleGroupId, @query engine?: Engine, @query band?: ScoreBand, @query allowlistHit?: boolean, @query hostObjectionId?: HostObjectionId): CandidatePage | ReadErrors;

  @doc("Pair a URL an operator typed with one tracked title. A pair that already exists is returned unchanged.")
  @extension("x-patrol-roles", #["operator", "administrator"])
  @post
  op create(...CsrfToken, @body body: ManualCandidateRequest): Candidate | CandidateCreated | MutationErrors;

  @doc("One candidate with its provenance, evidence, and decisions.")
  @extension("x-patrol-roles", #["operator", "administrator"])
  @get
  @route("/{candidateId}")
  op read(@path candidateId: CandidateId): CandidateDetail | ResourceErrors;

  @doc("Record one of the five dispositions. Confirmation is refused while an allowlist entry hits the URL, and a wrong-work decision requires the correct title.")
  @extension("x-patrol-roles", #["operator", "administrator"])
  @post
  @route("/{candidateId}/review-decisions")
  op decide(...CsrfToken, @path candidateId: CandidateId, @body body: ReviewDecisionRequest): ReviewDecisionRecorded | ResourceMutationErrors;

  @doc("Reopen a dismissed pair so it returns to the queue.")
  @extension("x-patrol-roles", #["operator", "administrator"])
  @post
  @route("/{candidateId}/reopen")
  op reopen(...CsrfToken, @path candidateId: CandidateId, @body body: CandidateReopenRequest): Candidate | ResourceMutationErrors;

  @doc("Queue a capture of the candidate's URL. An allowlisted URL is never captured, and a host under an objection answers 409 with the objection's identifier.")
  @extension("x-patrol-roles", #["operator", "administrator"])
  @post
  @route("/{candidateId}/captures")
  op capture(...CsrfToken, @path candidateId: CandidateId, @body body: CaptureRequest): CaptureAccepted | ResourceMutationErrors;
}
