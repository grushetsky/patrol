# SERP acquisition routes

Patrol obtains search results for Google and Yandex through two contracted routes, one adapter each, behind a single port. Bing is not a discovery engine in v1 and reuses the Google route's provider when it is added. This document fixes the routes, what their contracts permit, and the budget inputs they hand to scheduling; the terms are those of "_GLOSSARY.md_".

## Routes

| Engine | Route | Provider | Price per 1,000 | Response |
| --- | --- | --- | --- | --- |
| Google | Licensed aggregator, asynchronous queue | DataForSEO Google Organic | $0.60 standard, $1.20 priority, $2.00 live | JSON with `url`, `title`, `description`, `rank_group`, `domain` |
| Yandex | The engine's own search API | Yandex Search API v2 | $0.25 deferred, $4.00 synchronous | Base64 XML in `rawData` |
| Bing | Deferred; same aggregator when added | DataForSEO Bing Organic | $0.60 standard | JSON |

Both routes are self-serve: a prepaid balance at DataForSEO and a folder-scoped API key at Yandex Cloud. No negotiated agreement, no legal review, and no enterprise tier is part of the design.

## Alternatives considered

**Owned scraping of result pages** is rejected outright. All three engines disallow `/search` in robots.txt, and Google's terms make automated access that violates those instructions a prohibited act, so scraping is a breach by construction rather than a grey area. It is also more expensive than the aggregator: at residential bandwidth prices a thousand result pages cost more than $0.60 in bytes alone, before proxy rotation, CAPTCHA handling, JavaScript rendering, and parser maintenance. A rights holder that scrapes the engine it simultaneously asks to enforce its copyright hands the recipient an argument.

**Google's own Custom Search JSON API** is unavailable: closed to new customers, discontinued on 2027-01-01, and its terms forbid non-transitory storage of results.

**Manual monitoring only** gives up automated coverage. It remains available as manual URL entry, at no cost, and is unaffected by a route failing.

**SerpAPI** is the only provider that indemnifies lawful collection, up to $2 million in United States courts, for $9.17 to $25 per 1,000. It buys a legal shield, not throughput, and the shield explicitly excludes illegal use. Not worth fifteen times the price at this scale.

**Bright Data** costs $1.50 per 1,000 and names copyright enforcement as a use case, but reserves the right to retain and reuse what the customer collects — unacceptable for an infringement evidence set.

**A Yandex aggregator** costs $0.90 to $1.50 per 1,000 against the engine's own $0.25 deferred, and answers the ToS question with a weaker contract.

## What the contracts permit

- **SERP rows are provenance, not evidence.** No provider grants perpetual storage rights in words, and the engines' own terms range from a storage prohibition (Google) to silence (Yandex). Patrol keeps the minimum needed to explain where a URL came from: URL, rank, title, snippet, query, locale, engine, observation time, and a reference to the vendor's raw response. Evidence is captured from the landing page.
- **DataForSEO carries the widest clause.** Its terms are silent on customer-side retention, but §7.1 forbids using result data to compete with or adversely affect the search engines' business interests, and §7.2 makes the customer indemnify DataForSEO for a breach of §7.1. This is accepted without a legal opinion; it is the known risk of the cheap route.
- **Vendor-side retention differs.** DataForSEO stores standard-queue results for thirty days and does not store live results.
- **Cost levers.** DataForSEO bills one SERP of up to ten organic results, adds a base price per extra ten results, and multiplies the base price by five for search operators such as an exclusion. Yandex bills per request, with up to 100 groups of one to three documents.
- **Yandex's own terms** permit automated querying only through the paid API and require prior consent for any other automated access.

## The port

One adapter per engine, one vendor per engine, no vendor type outside the adapter:

```
search(query, {engine, locale, region, freshness, limit, mode})
  -> [{url, title, snippet, host, position, engine, retrievedAt, rawRef}]
```

The adapter owns request shaping, paging, parsing, retry, and the provider's error taxonomy. `host` is derived from `url` where the provider omits it. `rawRef` points at the stored vendor response so the observation can be reproduced without re-querying.

## Modes and budget

Scheduled scans and operator-triggered re-checks both use the asynchronous route: DataForSEO's standard queue and Yandex's deferred mode, at $0.60 and $0.25 per 1,000. The synchronous routes — DataForSEO priority or live, Yandex synchronous — stay off in v1: they cost two to sixteen times the asynchronous price and buy latency that a scan whose results a person reviews later does not need. Ten thousand queries each per month cost $6.00 for Google and $2.50 for Yandex.

These figures feed "_docs/design/scan-scheduling.md_" and "_docs/design/budget-envelope.md_".

## When a route fails

A route that is unavailable — exhausted balance, revoked key, changed terms, provider outage — disables that engine. Scheduled scans fail with a route-unavailable reason, the operator is alerted, and manual URL entry keeps working. Patrol never substitutes another route silently, and never falls back to scraping: a scan that did not run must never be indistinguishable from a scan that found nothing.

## Open risks

- DataForSEO §7.1 is unexamined by counsel and is paired with a customer indemnity.
- No provider promises retention, so the evidence chain rests entirely on landing-page captures.
- Yandex contracts through entities in Serbia and Dubai, so sanctions or payment friction can remove the route; the adapter stays removable.
- The Yandex v2 response schema rests on the legacy XML documentation and a quickstart sample, and must be validated against a live response before the parser is frozen.
- Prices are list prices and should be re-quoted before build.
- Two providers mean two billing relationships, two credentials, and two failure modes to monitor.

## Sources

- "_docs/research/search-engines.md_" on `research/search-engines` at `4bf9e48`: official APIs, quotas, and terms.
- "_docs/research/serp-providers.md_" on `research/serp-providers` at `47e79bd`: aggregator prices, retention clauses, and the legal position on owned scraping.
