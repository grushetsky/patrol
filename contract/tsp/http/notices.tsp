namespace Patrol.Http;

using TypeSpec.Http;
using TypeSpec.OpenAPI;
using Patrol.Domain;

// Notices and submissions: the draft an operator composes, the approval that
// freezes it, the handoff pack an operator files, and the acknowledgement that
// closes the loop. No operation mutates an approved notice.

@doc("A draft composed from selected open violations. The violations are reserved as soon as the draft cites them.")
model CreateNoticeRequest {
  @doc("The one recipient the notice addresses.")
  recipient: Recipient;

  @doc("The recipient profile the draft is composed for.")
  recipientProfileId: RecipientProfileId;

  @doc("The open violations the notice cites. At least one is required.")
  violationIds: ViolationId[];
}

@doc("One notice as the notices screen shows it.")
model NoticeCard {
  @doc("The notice's identifier.")
  id: NoticeId;

  @doc("The recipient the notice addresses.")
  recipient: Recipient;

  @doc("How many violations the notice cites.")
  violationCount: int32;

  @doc("The signatory's name, present once the notice is approved.")
  signatoryName?: string;

  @doc("When the draft was created.")
  createdAt: utcDateTime;

  @doc("The derived status the card renders.")
  status: NoticeStatus;

  @doc("Whether the frozen handoff pack exists and can be downloaded.")
  packAvailable: boolean;
}

@doc("A page of notices, newest first.")
model NoticePage {
  @doc("The notices on this page.")
  items: NoticeCard[];

  @doc("How many notices match the filter in total.")
  total: int32;

  @doc("The one-based page number.")
  page: int32;

  @doc("The page size.")
  pageSize: int32;
}

@doc("One cited violation with the work it copies and the captures the notice relies on.")
model CitedViolationDetail {
  @doc("The violation record.")
  violation: Violation;

  @doc("The tracked title's display title.")
  displayTitle: string;

  @doc("The tracked title's release year.")
  releaseYear: int32;

  @doc("The tracked title's kind of work.")
  titleType: TitleType;

  @doc("The captures the notice cites for this violation.")
  evidence: EvidenceSummary[];
}

@doc("A notice with its cited violations, its submission, and the pack's availability.")
model NoticeDetail {
  @doc("The notice record, with its frozen content once approved.")
  notice: Notice;

  @doc("The derived status the detail renders.")
  status: NoticeStatus;

  @doc("The cited violations, in composition order.")
  citedViolations: CitedViolationDetail[];

  @doc("The delivery attempt, present once approval has generated one.")
  submission?: Submission;

  @doc("Whether the frozen handoff pack exists and can be downloaded.")
  packAvailable: boolean;
}

@doc("The notice's draft was created and its violations are now reserved.")
model NoticeCreated {
  @statusCode statusCode: 201;
  @body body: NoticeDetail;
}

@doc("The three confirmations an approving operator makes. Each must be true.")
model ApprovalAttestation {
  @doc("The operator confirms every cited violation was reviewed.")
  reviewedViolations: true;

  @doc("The operator confirms the statement text is the recipient's current text.")
  currentStatements: true;

  @doc("The operator confirms the signatory is authorised to attest for the rights holder.")
  authorizedSignatory: true;
}

@doc("The approval of a draft.")
model NoticeApprovalRequest {
  @doc("The statement template version the operator confirmed.")
  statementVersion: string;

  @doc("The operator's three confirmations.")
  attestation: ApprovalAttestation;
}

@doc("The result of approving a notice: frozen content, queued captures, and the submission once its captures settle.")
model ApprovalResult {
  @doc("The approved notice.")
  notice: Notice;

  @doc("The derived status after approval.")
  status: NoticeStatus;

  @doc("How many pre-handoff captures were queued because the newest live capture was older than seven days.")
  queuedCaptures: int32;

  @doc("The delivery attempt, present when every capture had already settled.")
  submission?: Submission;
}

@doc("The withdrawal of a draft, or of an approved notice whose submission is still pending.")
model NoticeWithdrawalRequest {
  @doc("Why the notice is being withdrawn.")
  reason?: string;
}

@doc("The corrected citation set of a replacement notice.")
model NoticeSupersessionRequest {
  @doc("The violations the replacement draft cites. It must differ from the superseded notice's set.")
  citedViolationIds: ViolationId[];
}

@doc("The superseded notice and the replacement draft.")
model SupersessionResult {
  @doc("The notice that was superseded. Its pending submission is cancelled.")
  superseded: Notice;

  @doc("The replacement draft, carrying the corrected citation set.")
  draft: NoticeDetail;
}

@doc("One artifact in the frozen handoff pack.")
enum HandoffArtifactKind {
  NoticeHtml: "notice_html",
  FieldsJson: "fields_json",
  UploadFile: "upload_file",
  HandoffMarkdown: "handoff_markdown",
}

@doc("One file in the handoff pack, with a signed download reference.")
model HandoffArtifact {
  @doc("Which artifact this is.")
  kind: HandoffArtifactKind;

  @doc("The file name the operator saves or uploads.")
  fileName: string;

  @doc("The artifact's content type.")
  contentType: string;

  @doc("The artifact's size in bytes.")
  byteSize: int32;

  @doc("The signed URL to download the artifact for as long as the pack survives.")
  downloadUrl: Url;
}

@doc("One cited URL whose newest capture is dead or blocked, flagged at handoff rather than dropped.")
model CaptureFlag {
  @doc("The violation the flag belongs to.")
  violationId: ViolationId;

  @doc("The URL the notice names.")
  url: Url;

  @doc("The newest capture's identifier.")
  newestEvidenceId: EvidenceId;

  @doc("The newest capture's outcome.")
  newestOutcome: CaptureOutcome;

  @doc("An earlier capture whose outcome was captured, when one exists.")
  earlierLiveEvidenceId?: EvidenceId;
}

@doc("The frozen pack an operator files. It is generated from the approved notice and never regenerated with different content.")
model HandoffPack {
  @doc("The delivery attempt the pack belongs to.")
  submissionId: SubmissionId;

  @doc("The content-addressed reference to the pack.")
  packRef: string;

  @doc("The pack's SHA-256.")
  packSha256: Sha256;

  @doc("When the pack was generated.")
  generatedAt: utcDateTime;

  @doc("The recipient's form URL observed at approval.")
  formUrl?: Url;

  @doc("The pack's artifacts.")
  artifacts: HandoffArtifact[];

  @doc("Per cited URL, the newest capture outcome and any dead or blocked warning.")
  captureFlags: CaptureFlag[];
}

@doc("One submission as a list or detail renders it.")
model SubmissionDetail {
  @doc("The submission record.")
  submission: Submission;

  @doc("The notice the submission delivers.")
  notice: NoticeRef;

  @doc("Whether the frozen handoff pack exists and can be downloaded.")
  packAvailable: boolean;
}

@doc("A page of submissions, newest first.")
model SubmissionPage {
  @doc("The submissions on this page.")
  items: SubmissionDetail[];

  @doc("How many submissions match the filter in total.")
  total: int32;

  @doc("The one-based page number.")
  page: int32;

  @doc("The page size.")
  pageSize: int32;
}

@doc("The operator's attestation that the notice was filed as the pack presents it.")
model SubmissionAttestation {
  @doc("The operator confirms the notice was filed as presented.")
  filedAsPresented: true;

  @doc("The statement template version the operator confirmed.")
  statementVersion: string;
}

@doc("The operator's record that they filed the notice.")
model SubmissionDeliveryRequest {
  @doc("The operator's attestation.")
  attestation: SubmissionAttestation;
}

@doc("Google's acknowledgement: a reference number and the Removals Dashboard link.")
model GoogleAcknowledgement {
  @doc("The recipient this acknowledgement belongs to.")
  recipient: "google";

  @doc("The reference number Google returned, four to forty characters.")
  @minLength(4)
  @maxLength(40)
  referenceNumber: string;

  @doc("The Removals Dashboard URL Google returned.")
  dashboardUrl: Url;
}

@doc("Bing's acknowledgement: the TicketId and its ticket-details link.")
model BingAcknowledgement {
  @doc("The recipient this acknowledgement belongs to.")
  recipient: "bing";

  @doc("The TicketId parsed from the ticket-details URL.")
  ticketId: string;

  @doc("The ticket-details URL Bing returned.")
  ticketDetailsUrl: Url;
}

@doc("Yandex's acknowledgement: the reply email's Message-ID and date.")
model YandexAcknowledgement {
  @doc("The recipient this acknowledgement belongs to.")
  recipient: "yandex";

  @doc("The Message-ID header of Yandex's reply.")
  messageId: string;

  @doc("The date of Yandex's reply.")
  replyDate: plainDate;
}

@doc("What the recipient returned. The variant must match the notice's recipient.")
union AcknowledgementRequest {
  @doc("Google's reference number and dashboard link.")
  Google: GoogleAcknowledgement,

  @doc("Bing's TicketId and ticket-details link.")
  Bing: BingAcknowledgement,

  @doc("Yandex's reply Message-ID and date.")
  Yandex: YandexAcknowledgement,
}

@doc("The operator's acknowledgement recording.")
model AcknowledgementRecordRequest {
  @doc("The operator's attestation that the notice was filed as presented.")
  attestation: SubmissionAttestation;

  @doc("What the recipient returned.")
  acknowledgement: AcknowledgementRequest;
}

@doc("The operator's report that filing failed or was refused.")
model SubmissionFailureRequest {
  @doc("Why the filing failed or was refused.")
  reason: SubmissionFailureReason;

  @doc("The operator's account of the cause. A rejection requires a note naming it.")
  note: string;
}

@doc("Notices and the drafts, approvals, withdrawals, and supersessions that move them.")
@tag("Notices")
@useAuth(SessionCookie)
@route("/notices")
interface Notices {
  @doc("Every notice, filtered by state or recipient, newest first.")
  @extension("x-patrol-roles", #["operator", "administrator"])
  @get
  op list(...PageRequest, @query state?: NoticeState, @query recipient?: Recipient): NoticePage | ReadErrors;

  @doc("Compose a draft from selected open violations. A reserved violation, a duplicate URL at the same recipient, an over-cap batch, or an ineligible recipient is refused.")
  @extension("x-patrol-roles", #["operator", "administrator"])
  @post
  op create(...CsrfToken, @body body: CreateNoticeRequest): NoticeCreated | MutationErrors;

  @doc("One notice with its cited violations, submission, and pack availability.")
  @extension("x-patrol-roles", #["operator", "administrator"])
  @get
  @route("/{noticeId}")
  op read(@path noticeId: NoticeId): NoticeDetail | ResourceErrors;

  @doc("Approve a draft. This freezes the content, snapshots the signatory and rights-holder profile, queues stale pre-handoff captures, and creates the submission once they settle.")
  @extension("x-patrol-roles", #["operator", "administrator"])
  @post
  @route("/{noticeId}/approval")
  op approve(...CsrfToken, @path noticeId: NoticeId, @body body: NoticeApprovalRequest): ApprovalResult | ResourceMutationErrors;

  @doc("Withdraw a draft, or an approved notice whose submission is still pending. Delivered and acknowledged notices cannot be withdrawn.")
  @extension("x-patrol-roles", #["operator", "administrator"])
  @post
  @route("/{noticeId}/withdrawal")
  op withdraw(...CsrfToken, @path noticeId: NoticeId, @body body: NoticeWithdrawalRequest): Notice | ResourceMutationErrors;

  @doc("Supersede an approved notice with a corrected draft and cancel its pending submission.")
  @extension("x-patrol-roles", #["operator", "administrator"])
  @post
  @route("/{noticeId}/supersession")
  op supersede(...CsrfToken, @path noticeId: NoticeId, @body body: NoticeSupersessionRequest): SupersessionResult | ResourceMutationErrors;

  @doc("The frozen handoff pack: printable notice, resolved fields, upload file, handoff checklist, and capture flags.")
  @extension("x-patrol-roles", #["operator", "administrator"])
  @get
  @route("/{noticeId}/pack")
  op pack(@path noticeId: NoticeId): HandoffPack | ResourceErrors;
}

@doc("The single delivery attempt of an approved notice, performed by an operator.")
@tag("Notices")
@useAuth(SessionCookie)
@route("/submissions")
interface Submissions {
  @doc("Submissions, filtered by state or notice. `olderThanDays` surfaces the pending backlog the dashboard warns about.")
  @extension("x-patrol-roles", #["operator", "administrator"])
  @get
  op list(...PageRequest, @query state?: SubmissionState, @query noticeId?: NoticeId, @query olderThanDays?: int32): SubmissionPage | ReadErrors;

  @doc("One submission with the notice it delivers.")
  @extension("x-patrol-roles", #["operator", "administrator"])
  @get
  @route("/{submissionId}")
  op read(@path submissionId: SubmissionId): SubmissionDetail | ResourceErrors;

  @doc("Record that the notice was filed, with the operator's attestation.")
  @extension("x-patrol-roles", #["operator", "administrator"])
  @post
  @route("/{submissionId}/delivery")
  op deliver(...CsrfToken, @path submissionId: SubmissionId, @body body: SubmissionDeliveryRequest): Submission | ResourceMutationErrors;

  @doc("Record what the recipient returned. The acknowledgement variant must match the notice's recipient.")
  @extension("x-patrol-roles", #["operator", "administrator"])
  @post
  @route("/{submissionId}/acknowledgement")
  op acknowledge(...CsrfToken, @path submissionId: SubmissionId, @body body: AcknowledgementRecordRequest): Submission | ResourceMutationErrors;

  @doc("Report that the filing failed or was refused. A rejection requires a note naming its cause.")
  @extension("x-patrol-roles", #["operator", "administrator"])
  @post
  @route("/{submissionId}/failure")
  op fail(...CsrfToken, @path submissionId: SubmissionId, @body body: SubmissionFailureRequest): Submission | ResourceMutationErrors;

  @doc("Return a failed submission to pending while keeping the same row and raising its attempt count.")
  @extension("x-patrol-roles", #["operator", "administrator"])
  @post
  @route("/{submissionId}/retry")
  op retry(...CsrfToken, @path submissionId: SubmissionId): Submission | ResourceMutationErrors;
}
