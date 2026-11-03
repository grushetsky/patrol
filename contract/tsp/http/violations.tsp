namespace Patrol.Http;

using TypeSpec.Http;
using TypeSpec.OpenAPI;
using Patrol.Domain;

// Violations, their evidence, and legal holds. A violation is never reopened and
// evidence is never mutated; a correction is a new record.

@doc("One violation as the violations screen renders it.")
model ViolationRow {
  @doc("The violation record.")
  violation: Violation;

  @doc("The tracked title's display title, the heading the row groups under.")
  displayTitle: string;

  @doc("The tracked title's release year.")
  releaseYear: int32;

  @doc("The tracked title's kind of work.")
  titleType: TitleType;

  @doc("The newest capture of the URL, when one exists.")
  newestEvidence?: EvidenceSummary;

  @doc("The notice the violation is cited by, when it is reserved by one.")
  notice?: NoticeRef;
}

@doc("A page of violations, newest first.")
model ViolationPage {
  @doc("The violations on this page.")
  items: ViolationRow[];

  @doc("How many violations match the filter in total.")
  total: int32;

  @doc("The one-based page number.")
  page: int32;

  @doc("The page size.")
  pageSize: int32;
}

@doc("One capture a violation cites and the role it plays.")
model CitedEvidence {
  @doc("The capture as the UI shows it.")
  evidence: EvidenceSummary;

  @doc("Why the capture was taken.")
  role: CaptureReason;

  @doc("When the citation was recorded.")
  citedAt: utcDateTime;
}

@doc("A violation with its evidence citations, decision, and notice attachment.")
model ViolationDetail {
  @doc("The violation record.")
  violation: Violation;

  @doc("The tracked title's display title.")
  displayTitle: string;

  @doc("The tracked title's release year.")
  releaseYear: int32;

  @doc("The tracked title's kind of work.")
  titleType: TitleType;

  @doc("The captures the violation cites, newest first.")
  evidence: CitedEvidence[];

  @doc("The decision that confirmed the violation.")
  decision: ReviewDecision;

  @doc("The notice citing the violation, when one is active.")
  notice?: NoticeRef;

  @doc("The newest capture's outcome, which flags a dead or blocked page at handoff.")
  newestCaptureOutcome?: CaptureOutcome;
}

@doc("Close an open violation after a re-check, or record that its URL stopped serving the copy.")
model ViolationClosureRequest {
  @doc("Why the violation left the open state.")
  reason: ViolationClosureReason;

  @doc("The operator's note. Required when the reason is operator_closed.")
  note?: string;

  @doc("The capture that showed the URL gone, when one exists.")
  evidenceId?: EvidenceId;
}

@doc("A capture's metadata and artifact manifest. Bytes are fetched through a separate signed reference.")
model EvidenceDetail {
  @doc("The capture record.")
  evidence: Evidence;

  @doc("The artifacts the capture produced, without their bytes.")
  artifacts: ArtifactSummary[];

  @doc("Whether the artifact bytes survive retention and can still be downloaded.")
  downloadAvailable: boolean;
}

@doc("A short-lived signed reference to one artifact's bytes, pinned to the content hash.")
model ArtifactDownloadRef {
  @doc("The signed URL to fetch.")
  url: Url;

  @doc("When the signed URL stops working.")
  expiresAt: utcDateTime;

  @doc("The SHA-256 the returned bytes must match.")
  sha256: Sha256;

  @doc("The artifact's content type.")
  contentType: string;
}

@doc("The scope of a legal hold, which suspends every purge it covers.")
model CreateLegalHoldRequest {
  @doc("Why the hold is being placed.")
  reason: string;

  @doc("The captures the hold covers. May be empty.")
  evidenceIds: EvidenceId[];

  @doc("The violations the hold covers. May be empty.")
  violationIds: ViolationId[];

  @doc("The notices the hold covers. May be empty.")
  noticeIds: NoticeId[];
}

@doc("The release of a legal hold.")
model ReleaseLegalHoldRequest {
  @doc("Why the hold is being released.")
  reason: string;
}

@doc("The legal hold was placed.")
model LegalHoldCreated {
  @statusCode statusCode: 201;
  @body body: LegalHold;
}

@doc("A recorded objection that suspends every capture of one host until an operator clears it.")
model HostObjectionPage {
  @doc("The objections on this page, newest first.")
  items: HostObjection[];

  @doc("How many objections match the filter in total.")
  total: int32;

  @doc("The one-based page number.")
  page: int32;

  @doc("The page size.")
  pageSize: int32;
}

@doc("An operator's decision to reopen a host to capture.")
model ClearHostObjectionRequest {
  @doc("Why the host is being reopened. Recorded on the objection.")
  reason: string;
}

@doc("A page of legal holds, newest first.")
model LegalHoldPage {
  @doc("The holds on this page.")
  items: LegalHold[];

  @doc("How many holds match the filter in total.")
  total: int32;

  @doc("The one-based page number.")
  page: int32;

  @doc("The page size.")
  pageSize: int32;
}

@doc("The violation list and its detail.")
@tag("Violations")
@useAuth(SessionCookie)
@route("/violations")
interface Violations {
  @doc("Violations, filtered by tracked title, state, or notice. The screen groups the rows by title.")
  @extension("x-patrol-roles", #["operator", "administrator"])
  @get
  op list(...PageRequest, @query trackedTitleId?: TrackedTitleId, @query state?: ViolationState, @query noticeId?: NoticeId): ViolationPage | ReadErrors;

  @doc("One violation with its evidence, decision, and notice attachment.")
  @extension("x-patrol-roles", #["operator", "administrator"])
  @get
  @route("/{violationId}")
  op read(@path violationId: ViolationId): ViolationDetail | ResourceErrors;

  @doc("Close an open violation, or record that its URL stopped serving the copy. A closed or removed violation is terminal.")
  @extension("x-patrol-roles", #["operator", "administrator"])
  @post
  @route("/{violationId}/closure")
  op close(...CsrfToken, @path violationId: ViolationId, @body body: ViolationClosureRequest): Violation | ResourceMutationErrors;

  @doc("Queue a capture of the violation's URL for review or handoff.")
  @extension("x-patrol-roles", #["operator", "administrator"])
  @post
  @route("/{violationId}/captures")
  op capture(...CsrfToken, @path violationId: ViolationId, @body body: CaptureRequest): CaptureAccepted | ResourceMutationErrors;
}

@doc("Evidence metadata and artifact downloads. No operation mutates a capture.")
@tag("Evidence")
@useAuth(SessionCookie)
@route("/evidence")
interface EvidenceAccess {
  @doc("One capture with its artifact manifest.")
  @extension("x-patrol-roles", #["operator", "administrator"])
  @get
  @route("/{evidenceId}")
  op read(@path evidenceId: EvidenceId): EvidenceDetail | ResourceErrors;

  @doc("A signed, content-pinned download reference for one artifact. Purged bytes answer 410 while the record survives.")
  @extension("x-patrol-roles", #["operator", "administrator"])
  @get
  @route("/{evidenceId}/artifacts/{sha256}/download")
  op download(@path evidenceId: EvidenceId, @path sha256: Sha256): ArtifactDownloadRef | EvidenceErrors;
}

@doc("The objections that suspend captures of a host until an operator clears them.")
@tag("Evidence")
@useAuth(SessionCookie)
@route("/host-objections")
interface HostObjections {
  @doc("Every recorded objection, filtered by host or by whether it is still in force. The affected candidates are listed through the candidate filter.")
  @extension("x-patrol-roles", #["operator", "administrator"])
  @get
  op list(...PageRequest, @query host?: Host, @query active?: boolean): HostObjectionPage | ReadErrors;

  @doc("Clear an objection and reopen the host to capture. The clearance reason is recorded and the objection is never deleted.")
  @extension("x-patrol-roles", #["operator", "administrator"])
  @post
  @route("/{hostObjectionId}/clearance")
  op clear(...CsrfToken, @path hostObjectionId: HostObjectionId, @body body: ClearHostObjectionRequest): HostObjection | ResourceMutationErrors;
}

@doc("Legal holds, which outrank every purge rule until released.")
@tag("Evidence")
@useAuth(SessionCookie)
@route("/legal-holds")
interface LegalHolds {
  @doc("Every legal hold, newest first.")
  @extension("x-patrol-roles", #["operator", "administrator"])
  @get
  op list(...PageRequest): LegalHoldPage | ReadErrors;

  @doc("Place a legal hold over captures, violations, or notices. At least one of the three scopes is required.")
  @extension("x-patrol-roles", #["operator", "administrator"])
  @post
  op create(...CsrfToken, @body body: CreateLegalHoldRequest): LegalHoldCreated | MutationErrors;

  @doc("Release a legal hold. Only an administrator may release one.")
  @extension("x-patrol-roles", #["administrator"])
  @post
  @route("/{legalHoldId}/release")
  op release(...CsrfToken, @path legalHoldId: LegalHoldId, @body body: ReleaseLegalHoldRequest): LegalHold | ResourceMutationErrors;
}
