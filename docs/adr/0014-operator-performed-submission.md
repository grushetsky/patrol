# Notices are prepared by Patrol and submitted by an operator

None of the three recipients offers a removal API, and all three prohibit automated access to their forms, actively challenging it with sign-in gates, reCAPTCHA Enterprise, a proof-of-work challenge, and SmartCaptcha. Patrol therefore composes each notice, resolves every field value, generates the recipient's upload file, and hands the result to an operator, who submits it through the recipient's own channel and records the acknowledgement. The scheduler never contacts a recipient, and a submission is always attributed to an operator.

## Considered options

- **Unattended automation.** The obvious reading of "submits notices automatically", and a standing breach of every recipient's terms whose realistic cost is losing the channel that removes copies, plus an unattended act filed under a perjury statement.
- **Browser-assisted submission.** Patrol drives a visible browser and leaves the final click to a person; still automated access to a bot-challenged form, and three scrapers to maintain against redesigns.
- **Third-party DMCA agent.** Buys existing recipient relationships, but replaces the rights holder's sworn statement with a vendor's and moves evidence and contact data outside Patrol.

## Consequences

- "Automatic on schedule" means automatic preparation and queuing, never automatic delivery. The automatic-versus-confirmation-only mode axis collapses, because both end in the same operator act; recipient profiles carry a composition trigger instead, and the submission record carries no mode.
- Every submission state depends on operator input, so the review queue's capacity is also the submission ceiling, and a stale `Pending` submission is a visible backlog rather than a silent failure.
- The Google Trusted Copyright Removal Program is pursued as an operational route, not assumed: admission is discretionary and needs a track record, so `trusted_program` exists as a channel value that v1 does not build.
- Yandex submission is gated on the rights holder being in the US, an EU member state, or Switzerland, because its policy is territorially limited; Yandex remains a discovery engine when the gate closes.
- The operator who submits is recorded separately from the signatory who attested at approval; the same person may hold both roles, but the records never merge.
