# Glossary audit

The audit checks that every glossary term is used with the agreed meaning by the contract and the operator screens, and that no screen renames a domain concept. The glossary is canonical; this audit changes nothing in "_GLOSSARY.md_".

## Method

- Extracted the 27 bold entries from "_GLOSSARY.md_" and mapped each to the contract types that carry it.
- Extracted every `model`, `enum`, `union`, and `scalar` from "_contract/tsp/_" and checked each against the glossary or against the support-record categories below.
- Read the six screens and the review-queue, notice, and settings behaviour in "_docs/design/dashboard-ui.md_" and the action labels in the prototype, then checked each label against the glossary's terms and its `_Avoid_` lists.
- Checked the operator-facing design documents for a concept that the contract models but the glossary does not name.

## Terms and their surfaces

| Term | Contract types | Where the operator sees it | Status |
| --- | --- | --- | --- |
| Rights holder | `RightsHolder`, `RightsHolderSnapshot` | Claimant on a notice; settings for administrators. | Defined and used. |
| Operator | `Operator`, `OperatorSession`, `Invitation` | Sign-in, session list, operator administration. | Defined and used. |
| Signatory | `Signatory`, `SignatorySnapshot` | Notice card and composed notice; rights-holder settings. | Defined and used. |
| Tracked title | `TrackedTitle`, `TrackedTitleCard`, `TrackedTitleDetail` | Titles, review queue, violations. | Defined and used. |
| Title variant | `TitleVariant`, `VariantSnapshot`, `NewTitleVariant` | Titles, the review queue's matched variant. | Defined and used. |
| Title type | `TitleType` | Titles, review queue, notice work identification. | Defined and used. |
| Title group | `TitleGroup` | Titles, scan settings, chart grouping. | Defined and used. |
| Allowlist entry | `AllowlistEntry`, `AllowlistEntrySummary` | Review flags, settings. | Defined and used. |
| Locale | `Locale` | Title groups, review source, scan results. | Defined and used. |
| Territory | `Territory` | Allowlist, title variants, query source, review. | Defined and used. |
| Engine | `Engine` | Dashboard engine row, review source, scan history. | Defined and used. |
| Scan | `Scan` | Scan history, dashboard activity. | Defined and used. |
| Search query | `SearchQuery` | Scan detail and results. | Defined and used. |
| Query plan | `QueryPlan` | Scan detail. | Defined and used. |
| Search result | `SearchResult` | Scan results; the review row's source. | Defined and used. |
| Candidate | `Candidate`, `CandidateReviewRow` | Review queue and detail. | Defined and used. |
| Review decision | `ReviewDecision`, `ReviewDecisionRequest`, `ReviewDecisionResult` | Review actions and prior-decision flag. | Defined and used. |
| Violation | `Violation`, `ViolationRow`, `ViolationDetail` | Violations list and detail, notice citations. | Defined and used. |
| Host | `Host` | Review and violation rows, host objection. | Defined and used. |
| Registrable domain | `RegistrableDomain` | Review reputation flag, violation rows. | Defined and used. |
| Capture | `CaptureRequest`, `CaptureReason`, `CaptureOutcome`, `CaptureProfile` | Evidence dialogs, capture-on-demand action. | Defined and used. |
| Evidence | `Evidence`, `EvidenceSummary`, `EvidenceDetail`, `EvidenceArtifact` | Review evidence column, violation detail, notice citations. | Defined and used. |
| Legal hold | `LegalHold` | Administrator capability; no screen is specified. | Defined; API only. |
| Recipient | `Recipient` | Notice cards, cart recipient selector. | Defined and used. |
| Recipient profile | `RecipientProfile`, `RecipientProfileSnapshot` | Administrator settings; no screen is specified. | Defined; API only. |
| Notice | `Notice`, `NoticeCard`, `NoticeDetail`, `NoticeContent` | Notices list and composed document. | Defined and used. |
| Submission | `Submission`, `SubmissionDetail` | Notice stepper and submission detail. | Defined and used. |

No term is defined twice, and no two terms compete for one concept.

## Records outside the glossary

The glossary holds concepts, not every table. These groups are deliberate omissions, each named by the terms above:

- **Lifecycle states and transitions** (`CandidateLifecycle`, `ScanLifecycle`, `ViolationLifecycle`, `NoticeLifecycle`, `SubmissionLifecycle`, and their members). These are states of a glossary term, listed in the glossary's lifecycle table rather than defined as terms.
- **Snapshots, score components, and citations** (`VariantSnapshot`, `ReputationSnapshot`, `ScoreComponents`, `SignalContribution`, `EvidenceCitation`, `CitedViolation`, `WorkIdentification`, `NoticeStatement`, `ResolvedField`). Value records inside a decision or a notice; they have no independent meaning.
- **Operational records** (`QuotaLedger`, `BudgetReservation`, `RecheckSchedule`, `AcquisitionBudget`, `EngineBudgetCap`, `ExternalIdentifier`, `TitleProvenance`). Quantities and settings defined in the design documents, not vocabulary.
- **Auth records** (`OperatorSession`, `Invitation`, `OperatorAttestation`). Implementation records behind the `Operator` and `Submission` terms.
- **Transport records** (`ErrorBody`, every `*Request`, `*Response`, `*Page`, and HTTP read model). The API's shape, not the domain's language.
- **The proposed additions below.** They are concepts the design names but the vocabulary has not yet admitted.

## Findings

### One label drifted

"_docs/design/dashboard-ui.md_" labelled the review queue's first content column "Work", a word the glossary lists under `_Avoid_` for a tracked title. The column now reads "Tracked title". No other screen label collides with an `_Avoid_` entry: the prototype's demonstrator strings are discarded by the design, and "provider" in the design documents names a vendor (DataForSEO, Yandex) rather than an engine concept.

### Administrator screens are not specified

"_docs/design/dashboard-ui.md_" fixes six operator-facing sections and the Settings allowlist table, but it does not specify screens for the rights holder and signatory, recipient profiles, the acquisition budget, operators and invitations, or legal holds. The HTTP contract carries every operation those screens need. The build effort designs the screens; the vocabulary and the API already constrain them. This is recorded as an open UI scope item, not as a glossary gap.

### Three concepts are named but not admitted

The design and the contract use three concepts that the frozen vocabulary predates. They are documented where they live, and the audit proposes these entries for a future vocabulary ticket rather than editing the canonical glossary:

```
**Host objection** (`HostObjection`):
A host's recorded refusal of Patrol's capture, such as a cease-and-desist, a block notice, or an abuse complaint naming Patrol, which suspends every capture of that host until an operator clears it.
_Avoid_: Ban, block, opt-out.

**Handoff pack** (`HandoffPack`):
The frozen, content-addressed set of files an operator files for one approved notice.
_Avoid_: Bundle, export, submission package.

**Notice status** (`NoticeStatus`):
The derived state a notice list shows by joining the notice and the submission lifecycles.
_Avoid_: Notice state, which is the notice's own lifecycle.
```

Until that ticket exists, the artifacts that introduce each concept are canonical: "_contract/tsp/violations.tsp_" for the objection, "_docs/adr/0020-handoff-is-a-frozen-pack.md_" for the pack, and "_contract/HTTP.md_" for the derived status.

## Verdict

Every glossary term is used consistently by the model and the operator screens; the one drifted label is corrected; the three unadmitted concepts are additions, not conflicts, and none blocks the build. Changing "_GLOSSARY.md_" remains a vocabulary-ticket act.
