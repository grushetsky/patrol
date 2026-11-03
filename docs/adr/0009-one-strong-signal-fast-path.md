# One strong signal plus an exact title match reaches the approval queue

The matching research recommended two independent strong signals for the fast path. Patrol instead accepts one strong signal when the page carries an exact title variant, because every violation still passes a human review decision and a second signal mostly delays obvious cases. The score makes the boundary explicit: an exact variant match is 0.70, the first strong signal adds 0.25, and the approval band starts at 0.95. A slug or partial match with one strong signal reaches 0.85 and stays in review unless reputation supplies the remaining 0.10; reputation applies only alongside a strong signal, so weaker title evidence still needs corroboration.

## Considered options

- Two strong signals as researched: fewer candidates in the fast path, more review of obvious pages.
- Any title match plus one strong signal: higher recall, but slug-only matches would reach one-click approval.
- Count-based points: simpler, but loses the ranking the queue needs.

## Consequences

Thresholds and weights are calibration constants, not policy; review labels can move them. The policy that keeps human confirmation is recorded separately and is unchanged.
