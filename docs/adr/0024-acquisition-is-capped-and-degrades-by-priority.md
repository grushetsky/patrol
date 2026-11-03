# Acquisition is capped at $60 a month and degrades by group priority

The rights holder accepts **$60 per month** for search acquisition: $48 for Google and $12 for Yandex, with Bing deferred at no cost. That buys 150 tracked titles scanned daily in two locales with the re-check share intact. The cap never truncates a plan; when a bucket runs out, work queues in a fixed order — re-checks first, then low-priority groups, then all scheduled scans — and the dashboard names the groups the month did not cover.

## Considered options

- **Pay per query with no cap.** Maximises coverage and removes the reason the product exists from the budget conversation: a runaway cadence or a broad catalogue produces a bill nobody approved.
- **$20 a month.** Covers about 50 titles daily, which is below the catalogue a rights holder of this shape actually tracks, so the cap would bind immediately.
- **$200 a month.** Comfortable headroom for 500 titles and a denser cadence, and it spends four times the price of the cheapest route that already meets the requirement.
- **Buy the priority, live, or synchronous routes.** Seconds of latency instead of minutes, at two to sixteen times the price, for scans a person reviews later.
- **Hard-stop at the cap without a degradation order.** Spends the month's allowance in arrival order, so an arbitrary group scans while a high-priority one waits, and a re-check can consume the share meant for discovery.

## Consequences

- Scheduled and manual scans both use the standard and deferred routes; priority, live, and synchronous modes stay off in v1, because a single synchronous Yandex query costs sixteen deferred ones and would break the envelope.
- The 70/30 split makes the degradation order enforceable: re-checks starve first, discovery keeps running, and low-priority groups stop at 90% of the scan share rather than at exhaustion.
- A queued scan is `budget_exhausted`, not skipped, and a `skipped_budget` count per group shows what the envelope failed to cover.
- Capacity is derived from the cap and the provider's price, not stored as a constant: a 20% price rise cuts daily capacity from 150 titles to about 120, and the settings screen says so.
- Title groups should hold 25 to 50 titles, because a group is the unit of the re-check that consumes the 30% share.
- The cap covers acquisition only; hosting, storage, and the rights holder's provider balances are separate budget lines, and the deployment design estimates hosting.
