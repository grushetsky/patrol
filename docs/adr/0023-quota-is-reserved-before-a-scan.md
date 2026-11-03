# Quota is reserved before a scan and committed after it

Patrol's spend authority is a ledger in PostgreSQL, one row per engine and UTC month, not the provider's balance. A scan prices its plan before it starts, reserves the units in one transaction against its bucket, and commits what it actually issued when it finishes; a plan that does not fit stays queued with an explicit budget-exhaustion reason. The provider's prepaid balance is a daily backstop alert, not the budget.

## Considered options

- **Spend against the provider's balance.** One source of truth, but the provider knows what it charged and not which bucket, group, or re-check caused it, and it cannot prevent the scan that overspends.
- **Count after the scan.** Simplest, and it lets concurrent scans both spend the last of a bucket, which is the failure mode the reservation exists to prevent.
- **Reserve the whole month up front per group.** No contention, but it hands a group an allowance it may not need and starves the others.
- **Hard-stop at the provider.** A provider quota refuses requests but returns no useful accounting, and a refusal is indistinguishable from an outage in Patrol's own records.

## Consequences

- A plan that does not fit its share never starts and never truncates: it queues with `budget_exhausted`, so a missing scan is explainable.
- Reservations expire after an hour if the job never starts, and a failure releases the units it did not issue, so a crashed worker does not leak budget.
- A reservation made before midnight stays in its month; the rollover job opens the new month's row at 00:00 UTC, and a lowered allowance cannot un-spend what is already committed.
- The ledger distinguishes the scan share from the re-check share, which is what makes "re-checks starve first" enforceable rather than advisory.
- Two sources of alerting remain: the ledger's 75/90/100% thresholds and a daily provider-balance probe, so a thin provider balance is caught before the ledger spends into it.
