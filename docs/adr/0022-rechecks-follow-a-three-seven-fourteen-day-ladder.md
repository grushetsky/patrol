# Re-checks follow a 3, 7, and 14-day ladder per title group and engine

A confirmed violation starts a re-check ladder for its title group and engine: re-scan at 3, 7, and 14 days, then every 14 days while any violation from that pair is still open. A re-check reissues the whole query plan, because the queries that found the copy are not known to be the queries that find it next month. The ladder stops when the pair has no open violation, and an operator's manual scan or re-check resets it to the first rung.

## Considered options

- **Re-check daily.** The closest watch on a live page, and it spends the allowance on pages that have not moved: a 100-title group scanned daily at six queries per title costs more than the discovery it duplicates.
- **Re-check once, at 7 days.** One chance to observe removal, then silence; a page still live after a week is exactly the one that needs a later look.
- **Per-violation ladder.** Precisely tracks one URL's life, but a re-check reissues a whole group plan, so ten violations in one group would schedule ten identical scans.
- **No ladder, rely on the next scheduled scan.** Cheapest, and the scan that found the violation is the same scan that would find it again, so a group whose cadence is weekly would re-check on a schedule that has nothing to do with the violation.

## Consequences

- The ladder is keyed by `(title group, engine)`, which is the unit a scan targets, so the schedule and the cost match.
- The 3-day rung catches a takedown that works; the 7 and 14-day rungs catch a copy that was restored or replaced; the 14-day tail bounds the spend on a page that refuses to die.
- A manual re-check resets the ladder to rung one, because an operator asking for a look now is signalling that this pair matters sooner than the ladder says.
- Re-checks draw on the 30% re-check share and never on the scan share; when the share is spent, the ladder waits rather than starving discovery.
- Because each rung costs a whole group plan, title groups should hold roughly 25 to 50 titles; the budget design sizes them that way.
