# Notice composition and handoff

Patrol turns confirmed violations into notices that an operator files in the recipient's own form. This document fixes what a notice contains, how violations group into one, when a draft appears, what the operator receives, and how the acknowledgement returns; the submission model is "_docs/design/submission-model.md_", the evidence a notice cites is "_docs/design/evidence-capture.md_", and the terms are those of "_GLOSSARY.md_".

## One notice, one delivery

A notice is the unit a recipient accepts. Its cardinality differs per recipient — Google takes a list of works and a URL file, Bing takes one work and up to 1,000 URLs, Yandex takes one URL — so grouping happens when the draft is composed, not when it is filed. Every notice therefore maps to exactly one delivery, and a batch that exceeds a recipient's limit becomes several notices, each approved and submitted on its own. The decision is "_docs/adr/0019-notice-grouping-is-per-recipient.md_".

Two actors appear on the record and only one appears on the form:

- The **signatory** is the natural person the rights holder authorised to attest. The notice snapshots that person at approval, and every statement and signature the recipient renders is the signatory's.
- The **operator** who approves and the operator who files are recorded on Patrol's side. No operator's name is typed into a recipient's form, because Google requires the typed signature to match the name at the top of the form and a mismatch risks rejection. The decision is "_docs/adr/0021-signatory-attests-and-operator-files.md_".

## What a notice carries

| Element | Contents | Frozen at |
| --- | --- | --- |
| Identity | UUIDv7, recipient, recipient profile and channel, product | Draft creation |
| Recipient binding | Profile version, channel, account, published limits, form URL and version observed | Approval |
| Rights holder | Legal name, country, address, role mailbox, phone where the form asks | Approval |
| Signatory | Full legal name, authority basis, snapshot of the contact profile | Approval |
| Cited violations | The violations and, per violation, the exact evidence ids and capture times | Approval |
| Work identification | Per cited tracked title: display title, year, type, and authorised example URL | Approval |
| Statement set | Exact text of every required statement, with its template version | Approval |
| Resolved fields | The form-ordered field map the operator will copy from | Approval |
| Date | The submission date, rendered into the pack at handoff, never into an approved notice | Handoff |

A notice cites one or more violations of exactly one rights holder and is addressed to exactly one recipient. Its evidence citations are the `pre_handoff` and earlier captures that existed when it was approved; a later capture never changes what an approved notice claims.

## Grouping per recipient

| | Google Search | Bing content removal | Yandex copyright form |
| --- | --- | --- | --- |
| One notice covers | Many works, many URLs | One tracked title, up to 1,000 URLs | One violation, one URL |
| Split rule | At most 500 URLs by default, lowered to the server-discovered cap when the form reports it | One notice per title; a title over 1,000 URLs splits into numbered notices | One notice per violation |
| Product scope | Web search only in v1 | Web search only in v1 | Web search only in v1 |
| Upload file | `.txt`, one URL per line, `# <title>` comment lines allowed | `.txt`, one URL per line, at most 1,000 | None |
| Eligibility | A Google account exists in the profile | A contact mailbox exists | Rights holder in the US, an EU member state, or Switzerland |

Google's per-file cap is server-side and unpublished: the form's error text supplies the value, which the profile records as `max_urls_per_file` and the next draft respects. Patrol never discovers the cap by submitting a file it expects to fail more than once, and never hard-codes a number. Bing's per-day quota is treated the same way: the profile records the last observed quota, and a refusal lowers the effective daily batch until the next observation.

## Composition triggers and windows

Every recipient profile carries a composition trigger, as "_docs/design/submission-model.md_" settles:

- **Scheduled.** A daily window, default 07:00 UTC and configurable per profile, composes drafts for violations confirmed since the profile's previous window. A violation confirmed while the window is open waits for the next one, so a window is a cut-off, not a rolling queue.
- **On demand.** An operator selects confirmed violations and composes a draft immediately. A manual draft uses the same grouping, limits, and approval path.

A violation is reserved by an open notice as soon as the draft cites it, so it cannot appear in a second draft. The reservation is released when the draft is withdrawn or superseded, and it ends when the notice's submission reaches `Rejected` or `Failed`. This is also the deduplication that keeps a recipient from receiving the same URL twice: `(recipient, normalized URL, tracked title)` is unique among notices that are not withdrawn, superseded, rejected, or failed.

## Approval

An operator approves a draft by confirming that every cited violation was reviewed, that the statement text is the recipient's current text, and that the signatory is the person authorised to attest. Approval:

1. Freezes the notice and its resolved field map.
2. Snapshots the signatory and the rights-holder contact profile.
3. Queues the `pre_handoff` capture for every cited URL whose newest live capture is older than seven days, as "_docs/design/evidence-capture.md_" requires.
4. Creates one `Submission` in state `Pending` with the handoff pack once the captures settle.

Any `Operator` may approve; the approving operator is recorded. The role set is settled by "Operator authentication and roles", and the signatory is a profile rather than an account.

A draft may be **withdrawn** by an operator while it is still a draft, and an approved notice may be withdrawn while its submission is still `Pending`. Withdrawal releases the cited violations for a later draft. Once a submission is `Delivered` or `Acknowledged`, the notice can no longer be withdrawn; a wrong notice is corrected by a new notice, and the recipient's process, not Patrol's, handles the old one.

A notice is **superseded** when its cited set must change after approval — a page died and the operator decided to drop it, a field was wrong, or a new violation belongs in the same batch. The old notice becomes `Superseded`, its `Pending` submission is cancelled, and a new draft carries the corrected set. No operator edits an approved notice's contents in place.

## The handoff pack

A submission gives the operator an immutable pack, stored content-addressed in the evidence bucket and linked from the submission. The decision is "_docs/adr/0020-handoff-is-a-frozen-pack.md_"; the pack holds:

| Artifact | Contents |
| --- | --- |
| `notice.html` | Printable notice in the recipient's field order, with statements quoted verbatim |
| `fields.json` | The resolved field map: field name, value, whether the form marks it required, and the length cap |
| Upload file | The recipient's URL file, or none where the recipient asks for a single URL |
| `handoff.md` | Form URL, sign-in requirement, the step checklist, the exact statements to tick, and the acknowledgement fields to return |
| Capture flags | Per cited URL, the newest capture outcome and any `dead` or `blocked` warning |

The pack is generated from the frozen notice, never edited, and never regenerated with different content; a pack that must change means a superseded notice. The submission page shows the pack, the recipient's form in a new browser tab, and the acknowledgement form. Patrol never drives that browser tab, as "_docs/adr/0014-operator-performed-submission.md_" settles.

The pack renders the signatory's name in every identity and signature field and the rights holder's role mailbox as the contact address. Google republishes qualifying notices through Lumen, so the pack states that the contact details become public; Patrol never places an operator's personal email, phone number, or home address on a form.

## Recording the acknowledgement

The operator either files the notice and records what the recipient returned, or reports that the filing failed. The submission is keyed by the notice's delivery and is unique, so a retry can never create a second delivery for the same notice.

| Recipient | Acknowledgement fields | Accepted shape |
| --- | --- | --- |
| Google | Reference number, Removals Dashboard URL | Free text of 4 to 40 characters, plus the dashboard link |
| Bing | `TicketId`, ticket-details URL | The id parsed from `TicketDetails?ticketId=<id>`, and the URL |
| Yandex | Reply email `Message-ID`, reply date | The `Message-ID` header value and a date |

The operator's attestation that the notice was filed as presented is mandatory. Without it the submission stays `Pending`. `Delivered` means the operator filed and supplied an attestation; `Acknowledged` means the recipient's identifier is recorded; `Failed` means the operator reported a recipient error and the pack can be retried.

Retries, quota accounting for submission attempts, and the rule that a retry never double-submits belong to "Scan cadence, quota budget, and re-check policy".

## Re-verification before handoff

The only re-check a notice performs is the `pre_handoff` capture that approval queues, and it runs when the newest live capture is more than seven days old. Patrol does not re-check every URL immediately before every filing: the capture is a fetch of the recipient's target, not of the form, and a fresh capture for a notice approved an hour ago would prove nothing new.

A `pre_handoff` capture that comes back `dead` never drops the URL from the notice silently. The pack flags the violation and shows the earlier live capture beside it, and the operator chooses:

- **Submit anyway.** Google accepts URLs outside its index, and a truthful notice about a page that has since gone is still truthful. The pack records the choice and the capture it rests on.
- **Drop it from this notice.** The approved notice is superseded by a draft without that violation, the violation is closed as removed, and the closed record keeps the captures its predecessor cited.

A `blocked` capture is shown with the same warning and a different instruction: the page still exists but refuses Patrol, so the operator may still file, and the submission records that the newest capture was blocked.

## Volume and accuracy safeguards

Google can suspend a submitter whose notices are systematically invalid, and Bing rejects URLs already in flight, so accuracy is a per-profile operational control rather than a per-notice checkbox:

- The first five notices a profile produces are approved by a second operator where two exist.
- Every `Rejected` submission requires a review note naming the cause, and the offending violation gets a review decision before it can be cited again.
- A profile whose `Rejected` plus `Failed` share exceeds 10% over its last twenty submissions pauses scheduled drafting, shows the reason to an administrator, and resumes only on an explicit clearance. On-demand drafting stays available so a single bad batch does not stop urgent work.
- The profile records the last observed per-file cap, per-day quota, and duplicate error so the next draft respects them without rediscovery.

## What this implies for the model

The TypeSpec model carries a `RecipientProfile` with its channel, trigger, limits, and contact profile; a `Notice` with its template version, signatory snapshot, resolved field map, and cited violations and evidence; and a `Submission` with its pack reference, acknowledgement, and attempt. The HTTP contract exposes draft creation, approval, withdrawal, pack download, and acknowledgement recording, and exposes no mutation of an approved notice. The TypeSpec model that follows from this lives in the ticket "TypeSpec domain model".

## Open risks

- Google's per-file and per-day caps are unpublished and can change; the design learns them from error text, which delays a batch when the cap moves down.
- The signatory's typed name is filed by an operator, so the separation rests on the operator's authority and the recorded attestation, not on the recipient verifying who typed.
- Yandex publishes no case number, so acknowledgement depends on the operator keeping the reply email that Patrol records only as a `Message-ID`.
- Lumen republication makes the signatory's name and the rights holder's contact details public, which cannot be undone after filing.
- A profile paused by the rejection threshold stops scheduled coverage until an administrator clears it, which is deliberate but is throughput the rights holder loses.

## Sources

- "_docs/research/notice-submission.md_" on `research/notice-submission` at `b063eeb`: field maps, per-recipient cardinality, caps, acknowledgement signals, and the Lumen republication.
- "_docs/research/matching-prior-art.md_" on `research/matching-prior-art` at `5327830`: recipients need URLs, work identification, statements, and a signature only.
- "_docs/design/submission-model.md_" and "_docs/adr/0014-operator-performed-submission.md_" for the operator-performed submission model and the composition trigger.
- "_docs/design/evidence-capture.md_" and "_docs/adr/0016-evidence-is-a-rendered-page-bundle.md_" through "_docs/adr/0018-single-url-evidence-fetch.md_" for the `pre_handoff` capture and the dead-page rule.
