namespace Patrol.Domain;

// Every record Patrol creates is keyed by Patrol's own UUIDv7. External
// identifiers are attributes of a tracked title, never its key, so a wrong or
// reassigned identifier can be corrected without re-keying the candidates,
// violations, and notices that inherit the title.

@doc("Identifier of the single rights holder in the deployment.")
@format("uuid")
scalar RightsHolderId extends string;

@doc("Identifier of an operator account.")
@format("uuid")
scalar OperatorId extends string;

@doc("Identifier of an operator invitation.")
@format("uuid")
scalar InvitationId extends string;

@doc("Identifier of an operator session.")
@format("uuid")
scalar SessionId extends string;

@doc("Identifier of an operator-defined title group.")
@format("uuid")
scalar TitleGroupId extends string;

@doc("Identifier of a tracked title.")
@format("uuid")
scalar TrackedTitleId extends string;

@doc("Identifier of a title variant.")
@format("uuid")
scalar TitleVariantId extends string;

@doc("Identifier of an external identifier row.")
@format("uuid")
scalar ExternalIdentifierId extends string;

@doc("Identifier of an allowlist entry.")
@format("uuid")
scalar AllowlistEntryId extends string;

@doc("Identifier of a scan.")
@format("uuid")
scalar ScanId extends string;

@doc("Identifier of a search query inside a query plan.")
@format("uuid")
scalar SearchQueryId extends string;

@doc("Identifier of a search result.")
@format("uuid")
scalar SearchResultId extends string;

@doc("Identifier of a candidate, the URL and tracked-title pair.")
@format("uuid")
scalar CandidateId extends string;

@doc("Identifier of a review decision.")
@format("uuid")
scalar ReviewDecisionId extends string;

@doc("Identifier of a violation.")
@format("uuid")
scalar ViolationId extends string;

@doc("Identifier of a host objection that suspends captures of one host.")
@format("uuid")
scalar HostObjectionId extends string;

@doc("Identifier of an evidence record, one per capture.")
@format("uuid")
scalar EvidenceId extends string;

@doc("Identifier of a legal hold.")
@format("uuid")
scalar LegalHoldId extends string;

@doc("Identifier of a recipient profile.")
@format("uuid")
scalar RecipientProfileId extends string;

@doc("Identifier of a notice.")
@format("uuid")
scalar NoticeId extends string;

@doc("Identifier of a submission, one per notice delivery.")
@format("uuid")
scalar SubmissionId extends string;

@doc("Identifier of a quota ledger row, one per engine and UTC month.")
@format("uuid")
scalar QuotaLedgerId extends string;

@doc("Identifier of a budget reservation held by a scan.")
@format("uuid")
scalar BudgetReservationId extends string;

@doc("Identifier of a re-check ladder, one per title group and engine.")
@format("uuid")
scalar RecheckScheduleId extends string;
