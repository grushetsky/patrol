# Search-engine access: APIs, quotas, and terms

- **Date:** 2026-11-03
- **Ticket:** [#2 — Search-engine access: APIs, quotas, and terms](https://github.com/grushetsky/patrol/issues/2)
- **Question:** Which search APIs can Patrol query, at what cost and quota, and with what result fields? Specifically for Google, Bing, and Yandex: does an official search API exist today, what are its endpoint/auth/pricing/quota, does it return URL/title/snippet/host plus locale/region/freshness controls, what happens at the cap, and what do the terms allow?

## Bottom line

1. **Google has no usable search API for a new product.** The Custom Search JSON API is *closed to new customers* and is being discontinued for existing customers on **2027-01-01**. Its terms also forbid non-transitory storage/caching of results and automated query generation, which conflicts with Patrol's evidence model. The site-restricted variant was already shut down on 2025-01-08.
2. **Bing has no search API at all since 2025-08-11.** Bing Search APIs (including Custom Search) were retired and decommissioned. The official successor, *Grounding with Bing Search*, is an LLM-grounding add-on: its outputs are "not directly accessible for use in other applications or programs", it must be used inside an internet search experience with visible citations, and its terms forbid building a database from the output. It cannot serve as Patrol's SERP source.
3. **Yandex is the only official, generally available SERP API of the three.** Yandex Search API v2 (Yandex AI Studio / Yandex Cloud) is sold per 1,000 requests, returns XML or HTML, and supports region, language, freshness, sorting, and paging. Text results are **not JSON**: the response is base64-encoded XML (or HTML). It is the only engine here that a new customer can actually buy today.

## Findings

### 1. Google

#### 1.1 Existence and lifecycle

- The **Custom Search JSON API** is the only self-serve official Google web-results API. Its own overview now carries a banner: it is **"closed to new customers"**, existing customers must transition by **January 1, 2027**, and Google points to Vertex AI Search (site search, up to 50 domains) or a sales contact for "full web search" [1].
- The **Custom Search Site Restricted JSON API** (≤10 sites, no daily limit) stopped serving traffic on **January 8, 2025** [2].
- There is therefore **no self-serve Google full-web search API** available to a new customer as of 2026-11-03. Vertex AI Search is a site/enterprise search product, not a general web SERP API, and Google's own note limits its alternative to "up to 50 domains" [1].

#### 1.2 Endpoint and auth

- Endpoint: `GET https://customsearch.googleapis.com/customsearch/v1` (the older `https://www.googleapis.com/customsearch/v1` form is documented in the usage guide) [3][4].
- Auth: API key in the `key` query parameter, plus a Programmable Search Engine ID in `cx` [4]. The reference also lists OAuth scope `https://www.googleapis.com/auth/cse` [3].
- Three parameters are mandatory: `key`, `cx`, `q` [4].

#### 1.3 Pricing and quotas

- **100 queries/day free**; additional requests **$5 per 1,000 queries**, **up to 10,000 queries/day** [1].
- The pricing text applies only to existing customers until the 2027-01-01 discontinuation; the API is not available to new customers [1].
- No documented overage tier beyond 10k/day: the published ceiling is the cap. Quota exhaustion is a hard failure, not a metered overage [1]. Google's canonical error model reports quota exhaustion as `RESOURCE_EXHAUSTED` [5]; the exact CSE HTTP status/body was not retrievable from a first-party page, so treat the status code as `[INFERENCE]`.

#### 1.4 Result fields

The `items[]` result object includes [6]:

| Field | Meaning |
| --- | --- |
| `title` / `htmlTitle` | Result title (plain text / HTML) |
| `link` | Full result URL |
| `displayLink` | Abridged URL, e.g. `www.example.com` (usable as host, but not a dedicated host field) |
| `snippet` / `htmlSnippet` | Snippet text (plain / HTML) |
| `formattedUrl` / `htmlFormattedUrl` | Display URL |
| `pagemap` | Structured data, when present |
| `mime`, `fileFormat` | MIME type / file format |
| `cacheId` | Google cache identifier |

`queries.request[].totalResults`, `searchInformation.totalResults`, `searchInformation.searchTime`, and `spelling.correctedQuery` are also returned [6].

#### 1.5 Query controls (locale, region, freshness)

| Need | Parameter | Notes |
| --- | --- | --- |
| Region boost | `gl` | Two-letter country code; *boosts*, does not strictly filter [3] |
| Region restriction | `cr` | Restricts documents by country; supports boolean operators [3] |
| UI language | `hl` | Affects result language/quality [3] |
| Content language | `lr` | e.g. `lang_ru`, `lang_en` [3] |
| Freshness | `dateRestrict` | `dN`, `wN`, `mN`, `yN` (past N days/weeks/months/years) [3] |
| Sort by date | `sort=date` | Structured sort expression [3] |
| Exact phrase | `exactTerms` | All documents must contain the phrase [3] |
| Exclusion | `excludeTerms` | Exclude terms [3] |
| Site include/exclude | `siteSearch` + `siteSearchFilter` | `i` include, `e` exclude [3] |
| SafeSearch | `safe=active|off` | Default `off` [3] |

#### 1.6 Per-query limits

- `num` is **1–10** per request [3].
- `start` pages through results, but the API **never returns more than 100 results**; `start + num > 100` is an error [3].
- Query length must be within **2,048 characters** [4].

#### 1.7 Terms of use

The Custom Search JSON API Additional Terms require acceptance of the **Google APIs Terms of Service**, the **Programmable Search Engine (PSE) Terms of Service**, and the Additional Terms [7]. The PSE terms contain the operative restrictions [8]:

- **§1.4(d):** may not "display any Results to any third parties other than End Users".
- **§1.4(i):** may not "directly or indirectly generate queries, or impressions of or clicks on Results, through any automated, deceptive, fraudulent or other invalid means (including, but not limited to, click spam, robots, macro programs, and Internet agents)".
- **§1.4(l):** may not "'crawl', 'spider', index or in any non-transitory manner store or cache information obtained from the Service (including, but not limited to, Results, or any part, copy or derivative thereof)".
- **§1.4(b):** may not frame Results except as provided in the documentation.
- The Additional Terms add that you "may not access the Custom Search JSON API in a manner intended to avoid incurring fees" [7].

For Patrol, §1.4(l) directly conflicts with retaining SERP rows as immutable evidence, and §1.4(i) is at odds with an unattended patrol bot generating queries. The JSON API is programmatic by design, so §1.4(i) is probably aimed at invalid traffic, but the text is broad. This needs legal review, not an engineering assumption. `[INFERENCE]` on how Google would apply it to a paid anti-piracy bot.

### 2. Bing

#### 2.1 Retirement status — confirmed

- Microsoft's lifecycle announcement: **"Bing Search APIs will be retired on August 11, 2025. Any existing instances ... will be decommissioned completely, and the product will no longer be available to be used or new customer signup."** [9]
- The archived Bing Web Search API documentation is marked `is_retired: true` and `is_archived: true` [10].
- The retirement applies to the Bing Search APIs product family, including the web search endpoint documented in the archived overview [9][10].

There is **no Bing SERP API** to buy as of 2026-11-03.

#### 2.2 What replaced it

Microsoft directs customers to **Grounding with Bing Search** as part of Azure AI Agents/Foundry [9]. It is explicitly an add-on:

- Pricing: **$14 per 1,000 transactions**, max **150 transactions/second**, **1 million transactions/day** [11].
- "This product is designed to function as an add-on feature for select Microsoft products... **Outputs are not directly accessible for use in other applications or programs.**" [11]
- It is available as a resource/tool in Azure AI Foundry Agent Service or as a Web Knowledge Source in Azure AI Search/Foundry Knowledge [11].

So it returns model-grounded answers with citations, not a queryable SERP result list.

#### 2.3 Endpoint and auth (successor)

- No public raw endpoint; it is invoked through the Azure AI Foundry Agents API using a Bing project connection (`bing_grounding` / `bing_custom_search_preview` tool types) and Azure credentials/RBAC [12].
- Setup requires an Azure subscription, a Grounding with Bing resource, and a project connection [12].

#### 2.4 Terms of use

The enterprise Grounding TOU [13]:

- **§2(a):** use only the documented methods/means of access.
- **§2(c):** "Customer will not modify or create a derivative work based on any Bing Services Output".
- **§3(b)(a):** may not "use the Services outside of, or separately from, the Enterprise Integration".
- **§3(b)(g):** may not "use the Service to create a database or service that competes with Bing Services Output".
- **§3(c):** may copy/store/cache output **solely** to the extent permitted by copyright law and as an integrated part of its own work product, provided the work product is not a substitute for the Services; it explicitly names "creating a database of Bing Services Output, indexing links contained in the Bing Services Output, using links for crawling or scraping, or offering a separate search offering" as prohibited purposes.
- **Appendix (Use and Display Requirements):** output may only be used in "internet search experiences"; references/citations must be retained and displayed in the exact form provided; may not "copy, store, or cache the Bing Services Output" except as permitted; may not modify output.
- Data Protection Addendum does **not** apply; data flows outside the Azure compliance boundary [12][13].

Historically, even the retired Bing Web Search API was restricted to queries arising from "a direct user query or search, or ... an action within an app or experience that logically can be interpreted as a user's search request" [10]. An unattended patrol crawler was already outside that model.

**Conclusion:** Bing offers no lawful raw-SERP path for Patrol.

### 3. Yandex

#### 3.1 Existence and product shape

- **Yandex Search API** is a paid service in Yandex AI Studio (Yandex Cloud). It lets a customer "automatically submit queries to the Yandex search database and get ... search results", in **synchronous** or **deferred (asynchronous)** mode [14].
- It is API v2, built on gRPC with REST/JSON transcoding; text results are returned as **XML or HTML** (`FORMAT_XML` default, `FORMAT_HTML`), not a JSON result schema [15][16].
- The old `yandex.ru/search/xml` (Yandex.XML) terms are void; Yandex.XML "may be offered to users on different conditions within Yandex Search API" [17]. Automated requests to the search engine by any other means are prohibited without prior consent [17][18].

#### 3.2 Endpoint and auth

- REST: `POST https://searchapi.api.cloud.yandex.net/v2/web/search` (sync) [15][16].
- Deferred: `POST /v2/web/searchAsync` returns an `Operation`; the result is fetched later [15].
- Auth (REST): `Authorization: Api-Key <API_key>` or `Authorization: Bearer <IAM_token>`; the folder ID goes in the request body (`folderId`) [16][19].
- Required role: `search-api.webSearch.user` on the folder; scoped API keys can use `yc.search-api.execute` [19][20].
- gRPC: service `yandex.cloud.searchapi.v2.WebSearchService` on the same `searchapi.api.cloud.yandex.net` host [15].

#### 3.3 Pricing

Prices per 1,000 requests, excluding VAT, Russia region, archived 2025-11-16 [21]:

| Service | Price / 1,000 requests |
| --- | --- |
| Daytime synchronous | $3.999998 |
| Daytime deferred | $0.250000 |
| Night-time synchronous (00:00:00–07:59:59 UTC+3) | $2.999999 |
| Night-time deferred | $0.208333 |
| Image search | $7.499997 |
| Synchronous with generative response | $41.667000 |

Billing is per search request within a calendar month [21]. The archived page is the most recent machine-readable copy; the live page sits behind a captcha, so treat the exact cents as `[INFERENCE]` to be re-checked before budgeting, but the order of magnitude (≈$4/1k sync, ≈$0.25/1k deferred) is from the official pricing policy.

#### 3.4 Quotas and limits

From the current first-party docs repository [22]:

| Limit | Value |
| --- | --- |
| Synchronous requests | 10/second, 10,000/hour |
| Deferred requests | 10/second, 35,000/hour |
| Fetches of deferred results | 10/second |
| Generative-response requests | 1/second, 1,000/hour |
| Results returned | up to 250 |
| Query text | ≤400 characters |
| Deferred minimum processing time | 5 minutes |
| Deferred result retention | 12 hours |
| Groups per page | 1–100 |
| Documents per group | 1–3 |
| Snippets (`maxPassages`) | 1–5 |
| Metadata flags | ≤64 key/value pairs |

No daily request cap is published; the caps are per second/hour and the monthly bill is uncapped. Behaviour at the rate cap is not stated on the limits page; Yandex Cloud APIs conventionally return HTTP 429, so `[INFERENCE]` that Patrol must back off on 429/`RESOURCE_EXHAUSTED`.

#### 3.5 Result fields

The v2 response body is `{ "rawData": "<base64>" }`, where the decoded bytes are XML (or HTML) [16]. The quickstart's decoded sample begins `<yandexsearch version="1.0">`, i.e. the classic Yandex XML document [16]. The documented XML elements (legacy format, still the wire format family) are [23]:

| Element | Meaning |
| --- | --- |
| `doc/url` | Result URL |
| `doc/domain` | Host/domain |
| `doc/title` | Title (query words wrapped in `hlword`) |
| `doc/headline` | Optional summary from the page's meta description |
| `doc/passages/passage` | Snippet passages (1–5 depending on `maxPassages`) |
| `doc/modtime` | Last-modified time, optional |
| `doc/mime-type` | MIME type |
| `doc/size`, `doc/charset` | Size and encoding |
| `doc/saved-copy-url` | Yandex saved-copy URL |
| `response/error`, `response/reqid`, `response/found` | Error, request ID, result counts |

`[INFERENCE]`: v2 uses the same element names as the legacy XML because the v2 sample declares `<yandexsearch version="1.0">`; the current v2 "response format" page could not be fetched (captcha), so validate against a live response before writing the parser contract.

#### 3.6 Query controls (locale, region, freshness)

From the v2 request schema [15][16]:

| Need | Field | Notes |
| --- | --- | --- |
| Search domain / locale | `query.searchType` | `SEARCH_TYPE_RU` (yandex.ru), `TR` (yandex.tr), `COM` (yandex.com), `KK` (yandex.kz), `BE` (yandex.by), `UZ` (yandex.uz) |
| Region | `region` | Region/country ID; e.g. 225 Russia, 213 Moscow; the regions reference calls this the `lr` value [24] |
| Response language | `l10n` | `RU`, `UK`, `BE`, `KK`, `TR`, `EN` |
| Freshness | `period` | `ALL_TIME`, `DAY`, `2_WEEKS`, `MONTH` |
| Sort by time | `sortSpec.sortMode=BY_TIME` + `sortOrder` | Also `BY_RELEVANCE` |
| Paging | `query.page` | Page number, starts at 0 |
| Grouping | `groupSpec.groupMode` | `FLAT` (one doc per group) or `DEEP` (by domain) |
| Result volume | `groupSpec.groupsOnPage`, `docsInGroup` | 1–100 groups, 1–3 docs/group |
| Snippet length | `maxPassages` | 1–5 |
| Family filter | `query.familyMode` | `NONE`, `MODERATE`, `STRICT` |
| Typo correction | `query.fixTypoMode` | `ON`/`OFF` |
| Output format | `responseFormat` | `FORMAT_XML` (default) or `FORMAT_HTML` |
| User agent | `userAgent` | Passed through, ≤300 chars |

Note the naming inconsistency: the proto/REST field is `region`, while the regions reference and legacy XML call it `lr` [15][24].

## Per-engine capability matrix

| Capability | Google Custom Search JSON API | Bing | Yandex Search API v2 |
| --- | --- | --- | --- |
| Official API today | Yes, but **closed to new customers**; ends 2027-01-01 [1] | **No** — retired 2025-08-11 [9] | **Yes**, generally available [14] |
| Endpoint | `GET customsearch.googleapis.com/customsearch/v1` [3] | None (grounding only, via Foundry) [11][12] | `POST searchapi.api.cloud.yandex.net/v2/web/search` [15][16] |
| Auth | API key + `cx` [4] | Azure RBAC + Bing project connection [12] | API key (`Api-Key`) or IAM token (`Bearer`) + `folderId` [19] |
| Pricing | 100/day free; $5/1k; max 10k/day [1] | $14/1k grounding transactions [11] | ≈$4/1k sync, ≈$0.25/1k deferred; night discounts [21] |
| Per-query cap | `num` 1–10; ≤100 results total [3] | N/A (no SERP) | 1–100 groups × 1–3 docs; ≤250 results [22] |
| Rate/daily caps | 10k queries/day documented [1] | 150 TPS, 1M/day [11] | 10 rps / 10k per hour sync; 35k/hour deferred [22] |
| URL | `link` [6] | citations only, not raw data [11][13] | `doc/url` [23] |
| Title | `title` [6] | No | `doc/title` [23] |
| Snippet | `snippet` [6] | Model summary/citations | `doc/passages/passage` [23] |
| Host | `displayLink` (derived) [6] | No | `doc/domain` [23] |
| Region | `gl`, `cr` [3] | No | `region` (lr) [15][24] |
| Locale/language | `hl`, `lr` [3] | No | `searchType`, `l10n` [15] |
| Freshness | `dateRestrict`, `sort=date` [3] | No | `period`, `sortMode=BY_TIME` [15] |
| Output format | JSON [1] | Grounded text + citations | XML (default) or HTML, base64 in `rawData` [16] |
| Automated patrol allowed? | Ambiguous/risky: PSE §1.4(i),(l) [8] | No: must be user search; no standalone output [10][13] | Yes via API; other automated access prohibited [18]; use-on-product clause [18] |
| Store results as evidence? | Prohibited non-transitory storage [8] | Prohibited except narrow cases [13] | Not expressly prohibited; "use on Customer's product" [18] — needs legal review |

## Terms-of-use comparison

| Question | Google | Bing | Yandex |
| --- | --- | --- | --- |
| Automated queries | PSE §1.4(i) forbids generating queries by automated means [8] | Must be direct user query/search [10]; successor must be an internet search experience [13] | Allowed through the API; any other automated access to the engine needs prior consent [18] |
| Caching / storing results | §1.4(l): no non-transitory store or cache [8] | §3(c): only narrow copyright/integration exception; no database/indexing [13] | Not expressly banned; results may be used on the customer's product without reordering [18] |
| Use for enforcement / notices | Not addressed; display limited to End Users [8] | Not addressed; output must be displayed as search results with references [13] | Not addressed; "use ... on the Customer's product" is the permitted purpose [18] |
| Competing product | §1.4(m) no substitute/similar service [8] | §3(b)(g) no competing database/service [13] | §3.3.1 no similar search product [18] |
| Attribution / display | Google branding required for PSE [8] | Citations + Bing references mandatory [13] | Results may be displayed in any design without reordering [18] |

## Open risks

1. **Google is a dead end for a new build.** Closed to new customers, hard shutdown 2027-01-01, and a no-cache clause that collides with "immutable evidence". Even if Patrol obtained access, the ToS would need a legal opinion before storing SERP rows [1][8].
2. **Bing has no lawful raw-SERP path.** The API is gone; the successor is contractually an LLM grounding add-on whose outputs are not directly accessible and may not be stored as a database [9][11][13].
3. **Yandex text results are XML, not JSON.** The pipeline needs an XML parser and a stable mapping; the current v2 response-format page was not retrievable, so the field contract rests on the legacy XML schema plus the v2 sample [16][23]. `[INFERENCE]`.
4. **Yandex quota ceiling is hourly, not daily.** 10k sync requests/hour is generous for one rights-holder, but bursty parallel title checks will hit 10 rps; deferred mode is ~16× cheaper but has a 5-minute minimum and 12-hour result retention [21][22].
5. **Yandex terms are permissive but not explicit about retention for legal enforcement.** §3.2 permits use of results "on the Customer's product"; it does not say "may archive as evidence". Legal review required [18].
6. **Yandex is a sanctions/availability risk** for a US/EU-operated service: contracting entities are in Serbia/Dubai, and the service is operated by Yandex LLC in Russia [18][21]. This is a business/legal risk, not a technical one, but it can remove the only viable engine.
7. **No engine returns a guaranteed publication date.** Google's `dateRestrict` filters by Google's date signal, Yandex's `modtime` is optional, and Bing has nothing. Freshness cannot be treated as authoritative evidence of when a page appeared [3][23].
8. **No engine returns a clean host field except Yandex.** Google requires deriving host from `link`/`displayLink`; Bing returns only citations. Normalisation must be explicit [6][23].
9. **Volume clause in Yandex terms.** Yandex may restrict access to advanced results/generative responses above 1M users/day or 100M requests/month [18]. Patrol is far below this, but the clause exists.

## What this means for design

1. **Do not design around Google or Bing APIs.** Neither can be procured for a new product: Google is closed and sunsetting, Bing is retired, and both sets of terms would forbid the automated, stored-SERP workflow Patrol needs. Any architecture that assumes a `GoogleSearchAdapter` or `BingSearchAdapter` is building on a decommissioned contract.
2. **Make Yandex the only implemented engine adapter for now**, behind a narrow port:
   `search(query, {region, locale, freshness, limit, mode}) -> [{url, title, snippet, host, position, engine, retrievedAt, rawRef}]`.
   The adapter owns XML parsing, base64 decoding, paging (`page`, `groupsOnPage`), and the 250-result cap. Keep `rawRef` so the original XML can be retained if legal approves.
3. **Prefer deferred mode for bulk sweeps.** At ≈$0.25/1k vs ≈$4/1k, a nightly batch of thousands of title queries costs cents instead of dollars; reserve synchronous calls for on-demand re-checks. Budget on requests/month, not per-user [21].
4. **Treat the SERP as a lead, not as evidence.** Because Google/Bing forbid storing SERP rows and Yandex's terms speak to display rather than archival, evidence should be captured from the infringing page itself (URL, timestamp, content hash, screenshot) with the SERP row stored only as provenance. This also fixes the "no publication date" gap.
5. **Keep the engine port open for a licensed data provider.** If Yandex becomes unavailable (sanctions, contracting, price), the only substitutes are licensed SERP providers or manual capture; the port should not leak Yandex XML types into the domain.
6. **Get legal sign-off on two specific questions before building the evidence store:** (a) may Patrol retain Yandex result rows for the life of a notice/audit; (b) does using SERP results to prepare DMCA/ infringement notices count as "use on the Customer's product" under §3.2 [18].

## Citations

1. Google, *Custom Search JSON API* (overview, closed-to-new-customers banner, pricing, 10k/day, 2027-01-01 sunset). https://developers.google.com/custom-search/v1/overview (accessed 2026-11-03).
2. Google, *Custom Search Site Restricted JSON API* (ceased 2025-01-08). https://developers.google.com/custom-search/v1/site_restricted_api (accessed 2026-11-03).
3. Google, *Method: cse.list* (endpoint, parameters, `num`/`start` limits, 100-result cap, OAuth scope). https://developers.google.com/custom-search/v1/reference/rest/v1/cse/list (accessed 2026-11-03).
4. Google, *Use REST to Invoke the API* (`key`, `cx`, `q`; 2,048-char query limit; first 100 results). https://developers.google.com/custom-search/v1/using_rest (accessed 2026-11-03).
5. Google, *AIP-193: Errors* (canonical error model; `RESOURCE_EXHAUSTED`). https://google.aip.dev/193 (accessed 2026-11-03).
6. Google, *Search* resource and *Result* schema (`items[].title/link/displayLink/snippet/pagemap/mime`, `queries`, `searchInformation`). https://developers.google.com/custom-search/v1/reference/rest/v1/Search (accessed 2026-11-03).
7. Google, *Custom Search JSON API Additional Terms of Service* (incorporates Google APIs ToS and PSE ToS; no fee avoidance). https://developers.google.com/custom-search/terms (last modified 2020-01-11; accessed 2026-11-03).
8. Google, *Programmable Search Engine Terms of Service* (§1.4(b),(d),(i),(l),(m); branding). https://support.google.com/programmable-search/answer/1714300 (accessed 2026-11-03).
9. Microsoft, *Bing Search APIs Retiring on August 11, 2025*. https://learn.microsoft.com/en-us/lifecycle/announcements/bing-search-api-retirement (accessed 2026-11-03).
10. Microsoft, *What is the Bing Web Search API?* (retired/archived; direct-user-query restriction). https://learn.microsoft.com/en-us/previous-versions/bing/search-apis/bing-web-search/overview (accessed 2026-11-03).
11. Microsoft, *Grounding with Bing* (pricing $14/1k, 150 TPS, 1M/day; outputs not directly accessible). https://www.microsoft.com/en-us/bing/apis (accessed 2026-11-03).
12. Microsoft Learn, *Use Grounding with Bing Search tools with the agents API* (project connection, RBAC, DPA exclusion, web search tool). https://learn.microsoft.com/en-us/azure/foundry/agents/how-to/tools/bing-tools (updated 2026-10-21; accessed 2026-11-03).
13. Microsoft, *Terms of Use for Grounding with Bing Search and Grounding with Bing Custom Search (Enterprise Integration)* (§2, §3(b), §3(c), Appendix Use and Display Requirements). https://www.microsoft.com/en-us/bing/apis/grounding-legal-enterprise (last updated 2025-11; accessed 2026-11-03).
14. Yandex, *About Yandex Search API* (sync/deferred, XML/HTML, text and image search). https://yandex.cloud/en/docs/search-api/concepts/ (archived 2025-11-04: https://web.archive.org/web/20251104100045/https://yandex.cloud/en/docs/search-api/concepts/).
15. Yandex Cloud, *searchapi/v2 protos* (`WebSearchService`, `WebSearchAsyncService`, `WebSearchRequest`, `SearchQuery`, `SortSpec`, `GroupSpec`, `Period`, formats). https://github.com/yandex-cloud/cloudapi/tree/master/yandex/cloud/searchapi/v2 (accessed 2026-11-03).
16. Yandex AI Studio, *Getting started with Yandex Search API* (endpoint, `Api-Key`, `folderId`, `rawData` base64, `<yandexsearch version="1.0">`). https://aistudio.yandex.ru/en/docs/search-api/quickstart/ (archived 2026-10-24: https://web.archive.org/web/20261024122316/https://aistudio.yandex.ru/en/docs/search-api/quickstart/).
17. Yandex, *Yandex.XML (Web Search API) Terms of Service* (void from 2023-11-01; successor is Yandex Search API). https://yandex.com/legal/xml/en/ (accessed 2026-11-03).
18. Yandex, *Terms of Use of Yandex Search API* (§3.2 use on customer's product; §3.3.1 no similar product; §3.5 no other automated access; §3.6 volume limits). https://yandex.com/legal/cloud_terms_search_api/en/ (effective 2026-09-07; accessed 2026-11-03).
19. Yandex Cloud, *API authentication in Yandex Search API* (`Api-Key`/`Bearer`, `folderId`, `search-api.webSearch.user`). https://yandex.cloud/en/docs/search-api/api-ref/authentication (archived 2025-11-01: https://web.archive.org/web/20251101012812/https://yandex.cloud/en/docs/search-api/api-ref/authentication).
20. Yandex Cloud, *API key* (`yc.search-api.execute` scope). https://yandex.cloud/en/docs/iam/concepts/authorization/api-key (accessed 2026-11-03).
21. Yandex Cloud, *Yandex Search API pricing policy* (per-1,000 prices, night rates, monthly billing). https://yandex.cloud/en/docs/search-api/pricing (archived 2025-11-16: https://web.archive.org/web/20251116001105/https://yandex.cloud/en/docs/search-api/pricing).
22. Yandex Cloud docs, *search-api-limits* (quotas and limits table). https://github.com/yandex-cloud/docs/blob/master/en/_includes/search-api-limits.md (accessed 2026-11-03).
23. Yandex, *Yandex.XML — Response format* (`doc/url`, `doc/domain`, `doc/title`, `doc/headline`, `doc/passages`, `doc/modtime`). https://tech.yandex.com/xml/doc/dg/concepts/response-docpage/ (archived 2019-09-21: https://web.archive.org/web/20190921023353/https://tech.yandex.com/xml/doc/dg/concepts/response-docpage/).
24. Yandex AI Studio, *Search regions* (region IDs; `lr`). https://aistudio.yandex.ru/en/docs/search-api/reference/regions (archived 2026-08-28: https://web.archive.org/web/20260828194936/https://aistudio.yandex.ru/en/docs/search-api/reference/regions).

## Method note

Live Yandex documentation is behind a SmartCaptcha for non-browser clients. Where a live page could not be fetched, the citation is the Internet Archive capture of the same first-party URL with its capture date; request/response schema claims are additionally checked against Yandex's public `cloudapi` proto repository. Google and Microsoft pages were fetched live on 2026-11-03. Items explicitly marked `[INFERENCE]` are deductions, not published statements.
