# Search query strategy

Patrol turns a title group's titles into search queries, reads a bounded page of results for each, deduplicates the URLs those results return, and pays for it out of a per-engine budget. This document fixes the query-generation rules, the request shape, the paging and dedup policy, and the allocation model; the costs it builds on are those of "_docs/design/serp-acquisition-route.md_", and the terms are those of "_GLOSSARY.md_".

## Query plan

A scan derives its query plan at scan start from the title group's locales and the variants of the titles in that group. No query is stored as an editable template, and no plan outlives its scan.

Per tracked title and locale, the plan carries:

- **Bare variant queries**, for at most three variants, ordered original-title variant, localized variant, transliterated variant. A variant is eligible when its language matches the locale's language, except the original-title variant, which is always eligible.
- **Intent queries**, two per locale, each the display title followed by one intent phrase for that locale.

Intent phrases are configuration, seeded per supported locale — `смотреть онлайн` and `скачать` for `ru`, `watch online` and `download` for `en` — and an operator edits them without a release. Every phrase carries a version, and each search result records the version it was issued under.

Within one plan, queries deduplicate by normalized text, so a localized variant that repeats the display title for its own locale costs one query, not two. The plan never repeats the same text across variants.

No query carries quotation marks or a search operator. Allowlisting is applied after matching, never inside the query (see "_docs/adr/0012-query-generation-without-search-operators.md_").

## Request shape

| Setting | Google | Yandex |
| --- | --- | --- |
| Query text | variant, or display title plus intent phrase | same |
| Language | `language_code` from the locale's language | `l10n` from the locale's language |
| Location | `location_name` from the locale's territory | `searchType` from the territory, `region` id from the territory |
| Defaults for `ru` | Russia | `SEARCH_TYPE_RU`, region 225 (Russia) |
| Defaults for `en` | United States | `SEARCH_TYPE_COM`, region omitted |
| Freshness | none | `period` unset |
| Device | desktop | desktop |
| Length cap | 2,048 characters | 400 characters |

A query that exceeds the cap drops its intent phrase first and then truncates the variant at a word boundary. The issued text is what the search result records, so an operator can always reproduce the query.

## Paging

Google runs at `depth` 20, which is two billable SERPs of up to ten organic results each. Yandex runs with `groupsOnPage` 30, `docsInGroup` 1, and `groupMode` `FLAT`, which fits one request. Neither engine is paged beyond that in v1, and no request is repeated to read a second page.

A page that ranks below the twentieth Google result or the thirtieth Yandex result is outside v1's reach. It stays reachable through manual URL entry, which costs nothing.

## URL identity

A URL deduplicates under a normalized key, computed without touching the string Patrol displays or submits:

| Component | Rule |
| --- | --- |
| Scheme | Dropped, so `http` and `https` twins collapse. |
| Host | Lowercased, with a leading `www.` dropped for the key only. |
| Path | Trailing slash trimmed. |
| Query parameters | `utm_*`, `fbclid`, `gclid`, and `yclid` removed, the rest sorted by name. |
| Fragment | Dropped. |

Each search result keeps its raw URL, query, locale, engine, rank, and observation time as provenance. A candidate deduplicates observations by normalized URL and tracked title, as "_docs/design/matching-and-classification-rules.md_" requires, and the raw URL of the first observation stays attached to it.

## Budget

The operator sets a monthly allowance per engine in billable units, derived from the dollar cap in "Budget envelope and supported title count". One Google depth-20 query costs two units at $0.60 per 1,000 SERPs; one Yandex request costs one unit at $0.25 per 1,000 deferred requests.

- **Split.** 70% of the monthly allowance funds scheduled new scans and 30% is reserved for re-checks. The reservation is not borrowable by scans.
- **Share.** A group's daily share is the remaining scan allowance divided by the days remaining in the month and by the number of groups. A group that leaves its share unused lets another group borrow it the same day, and unspent allowance stays in the pool for the days that remain.
- **Preflight.** A scan prices its plan before it starts. A plan that does not fit the remaining share does not start: it stays queued, records budget exhaustion as its reason, and runs when budget allows. Budget exhaustion never truncates a plan and never drops a query silently.
- **Exhaustion.** A bucket that is spent stops its own work: re-checks wait once the re-check share is spent, and scheduled scans queue once the scan share is spent, so re-checks starve first and never eat the scan share. A scan that did not run must never be indistinguishable from a scan that found nothing, which is the failure mode "_docs/adr/0011-serp-acquisition-routes.md_" already rules out for a failed route.
- **Manual scans.** An operator-triggered scan targets one title group or one tracked title, issues that target's queries from the same per-engine pool, and runs ahead of every scheduled scan. It queues on exhaustion rather than skipping.

Alerting, decrementing the pool, and the re-check ladder belong to "Scan cadence, quota budget, and re-check policy"; the dollars and the supported title count belong to "Budget envelope and supported title count".

## Re-checks

A re-check reissues the full query plan of the scan that found the violations, under the same variants and intent-phrase versions. It never narrows to the queries that previously produced candidates (see "_docs/adr/0013-rechecks-reissue-the-query-plan.md_"). An operator-triggered scan for one title issues that title's portion of the plan and leaves the rest of the group's queries unissued.

## Worked cost

A group of 100 titles in two locales, with one language-matching variant per locale and two intent queries per locale, issues six queries per title per scan:

| Scope | Queries | Google, depth 20 | Yandex, 30 results |
| --- | --- | --- | --- |
| One scan | 600 | $0.72 | $0.15 |
| Daily for 30 days | 18,000 | $21.60 | $4.50 |
| Weekly for 30 days | ~2,600 | $3.12 | $0.65 |

Ten thousand queries a month cost $12.00 on Google at depth 20 and $2.50 on Yandex, which is the order of magnitude the allocation model is sized for.
