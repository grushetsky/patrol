# Submission model

Patrol composes a notice, resolves every value a recipient's form asks for, and hands the result to an operator, who submits it through the recipient's own channel and records the acknowledgement. The scheduler prepares and queues; it never delivers. This document fixes the submission model, the per-recipient channels and eligibility rules, and the split between machine acts and the operator's act. Notice composition and grouping are settled separately by the ticket "Notice template and submission adapter contract"; the terms are those of "_GLOSSARY.md_".

## Why an operator submits

None of the three recipients offers a removal API, and each prohibits automated access to its forms and actively challenges it:

| Recipient | Terms position | Observed challenge |
| --- | --- | --- |
| Google | Bans automated access and bypassing protective measures | Google account sign-in gate, reCAPTCHA Enterprise, attempt cap |
| Bing | Bans circumventing restrictions and automating inauthentic activity | `solveAntiAutomation` proof-of-work, honeypot field, antiforgery token |
| Yandex | Bans automatic requests and refuses automatically generated information | SmartCaptcha |

Automating submission would therefore be a standing contract breach, and the consequence is not a fine but the loss of the channel that actually removes copies. A notice is also a statement made under penalty of perjury, so the act of filing it belongs to a person Patrol can name. The route is "_docs/adr/0014-operator-performed-submission.md_".

## Two kinds of act, two kinds of record

- **Machine acts** are composition, deduplication against open submissions, field resolution, upload-file generation, pre-handoff re-verification, and task creation. They attach to the notice as system events. They never produce a submission.
- **The operator's act** is opening the recipient's form, submitting it, and returning what the recipient answered. It produces the single `Submission` record for that delivery, and that record names the operator.

An approved notice with no operator action stays `Pending` forever. Nothing ages it into delivery.

## Flow

1. A violation is confirmed by a review decision. The recipient profile's composition trigger decides whether a notice draft appears immediately or waits for an operator to request one.
2. An operator approves the notice. The signatory is snapshotted and the notice becomes immutable.
3. Patrol creates one `Submission` per delivery the recipient's channel requires, in state `Pending`, carrying the resolved field values and the generated upload file.
4. The operator submits in their own signed-in browser session, then records the acknowledgement: the reference number or ticket id where the recipient issues one, and an attestation that they submitted.
5. The submission moves to `Delivered` or `Acknowledged` on that input, or to `Failed` when the operator reports a recipient error; `Rejected` records a refusal.
6. Retries, quota accounting, and the rule that a retry never double-submits belong to "Scan cadence, quota budget, and re-check policy".

## Composition trigger replaces submission mode

With submission always performed by an operator, "automatic" and "confirmation-only" submission describe the same act by the same actor. The only surviving difference is when a draft notice is assembled, so the mode axis moves off submission entirely. Each recipient profile carries a composition trigger:

| Trigger | Draft appears | Still requires |
| --- | --- | --- |
| Scheduled | Automatically, when violations are confirmed inside the profile's batching window | Operator approval, operator submission |
| On demand | When an operator selects violations and composes | Operator approval, operator submission |

The submission record therefore carries no mode. The states `Pending`, `Delivered`, `Acknowledged`, `Rejected`, and `Failed` stay as they are.

## Channels and eligibility

A recipient profile names a channel, the account the submission runs under, the required fields, and the limits the recipient publishes. Two channel values exist in the model:

- `web_form`, the only channel designed and built for v1, covering all three recipients.
- `trusted_program`, a recipient bulk programme with its own intake, currently Google's invitation-only Trusted Copyright Removal Program. It changes the intake, not the submission record.

| | Google | Bing | Yandex |
| --- | --- | --- | --- |
| Channel | `web_form`, Google account sign-in required | `web_form`, anonymous submission accepted, email still required | `web_form` |
| Bulk artifact | URL-list file, server-enforced cap discovered at runtime | One work per notice, `.txt` with at most 1,000 URLs | None; one URL per submission |
| Acknowledgement | Reference number plus Removals Dashboard | `TicketId` plus ticket-details URL | None published; the recipient's reply email is the only correlation key |
| Eligibility | None beyond an account | None beyond an email address | Rights holder in the US, an EU member state, or Switzerland |

Eligibility is a predicate on the profile, not a routing decision: an ineligible profile cannot be handed off and shows the reason it is ineligible. Because exactly one rights holder exists per deployment, this is a deployment-level flag. Yandex stays a discovery engine for an ineligible rights holder, since its results still surface copies, and only its submission channel is disabled.

The Trusted Copyright Removal Program is pursued rather than depended on. It requires a track record of accurate submissions and admission is discretionary, so the design must be complete without it; admission later flips one profile's channel to `trusted_program` and enables real batch.

## Rejected routes

- **Browser-assisted submission**: Patrol driving a visible browser and leaving the final click to a person is still automated access to a challenged form. It also adds three form scrapers that break on every redesign.
- **Unattended submission**: a scheduled job that signs in and posts notices breaches every recipient's terms and puts an unreviewed act under the signatory's name.
- **Third-party DMCA agent**: it would replace the rights holder's sworn statement with the vendor's, move evidence and contact data outside Patrol, and add agreements and a relationship that can be withdrawn. It is revisited only if operator handoff remains the throughput ceiling after the Trusted Copyright Removal Program is attempted, and then as another channel value, not another architecture.

## What Patrol records as the operator's act

- The operator's identity and the time of submission.
- The channel and the recipient profile it used, including the account.
- The recipient's acknowledgement, when one exists: Google's reference number, Bing's `TicketId`, or for Yandex the operator's note plus the reply email.
- The operator's attestation that the notice was submitted as presented.
- A link to the exact notice version, whose signatory and violations are already immutable.

The operator who submits need not be the signatory. The signatory attests to the notice at approval; the operator attests to the delivery.
