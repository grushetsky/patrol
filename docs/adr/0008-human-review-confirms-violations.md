# Every violation passes a human review decision

A notice is a sworn statement made under penalty of perjury, and Google publishes every search notice to Lumen, so a false positive is a public misstatement rather than a ranking mistake. Patrol therefore never confirms a violation from a score: the highest band queues a candidate for one-click approval, and every violation records a review decision and its actor. The queue orders by score so review effort lands where the evidence is strongest.

## Considered options

- Auto-confirm above a score threshold: fastest, but it puts an unreviewed claim under the signatory's name.
- Auto-confirm only on hosts with a long confirmed history: reduces risk, but one bad host decision propagates and the invariant still breaks.
- Trust ramping per operator: adds a second state machine for a queue of hundreds of titles.

## Consequences

Review capacity is the throughput ceiling, and band A is designed for one click. Thresholds and weights can change without changing the policy.
