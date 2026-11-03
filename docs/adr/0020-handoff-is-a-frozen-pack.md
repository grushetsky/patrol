# A handoff is a frozen pack, and the operator returns the acknowledgement

Patrol prepares a notice but never contacts a recipient. The operator therefore needs everything the form asks for, in the form's order, with no room to improvise: an approved notice produces one immutable handoff pack containing the printable notice, the resolved field map, the recipient's upload file, and a checklist naming the form, the sign-in requirement, and the acknowledgement fields to return. The pack is stored content-addressed and linked from the single `Submission` that the notice produces.

## Considered options

- **A live form-filling helper that copies fields into the recipient's page.** Closest to automation, and the closest to the automated-access posture every recipient forbids; it also makes Patrol depend on three form DOMs that change without notice.
- **A printable notice only, with field values in the notice body.** Fewer artifacts, but the operator retypes values, misreads which field is required, and the acknowledgement shape is left to memory.
- **A regenerated pack at each viewing.** Never stale, but two operators could see two different packs for one approval, and the pack would stop being evidence of what was handed off.

## Consequences

- The pack is generated once from the frozen notice; a pack that must change means a superseded notice and a cancelled `Pending` submission.
- Every field carries its value, its required flag, and the recipient's cap, so the operator copies rather than interprets.
- Acknowledgement recording is part of the pack's checklist: Google's reference number and dashboard, Bing's `TicketId` parsed from the ticket URL, Yandex's reply-email `Message-ID`. A submission without the operator's attestation stays `Pending`; it never ages into `Delivered`.
- The pack renders the signatory's name in every identity and signature field and the rights holder's role mailbox as contact, because Google republishes notices through Lumen and requires the typed signature to match the name at the top of the form.
- A dead or blocked pre-handoff capture is a visible flag in the pack with the earlier live capture beside it, and the operator's choice is recorded; no URL is dropped silently.
