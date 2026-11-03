# One notice maps to one delivery, so grouping happens per recipient

The three recipients accept different shapes: Google takes a representative list of works with a URL file whose cap is server-configured and unpublished, Bing takes exactly one work per notice with at most 1,000 URLs, and Yandex takes exactly one URL per form submission. Patrol therefore composes a notice per recipient at draft time, splits a batch that exceeds the recipient's limit into several notices, and gives every notice exactly one submission. Violations are reserved by an open notice so the same URL cannot enter two drafts for the same recipient.

## Considered options

- **One internal notice split into deliveries at handoff.** Keeps a single document as the claim, but the recipient's unit is what gets approved and acknowledged, so one record would have to track several acknowledgements, several partial failures, and a split that changes after approval, and the immutable notice would stop being the thing that was filed.
- **One notice per violation everywhere.** Uniform and simple, but it throws away the batch that Bing and Google's forms accept, multiplying approvals and submissions by the number of URLs.
- **One universal notice with a per-recipient adapter.** Pushes cardinality into a transformation that must also invent the work identification and the statements, and hides the actual limit from the operator who approves the batch.

## Consequences

- A batch over a recipient's cap becomes several notices, each with its own signatory snapshot and submission, so one bad URL cannot invalidate the rest.
- A violation is reserved by the first open notice that cites it; the reservation is released on withdrawal, supersession, rejection, or failure, which is the same rule that prevents a duplicate submission to a recipient that rejects in-flight URLs.
- Approval freezes the cited set. Changing it means superseding the notice, never editing it, so the record always explains exactly what was filed.
- The recipient profile carries the discovered per-file and per-day caps, and the next draft respects them; a cap change costs one rejected file rather than a hard-coded constant that drifts.
