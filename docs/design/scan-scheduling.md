# Scan scheduling, quota, and re-checks

Every scan and re-check costs money at a provider and competes for a monthly allowance, so Patrol schedules them against a ledger rather than firing them blindly. This document fixes the jobs that drive discovery, the order they run in, the re-check ladder, how units are reserved and committed, the alerts that precede exhaustion, and what happens when an engine or a submission fails. The query plan is "_docs/design/query-strategy.md_", the routes and prices are "_docs/design/serp-acquisition-route.md_", the dollar cap is "Budget envelope and supported title count", the queue substrate is "_docs/adr/0005-single-postgres-for-jobs.md_", and the terms are those of "_GLOSSARY.md_".

## Jobs

Everything runs in the worker process on pg-boss, with one queue per engine holding concurrency at one so a provider never sees a burst from Patrol.

| Job | Trigger | Purpose |
| --- | --- | --- |
| `scan.schedule` | Every 15 minutes | Enqueues one `scan.run` per title group and engine whose local scan time has passed and which has not been scanned today |
| `scan.run` | Enqueued by a schedule or an operator | Prices the plan, reserves budget, issues the queries, records the scan outcome |
| `recheck.schedule` | Every 15 minutes | Enqueues due re-checks by the ladder below |
| `capture.run` | Enqueued by detection, review, or approval | Fetches one URL for evidence |
| `submission.draft` | Per recipient profile, default daily 07:00 UTC | Composes drafts for confirmed violations in the window |
| `submission.remind` | Daily | Surfaces `Pending` submissions older than 7 days to the operators |
| `budget.rollover` | Monthly, 1st at 00:00 UTC | Opens the new month's allowance and closes the old one |
| `budget.balance` | Daily | Probes each provider's prepaid balance and alerts on a thin balance |
| `route.probe` | Hourly, only while an engine is disabled | Checks whether a disabled route has recovered |
| `retention.purge` | Daily | Runs the evidence purge, honouring legal holds |

A scan is idempotent on `(title group, engine, due date)`: a scheduler restart, a duplicate wake-up, or a manual scan earlier the same day cannot produce a second scan. A manual scan records the group as scanned for that day, so the scheduler does not follow it.

## Order of work

Within one engine queue, scans run in this order:

1. Manual scans, in the order an operator requested them.
2. Scheduled scans by group priority, high then normal then low.
3. Within one priority, by `last_scan_at` ascending, so the stalest group goes first.

Each title group carries a `scan_time` inside a spreading window — default 02:00 to 05:59 UTC, derived from its identity and editable — so that a hundred groups do not all become due on the same minute. Google and Yandex are separate queues, so one group's scan of each engine may run at the same time.

A re-check occupies the same engine queue as a scan and is ordered after manual work but before scheduled work, because its whole purpose is to observe a page before more damage is done.

## The re-check ladder

A re-check is keyed by `(title group, engine)`, because a scan targets exactly that pair and a re-check reissues the whole query plan of the scan that found the violations, per "_docs/adr/0013-rechecks-reissue-the-query-plan.md_".

- **Start.** The first confirmed violation produced by a group's scan on an engine starts that pair's ladder at rung one.
- **Rungs.** Re-checks fall due 3, 7, and 14 days after the scan that started the ladder, then every 14 days for as long as any violation from that pair is `Open`.
- **End.** When no violation from that pair is `Open` — every one is `Removed` or `Closed` — the ladder stops, and the pair returns to its ordinary scan cadence. A violation that reappears starts a new violation and a new ladder.
- **Manual reset.** An operator's manual scan or manual re-check of the pair resets the ladder to rung one: the next re-check is three days after the manual run. The intent of a manual check is "look again soon", and a ladder that ignored it would schedule the next look up to eleven days later.
- **Budget.** Re-checks draw only on the 30% re-check share from "_docs/design/query-strategy.md_". They queue when that share is spent and never borrow the scan share; the ladder resumes at the next month's allowance or when the operator raises it.

The 3, 7, 14 shape is chosen because a page that survives the first days usually survives weeks, and a daily re-check of every open violation would spend the whole allowance watching pages that have not moved. The decision is "_docs/adr/0022-rechecks-follow-a-three-seven-fourteen-day-ladder.md_".

## Quota accounting

The ledger lives in PostgreSQL, not at the provider, because the provider knows what it charged and not what Patrol intended to spend. It has one row per engine and UTC calendar month:

| Column | Meaning |
| --- | --- |
| `allowance_units` | The month's billable units for the engine, from the dollar cap |
| `scan_reserved`, `scan_committed` | Units reserved and spent by scans |
| `recheck_reserved`, `recheck_committed` | Units reserved and spent by re-checks |
| `month_start` | The UTC month the row belongs to |

A Google depth-20 query costs two billable units and a Yandex request one, per "_docs/design/query-strategy.md_". Accounting runs in three steps:

1. **Preflight.** A scan prices its plan — Google two units per query, Yandex one per request — and compares the total with the remaining share of its bucket. A plan that does not fit does not start: the scan stays queued with `budget_exhausted` as its reason, and it is never truncated. A fitting plan reserves the units in one transaction, so two concurrent scans cannot both spend the last of a bucket.
2. **Reservation.** A reservation is held by the scan, expires after one hour if the scan never starts, and is released on a failure that spent nothing. A reservation made before midnight stays in the month it was made, even if the scan finishes after midnight.
3. **Commit.** On completion, the reservation converts to committed units for the queries actually issued. A partial scan commits what it issued and releases the rest. A route failure releases everything it did not issue.

An operator who lowers the allowance below what is already committed cannot un-spend it: the ledger records what was spent, the current month is over its new cap, and alerting treats it as exhausted until the next month or a raised allowance.

## Alerts

Alerts go to every operator through the UI and to the configured operator mailbox. They fire once per threshold per engine per month, so a spent bucket does not produce a message per minute.

| Threshold | Severity | Meaning and action |
| --- | --- | --- |
| 75% of the monthly allowance | Warning | The month is running hot; review cadence, group priorities, and open violations |
| 90% of the scan share or of the re-check share | Critical | Degrade in the order "_docs/design/budget-envelope.md_" sets: low-priority groups stop scanning, re-checks already starve first |
| 100% of a bucket | Critical | New work in that bucket queues with `budget_exhausted`; nothing is truncated or silently skipped |
| Provider balance below 10% of the engine's monthly cap, or below one day's average burn where that is larger | Critical | Top up the provider; the route disables when the balance actually runs out |
| An engine disabled by a route failure | Critical | The engine scans nothing until it recovers; manual URL entry keeps working |
| A scan with `Partial` outcome | Warning | Some queries failed; the record names them and the reason |
| A `Pending` submission older than 7 days | Warning | The submission backlog is the throughput ceiling; the notice is not moving |

The provider balance is a backstop, not the budget authority: Patrol's ledger decides what may be spent, and the daily probe catches a balance that will not cover what the ledger allows — a top-up prompt rather than a surprise failure mid-scan.

## Failure handling

Engine and route failures are recorded on the scan, never smoothed away:

| Failure | Retry | Scan outcome |
| --- | --- | --- |
| Provider `5xx`, timeout, or `429` on one query | Three attempts with 1, 5, and 15 minute backoff, sequence recorded | Query failed; the scan is `Partial` if others answered |
| Authentication failure, revoked key, or exhausted provider balance | None; the engine is disabled and `route.probe` checks it hourly | Scan `Failed` with `route_unavailable` |
| A plan that does not fit its bucket | None until budget frees | Scan stays queued with `budget_exhausted` |
| Worker crash mid-scan | The job retries; the reservation expires after one hour and is re-priced | The retried run is a new attempt on the same scan |

A scan is `Succeeded` when every query answered, `Partial` when at least one answered and at least one failed, and `Failed` when none answered. A scan that did not run is never indistinguishable from a scan that found nothing: the failure reason is on the row, the dashboard shows it, and the alerts above fire.

Submission retries deliberately have no scheduler. A submission is created once per notice delivery, and its row is unique, so a retry cannot create a second delivery:

- The operator refiles from the same frozen handoff pack; the submission returns to `Pending` and its attempt count rises.
- If the recipient answers that the notice is already in flight, the operator records that answer as the acknowledgement on the same submission, not as a new one.
- A `Rejected` submission is not retried unchanged: the notice is superseded by a corrected one, and the refusal's cause is recorded, as "_docs/design/notice-composition.md_" requires.
- After three failed attempts the submission is flagged for an administrator, and an operator decides whether to withdraw the notice or try again; nothing is cancelled automatically.

## What this implies for the model

The model carries a `Scan` with its group, engine, trigger, plan size, outcome, failure reason, and budget reservation; a `QuotaLedger` row per engine and month; a `RecheckSchedule` per group and engine with its rung and next due date; and a `Submission` with its attempt count. The HTTP contract exposes scans, the ledger, and the ladder as read models and exposes budget and profile settings as writes; no endpoint deletes a ledger row. The TypeSpec model that follows from this lives in the ticket "TypeSpec domain model".

## Open risks

- Google's and Yandex's prices are list prices; a price change invalidates the unit costs and the capacity the budget buys, so both are re-quoted before build and reviewed quarterly.
- Provider-side quota errors that arrive as `429` burn three retry attempts before a scan turns `Partial`, which can waste units right when the bucket is thin.
- A daily scan per group is the default, and an operator who never revisits priorities can spend the month on stale groups before an urgent one.
- The ladder is per group and engine, so a group packing many titles makes each re-check expensive; the budget design recommends 25 to 50 titles per group for that reason.
- Reservations are estimated from the plan; a provider that bills a query Patrol counted as failed still costs money the ledger released.

## Sources

- "_docs/design/query-strategy.md_" and "_docs/design/serp-acquisition-route.md_" for the plan, the units, and the 70/30 split.
- "_docs/adr/0005-single-postgres-for-jobs.md_" for pg-boss and per-engine concurrency at one.
- "_docs/adr/0013-rechecks-reissue-the-query-plan.md_" for what a re-check issues.
- "_docs/design/evidence-capture.md_" for capture retries and pre-handoff timing.
- "_docs/design/notice-composition.md_" for the submission retry rule this document confirms.
