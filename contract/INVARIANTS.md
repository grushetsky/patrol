# Domain model invariants

The TypeSpec domain model encodes what a type can enforce; relational invariants that need a database constraint or an application guard are listed here so the build effort implements them rather than assuming the schema covers them. The glossary is "_GLOSSARY.md_", the model is "_contract/tsp/main.tsp_", and the emitted artifacts are "_contract/generated/_".

## What the model enforces by construction

| Invariant | How the model enforces it |
| --- | --- |
| Exactly one rights holder, and every notice names it | The rights holder is a single entity, and `ApprovedNotice` requires a `RightsHolderSnapshot`. |
| Every tracked title belongs to one title group | `TrackedTitle.titleGroupId` is required and typed `TitleGroupId`. |
| Every title group declares at least one locale | `TitleGroup.locales` is a required array; emptiness is a database check, because TypeSpec cannot express a non-empty array. |
| Every tracked title has exactly one original variant, which is the display title | `TrackedTitle.originalVariantId` is required; the display title is derived, not stored twice. Uniqueness of the original variant is a partial unique index. |
| A variant's text is unique within its title after normalization | `TitleVariant.normalizedText` is required; `UNIQUE (tracked_title_id, normalized_text)` enforces it. |
| An external identifier value is unique within its scheme | `UNIQUE (scheme, value)` on `ExternalIdentifier`. |
| A violation belongs to one tracked title and one host | `Violation.trackedTitleId`, `Violation.host`, and `Violation.hostSource` are required. |
| A violation's host comes from its destination, with the submitted URL and redirect chain retained | `Violation.hostSource` distinguishes the landing page from the fallback; `Evidence.redirectChain` and `Evidence.requestedUrl` retain the chain. |
| A page hosting several titles yields one violation per title, sharing evidence | `Violation` is keyed by URL and title; evidence is keyed by URL and capture time, and `ViolationEvidence` joins many violations to one capture. |
| A violation is created only from a confirmed candidate | `Violation.candidateId` and `Violation.reviewDecisionId` are required; `ConfirmedCandidate` requires both the decision and the violation id. |
| At most one open violation per URL and tracked title, and a reappearance starts a new one | `UNIQUE (normalized_url, tracked_title_id) WHERE state = 'open'`; `Violation.predecessorViolationId` links the chain, and no lifecycle state transitions back to open. |
| An allowlist hit prevents confirmation regardless of score | `Candidate.allowlistEntryId` is recorded and the transition guard rejects confirmation while it is set. A score can never confirm a candidate: only `ReviewDecision` creates a violation. |
| A notice cites one or more violations of one rights holder and one recipient | `NoticeContent.recipient`, `citedViolations`, and `workIdentifications` are required; non-emptiness is an application and database check. |
| A notice records exactly one signatory at approval | `ApprovedNotice.signatory` is a required singular `SignatorySnapshot`. |
| A submission cites exactly one approved notice, and an approved notice is never edited | `Submission.noticeId` is unique; `Notice.content` is frozen by approval, and a change is a new notice via `SupersededNotice.supersededByNoticeId`. |
| A submission is performed by an operator; no scheduled process delivers | Every delivery state requires `operatorId`; `PendingSubmission` has no delivery fields. |
| A scan targets one group and one engine; a notice targets one recipient | Required singular fields on `Scan` and `NoticeContent`. |
| A search result is never edited; a candidate deduplicates results | `SearchResult` has no update path and carries the raw URL; a candidate is unique on `(normalized_url, tracked_title_id)`. |
| Evidence is immutable; a later capture is a new record | No mutation model exists; artifacts are content-addressed by SHA-256, and a correction is a new `Evidence` row. |
| A capture records one reason and one outcome; an absence is recorded | `Evidence.reason` and `Evidence.outcome` are required with explicit enums; `failureReason` is required when the outcome is not `captured`. |
| Every violation cites at least one capture, and a dead newest capture flags rather than drops | A violation must hold at least one `ViolationEvidence` row; the flag is a read-model and handoff rule. |
| A notice cites only captures that existed before approval, and later captures never change it | `ApprovedNotice.content` holds `EvidenceCitation.capturedAt`; no capture reference is mutable. |
| An allowlisted URL is never captured | The allowlist check runs before `Evidence` is requested; the model records the hit on the candidate and the review row carries no evidence. |
| Purging removes bytes, leaves the record, and a legal hold suspends it | `Evidence.purgedAt` and `purgeReason` mark the bytes; `LegalHold` carries its scope, reason, and release. |
| A host objection suspends every capture of that host until an operator clears it | `HostObjection` carries the host, reason, recording time, and the optional clearance with its operator and reason; no delete path exists. |

## Lifecycle transitions

The four record lifecycles are separate state machines, per "_docs/adr/0003-split-lifecycles.md_". Each state is a model with its own required fields, so a state that lacks the fields it needs cannot be constructed.

| Record | Model | Legal transitions |
| --- | --- | --- |
| Candidate | `CandidateLifecycle` | observed → `pending`; `pending` → `confirmed` through a violation decision; `pending` → `dismissed` through any other decision; `dismissed` → `pending` on an operator reopen or a material change. |
| Violation | `ViolationLifecycle` | confirmed → `open`; `open` → `removed` when a capture shows the URL gone; `open` → `closed` by an operator after a re-check. `removed` and `closed` are terminal; a reappearing URL creates a new violation. |
| Scan | `ScanLifecycle` | `queued` → `running`; `running` → `succeeded`, `partial`, or `failed`. A queued scan may stay queued with `budget_exhausted` or `route_unavailable`. |
| Notice | `NoticeLifecycle` | `draft` → `approved`; `draft` → `withdrawn`; `approved` → `withdrawn` while its submission is pending; `approved` → `superseded`. `withdrawn` and `superseded` are terminal. |
| Submission | `SubmissionLifecycle` | `pending` → `delivered` → `acknowledged`; `pending` → `rejected` or `failed`. A retry keeps the same row and increments `attemptCount`; a cancelled pending submission carries `cancelledAt` rather than a new state, because the glossary's five states do not include cancellation. |

## Relational rules the build effort must enforce

- `TitleGroup.locales` holds at least one locale.
- Exactly one `TitleVariant` per tracked title has `kind = original`, and it is the title's `originalVariantId`.
- `NoticeContent.citedViolations` holds at least one citation, and every citation's `evidence` holds at least one capture.
- `UNIQUE (normalized_url, tracked_title_id) WHERE state = 'open'` on violations.
- `UNIQUE (title_group_id, engine, due_date)` on scans, which makes a scan idempotent across scheduler restarts and duplicate wake-ups.
- `UNIQUE (engine, month_start)` on the quota ledger, and no endpoint deletes a ledger row.
- `UNIQUE (notice_id)` on submissions.
- `UNIQUE (recipient_profile_id, normalized_url, tracked_title_id)` among notices that are not withdrawn, superseded, rejected, or failed.
- `Evidence.failureReason IS NOT NULL` whenever `Evidence.outcome <> 'captured'`.
- `AllowlistEntry.territory IS NOT NULL` when `kind = licensed_destination`; `title_group_id` is set exactly when the scope is a title group, and `tracked_title_id` exactly when it is a tracked title.
- `TrackedTitle.originalVariantId` belongs to the same title; a merge is allowed only while the duplicate has no candidate and no violation.
- At most one active `HostObjection` exists per host: `UNIQUE (host) WHERE cleared_at IS NULL`. A cleared objection is never deleted, and a new one may be recorded afterwards.

## Deliberate omissions

- Credential material is not modelled: password hashes, TOTP secrets, recovery-code hashes, and session tokens never cross the domain or HTTP surface, and they live only in the API's own tables. `Operator` carries enrollment and state timestamps instead.
- No table stores a canonical title string separate from the original-title variant, and no table stores an operator-entered matching key: `normalizedText` is derived by the normalization rules and is never displayed.
- Defaults are not declared in TypeSpec, because the emitters keep a defaulted property required and Ajv applies defaults only with `useDefaults`, which mutates input. The application decides defaults.
