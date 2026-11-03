# Budget envelope and title capacity

The rights holder's recurring acquisition cost is capped at **$60 per month**: $48 for Google results and $12 for Yandex, with Bing deferred and costing nothing until it is added. That buys roughly 150 tracked titles scanned daily in two locales, with the re-check ladder funded, and the cap degrades scans by priority rather than truncating a plan. This document fixes the cap, the cost model behind it, the capacity it implies, and the order work stops in as the cap approaches. The routes and prices are "_docs/design/serp-acquisition-route.md_", the query plan and the 70/30 split are "_docs/design/query-strategy.md_", the ledger and alerts are "_docs/design/scan-scheduling.md_", and the terms are those of "_GLOSSARY.md_".

## The cap

| Engine | Monthly cap | Billable units | Queries at depth 20 |
| --- | --- | --- | --- |
| Google | $48.00 | 80,000 SERP units at $0.60 per 1,000 | 40,000 depth-20 queries |
| Yandex | $12.00 | 48,000 requests at $0.25 per 1,000 deferred | 48,000 requests |
| Bing | $0, deferred | — | — |
| **Total** | **$60.00** | | |

The cap covers search acquisition only. Evidence storage, the application's hosting, and the rights holder's own provider accounts are separate lines in the operating budget, and the deployment design estimates the hosting side.

Only the **standard** routes are bought: DataForSEO's standard queue at $0.60 per 1,000 and Yandex's deferred mode at $0.25 per 1,000. Priority ($1.20), live ($2.00), and Yandex synchronous ($4.00) are not used in v1, because the same query at sixteen times Yandex's deferred price would spend a month's cap in two days, and the latency they buy — seconds instead of minutes — changes nothing for a scan whose results are reviewed by a person later. A manual scan queues on the standard route and is still placed ahead of scheduled work in the queue.

Ten thousand depth-20 Google queries cost $12.00 and ten thousand Yandex requests cost $2.50, which is the order of magnitude this envelope is built around.

## What a scan costs

The query plan issues six queries per title per scan when a title has two locales — two bare-variant queries (one per locale) and four intent queries (two per locale), per "_docs/design/query-strategy.md_". A title with one locale issues three, and a third locale adds three more; the plan caps at three variants per locale, so the six-query shape is the reference case, not a hard ceiling.

| Scope | Queries | Google | Yandex |
| --- | --- | --- | --- |
| One title, one scan, two locales | 6 | $0.0072 | $0.0015 |
| One group of 50 titles, one scan | 300 | $0.36 | $0.075 |
| One group of 50 titles, daily for 30 days | 9,000 | $10.80 | $2.25 |
| 150 titles, daily for 30 days | 27,000 | $32.40 | $6.75 |

Re-checks multiply the per-scan cost by the ladder in "_docs/adr/0022-rechecks-follow-a-three-seven-fourteen-day-ladder.md_": in the first fourteen days a pair is checked three times, then twice a month, and a re-check costs a whole group plan. A group of 50 titles with one open violation therefore spends about 1,200 queries a month on its ladder, or $1.44 on Google.

## Capacity

The scan share is 70% of each engine's allowance, so Google's 40,000 queries leave 28,000 for new scans and 12,000 for re-checks. At six queries per title per scan:

| Cadence | Tracked titles | Scan queries per month | Google cost | Re-check headroom |
| --- | --- | --- | --- | --- |
| Daily | **150** | 27,000 | $32.40 | 1,000 queries |
| Every other day | 300 | 27,000 | $32.40 | 1,000 queries |
| Weekly | 1,000 | ~26,000 | ~$31.20 | 1,000 queries |

150 titles is the design point: it uses 96% of the scan share and leaves the re-check share intact. A deployment that tracks fewer titles has room for a third locale or a denser cadence; one that tracks more must either raise the cap, lower the cadence, or shrink the locale set, and the settings screen shows which of those the current plan implies.

Yandex's allowance is deliberately set a little above the mirrored query count — 48,000 requests against 40,000 planned — because a Yandex request answers thirty results in one call and its count is not reduced by Google's depth-20 billing. The surplus covers a second locale pass or a heavier re-check month without changing the cap.

Title groups should hold **25 to 50 titles**. The group is the unit of a scan and of a re-check, so a group of 150 titles makes every ladder rung cost 900 queries and a single open violation starves the rest of the month's re-check share; four groups of about 38 titles keep each rung affordable.

## Degradation order

The cap never truncates a plan; it decides which work waits. The order is fixed so that operators can predict it:

1. **Re-checks starve first.** When the 30% re-check share is spent, due re-checks queue and the scan share is untouched. This is "_docs/design/query-strategy.md_"'s rule, and it means discovery keeps running while verification waits.
2. **At 90% of the scan share, low-priority groups stop being scheduled.** High and normal priority groups keep scanning; low-priority groups queue even though units remain. A group's priority is a setting, default normal, and the settings screen shows which groups would stop first.
3. **At 100% of the scan share, scheduled scans queue.** They do not drop: each waits with `budget_exhausted` and runs when the next month's allowance opens or the cap is raised. Within a resumed month, scans run by priority, then by staleness.
4. **Manual scans keep their place.** A manual scan still preflights, still uses the same pool, and still runs ahead of scheduled work; if the pool is empty it queues rather than skipping, so an operator can see that the check is waiting for budget.

The order inside one priority is least recently scanned first, so a cap that allows only part of the month scans each group once before any group twice.

## Alerts

The thresholds in "_docs/design/scan-scheduling.md_" apply per engine and per bucket: 75% is a warning, 90% is critical and coincides with low-priority groups stopping, and 100% is critical and means queued work. Every alert names the engine, the bucket, the dollars spent, the queries spent, and the groups that have not scanned this month.

The daily provider probe adds a top-up warning at 10% of an engine's cap, so a prepaid balance that will not cover the ledger's remaining allowance prompts a top-up before a scan fails. Patrol's ledger remains the authority: a healthy provider balance does not permit spending past the cap, and a thin balance does not silently change the plan.

A `skipped_budget` count per group appears on the dashboard each month, so an operator sees which groups the envelope actually failed to cover rather than inferring it from a quiet queue.

## Who decides, and what changes the numbers

The cap and the per-engine split are settings an administrator edits; changing them does not rewrite history, because the ledger records what each month actually spent. Capacity is derived, not stored: the settings screen recomputes titles, locales, and cadence against the current cap and shows the shortfall when the plan exceeds it.

The numbers to re-quote before build are the provider list prices ($0.60 and $0.25 per 1,000) and Yandex's deferred-mode boundary. A price increase of 20% would cut the daily capacity from 150 titles to about 120 at the same cap, so the settings screen treats capacity as a function of price rather than a fixed row.

## Open risks

- The 150-title capacity assumes two locales per title and the six-query plan; a catalogue that needs three locales per title supports only about 100 titles at the same cap.
- Google's depth-20 query bills as two SERP units, so a later decision to page deeper than 20 would double the per-query cost without changing the query count.
- A re-check ladder on many open violations can consume the 12,000-query re-check share and leave later ladders waiting; the group size recommendation mitigates but does not remove this.
- Provider price changes, currency, and payment friction are outside Patrol's control, and a route that cannot be paid for disables its engine rather than degrading quietly.
- The cap excludes hosting and storage, which are estimated in the deployment design; a full operating budget must add them.

## Sources

- "_docs/design/serp-acquisition-route.md_" and "_docs/research/serp-providers.md_" on `research/serp-providers` at `47e79bd`: prices, per-1,000 units, and the standard, priority, live, deferred, and synchronous modes.
- "_docs/design/query-strategy.md_": six queries per title per scan at two locales, depth 20, and the 70/30 split.
- "_docs/design/scan-scheduling.md_" and "_docs/adr/0022-rechecks-follow-a-three-seven-fourteen-day-ladder.md_": the ladder that consumes the re-check share.
