# Lifecycle is split across candidate, violation, notice, and submission

The end-to-end chain from detection to closure crosses four records with independent transitions, and a violation can be cited by more than one notice over time. Patrol therefore models four state machines: candidate (pending, confirmed, dismissed), violation (open, removed, closed), notice (draft, approved, withdrawn, superseded), and submission (pending, delivered, acknowledged, rejected, failed). The chain remains the documented journey, not a single status field.

## Considered options

- One violation status spanning the chain: cannot represent a violation cited by two notices in different states, and mixes submission outcomes with violation state.
- One violation status stopping at submitted, plus a separate submission outcome: still conflates the notice document with the delivery attempt.

## Consequences

Each transition is enforceable in the TypeSpec model. Dashboards derive the journey by joining the four records.
