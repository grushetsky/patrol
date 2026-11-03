namespace Patrol.Domain;

// Violations and evidence. A violation is keyed by its URL and one tracked
// title; evidence is captured per URL and shared by every violation that cites
// it. Neither is ever reopened or rewritten.

@doc("A confirmed unauthorized copy of one tracked title, located by the search-result URL that surfaced it and hosted at the landing page it resolves to.")
model Violation {
  @doc("Patrol's own identifier.")
  id: ViolationId;

  @doc("The one tracked title the copy is of.")
  trackedTitleId: TrackedTitleId;

  @doc("The candidate the violation was created from.")
  candidateId: CandidateId;

  @doc("The review decision that confirmed the violation.")
  reviewDecisionId: ReviewDecisionId;

  @doc("The URL as it was submitted or surfaced, stored verbatim. A notice names this URL.")
  url: Url;

  @doc("The URL's deduplication key.")
  normalizedUrl: NormalizedUrl;

  @doc("The violation's host, taken from the destination.")
  host: Host;

  @doc("Where the host came from, since an unreachable landing page falls back to the submitted host.")
  hostSource: HostSource;

  @doc("The host's registrable domain, the unit of reputation and reporting.")
  registrableDomain: RegistrableDomain;

  @doc("When the pair was first observed.")
  detectedAt: utcDateTime;

  @doc("When an operator confirmed the violation.")
  confirmedAt: utcDateTime;

  @doc("The operator who confirmed the violation.")
  confirmedBy: OperatorId;

  @doc("The earlier violation this one succeeds, when a URL reappeared after removal or closure.")
  predecessorViolationId?: ViolationId;

  @doc("How the violation currently stands.")
  lifecycle: ViolationLifecycle;
}

@doc("The violation state machine. A closed violation is never reopened; a reappearing URL starts a new violation.")
union ViolationLifecycle {
  @doc("The page is believed to serve the copy.")
  OpenViolation,

  @doc("The URL stopped serving the copy.")
  RemovedViolation,

  @doc("An operator closed the violation after a re-check.")
  ClosedViolation,
}

@doc("A violation believed to be live.")
model OpenViolation {
  @doc("The literal state discriminator.")
  state: "open";

  @doc("When the violation entered the open state; equal to the confirmation time.")
  openedAt: utcDateTime;
}

@doc("A violation whose URL stopped serving the copy.")
model RemovedViolation {
  @doc("The literal state discriminator.")
  state: "removed";

  @doc("When removal was recorded.")
  closedAt: utcDateTime;

  @doc("Why the violation closed.")
  reason: ViolationClosureReason;

  @doc("The capture that showed the URL gone, when one exists.")
  closureEvidenceId?: EvidenceId;

  @doc("The operator who recorded the removal, when a person did.")
  closedBy?: OperatorId;
}

@doc("A violation an operator closed after a re-check.")
model ClosedViolation {
  @doc("The literal state discriminator.")
  state: "closed";

  @doc("When the operator closed the violation.")
  closedAt: utcDateTime;

  @doc("Why the violation closed.")
  reason: ViolationClosureReason;

  @doc("The operator who closed the violation.")
  closedBy: OperatorId;

  @doc("The operator's note.")
  note?: string;
}

@doc("The capture a violation cites and the role it plays.")
model ViolationEvidence {
  @doc("The violation citing the capture.")
  violationId: ViolationId;

  @doc("The capture cited.")
  evidenceId: EvidenceId;

  @doc("Why the capture was taken.")
  role: CaptureReason;

  @doc("When the citation was recorded.")
  citedAt: utcDateTime;
}

@doc("An immutable, content-addressed record of what a URL served at one capture time. The record of one capture.")
model Evidence {
  @doc("Patrol's own identifier.")
  id: EvidenceId;

  @doc("The URL as it was requested, stored verbatim.")
  requestedUrl: Url;

  @doc("The requested URL's deduplication key.")
  normalizedRequestedUrl: NormalizedUrl;

  @doc("Every redirect hop, in order, with its status and Location.")
  redirectChain: RedirectHop[];

  @doc("The landing page's final URL, absent when no response was received.")
  finalUrl?: Url;

  @doc("The landing page's host, absent when no response was received.")
  host?: Host;

  @doc("Where the host was derived from, when a host was recorded.")
  hostSource?: HostSource;

  @doc("Why the capture was taken.")
  reason: CaptureReason;

  @doc("What the capture observed.")
  outcome: CaptureOutcome;

  @doc("The final response's HTTP status, when one was received.")
  httpStatus?: int32;

  @doc("Why the capture did not succeed, when the outcome is not captured.")
  failureReason?: string;

  @doc("The attempt number within the retry window, starting at one.")
  @minValue(1)
  attemptNumber: int32;

  @doc("When the page was observed, in UTC. The capture time is part of the record.")
  observedAt: utcDateTime;

  @doc("The browser and extraction settings of the capture.")
  profile: CaptureProfile;

  @doc("The artifacts the capture produced. An absence carries none, which is itself the record.")
  artifacts: EvidenceArtifact[];

  @doc("When the bytes were purged, absent until retention acts.")
  purgedAt?: utcDateTime;

  @doc("Why the bytes were purged, present with the purge marker.")
  purgeReason?: string;
}

@doc("One artifact produced by a capture, keyed by the SHA-256 of its bytes.")
model EvidenceArtifact {
  @doc("Which artifact this is.")
  kind: EvidenceArtifactKind;

  @doc("The SHA-256 of the bytes, which is also the object key.")
  sha256: Sha256;

  @doc("The artifact's size in bytes.")
  @minValue(0)
  byteSize: int32;

  @doc("The artifact's content type.")
  contentType: string;

  @doc("The artifact's width in pixels, for image artifacts.")
  @minValue(0)
  width?: int32;

  @doc("The artifact's height in pixels, for image artifacts.")
  @minValue(0)
  height?: int32;

  @doc("Whether the artifact was truncated at a ceiling. Truncation is flagged, never silent.")
  truncated: boolean;
}

@doc("The kinds of artifact a capture can produce.")
enum EvidenceArtifactKind {
  ResponseBody: "response_body",
  ResponseHeaders: "response_headers",
  RenderedDom: "rendered_dom",
  Screenshot: "screenshot",
  Thumbnail: "thumbnail",
  ExtractionSidecar: "extraction_sidecar",
}

@doc("A recorded restriction that suspends deletion of the evidence it covers until an operator releases it.")
model LegalHold {
  @doc("Patrol's own identifier.")
  id: LegalHoldId;

  @doc("Why the hold was placed.")
  reason: string;

  @doc("The operator who placed the hold.")
  createdBy: OperatorId;

  @doc("When the hold was placed.")
  createdAt: utcDateTime;

  @doc("The captures the hold covers.")
  evidenceIds: EvidenceId[];

  @doc("The violations the hold covers.")
  violationIds: ViolationId[];

  @doc("The notices the hold covers.")
  noticeIds: NoticeId[];

  @doc("When the hold was released.")
  releasedAt?: utcDateTime;

  @doc("The operator who released the hold.")
  releasedBy?: OperatorId;
}
