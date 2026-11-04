namespace Patrol.Domain;

// Notices and submissions. A notice is the immutable document one recipient
// receives; a submission is the operator's single delivery attempt for it.
// The signatory attests at approval; the operator files and attests delivery.

@doc("The configuration for one recipient's submission channel: its channel, account, required fields, limits, eligibility, and composition trigger.")
model RecipientProfile {
  @doc("Patrol's own identifier.")
  id: RecipientProfileId;

  @doc("The recipient the profile addresses.")
  recipient: Recipient;

  @doc("The channel the submission runs through.")
  channel: RecipientChannel;

  @doc("The account the submission runs under, such as a Google account email.")
  account: string;

  @doc("The contact mailbox the form asks for, where the account is not it.")
  contactEmail?: Email;

  @doc("When drafts are composed for this profile.")
  compositionTrigger: CompositionTrigger;

  @doc("The UTC time the scheduled composition window opens.")
  windowTime?: plainTime;

  @doc("The territories in which the rights holder is eligible to submit. Empty means every territory.")
  eligibleTerritories: Territory[];

  @doc("The recipient's published per-notice URL cap, where one is published.")
  @minValue(1)
  maxUrlsPerNotice?: int32;

  @doc("The recipient's published per-file URL cap, where one is published.")
  @minValue(1)
  maxUrlsPerFile?: int32;

  @doc("The recipient's published per-day URL cap, where one is published.")
  @minValue(1)
  maxUrlsPerDay?: int32;

  @doc("The per-file cap last observed from the recipient's error text.")
  @minValue(1)
  lastObservedMaxUrlsPerFile?: int32;

  @doc("The per-day quota last observed from the recipient.")
  @minValue(1)
  lastObservedDailyQuota?: int32;

  @doc("Whether scheduled drafting is paused by the rejection threshold.")
  paused: boolean;

  @doc("Why the profile is paused, when it is.")
  pauseReason?: string;

  @doc("The profile's recent submission outcome, the input to the pause threshold.")
  recentSubmissions: SubmissionStats;

  @doc("The profile's version, snapshotted into a notice at approval.")
  @minValue(1)
  version: int32;

  @doc("The administrator who last edited the profile.")
  updatedBy: OperatorId;

  @doc("When the profile was last edited.")
  updatedAt: utcDateTime;
}

@doc("The last twenty submissions' outcomes for one recipient profile.")
model SubmissionStats {
  @doc("How many submissions the window covers, at most twenty.")
  @minValue(0)
  windowSize: int32;

  @doc("How many were rejected by the recipient.")
  @minValue(0)
  rejected: int32;

  @doc("How many failed to deliver.")
  @minValue(0)
  failed: int32;

  @doc("Whether the rejected plus failed share crossed the threshold that pauses scheduled drafting.")
  thresholdExceeded: boolean;
}

@doc("The document one recipient receives. It cites one or more violations of exactly one rights holder and is addressed to exactly one recipient.")
model Notice {
  @doc("Patrol's own identifier.")
  id: NoticeId;

  @doc("The notice's contents, frozen by approval.")
  content: NoticeContent;

  @doc("The operator who created the draft.")
  createdBy: OperatorId;

  @doc("When the draft was created.")
  createdAt: utcDateTime;

  @doc("The notice's lifecycle state.")
  lifecycle: NoticeLifecycle;
}

@doc("What a notice carries: its recipient binding, citations, work identification, statements, and resolved form fields.")
model NoticeContent {
  @doc("The one recipient the notice addresses.")
  recipient: Recipient;

  @doc("The recipient profile the notice was composed for.")
  recipientProfileId: RecipientProfileId;

  @doc("The profile's channel at composition time.")
  channel: RecipientChannel;

  @doc("The violations cited, each pinned to the captures it relies on.")
  citedViolations: CitedViolation[];

  @doc("One identification per cited tracked title.")
  workIdentifications: WorkIdentification[];

  @doc("The exact text of every required statement.")
  statements: NoticeStatement[];

  @doc("The form-ordered field map the operator will copy from.")
  resolvedFields: ResolvedField[];

  @doc("The version of the statement template used.")
  templateVersion: string;
}

@doc("One violation cited by a notice, with the captures the notice relies on.")
model CitedViolation {
  @doc("The violation cited.")
  violationId: ViolationId;

  @doc("The evidence the notice cites for this violation. A later capture never changes it.")
  evidence: EvidenceCitation[];
}

@doc("One capture cited by a notice or a decision, with the time it was taken.")
model EvidenceCitation {
  @doc("The capture cited.")
  evidenceId: EvidenceId;

  @doc("When the capture was taken, frozen with the citation.")
  capturedAt: utcDateTime;

  @doc("Why the capture was taken.")
  reason: CaptureReason;
}

@doc("How a cited tracked title is identified to the recipient.")
model WorkIdentification {
  @doc("The tracked title cited.")
  trackedTitleId: TrackedTitleId;

  @doc("The display title, which is the original-title variant.")
  displayTitle: string;

  @doc("The release year.")
  releaseYear: int32;

  @doc("The kind of work.")
  titleType: TitleType;

  @doc("An authorized example URL, where the form asks for one.")
  authorizedExampleUrl?: Url;
}

@doc("One required statement and the template version it came from.")
model NoticeStatement {
  @doc("The statement's key in the recipient's form.")
  key: string;

  @doc("The exact statement text.")
  text: string;

  @doc("The version of the statement template.")
  templateVersion: string;
}

@doc("One resolved field of the recipient's form.")
model ResolvedField {
  @doc("The form field's name.")
  name: string;

  @doc("The value the operator copies.")
  value: string;

  @doc("Whether the form marks the field required.")
  required: boolean;

  @doc("The field's length cap, when the form publishes one.")
  @minValue(1)
  maxLength?: int32;
}

@doc("The notice state machine. Approval freezes the content and snapshots the parties.")
union NoticeLifecycle {
  @doc("A notice still being composed.")
  DraftNotice,

  @doc("An immutable notice awaiting delivery.")
  ApprovedNotice,

  @doc("A notice withdrawn before delivery or while its submission was pending.")
  WithdrawnNotice,

  @doc("A notice replaced by a corrected one.")
  SupersededNotice,
}

@doc("A notice being composed. Its content may still change.")
model DraftNotice {
  @doc("The literal state discriminator.")
  state: "draft";

  @doc("When the draft was last edited.")
  updatedAt?: utcDateTime;
}

@doc("An approved notice. Content is frozen and the parties are snapshotted.")
model ApprovedNotice {
  @doc("The literal state discriminator.")
  state: "approved";

  @doc("The operator who approved the notice.")
  approvedBy: OperatorId;

  @doc("When the notice was approved.")
  approvedAt: utcDateTime;

  @doc("The rights-holder contact profile, frozen at approval.")
  rightsHolder: RightsHolderSnapshot;

  @doc("The signatory, frozen at approval.")
  signatory: SignatorySnapshot;

  @doc("The recipient profile, frozen at approval.")
  profile: RecipientProfileSnapshot;
}

@doc("A notice withdrawn before delivery or while its submission was pending.")
model WithdrawnNotice {
  @doc("The literal state discriminator.")
  state: "withdrawn";

  @doc("The operator who withdrew the notice.")
  withdrawnBy: OperatorId;

  @doc("When the notice was withdrawn.")
  withdrawnAt: utcDateTime;

  @doc("Why the notice was withdrawn.")
  reason?: string;
}

@doc("A notice replaced by a corrected one.")
model SupersededNotice {
  @doc("The literal state discriminator.")
  state: "superseded";

  @doc("The operator who superseded the notice.")
  supersededBy: OperatorId;

  @doc("When the notice was superseded.")
  supersededAt: utcDateTime;

  @doc("The corrected notice that replaces it.")
  supersededByNoticeId: NoticeId;
}

@doc("The rights-holder details a notice carries, frozen at approval.")
model RightsHolderSnapshot {
  @doc("The legal name rendered in the notice.")
  legalName: string;

  @doc("The country of the rights holder's address.")
  country: CountryCode;

  @doc("The rights holder's address.")
  address: PostalAddress;

  @doc("The role mailbox rendered as the contact.")
  roleMailbox: Email;

  @doc("The phone number, where the form asks for one.")
  phone?: string;

  @doc("When the snapshot was taken.")
  capturedAt: utcDateTime;
}

@doc("The signatory details a notice carries, frozen at approval.")
model SignatorySnapshot {
  @doc("The signatory's full legal name, rendered in every signature field.")
  fullLegalName: string;

  @doc("The basis on which the signatory is authorised.")
  authorityBasis: string;

  @doc("The signatory's contact email.")
  contactEmail: Email;

  @doc("The signatory's contact phone.")
  contactPhone?: string;

  @doc("When the snapshot was taken.")
  capturedAt: utcDateTime;
}

@doc("The recipient profile a notice was composed under, frozen at approval.")
model RecipientProfileSnapshot {
  @doc("The profile's identifier.")
  profileId: RecipientProfileId;

  @doc("The profile's version.")
  version: int32;

  @doc("The channel used.")
  channel: RecipientChannel;

  @doc("The account used.")
  account: string;

  @doc("The form URL observed at approval.")
  formUrl?: Url;

  @doc("The per-notice URL cap observed at approval.")
  maxUrlsPerNotice?: int32;

  @doc("The per-file URL cap observed at approval.")
  maxUrlsPerFile?: int32;

  @doc("When the snapshot was taken.")
  capturedAt: utcDateTime;
}

@doc("One delivery attempt of an approved notice through a recipient's channel, performed by an operator. One exists per notice.")
model Submission {
  @doc("Patrol's own identifier.")
  id: SubmissionId;

  @doc("The notice being delivered. Unique: a retry never creates a second delivery.")
  noticeId: NoticeId;

  @doc("The channel used.")
  channel: RecipientChannel;

  @doc("The recipient profile used.")
  recipientProfileId: RecipientProfileId;

  @doc("The language of the operator-facing handoff checklist, frozen from the approving operator at approval.")
  packLanguage: InterfaceLanguage;

  @doc("How many delivery attempts the operator has made.")
  @minValue(0)
  attemptCount: int32;

  @doc("The content-addressed reference to the frozen handoff pack, once the pack is generated.")
  packRef?: string;

  @doc("The pack's SHA-256, once the pack is generated.")
  packSha256?: Sha256;

  @doc("When the submission row was created.")
  createdAt: utcDateTime;

  @doc("When the pending submission was cancelled because its notice was withdrawn or superseded.")
  cancelledAt?: utcDateTime;

  @doc("The submission's lifecycle state.")
  lifecycle: SubmissionLifecycle;
}

@doc("The submission state machine.")
union SubmissionLifecycle {
  @doc("Created and awaiting the operator's filing.")
  PendingSubmission,

  @doc("Filed by an operator and attested.")
  DeliveredSubmission,

  @doc("Filed and acknowledged by the recipient.")
  AcknowledgedSubmission,

  @doc("Refused by the recipient.")
  RejectedSubmission,

  @doc("Failed to deliver.")
  FailedSubmission,
}

@doc("A submission awaiting the operator's filing.")
model PendingSubmission {
  @doc("The literal state discriminator.")
  state: "pending";
}

@doc("A submission the operator filed and attested.")
model DeliveredSubmission {
  @doc("The literal state discriminator.")
  state: "delivered";

  @doc("The operator who filed the notice.")
  operatorId: OperatorId;

  @doc("When the operator filed the notice.")
  deliveredAt: utcDateTime;

  @doc("The operator's attestation that the notice was filed as presented.")
  attestation: OperatorAttestation;
}

@doc("A submission the recipient acknowledged.")
model AcknowledgedSubmission {
  @doc("The literal state discriminator.")
  state: "acknowledged";

  @doc("The operator who filed the notice.")
  operatorId: OperatorId;

  @doc("When the operator filed the notice.")
  deliveredAt: utcDateTime;

  @doc("The operator's attestation that the notice was filed as presented.")
  attestation: OperatorAttestation;

  @doc("What the recipient returned.")
  acknowledgement: Acknowledgement;
}

@doc("A submission the recipient refused. A rejected submission is not retried unchanged.")
model RejectedSubmission {
  @doc("The literal state discriminator.")
  state: "rejected";

  @doc("The operator who filed the notice.")
  operatorId: OperatorId;

  @doc("When the refusal was recorded.")
  decidedAt: utcDateTime;

  @doc("The refusal and its cause.")
  failure: SubmissionFailure;
}

@doc("A submission that failed to deliver.")
model FailedSubmission {
  @doc("The literal state discriminator.")
  state: "failed";

  @doc("The operator who attempted the filing.")
  operatorId: OperatorId;

  @doc("When the failure was recorded.")
  failedAt: utcDateTime;

  @doc("The failure and its cause.")
  failure: SubmissionFailure;
}

@doc("What a recipient returned when it accepted a notice.")
model Acknowledgement {
  @doc("The recipient that acknowledged.")
  recipient: Recipient;

  @doc("Google's reference number.")
  referenceNumber?: string;

  @doc("Google's Removals Dashboard URL.")
  dashboardUrl?: Url;

  @doc("Bing's TicketId.")
  ticketId?: string;

  @doc("Bing's ticket-details URL.")
  ticketDetailsUrl?: Url;

  @doc("Yandex's reply email Message-ID.")
  messageId?: string;

  @doc("The date of Yandex's reply.")
  replyDate?: plainDate;

  @doc("The operator's note, where the recipient published no identifier.")
  note?: string;
}

@doc("A failed or refused submission and its cause.")
model SubmissionFailure {
  @doc("Why the submission failed or was refused.")
  reason: SubmissionFailureReason;

  @doc("The operator's account of the cause. A rejection requires a review note naming it.")
  note: string;

  @doc("When the failure was recorded.")
  recordedAt: utcDateTime;
}
