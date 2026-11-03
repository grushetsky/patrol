# Re-checks reissue the whole query plan

A re-check repeats every query of the scan that found the violations, under the same variants and intent-phrase versions, instead of narrowing to the queries that previously produced candidates. A narrowed set is cheaper but makes "not found this time" indistinguishable from "not looked for", and it cannot detect a copy that migrated to a query that never fired before.

## Considered options

- **Only the queries that produced candidates.** Cheapest, but it freezes the search to its first lucky hits and quietly stops covering the rest of the title.
- **Only the bare-variant query.** Half the cost of a full plan, and blind to the intent phrasings that surfaced the violation in the first place.
- **Skip the re-check when the budget is tight.** Saves money in the worst month, at the cost of the removal signal the ladder exists for; the reservation in the budget model covers this case instead.

## Consequences

- A re-check costs as much as a scan of the same title, so the 30% re-check reservation is sized against the same per-title price.
- Every observation is comparable across time, and a dismissal reopens only on the material changes the matching rules already enumerate.
- An operator-triggered check of a single title issues that title's queries only, so it stays cheap without weakening the scheduled set.
