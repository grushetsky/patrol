# SERP providers: licensed aggregators, terms, and owned scraping

- **Date:** 2026-11-03
- **Question:** With Google's Custom Search JSON API closed to new customers and Bing's Search APIs retired, how can Patrol obtain Google, Bing, and Yandex result pages? What do licensed SERP aggregators charge per 1,000 requests, what do their contracts permit (storage, evidence retention, unattended querying, enforcement use), and is scraping the engines ourselves lawful in the US and EU?
- **Companion:** [`search-engines.md`](search-engines.md) covers the official APIs, their quotas, and their terms. This file covers the substitutes.

## Bottom line

1. **A licensed aggregator is the only route that covers all three engines with one contract.** DataForSEO, Zenserp, SerpAPI, Bright Data, and Oxylabs each return Google, Bing, and (except DataForSEO) Yandex as structured JSON with URL, title, snippet, and position. None requires an engine API key.
2. **DataForSEO is the cheapest for Google and Bing at $0.60 per 1,000 SERPs** (Standard queue, ~5 min turnaround), then $1.20 (Priority) and $2.00 (Live). Its contract has no caching or storage prohibition, but §7.1 forbids using SERP data to "compete with or adversely affect the business interests" of the engines, and §7.2 makes the customer indemnify DataForSEO for that. That clause is the main reason not to treat $0.60 as free of risk.
3. **Bright Data is the cheapest provider that names copyright enforcement as a use case** — $1.50 per 1,000 requests pay-as-you-go, $1.30 at the $499/month tier, all engines, and its own marketing lists "detect copyright infringements" among SERP API use cases. Its MSA has no customer-side storage ban; it does claim the right to retain and reuse data the client collects.
4. **SerpAPI is the only provider offering a contractual legal shield**: up to **$2 million** for "the lawful collection of public search data", limited to claims in US courts, and explicitly *not* covering illegal use of the data. At $9.17–$25 per 1,000 it is 15–40× DataForSEO, so it buys indemnity, not volume.
5. **No provider licenses indefinite storage of Google SERP rows in so many words.** The best available position is a contract that is *silent* on retention plus a clause granting the customer ownership of scraped output (ScrapingBee §16, Apify §5.8). Silence is not a licence; it is the absence of a prohibition.
6. **Yandex is the one engine where the official API beats every aggregator**: Yandex Search API deferred mode is ≈$0.25 per 1,000 versus $0.90–$9.17 from aggregators. For Yandex, buy the engine's own API.
7. **Scraping the engines ourselves is a breach of contract in every case.** All three engines disallow `/search` in robots.txt, and Google's 2026 ToS makes automated access "in violation of the machine-readable instructions on our web pages" a prohibited act. The CFAA is a poor weapon against public-page scraping after *Van Buren* and *hiQ*, so the exposure is contract and injunction rather than criminal — but hiQ itself ultimately lost on breach of contract, and *Meta v. Bright Data* only helps a scraper who never accepted the terms. `[INFERENCE]` Anti-piracy enforcement is not a recognised permitted purpose in either jurisdiction.

## Findings by provider

### 1. DataForSEO

- **Coverage.** Google Organic and Bing Organic SERP endpoints, alongside Yahoo, Baidu, Naver, YouTube, Maps and News variants. **Yandex is not offered** [1][2].
- **Price per 1,000 SERPs** (identical for Google and Bing): **$0.60 Standard queue**, **$1.20 Priority queue**, **$2.00 Live** [1][2]. Billing unit is one SERP of up to 10 organic results; `depth` adds one base price per extra 10 results; search operators multiply the base price ×5 [1].
- **Minimum spend.** Pay-as-you-go against a prepaid balance; no subscription and no published minimum [1].
- **Rate limits.** Queue-based (POST task, GET results), so throughput is governed by queue turnaround (target 45 min Standard, ~1 min Priority) rather than a published rps cap [1].
- **Response format.** Parsed JSON or raw HTML; organic items carry `url`, `title`, `description`, `rank_group`/`rank_absolute`, `domain` [1][2].
- **Terms.** The ToS has no clause restricting caching, storage, or retention of results by the customer. The operative restriction is **§7.1**: SERP data "shall not be used to compete with or adversely affect the business interests of the search engine providers from which such data originates", backed by **§7.2** (customer indemnifies DataForSEO for breach of §7.1) [3]. §6.2 refuses service to entities in Russia, Belarus, and sanctioned territories [3].
- **Assessment.** Cheapest by a wide margin and silent on retention, which suits an evidence store. But §7.1 is broad enough that a lawyer must decide whether feeding SERP rows into takedown notices "adversely affects" the engine's interests. `[INFERENCE]` Sending a DMCA notice is unlikely to be what §7.1 targets; the clause reads as an anti-competitor term. DataForSEO's own documentation says queued results are stored on their side for 30 days and Live results are not stored [4] — that is their retention, not a limit on yours.

### 2. Zenserp

- **Coverage.** Google, Bing, Yandex, DuckDuckGo; Google, Bing, and Yandex each have a dedicated endpoint returning JSON [5][6][7].
- **Price per 1,000 searches:** **$2.00** (25k/mo, $49.99), **$1.50** (100k, $149.99), **$1.20** (250k, $299.99), **$1.00** (500k, $499.99), **$0.90** (1M, $899). Annual billing takes 20% off. Free tier is 50 searches/month; only successful requests are billed [5].
- **Minimum spend.** $49.99/month for the first paid tier [5].
- **Rate limits.** "We encourage not to exceed 400 concurrent connections"; an asynchronous batch endpoint is available [5].
- **Response format.** JSON with `organic[].position`, `title`, `url`, `snippet` (Yandex) / `description` (Google); up to 100 results per page and 400+ with pagination [6][7].
- **Terms.** Zenserp publishes **no product-specific terms of service**. Its footer links to the Idera/ApILayer "General Website Terms of Use" [8], which governs the *website*, not the API output, and whose "Prohibited Activities" list bans using "any deep-link, scraper, robot, crawl, index, spider ... to use, access, copy, acquire information ... [from] the Site" — i.e. Idera's own site [8]. There is therefore **no reachable clause** governing storage, automated querying, or enforcement use of Zenserp results.
- **Assessment.** Cheapest all-three-engines option at volume ($0.90/1k) and the cheapest Yandex aggregator. The missing contract is the problem: with no product terms, the customer has neither a storage permission nor a clear prohibition, and no indemnity. `[INFERENCE]` For a service whose core asset is retained evidence, "no terms" is worse than "restrictive terms", because it cannot be relied on in a dispute.

### 3. SerpAPI

- **Coverage.** Dedicated engines for Google, Bing, and Yandex, all returning the same JSON envelope; Bing results carry `position`, `link`, `displayed_link`, `snippet`, and the same 1-hour free cache [9][10][39].
- **Price per 1,000 searches:** **$25** (1,000/mo, $25), **$15** (5,000, $75), **$10** (15,000, $150), **$9.17** (30,000, $275). Free tier 250/month; Enterprise is custom. Only successful searches count; cached and errored searches are free [11].
- **Minimum spend.** $25/month; free tier exists [11].
- **Rate limits.** Guaranteed throughput by plan: 200, 1,000, 3,000, 6,000 successful searches per hour [11].
- **Response format.** JSON: `organic_results[].position`, `title`, `link`, `displayed_link`, `snippet`; Yandex results also expose `pagination` and a `no_cache` flag. Default cache lifetime is 1 hour and cached searches are free [10].
- **Terms.** No caching or storage prohibition. The relevant clauses are **§2 (General Conditions)** — "You agree not to reproduce, duplicate, copy, sell, resell or exploit any portion of the Service" — and **§13 (Disclaimer of Warranties; Limitation of Liability)**, which creates the **U.S. Legal Shield**: for plans above Free/Starter/Developer, SerpAPI "will assume the liabilities of scraping and parsing search engine results for both U.S. and international companies and individuals, with up to $2 million in coverage ... provided your use of the data or service is not illegal", covering "the lawful collection of public search data ... but not ... how that data is ultimately used", limited to "claims brought under U.S. state or federal law in a U.S. court" [12]. Privacy **§10** says SerpAPI retains search data for 31 days unless ZeroTrace Mode is on [12].
- **Assessment.** The only provider that will stand behind the scraping itself. The shield explicitly excludes illegal use, naming "copyright infringement, DMCA violations" as examples of illegal use [12] — Patrol's *own* DMCA notices are not a DMCA violation, but this is exactly the sentence a lawyer must read. §2's "reproduce ... any portion of the Service" is the nearest thing to a storage limit and is aimed at reselling the API, not at keeping evidence. `[INFERENCE]`

### 4. Bright Data

- **Coverage.** SERP API supports "Google, Bing, DuckDuckGo, Yandex, Baidu, Yahoo, Naver" [13].
- **Price per 1,000 requests:** **$1.50 pay-as-you-go**, **$1.30** on the $499/month Scale plan (380K requests included), Enterprise custom; free tier 5K requests/month. Billed per *successful* request with parsing and unlocking included; failed requests are not billed, except when custom headers/cookies are configured, in which case all requests bill [14][15].
- **Minimum spend.** None on PAYG; $499/month for the volume tier [14].
- **Rate limits.** "No limit to the number of concurrent requests" [14].
- **Response format.** JSON, Markdown, or raw HTML; parsed output has `organic[].link`, `title`, `description`, `global_rank` [13].
- **Terms.** The Master Service Agreement requires that the client "shall not use the Services in violation of applicable law or regulations or any third party rights (including intellectual property rights) and not use the Service in any manner or for any purpose other than as stated in the intended use case provided to Bright Data" [16]. For Data Services, the client "shall not distribute, transmit, reproduce, publish, license, transfer, or sell any Data in order to offer a similar or competitive product" [16]. The Web Scraper IDE section adds: "Bright Data may retain data it has collected or delivered to its Clients and may use it for its own purposes in its sole discretion" [16]. The Acceptable Use Policy forbids "Any Search Engine Optimization (SEO) manipulation (i.e: fake clicks in search engines results)" but says nothing about retention [17].
- **Assessment.** The most explicit commercial posture for Patrol's use case: Bright Data's own SERP page lists "detect copyright infringements" and "brand protection" as use cases [14]. There is no customer-side storage ban and no requirement to display results to end users. The cost is that Bright Data claims a right to retain and reuse what you collect — a confidentiality problem for a rights-holder's evidence set, not a legality problem. `[INFERENCE]`

### 5. ScraperAPI

- **Coverage.** SERP credit class covers "Google, Bing - (applies to all subdomains)". **Yandex has no structured SERP support** and would fall into the flat 1-credit "normal" class with no parsed output [18].
- **Price per 1,000 SERPs** (25 credits per SERP): **$12.25** (Hobby, $49/100k credits), **$3.73** (Startup, $149/1M), **$2.49** (Business, $299/3M), **$2.38** (Scaling, $475/5M), **$2.32** (Professional, $975/10.5M), **$2.30** (Advanced, $1,975/21.5M). Annual billing is 10% off [18][19].
- **Minimum spend.** $49/month; 7-day trial with 5,000 credits [19].
- **Rate limits.** Concurrent threads by plan: 20 (Hobby) to 500+ (Enterprise) [19].
- **Response format.** JSON auto-parsing with `autoparse=true`; raw HTML otherwise [18].
- **Terms.** **§3.3** forbids gathering data "in violation of the third party sites' own terms of service"; **§7.1** limits use to pages where extraction "is permitted implicitly or where you are authorized to do so" and makes the customer warrant it; **§7.4.10** bans generating "computer generated search requests" for ad impressions; **§2.3** lets ScraperAPI store downloaded data indefinitely; **§12.3** lets ScraperAPI suspend the account if a targeted site asks it to cease extraction [19].
- **Assessment.** Expensive per SERP for what it is, no Yandex, and §7.1/§3.3 push the Google-ToS question squarely onto Patrol. §12.3 is a real operational risk: Google complaining to ScraperAPI terminates the feed. Not a fit.

### 6. ScrapingBee

- **Coverage.** A dedicated Google endpoint (`/api/v1/google`) returning parsed JSON; **no Bing or Yandex SERP endpoint** — those would be generic URL scraping at 1–75 credits per request [20][21].
- **Price.** Credit-metered: 1 credit classic no-JS, 5 classic + JS (default), 10 premium no-JS, 25 premium + JS, 75 stealth + JS. Plans: $19/75k credits, $49/250k, $99/1M, $249/3M, $599/8M, up to $5,799/120M. That is $0.099 per 1,000 credits at the $99 tier, so **≈$0.50/1k at 5 credits and ≈$2.48/1k at 25 credits** [20][21]. ScrapingBee does not publish a fixed credit cost for the Google endpoint, so the real figure depends on which tier Google requires. `[INFERENCE]`
- **Minimum spend.** $19/month [20].
- **Rate limits.** Concurrency by plan: 25 to 900 [20].
- **Response format.** JSON: `organic_results[].position`, `title`, `link`, `displayed_url`, `domain`, `description` [21].
- **Terms.** **§6 (Conditions of Use)** is the problem: users shall not "Use the Services or any element thereof in a commercial manner" — a literal reading bars Patrol entirely — and shall not "Breach the terms and conditions of use of third-party websites"; it adds "Websites may expressly prohibit scraping; it is therefore User's responsibility to check such potential prohibition for each website prior to scraping" [22]. **§10** makes the user warrant that scraping is "duly authorized by the applicable terms and conditions of the targeted databases, websites, or other sources" [22]. **§16** is the one helpful clause: "User owns all rights, title, and interest (including all intellectual property rights) in and to its User Data", where User Data includes data generated by the Services [22].
- **Assessment.** §16 gives the cleanest output-ownership statement of any provider here, but the "not in a commercial manner" clause is disqualifying on its face for a commercial anti-piracy service unless ScrapingBee confirms in writing that it means "not for personal use". Do not build on it without that confirmation.

### 7. Oxylabs

- **Coverage.** SERP Scraper API covers Google, Baidu, Bing, and Yandex (Yandex as a raw-HTML "URL" source rather than a parsed schema) [23].
- **Price per 1,000 results:** **$1.00 Google non-JS**, **$1.35 Google JS** at the $100 Basic tier; $1.00/$1.35 at Starter ($30), $0.90/$1.30 at Flexible ($500), down to $0.50/$0.90 at 5M+ results. Bing parsed search is in the same Web API credit pool; Yandex URL scraping is billed as a universal source [23].
- **Minimum spend.** $30/month (Starter); $5 welcome credit [23].
- **Rate limits.** Not published on the product page; Enterprise plans start at $2,500/month [23].
- **Response format.** Parsed JSON with `organic[].pos`, `title`, `url`, `desc`, or raw HTML [23].
- **Terms.** GC **§4.2.6** requires the customer to comply with "any relevant terms of service ... or third party rights (including, without limitation, regulation, case-law practice, and best practice regarding the automated data gathering)" [24]. **§8.1** puts responsibility for the accessed data on the customer and states Oxylabs will not suspend a customer whose access is "with consent or in accordance with Data owner terms of services" [24]. **§4.3.9** reserves Oxylabs' right to "retain data gathered through the Customer's use of the Web Scraper API and Web Unblocker Services ... and may use it at its sole discretion" [24]. The AUP requires the customer not to use the Services "in a way that would: 1. Be in violation of relevant terms of use/service or other legal documents" [25]. Liability is capped at 2× the monthly fee [24].
- **Assessment.** Middle of the pack on price, permissive on retention, and it pushes the Google-ToS question to the customer with unusual explicitness ("case-law practice"). The §4.3.9 retention right is broader than Bright Data's.

### 8. Apify

- **Coverage.** The Google Search Results Scraper covers Google only; Bing and Yandex are not first-class actors in Apify's own portfolio [26].
- **Price per 1,000:** **from $1.80 per 1,000 scraped SERPs** for the Google Search Results Scraper (pay-per-event `search-page-scraped`). Separately, Apify sells "Google SERP proxies" at **$2.50/1,000 SERPs** (free/Starter), $2.00 (Scale), $1.70 (Business) — proxy access only, you parse [27][28].
- **Minimum spend.** $0 free plan with $5 credit; $19/month Starter [28].
- **Rate limits.** Max concurrent Actor runs: 5 (Free) to 256 (Business) [28].
- **Response format.** JSON/CSV/Excel; organic results with `position`, `title`, `url`, `description` [26].
- **Terms.** GTC **§5.8** — "you retain all right, title, and interest in and to your Customer Data"; **§6.2** — process "only the Customer Data that you are authorized to access and that is in compliance with all applicable laws"; **§11** — customer indemnifies Apify, and "Should you use the Services or Actors to extract Customer Data from unauthorized sources, you shall be responsible for compensating any damages" [27]. AUP **§2.1(10)** forbids activities contravening "applicable laws, regulations, or the rights of any third party" [29].
- **Assessment.** Clean output-ownership language and cheap at the top of the funnel, but the Google-only actor and the customer-indemnity clause put the entire Google-ToS risk on Patrol. The SERP-proxy product ($2.50/1k) is the honest price of "owned scraping with someone else's IPs".

## Comparison

### Price per 1,000 requests (USD, excl. VAT)

| Provider | Google | Bing | Yandex | Cheapest tier | Min. spend | Structured output |
| --- | --- | --- | --- | --- | --- | --- |
| DataForSEO | **$0.60** | **$0.60** | not offered | Standard queue | PAYG balance | JSON |
| Bright Data | $1.50 | $1.50 | $1.50 | PAYG | none | JSON/HTML/MD |
| Oxylabs | $1.00 (non-JS) / $1.35 (JS) | same pool | universal-source rate | $30/mo | $30/mo | JSON/HTML |
| Apify | $1.80 | — | — | PPE | $0 | JSON |
| Zenserp | $2.00 → $0.90 | same | same | 25k → 1M plan | $49.99/mo | JSON |
| ScraperAPI | $2.49 | $2.49 | — | Business | $49/mo | JSON |
| ScrapingBee | ≈$0.50–$2.48 | — | — | credit tiers | $19/mo | JSON |
| SerpAPI | $9.17 → $25 | same | same | 30k plan | $25/mo | JSON |
| **Yandex official API** | — | — | **$4.00 sync / $0.25 deferred** | deferred | PAYG | XML/HTML |

### Terms by question

| Provider | Store/cache results | Retain as legal evidence | Unattended automated querying | Use for enforcement |
| --- | --- | --- | --- | --- |
| DataForSEO | silent — no ban | silent | queue API designed for it | §7.1 "adversely affect" caveat + §7.2 indemnity [3] |
| Bright Data | silent; vendor may retain and reuse [16] | silent | unlimited concurrency [14] | "detect copyright infringements" named use case [14] |
| Oxylabs | silent; vendor may retain [24] | silent | allowed; AUP bars target-ToS violations [25] | not addressed |
| Apify | customer owns output §5.8 [27] | silent | allowed | not addressed; customer indemnity §11 [27] |
| Zenserp | no product terms [8] | no product terms | no product terms | no product terms |
| ScraperAPI | vendor stores indefinitely §2.3 [19] | silent | allowed but §7.1 warrants target permission | not addressed; §12.3 takedown by target |
| ScrapingBee | §16 user owns User Data [22] | silent | §6 bars commercial use (literal) | not addressed |
| SerpAPI | §2 no "reproduce ... any portion of the Service" [12] | silent | allowed | §13 shield covers collection, not use [12] |

## Cost per 1,000 queries by route

| Route | Google | Bing | Yandex | Notes |
| --- | --- | --- | --- | --- |
| Official API | n/a (closed, ends 2027-01-01) | n/a (retired 2025-08-11) | $4.00 sync / $0.25 deferred | see `search-engines.md` |
| Cheapest aggregator | $0.60 (DataForSEO) | $0.60 (DataForSEO) | $0.90 (Zenserp @1M) | async; 45-min target |
| Aggregator with named enforcement use case | $1.50 (Bright Data) | $1.50 | $1.50 | vendor may reuse your data |
| Aggregator with legal shield | $9.17 (SerpAPI) | $9.17 | $9.17 | $2M, US courts only |
| Owned scraping, proxy only | $2.50 (Apify SERP proxies) | $2.50 | — | you parse and rotate; still your ToS risk |
| Owned scraping, DIY | ≈$1.50–$2.50 + engineering | same | same | residential bandwidth $7–8/GB, CAPTCHA handling, maintenance `[INFERENCE]` |
| Manual operator search | ≈$250 | ≈$250 | ≈$250 | 30 s per query at $30/h `[INFERENCE]` |

## Open risks

1. **No provider grants perpetual storage rights in words.** Every "yes" in the table above is really "no prohibition found". If an engine ever sues a data vendor, the customer's retained rows are downstream of a contract that never promised them. Get a written retention representation from whichever vendor is chosen.
2. **DataForSEO §7.1 is the widest clause in the set** and is paired with a customer indemnity. $0.60/1k is only cheap if legal accepts that "adversely affect the business interests" does not reach anti-piracy enforcement [3].
3. **SerpAPI's shield excludes illegal use and is US-only.** It covers collection, not use; an EU rights-holder gets nothing from it [12].
4. **Zenserp has no product terms at all.** Cheapest Yandex aggregator, weakest contractual position [8].
5. **ScrapingBee's §6 "not in a commercial manner"** is disqualifying as written; do not use without a written waiver [22].
6. **Vendor-side retention is the norm, not the exception.** Bright Data, Oxylabs, and ScraperAPI all reserve the right to keep and reuse what the customer collects [16][24][19]. For a rights-holder handling infringement evidence, that is a confidentiality and chain-of-custody issue.
7. **ScraperAPI §12.3 lets a target site terminate the feed** by complaining to the vendor [19]. Any single-vendor architecture has this kill switch.
8. **Prices are list prices.** Every provider here has an Enterprise tier with unpublished pricing; at Patrol's likely volume (thousands, not millions, of queries per month) the cheapest published tier is what matters, but a 1M+/month commitment should be re-quoted.

## What this means for design

1. **Do not pick one vendor for all engines.** Yandex belongs on the official API (≈$0.25/1k deferred, structured XML with `doc/domain`, `doc/title`, `doc/passages`); Google and Bing belong on a licensed aggregator. One adapter per engine, one vendor per engine.
2. **Keep the port from `search-engines.md` unchanged** — `search(query, {region, locale, freshness, limit, mode}) -> [{url, title, snippet, host, position, engine, retrievedAt, rawRef}]`. Every aggregator above already returns those fields; only `host` needs deriving from `url` where the vendor omits it.
3. **Make `rawRef` a first-class column now.** The SERP row is a lead; the evidence is the infringing page (URL, timestamp, content hash, screenshot). Storing the vendor's raw JSON alongside gives provenance without making the vendor's contract the load-bearing element of the evidence chain.
4. **Budget on cost per 1,000 queries, per engine, per route**, not per seat. At 10k Google + 10k Bing + 10k Yandex per month: DataForSEO $12, Bright Data $30, SerpAPI $184, Yandex deferred $2.50.
5. **Buy the legal review with the vendor choice.** If Patrol needs the vendor to stand behind the scraping, that is SerpAPI at 15× the price; if it needs the cheapest defensible feed, that is DataForSEO with a written opinion on §7.1; if it needs a vendor that already markets copyright enforcement, that is Bright Data.
6. **Never scrape the engines directly as the primary route.** All three disallow `/search` in robots.txt, and Google's ToS makes that dispositive, so the "cheapest" route is a standing breach with no statutory defence in the EU. It is the cheapest on paper and the most expensive in disputes.

## Legal context: owned scraping of SERP pages

### The engines' own rules decide most of this

- **Google.** The Terms of Service effective 2026-07-30 prohibit "using automated means to access content from any of our services in violation of the machine-readable instructions on our web pages (for example, robots.txt files that disallow crawling, training, or other activities)" [30]. Google's `robots.txt` begins `User-agent: *` and then `Disallow: /search` [31]. Automated fetching of Google result pages is therefore a breach of the ToS *by construction*: the robots.txt carve-out is not a safe harbour, it is the trigger.
- **Bing.** `https://www.bing.com/robots.txt` likewise carries `Disallow: /search` [32]. Bing has no search API (retired 2025-08-11) and its successor forbids standalone output — see `search-engines.md`.
- **Yandex.** `https://yandex.com/robots.txt` disallows `/search` [33]. Yandex's Search API terms permit automated querying only through the paid API and require prior consent for any other automated access (`search-engines.md` §3.6).
- **Consequence.** "Owned scraping" of any of the three engines is a contractual breach in every case, not a grey area. The only open question is what the engine can do about it.

### United States

- **CFAA is not a general anti-scraping statute.** *Van Buren v. United States*, 593 U.S. 374 (2021), narrowed "exceeds authorized access" to using a system one is entitled to use for an improper purpose, rather than accessing a system one is not entitled to use [34]. The Ninth Circuit applied that in *hiQ Labs v. LinkedIn*, 938 F.3d 985 (9th Cir. 2019), whose judgment was vacated and remanded after *Van Buren* and then reaffirmed on remand in April 2022: scraping public data is not access "without authorization" for CFAA purposes [35].
- **But contract claims survive, and win.** In November 2022 the Northern District of California held that hiQ had breached LinkedIn's User Agreement; the case settled [35]. The practical lesson is that the CFAA loss did not make the scraping lawful — it moved the fight to contract.
- **Contract claims are narrowing.** In *Meta Platforms v. Bright Data* (N.D. Cal., Judge Edward Chen), the court granted Bright Data summary judgment, holding that Meta's terms "could not be construed to prohibit logged-off scraping of data that is publicly available on Meta's platforms", and that a survival clause purporting to bind a former user in perpetuity was unenforceable [36]. The court's reasoning leaned on Bright Data not being a "user" when it scraped logged off.
- **Why that reasoning does not transfer to Google.** Google's ToS bind by use, not by account: "by accessing or using our services, you're agreeing to these terms" [30]. A scraper with no Google account is still a party. `[INFERENCE]` The *Meta v. Bright Data* "not a user" argument therefore has no purchase against Google, and the robots.txt clause removes the ambiguity that saved Bright Data.
- **Unverified.** Ryanair v. Booking.com (D. Del.) could not be checked against a primary document in this environment; do not cite it in a legal memo without pulling the docket.

### European Union

- **No copyright in the facts.** Result listings are facts and short snippets; the EU protects the *database* rather than its contents. Directive 96/9/EC gives the maker of a database a sui generis right to prevent extraction or re-use of all or a substantial part of its contents, where there was substantial investment in obtaining, verifying, or presenting them; repeated extraction of insubstantial parts can still infringe [37].
- **Investment in *obtaining* counts, investment in *creating* does not.** CJEU C-203/02 *BHB v. William Hill* is the anchor: the sui generis right does not cover resources used to create the data. `[INFERENCE]` A search engine's index is a strong candidate for protection, but the point is litigable rather than settled.
- **Contract beats the Directive where the database is unprotected.** In C-30/14 *Ryanair v. PR Aviation* the CJEU held that a database outside both copyright and the sui generis right is not subject to the Directive's mandatory exceptions, so the owner may impose contractual restrictions on its use [37]. `[INFERENCE]` This is the settled reading; the judgment itself could not be fetched in this environment.
- **The TDM exception does not help.** Directive (EU) 2019/790 Art. 4 permits commercial text and data mining only where the rightsholder has not opted out, and it does not override a contractual prohibition on accessing a service [38]. Patrol is not mining for training anyway.
- **Net position.** In the EU the binding constraint is the engine's terms, not copyright. A rights-holder scraping Google in the EU is in breach of contract with no statutory defence.

### Is anti-piracy enforcement a permitted purpose?

**No.** None of the three engines' terms carves out rights enforcement, and no US or EU authority treats "preparing copyright takedowns" as a permitted purpose that overrides a site's terms [30][34][37]. The DMCA and the EU notice regimes regulate what a *host* must do with a notice, not how the notifier may collect the evidence. `[INFERENCE]` The only remaining lever is a proportionality or abuse-of-rights argument in a contract dispute, which is untested and would be decided after the fact.

### Assessment

- **Settled:** the CFAA does not bar scraping public pages (*Van Buren*, *hiQ*).
- **Settled:** breach of contract does, and hiQ lost on exactly that ground.
- **Settled:** all three engines disallow `/search` in robots.txt, and Google's ToS makes robots.txt dispositive.
- **Settled:** a vendor's contract does not launder the upstream breach — DataForSEO §7.2, Apify §11, Oxylabs §7.3, and ScraperAPI §9 all push the engine-facing risk back to Patrol.
- **Unsettled:** whether browsewrap terms bind a logged-off scraper outside the Northern District of California; *Meta v. Bright Data* is a district-court decision, not binding.
- **Unsettled:** whether a SERP is a "substantial part" of a sui generis-protected database in the EU.
- **Unsettled:** whether enforcement use is ever a defence. No authority says yes.
- **Practical conclusion:** the licensed-aggregator route does not make the scraping lawful — it makes the *scraping someone else's problem* and gives Patrol a contract to sue on. That is the real product being bought.

## Method note

Prices and terms were fetched on 2026-11-03. Several vendor sites block non-browser clients (serpapi.com and scraperapi.com time out; brightdata.com returns 403; scrapingbee.com and apify.com are slow). Where the live page could not be read, the citation is the Internet Archive capture of the same first-party URL with its capture date, and the archive link is given alongside. Bright Data's MSA, Apify's and Bright Data's policies, ScraperAPI's credit table, and Oxylabs' terms were read as served content (markdown or HTML) from the vendor's own domain.

Legal research was limited by access walls: EUR-Lex, Curia, CourtListener, Justia, supremecourt.gov and govinfo all refused automated fetches or returned WAF challenges. Google's ToS and all three `robots.txt` files were fetched live. Where a case holding is stated without a verbatim quotation, the citation says so and names the secondary source used. Anything marked `[INFERENCE]` is a deduction, not a published statement.

## Citations

1. DataForSEO, *Google Organic SERP API* (Standard $0.60/1k, Priority $1.20/1k, Live $2.00/1k; billing unit; multipliers). https://dataforseo.com/pricing/google-serp/google-organic-serp-api (accessed 2026-11-03).
2. DataForSEO, *Bing Organic SERP API* (same price grid). https://dataforseo.com/pricing/serp/bing-organic-serp-api (accessed 2026-11-03).
3. DataForSEO, *Terms of Service* (§7.1 no competing/adverse use, §7.2 indemnity, §6.2 excluded jurisdictions; updated 2026-06-12). https://dataforseo.com/terms-of-service (accessed 2026-11-03).
4. DataForSEO, *API v.3 documentation* (Standard results stored 30 days, Live not stored). https://docs.dataforseo.com/v3/ (accessed 2026-11-03).
5. Zenserp, *Pricing & Plans* ($2.00/$1.50/$1.20/$1.00/$0.90 per 1k; 400 concurrent; annual −20%). https://zenserp.com/pricing-plans/ (accessed 2026-11-03).
6. Zenserp, *Yandex Search API* (JSON `organic[].url/title/snippet`). https://zenserp.com/yandex-serp-api/ (accessed 2026-11-03).
7. Zenserp, *SERP API for Developers* (Google JSON with `position`, `url`, `description`). https://zenserp.com/ (accessed 2026-11-03).
8. Idera, Inc., *General Website Terms of Use* (Prohibited Activities: scraper/robot clause; updated 2019-11-01) — the terms Zenserp links from its footer. https://www.ideracorp.com/Legal/Terms-of-Use (archived 2026-10-15: https://web.archive.org/web/20261015051023/https://www.ideracorp.com/Legal/Terms-of-Use).
9. SerpAPI, *Plans and Pricing* ($25/1k, $75/5k, $150/15k, $275/30k; throughput 200–6,000/hour). https://serpapi.com/pricing (archived 2026-11-03: https://web.archive.org/web/20261103081924/https://serpapi.com/pricing).
10. SerpAPI, *Yandex Search Engine Results API* (`engine=yandex`, `organic_results[].position/link/displayed_link/snippet`, `no_cache`, 1-hour cache). https://serpapi.com/yandex-search-api (archived 2026-11-03: https://web.archive.org/web/20261103071251/https://serpapi.com/yandex-search-api).
11. SerpAPI, *Pricing FAQ* (successful searches only; cached/errored free; guaranteed throughput). https://serpapi.com/pricing (archived 2026-11-03, as above).
12. SerpAPI, *Legal Documents* (§2 General Conditions; §13 U.S. Legal Shield $2M, lawful collection not use, US courts; Privacy §10 31-day retention; last updated 2026-08-27). https://serpapi.com/legal (archived 2026-11-03: https://web.archive.org/web/20261103084106/https://serpapi.com/legal).
13. Bright Data, *Introduction to SERP API* (Google, Bing, DuckDuckGo, Yandex, Baidu, Yahoo, Naver; parsed JSON fields). https://docs.brightdata.com/products/serp-api/introduction.md (accessed 2026-11-03).
14. Bright Data, *SERP API Pricing* ($1.50/1k PAYG, $499/mo Scale 380K included at $1.30/1k; 5K free; "detect copyright infringements" use case). https://brightdata.com/pricing/serp (archived 2026-10-13: https://web.archive.org/web/20261013160254/https://brightdata.com/pricing/serp).
15. Bright Data, *SERP pricing & billing* (per successful request; failed not billed; custom headers change billing). https://docs.brightdata.com/products/serp-api/pricing-and-billing (accessed 2026-11-03).
16. Bright Data, *Master Service Agreement* (Client warranties — law and third-party rights, intended use case; Data Services I no competitive product; Proxy Services IV and Web Scraper IDE IV — Bright Data may retain and reuse client-collected data; modified 2026-10-12). https://brightdata.com/license (archived 2026-10-18: https://web.archive.org/web/20261018163519/https://brightdata.com/license).
17. Bright Data, *Acceptable use policy* (forbidden activities incl. SEO manipulation; no retention restriction). https://docs.brightdata.com/general/policy/acceptable-use-policy.md (accessed 2026-11-03).
18. ScraperAPI, *Credits and Requests costs* (SERP class = 25 credits for Google and Bing; premium/render multipliers). https://docs.scraperapi.com/getting-started/quick-start/credits-and-requests-costs (accessed 2026-11-03).
19. ScraperAPI, *Pricing* ($49/100k, $149/1M, $299/3M, $475/5M, $975/10.5M, $1,975/21.5M credits; concurrency) and *Terms of Use* (§2.3 vendor storage, §3.3 third-party ToS, §7.1 permitted use, §7.4.10 generated searches, §12.3 target complaint). https://www.scraperapi.com/pricing/ and https://www.scraperapi.com/terms/ (archived 2026-10-26 and 2026-10-19).
20. ScrapingBee, *Pricing* ($19/75k … $5,799/120M credits; concurrency) and *Documentation — credit costs* (1/5/10/25/75 credits; auto-mode). https://www.scrapingbee.com/pricing/ (archived 2026-10-26: https://web.archive.org/web/20261026143720/https://www.scrapingbee.com/pricing/) and https://www.scrapingbee.com/documentation/ (archived 2026: https://web.archive.org/web/2026/https://www.scrapingbee.com/documentation/).
21. ScrapingBee, *Google Search API* (`/api/v1/google`, `organic_results[].position/title/link/displayed_url/domain/description`). https://www.scrapingbee.com/features/google/ (archived 2026-10-19: https://web.archive.org/web/20261019025734/https://www.scrapingbee.com/features/google/).
22. ScrapingBee (VostokInc), *General Terms and Conditions of Service* (§6 no commercial use, third-party ToS, "websites may expressly prohibit scraping"; §10 user warranty; §16 user owns User Data; last updated 2024-07-15). https://www.scrapingbee.com/terms-and-conditions/ (archived 2026-10-04: https://web.archive.org/web/20261004223537/https://www.scrapingbee.com/terms-and-conditions/).
23. Oxylabs, *SERP Scraper API* (Google/Bing/Yandex/Baidu; Google non-JS $1.00/1k, JS $1.35/1k at Basic; plan tiers $30–$2,500+). https://oxylabs.io/products/web-api/scrape/serp (accessed 2026-11-03).
24. Oxylabs, *General Conditions of Services Agreement* (§4.2.6 comply with third-party ToS and case-law practice; §4.3.9 vendor may retain data; §8.1 customer responsibility; §6.2 liability cap; last updated 2025-10-08). https://oxylabs.io/legal/oxylabs-terms-of-service (accessed 2026-11-03).
25. Oxylabs, *Acceptable Use Policy* ("Automated data gathering" 1–3; no target-ToS violations; last updated 2024-06-25). https://oxylabs.io/legal/oxylabs-acceptable-use-policy (accessed 2026-11-03).
26. Apify, *Google Search Results Scraper* (from $1.80/1,000 scraped SERPs; `search-page-scraped` event; Google only). https://apify.com/apify/google-search-scraper (archived 2026-10-18: https://web.archive.org/web/20261018140414/https://apify.com/apify/google-search-scraper).
27. Apify, *General Terms and Conditions* (§5.8 Customer Data ownership, §6.2 authorized use, §11 indemnity; effective 2026-07-09). https://docs.apify.com/legal/general-terms-and-conditions (archived 2026-10-23: https://web.archive.org/web/20261023102353/https://docs.apify.com/legal/general-terms-and-conditions).
28. Apify, *Pricing* (free $5 credit, Starter $19; Google SERP proxies $2.50/1k free–Starter, $2.00 Scale, $1.70 Business; concurrency 5–256). https://apify.com/pricing (archived 2026-11-02: https://web.archive.org/web/20261102052551/https://apify.com/pricing).
29. Apify, *Acceptable Use Policy* (§2.1(7) SEO manipulation, §2.1(10) laws and third-party rights; last updated 2026-02-20). https://docs.apify.com/legal/acceptable-use-policy (archived 2026-08-29: https://web.archive.org/web/20260829170355/https://docs.apify.com/legal/acceptable-use-policy).
30. Google, *Terms of Service* ("Don't abuse our services": automated means in violation of robots.txt; effective 2026-07-30). https://policies.google.com/terms (accessed 2026-11-03).
31. Google, *robots.txt* (`User-agent: *` / `Disallow: /search`). https://www.google.com/robots.txt (accessed 2026-11-03).
32. Microsoft, *robots.txt* (`Disallow: /search`, line 61). https://www.bing.com/robots.txt (accessed 2026-11-03).
33. Yandex, *robots.txt* (`Disallow: /search`, lines 151/446/720). https://yandex.com/robots.txt (accessed 2026-11-03).
34. Van Buren v. United States, 593 U.S. 374 (2021) — holding summarised from Wikipedia, *Van Buren v. United States*, https://en.wikipedia.org/wiki/Van_Buren_v._United_States (accessed 2026-11-03); opinion at https://www.supremecourt.gov/opinions/20pdf/19-783_k53l.pdf (link verified, PDF not machine-readable here).
35. hiQ Labs, Inc. v. LinkedIn Corp., 938 F.3d 985 (9th Cir. 2019), vacated and remanded after *Van Buren*, reaffirmed on remand (9th Cir. 2022, No. 17-16783), breach of User Agreement found (N.D. Cal., Nov. 2022), settled — summarised from Wikipedia, *HiQ Labs v. LinkedIn*, https://en.wikipedia.org/wiki/HiQ_Labs_v._LinkedIn (accessed 2026-11-03); opinion at https://cdn.ca9.uscourts.gov/datastore/opinions/2022/04/18/17-16783.pdf (link verified).
36. Meta Platforms, Inc. v. Bright Data Ltd. (N.D. Cal., Judge Edward M. Chen) — summary judgment for Bright Data; quoted and analysed in Quinn Emanuel, *Meta v. Bright Data: Significant Decision For Web Scraping Industry*, https://www.quinnemanuel.com/media/n23fedyh/client-alert_-meta-v-bright-data-significant-decision-for-web-scraping-industry.pdf (accessed 2026-11-03); docket: https://www.courtlistener.com/docket/66706470/meta-platforms-inc-v-bright-data-ltd/.
37. Directive 96/9/EC on the legal protection of databases, Arts. 7–9, https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:31996L0009; sui generis right and the *obtaining vs creating* distinction summarised from Wikipedia, *Database right*, https://en.wikipedia.org/wiki/Database_right (accessed 2026-11-03). C-30/14 *Ryanair v. PR Aviation* cited as the settled reading; the judgment text could not be fetched (EUR-Lex and Curia both block automated access).
38. Directive (EU) 2019/790 on copyright and related rights in the Digital Single Market, Art. 4 (TDM exception subject to opt-out), https://eur-lex.europa.eu/eli/dir/2019/790/oj/eng (link verified; text not machine-readable here).
39. SerpAPI, *Bing Search Engine Results API* (`engine=bing`, `organic_results[].position/link/displayed_link/snippet`, 1-hour cache). https://serpapi.com/bing-search-api (archived 2026-09-28: https://web.archive.org/web/20260928105324/https://serpapi.com/bing-search-api).
