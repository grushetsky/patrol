# Evidence is captured per URL and shared across violations

Page captures are page-level facts and expensive to take, while violations are per title. Patrol stores evidence as immutable, content-addressed records keyed by URL and capture time, and every violation on that page references the same records. A notice records the evidence versions it relied on, so a later capture never changes what a past notice claimed.

## Considered options

- One capture per violation: isolates records, but duplicates bytes N times and lets copies drift.
- One capture per candidate: ties evidence to a single title and loses the shared page fact.

## Consequences

Evidence outlives any single violation, and storage deduplicates by content hash. Deleting a violation never deletes a page capture that other violations still cite.
