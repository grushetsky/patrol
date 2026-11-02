# Catalogue metadata sources and identifier resolution

- **Date:** 2026-11-03
- **Ticket:** [#5 — Catalogue metadata sources and identifier resolution](https://github.com/grushetsky/patrol/issues/5)
- **Status:** Research complete; recommendations below.
- **Scope:** IMDb, KinoPoisk, TMDB, plus Wikidata, TheTVDB, and PoiskKino as alternatives. No product code.

## Question

Where can Patrol get title metadata and stable identifiers, and how are aliases in each
locale obtained? Specifically: which public or licensed APIs expose title ids, canonical
and original titles, release year, type (film/series), seasons/episodes, and alternate
titles; what are the licence terms, rate limits, and costs; which sources provide Russian
and English aliases and how fresh are they; and how should a user-supplied IMDb or
KinoPoisk URL be resolved to a stable internal identifier and reconciled across catalogues?

## Method and scope notes

Claims below are traced to the source that owns them: vendor documentation, API
references, licence text, and live probes. Where a fact could not be verified from a
primary source it is marked **[INFERENCE]** with the reasoning. Prices and quotas are
reproduced exactly as published; nothing is estimated.

Three access constraints affected the research and are disclosed where relevant:

- `kinopoisk.ru` redirects unauthenticated requests to Yandex SSO, so page contents could
  not be read; URL shapes were verified from redirect `retpath` values and the provider's
  own OpenAPI example (`webUrl`).
- `aws.amazon.com` was unreachable from the research network, so the IMDb AWS Marketplace
  listing could not be read directly. IMDb's own documentation was used instead; the
  exact listing price remains unverified.
- `themoviedb.org` was partly unreachable, so the API terms were read from an Internet
  Archive snapshot of the same canonical page (see the appendix).

## Findings

### 1. IMDb

**Public API.** IMDb does not offer a free public read API. The only API IMDb advertises
is a commercial GraphQL API delivered through AWS Data Exchange; IMDb's developer site
sells "License IMDb Metadata" with 13+ million titles and 16+ million cast/crew, and the
API is described as real-time, while bulk files lag by up to 24 hours. Access requires an
AWS account, an AWS Data Exchange subscription, and an API key issued by IMDb staff; IMDb
asks buyers to request a trial and review the product offer. [1][2][3]

**Non-commercial datasets.** IMDb publishes daily-refreshed, gzipped TSV files at
`datasets.imdbws.com`, but the licence is **personal and non-commercial only**. The terms
explicitly forbid using the data to create any online or offline database of movie
information, forbid scraping the website, and require the attribution
"Information courtesy of IMDb (https://www.imdb.com). Used with permission." [4][5]

The bulk files expose exactly the fields Patrol needs:

| File | Fields relevant to Patrol |
|---|---|
| `title.basics.tsv.gz` | `tconst`, `titleType` (movie, tvseries, tvepisode, …), `primaryTitle`, `originalTitle`, `startYear`, `endYear` |
| `title.akas.tsv.gz` | `titleId`, `ordering`, `title`, `region`, `language`, `types`, `attributes`, `isOriginalTitle` |
| `title.episode.tsv.gz` | `tconst`, `parentTconst`, `seasonNumber`, `episodeNumber` |

[4]

The commercial GraphQL API exposes the same conceptual data with richer display fields:
`originalTitle`, `akas` (country/language-tagged alternative titles), and `titleDisplay`
(a curated subset of akas chosen for display per country/language). [6]

**Licensing, limits, cost.** Non-commercial datasets: free, no API quota (bulk download),
daily refresh, but unusable for a commercial rights-holder service. Commercial API:
subscription through AWS Data Exchange; IMDb publishes no price or request quota, and the
AWS listing describes pricing as based on contract duration and terms plus additional
usage. [1][2] **Cost: quote-based, not publicly listed.** **[INFERENCE]** A rights-holder
service that stores IMDb metadata is commercial use and therefore needs the paid licence,
not the datasets.

### 2. TMDB (The Movie Database)

**API and fields.** TMDB's v3 API is free to register and exposes:

- Movie and TV entities as separate namespaces (`/movie/{id}`, `/tv/{id}`), with `title`
  for movies and `name` for TV, plus `original_title` / `original_name` and
  `original_language`. [7][8]
- Release year as `release_date` (movies) and `first_air_date` (TV). [7]
- Seasons and episodes: `/tv/{series_id}/season/{season_number}`, with episode records and
  `append_to_response` support. [9]
- External IDs: movies return `imdb_id` and `wikidata_id`; TV returns `imdb_id`, `tvdb_id`,
  and `wikidata_id`. [10][11]
- Reverse lookup with `/find/{external_id}?external_source=…`, supporting IMDb, TheTVDB,
  and Wikidata (among others); coverage varies by source and object type (movies, TV
  shows, seasons, episodes, people). [12]
- Alternative titles per country: `/movie/{id}/alternative_titles` and
  `/tv/{id}/alternative_titles`, returning `iso_3166_1`, `title`, and a free-text `type`.
  [13][14]
- Translations: `/movie/{id}/translations` (and the TV equivalent) returning
  `iso_639_1`, `iso_3166_1`, and a `data.title` per translation. For *Fight Club* the
  Russian translation is `Бойцовский клуб`, while the RU alternative title is the
  transliteration `Boytsovskiy klub`. [15]

**Licensing.** TMDB's API Terms of Use (last updated 2023-10-20, operated by TiVo Platform
Technologies LLC) license the API for non-commercial use only. Commercial use — including
"deriving revenues from the use or provision of TMDB … directly or indirectly" — requires
a separate written agreement and may involve fees. Attribution is mandatory: the TMDB logo
plus the notice "This [website, program, service, application, product] uses TMDB and the
TMDB APIs but is not endorsed, certified, or otherwise approved by TMDB." The terms also
prohibit caching TMDB content for longer than **6 months**, and prohibit ML/AI training on
TMDB content. [16]

**Limits and cost.** Legacy rate limiting (40 requests per 10 seconds) was disabled in
2019; TMDB says upper limits sit "somewhere in the 40 requests per second range" and may
change at any time; there is no SLA. [17][18] Cost: free for non-commercial use with
attribution; commercial licence is quote-based via TMDB sales — no public price. [16][18]

### 3. KinoPoisk

**Official API.** No official public KinoPoisk API was found. Direct probes of
`yandex.ru/dev/kinopoisk/` and `api.kinopoisk.ru` return 404, and the widely used services
describe themselves as "unofficial". **[INFERENCE]** KinoPoisk's own user agreement
forbids automated collection of its site and database (see below), which is consistent
with there being no licensed public read API; any official partner access would have to be
negotiated separately with ООО «Кинопоиск».

**Unofficial API (`kinopoiskapiunofficial.tech`).** A third-party service that scrapes
`kinopoisk.ru` and exposes a documented REST API. Its OpenAPI spec provides:

- `GET /api/v2.2/films/{id}` with `kinopoiskId`, `imdbId`, `nameRu`, `nameEn`,
  `nameOriginal`, `year`, `startYear`, `endYear`, `type` (`FILM`, `VIDEO`, `TV_SERIES`,
  `MINI_SERIES`, `TV_SHOW`, `UNKNOWN`), and `webUrl` (e.g.
  `https://www.kinopoisk.ru/film/301/`). There is **no** `tmdbId` field. [19]
- `GET /api/v2.2/films/{id}/seasons`, returning seasons with episodes (`seasonNumber`,
  `episodeNumber`, `nameRu`, `nameEn`, `releaseDate`). [19]
- Search by keyword and by filters; the filter response includes `kinopoiskId`, `imdbId`,
  `nameRu`, `nameEn`, `nameOriginal`, `type`, `year`. [19]

Quotas: the documentation states **500 requests/day for all new users** and **25
requests/second per user**; higher daily limits are available by emailing support, with no
published price. [20]

**Licensing.** KinoPoisk's user agreement (ООО «Кинопоиск») prohibits "robots ('spiders') or
other automatic algorithms and methods aimed at 'pumping out' (collecting), illegal
transfer, copying, blocking, modification, destruction of Information and the Site
Database", and restricts use of site information to "personal non-commercial purposes"
unless permission is granted by the site administration or the rights holder. [21]
Therefore the unofficial API is **not a lawful production source** for Patrol without a
KinoPoisk agreement, regardless of what the third-party vendor charges.

**Canonical and alternate titles.** The unofficial API gives three names only
(`nameRu`, `nameEn`, `nameOriginal`); it does not expose a list of regional or historical
aliases. That is enough for a primary Russian display title but not for matching every
piracy listing, which often uses transliterations or alternative translations.

### 4. Wikidata (cross-catalogue backbone)

Wikidata is a free, CC0 knowledge base with per-language labels and aliases, and it holds
the identifier properties needed to bridge catalogues:

| Property | Meaning |
|---|---|
| `P345` | IMDb ID (`tt…`) |
| `P2603` | KinoPoisk film ID (used for films and series alike) |
| `P4947` | TMDB movie ID |
| `P4983` | TMDB TV series ID |
| `P4835` | TheTVDB series ID |

[22][23]

**Licensing.** All structured data in Wikidata (main, Property, Lexeme, EntitySchema
namespaces) is released under CC0; no attribution is required. [24]

**Aliases.** Labels and aliases are language-specific; aliases are the place for
alternative names, translations, and transliterations, and a single item may have many
aliases per language. [25] Example: the *Fight Club* film item (`Q190050`) has
`en` label "Fight Club", `ru` label "Бойцовский клуб", `en` alias "FightClub", `ru` alias
"Бойцовский клуб (фильм)", and claims `P345=tt0137523`, `P2603=361`, `P4947=550`. [26]

**Coverage and limits.** A live SPARQL query on 2026-11-03 returned **254,300** items with
a KinoPoisk ID, of which **253,515 (99.7%)** also carry an IMDb ID, and at least
**20,113** are instance of "television series" (`Q5398426`). [27] The MediaWiki API returns
at most 50 entities per `wbgetentities` request (500 for higher-limit clients). [28]

**Freshness.** Edits are visible immediately through the API; there is no batch refresh
cycle, but coverage and alias quality are contributor-driven and uneven per title.

### 5. TheTVDB (alternative for series)

TheTVDB's v4 API exposes series, seasons, episodes, aliases (per language), and
translations. Alias records carry a 3–4 character `language` and a `name`; translation
records carry `name`, `aliases`, `isPrimary`, and `isAlias`. Episodes are addressed by
season type, which matters because the same series can have Aired, DVD, Absolute, and
Alternate orders. [29][30]

**Licensing and cost.** Two models: a negotiated commercial licence, or a
user-subscription model where each end user has a **$12/year** TheTVDB subscription; the
API information page says the API is available to commercial projects and individual
developers, with attribution required unless approved otherwise. [29][31] No public rate
limit is stated in the v4 specification; the vendor recommends maintaining a local copy
and using the `/updates` endpoint. [29]

### 6. PoiskKino (paid KinoPoisk-derived aggregator)

`poiskkino.dev` (also reachable as `kinopoisk.dev`) is a third-party JSON API whose primary
source is KinoPoisk, supplemented with TMDB and IMDb. Its public page shows a movie record
with `externalId` containing KinoPoisk, TMDB, and IMDb ids. [32]

Published tiers (as of 2026-11-03):

| Tier | Daily limit | Price |
|---|---|---|
| Demo | 200 requests/day, pagination up to 10 pages | free |
| Basic | 5,000 requests/day | 2,500 ₽/month |
| Unlimited | unlimited for the month | 5,000 ₽/month |
| Companies | by agreement | by agreement |

[32]

The site states the database is updated daily. [32] **Licensing risk:** the service
aggregates KinoPoisk data without a visible KinoPoisk licence; the same KinoPoisk terms
that prohibit automated collection apply to the underlying data. **[INFERENCE]** Treat
this as a convenience integration, not as a clean rights position.

### 7. Rejected alternative: OMDb

OMDb is an IMDb-derived API addressed by IMDb ID or title, with `type` and `year`
parameters and season/episode querying. [33] It exposes no alternative-title list and its
data originates from IMDb, so it inherits IMDb's licensing problem while adding a
dependency. It is not recommended for Patrol.

## Source comparison

| Source | IDs exposed | Canonical / original title | Year | Type | Seasons / episodes | Alternate titles | Licence | Rate limit / cost | Freshness |
|---|---|---|---|---|---|---|---|---|---|
| **IMDb datasets** | `tconst` | `primaryTitle`, `originalTitle` | `startYear`, `endYear` | `titleType` | `title.episode` (`parentTconst`, season, episode) | `title.akas` (region, language, types, `isOriginalTitle`) | Personal/non-commercial only; no database use [4][5] | No quota; free | Daily [4] |
| **IMDb API (AWS)** | `tconst` | `originalTitle`, `titleDisplay` | yes | yes | yes (episodes queryable) | `akas`, `titleDisplay` [6] | Commercial subscription [1][2] | Not published; contract + usage pricing | Real-time [1] |
| **TMDB** | movie/TV IDs; `imdb_id`, `wikidata_id`, `tvdb_id` | `title`/`name`, `original_title`/`original_name`, `original_language` | `release_date` / `first_air_date` | separate movie/TV namespaces | `/tv/{id}/season/{n}` [9] | `alternative_titles` (per country) + `translations` (per language) [13][14][15] | Free non-commercial; commercial agreement; attribution; ≤6-month cache [16] | ~40 req/s; no SLA [17][18]; commercial price quote-based | Live API |
| **KinoPoisk (unofficial)** | numeric `kinopoiskId`; `imdbId` | `nameRu`, `nameEn`, `nameOriginal` | `year`, `startYear`, `endYear` | `type` enum | `/films/{id}/seasons` [19] | No alias list (three names only) | Scrapes KinoPoisk; KinoPoisk ToS forbids automated collection and commercial use [21] | 500/day, 25 req/s; extended by request [20] | Live scrape, no SLA |
| **Wikidata** | `Q…` plus P345/P2603/P4947/P4983/P4835 | labels per language | via qualifiers/statements, not uniform | `P31` instance-of | not modelled | labels + aliases per language [25] | CC0 [24] | 50 IDs/request [28]; free | Immediate edits |
| **TheTVDB** | series/movie/episode IDs | `name`, `originalLanguage`, translations | `year`, `firstAired` | series/movie namespaces | episodes by season type [30] | aliases + translations per language [29] | Negotiated commercial or $12/yr per end user [29][31] | Not published | `/updates` endpoint |
| **PoiskKino** | KinoPoisk, TMDB, IMDb ids | names | yes | yes | likely (not verified) | not verified | Third-party aggregator; underlying KinoPoisk rights unclear [32] | 200/day free; 2,500–5,000 ₽/mo | Daily [32] |

## Alias sources for Russian and English

| Locale | Preferred source | Secondary | Notes |
|---|---|---|---|
| **Russian (ru-RU)** | KinoPoisk `nameRu` (only with a KinoPoisk licence) | TMDB `translations` where `iso_639_1=ru`; Wikidata `ru` label and aliases | TMDB RU *alternative titles* are often Latin transliterations (`Boytsovskiy klub`), not Cyrillic; use translations for display, alternative titles for matching. IMDb `akas` with `region=RU`/`language=ru` is a fallback, subject to IMDb licensing. |
| **English (en-US / en-GB)** | TMDB `title`/`name` with `language=en-US`, `original_title` when the original language is English | IMDb `primaryTitle` / `originalTitle` and `akas` for `US`/`GB`; Wikidata `en` label and aliases | TMDB `alternative_titles` includes US/GB variants (working titles, abbreviations). Keep region and language separately; `en-GB` and `en-US` can differ. |

Freshness practices:

- Store `source`, `language`, `region`, `retrieved_at`, and `is_original` on every alias.
- TMDB content must be re-fetched or deleted within **6 months** under the standard
  terms [16]; schedule refresh well inside that window.
- IMDb datasets refresh daily [4]; the paid API is real-time [1].
- Wikidata changes are immediate, but quality varies; re-read on onboarding and
  periodically.
- KinoPoisk's unofficial API is a live scrape with no SLA and no lawful production basis
  [20][21].

## Resolving a user-supplied link

### IMDb URL → internal title

Accepted forms (verified live): `https://www.imdb.com/title/tt0133093/`,
`https://www.imdb.com/ru/title/tt0133093/` (localized path), and
`https://m.imdb.com/title/tt0133093/`, which redirects to the canonical `www` URL. [34]

Algorithm:

1. Parse the URL, lowercase the host, strip query/fragment and tracking parameters, and
   follow redirects for short links.
2. Match a path segment `title/(tt\d+)` anywhere after an optional language prefix.
3. Treat `tconst` as the external key. Resolve it through, in order:
   - TMDB `/find/{tconst}?external_source=imdb_id` [12];
   - Wikidata (`P345` → item → `P2603`/`P4947`/`P4983`) [22][26];
   - a licensed KinoPoisk/paid provider lookup.
4. Verify title, year, and media type before attaching the ID to an internal title. If the
   sources disagree, create a resolution candidate and require operator confirmation.

### KinoPoisk URL → internal title

Accepted forms (verified by redirect behaviour): `https://www.kinopoisk.ru/film/301/` and
`https://www.kinopoisk.ru/series/464963/`; the numeric id is the key, and the provider's
own `webUrl` example is `https://www.kinopoisk.ru/film/301/`. [19][35]

Algorithm:

1. Parse the URL, strip query/fragment, and match `/(film|series)/(\d+)`.
2. Use the numeric id as the external key; use the path segment only as a type hint.
3. Resolve through, in order:
   - a licensed KinoPoisk provider (the unofficial API returns `imdbId` directly) [19];
   - Wikidata (`P2603` → item → `P345`/`P4947`/`P4983`) [22][27];
   - title + year + type search as a candidate, never as an automatic merge.
4. Confirm with `nameRu`/`nameOriginal`, `year`, and `type`.

### Why not just use the external id as the primary key

IMDb itself documents duplicate title entities: when two IDs are later found to represent
the same title, `remappedTo` points at the primary ID while both records remain. [6]
Catalogue IDs can therefore merge, split, or redirect. An internal, source-independent key
absorbs those changes without rewriting violations, evidence, or notices.

## Reconciling the same work across catalogues

**What works:**

- **Wikidata is the strongest bridge.** 99.7% of items with a KinoPoisk ID also carry an
  IMDb ID (253,515 of 254,300), and TMDB's API exposes `wikidata_id` on both movies and TV
  [11][27]. So `KinoPoisk → Wikidata → IMDb/TMDB` is a high-coverage path.
- **TMDB `/find` accepts `imdb_id`, `tvdb_id`, and `wikidata_id`** (not KinoPoisk) and
  searches the object types each source supports (movies, TV shows, seasons, episodes,
  people). [12]
- **TMDB external IDs** give `imdb_id` and `wikidata_id` for movies, plus `tvdb_id` for TV.
  [10][11]
- **KinoPoisk's unofficial API** returns `imdbId` for a film; it does not return `tmdbId`.
  [19]
- **PoiskKino** returns all three ids in one record, but with the licensing caveat above.
  [32]

**What does not work:** there is no direct KinoPoisk lookup in TMDB's `/find`; a KinoPoisk
id must go through a KinoPoisk provider or Wikidata. Do not infer a TMDB id from a
KinoPoisk id by arithmetic or by URL patterns.

**Type and namespace traps:**

- TMDB movie and TV ids live in separate namespaces and are addressed by separate
  endpoints (`/movie/{id}`, `/tv/{id}`). Store `media_kind` with every TMDB id and never
  assume an id is valid across the two endpoints. [7][8]
- TheTVDB series and movie ids are likewise separate, and episodes can have multiple
  season orders (Aired, DVD, Absolute, Alternate). [29][30]
- KinoPoisk's provider models a single numeric `kinopoiskId` for all `type` values
  (`FILM`, `TV_SERIES`, …), so the number alone is the key and `type` is metadata. [19]
- IMDb `tconst` is unique across title types. [4]

**Season/episode reconciliation:** treat it as best-effort. IMDb, TMDB, KinoPoisk, and
TheTVDB number seasons differently, especially for anime, re-cut streaming releases, and
split seasons. Store a source-specific `(season, episode)` mapping per title and do not
assume a global canonical numbering unless Patrol defines one. For DMCA notices the work
title is normally what matters; episode-level precision is only needed if the notice
template demands it.

## Recommended identifier and alias strategy

### Identifier model

1. **`TitleId` is a Patrol-generated UUID (UUIDv7).** It is the only key referenced by
   violations, evidence, notices, and submissions. External ids are attributes, never the
   primary key.
2. **`TitleExternalId`** is a many-to-one table:
   `(title_id, source, media_kind, external_id, region?, confidence, first_seen_at,
   last_verified_at, status)` with a unique constraint on
   `(source, media_kind, external_id)`.
   - `source ∈ {imdb, tmdb, kinopoisk, tvdb, wikidata}`.
   - `media_kind ∈ {movie, series, season, episode}` because TMDB/TVDB use separate id
     spaces.
   - `confidence` records whether the mapping came from an authoritative id, a provider
     lookup, or fuzzy matching; `status ∈ {confirmed, candidate, rejected, stale}`.
3. **`Title`** carries `kind`, `original_title`, `original_language`, `release_year`,
   `end_year`, and `is_series`. Do not overwrite `original_title` with a localized title.
4. **`TitleAlias`** carries `title_id`, `value`, `language`, `region`, `script`,
   `source`, `alias_type` (original/translated/transliterated/working/abbreviation),
   `is_preferred`, and `retrieved_at`. Keep the raw string and a normalized form
   (case-folded, punctuation-stripped, optionally transliterated) for matching.
5. **`Season`/`Episode`** are optional; if modelled, give each a Patrol id and store
   source-specific numbering in a child table.

### Source precedence

| Field | Primary | Fallback |
|---|---|---|
| Original title / year / type | TMDB (licensed) | IMDb (licensed) or manual entry |
| Russian display title | KinoPoisk `nameRu` (licensed) | TMDB `ru` translation, Wikidata `ru` label, manual entry |
| English display title | TMDB `en-US` title, or `original_title` for English-origin works | IMDb `primaryTitle`, Wikidata `en` label |
| Cross-catalogue ids | Wikidata (P345/P2603/P4947/P4983) | TMDB external_ids + provider lookup |
| Alternate titles for matching | TMDB alternative_titles + translations, Wikidata aliases | IMDb akas (licensed), KinoPoisk names |

Manual entry is a first-class source: an operator can paste an IMDb or KinoPoisk URL and
type the Russian and English titles. Record `source=manual`, `confidence=confirmed`, and
the operator identity.

### Resolution policy

- Resolve to a Wikidata item first when possible; it is CC0 and holds the bridge ids.
- Use TMDB `/find` for IMDb/Wikidata/TVDB lookups and TMDB `/external_ids` for the reverse
  direction.
- Use a KinoPoisk provider only if a licence exists; otherwise require manual entry for
  KinoPoisk-only titles.
- Auto-link only on an exact, authoritative id match (same IMDb/TMDB/Wikidata id). Treat
  title+year+type matches as `candidate` and require confirmation. Remakes and same-year
  collisions make fuzzy auto-merge unsafe.
- Re-verify mappings on a schedule (for example quarterly) and whenever a source reports a
  redirect/merge; mark stale mappings rather than deleting history.

### Alias freshness policy

- Refresh aliases at onboarding, before a scan campaign, and on a fixed schedule.
- Respect the TMDB six-month cache ceiling [16]; a 90-day refresh is comfortably inside it.
- Re-read Wikidata labels/aliases on the same schedule; edits are immediate but quality is
  uneven.
- If IMDb datasets are licensed, ingest daily [4]; otherwise do not store IMDb metadata.
- Never refresh Russian aliases by scraping KinoPoisk [21].

## What this means for the design

1. **Adopt an internal UUID as the title identifier** and model external ids as a separate,
   provenance-bearing table. This is the decision the TypeSpec domain model in #14 needs;
   it also lets Patrol survive catalogue merges and licensing changes.
2. **Do not build on IMDb's free datasets or KinoPoisk scraping.** IMDb's non-commercial
   terms forbid a movie-information database [4][5]; KinoPoisk's terms forbid automated
   collection and commercial use [21]. A production rights-holder service needs commercial
   agreements or must rely on CC0/manual data.
3. **Use TMDB as the structural catalogue only under a commercial agreement.** Its free
   tier is non-commercial, caps caching at six months, and mandates attribution [16]. If
   Patrol is classified commercial, budget for the TMDB agreement; if not, the free tier is
   usable with attribution and a refresh job.
4. **Use Wikidata as the reconciliation backbone and as the free alias source.** It is CC0,
   has 99.7% KinoPoisk→IMDb coverage in the measured sample, and exposes per-language
   labels and aliases [24][25][27]. Its weakness is uneven alias coverage, not licensing.
5. **Treat KinoPoisk as a licensed data partner, not an API integration.** If Russian
   canonical titles are essential (they are, for Russian search results), negotiate access
   or make Russian title entry manual. Do not ship the unofficial API or a KinoPoisk-derived
   aggregator as the production source.
6. **Store aliases per language and region, with provenance and timestamps.** One "title"
   string per title is insufficient for piracy matching; notices and matching need
   different forms, and TMDB's RU alternative titles are often transliterations while its
   translations are Cyrillic [15].
7. **Expect to resolve links, not titles.** The user flow is "paste an IMDb or KinoPoisk
   URL"; the service should extract the id, resolve it, and present the resolved title and
   aliases for confirmation. Keep unresolved links in a candidate queue rather than
   guessing.

## Open risks

- **Licensing is the dominant risk, not API capability.** IMDb, TMDB, KinoPoisk, and
  TheTVDB all gate commercial use. Patrol's commercial classification determines whether
  the free tiers are available at all.
- **IMDb pricing is opaque.** The AWS listing was unreachable from this network; IMDb
  publishes no price and routes buyers to a trial request. Budget cannot be fixed without
  a quote. [1][2]
- **TMDB's six-month cache limit** conflicts with an evidence-retention design if title
  metadata is embedded in immutable evidence. Store only the fields needed for the notice,
  or obtain a commercial agreement that supersedes the limit. [16]
- **KinoPoisk has no verified official API.** The only working APIs are third-party
  scrapers; their terms and continuity are outside Patrol's control. [19][20][21]
- **Alias coverage is uneven.** IMDb `akas` and Wikidata aliases are contributor-driven;
  TMDB RU alternative titles may be transliterations. No source is complete for Russian
  piracy listings.
- **Season/episode numbering differs by catalogue**, especially for anime and re-cut
  releases; episode-level notices need a source-specific mapping. [29][30]
- **External ids can merge.** IMDb documents `remappedTo` for duplicate title entities;
  an internal id plus a mapping table is the only safe model. [6]

## Citations

1. IMDb Data — License IMDb Metadata (products, API via AWS Data Exchange, real-time API).
   https://data.imdb.com/
2. IMDb — Getting Access to the IMDb API (AWS account, subscription, trial request).
   https://data.imdb.com/documentation/api-documentation/getting-access/
3. IMDb Help — "Introducing the IMDb API!" (GraphQL, AWS Data Exchange, free trial).
   https://help.imdb.com/article/imdb/general-information/introducing-the-imdb-api/G49M5Y59L5N4WABM
4. IMDb — Non-Commercial Datasets (daily refresh, file schemas).
   https://developer.imdb.com/non-commercial-datasets/
5. IMDb Help — "Can I use IMDb data in my software?" (personal/non-commercial, no
   database, attribution).
   https://help.imdb.com/article/imdb/general-information/can-i-use-imdb-data-in-my-software/G5JTRESSHJBBHTGX
6. IMDb — Bulk Data Data Dictionary: Titles (`originalTitle`, `akas`, `titleDisplay`,
   `remappedTo`).
   https://data.imdb.com/documentation/bulk-data-documentation/data-dictionary/titles/
7. TMDB — Getting Started (v3 API, API key, terms).
   https://developer.themoviedb.org/docs/getting-started
8. TMDB — Movie Details / TV Details references.
   https://developer.themoviedb.org/reference/movie-details ;
   https://developer.themoviedb.org/reference/tv-series-details
9. TMDB — TV Season Details.
   https://developer.themoviedb.org/reference/tv-season-details
10. TMDB — Movie External IDs.
    https://developer.themoviedb.org/reference/movie-external-ids
11. TMDB — TV Series External IDs.
    https://developer.themoviedb.org/reference/tv-series-external-ids
12. TMDB — Find By ID (supported external sources table).
    https://developer.themoviedb.org/reference/find-by-id
13. TMDB — Movie Alternative Titles.
    https://developer.themoviedb.org/reference/movie-alternative-titles
14. TMDB — TV Series Alternative Titles.
    https://developer.themoviedb.org/reference/tv-series-alternative-titles
15. TMDB — Movie Translations (RU translation `Бойцовский клуб`; RU alternative title
    `Boytsovskiy klub`).
    https://developer.themoviedb.org/reference/movie-translations
16. TMDB — API Terms of Use (updated 2023-10-20; commercial agreement, attribution,
    6-month cache limit).
    https://www.themoviedb.org/api-terms-of-use
17. TMDB — Rate Limiting (~40 requests/second).
    https://developer.themoviedb.org/docs/rate-limiting
18. TMDB — FAQ (no SLA; commercial API via sales; free non-commercial with attribution).
    https://developer.themoviedb.org/docs/faq
19. Kinopoisk Unofficial API — OpenAPI specification (Film, Season, Episode,
    ExternalSourceResponse schemas; `webUrl`).
    https://kinopoiskapiunofficial.tech/documentation/api/openapi.json
20. Kinopoisk Unofficial API — site documentation (500 requests/day for new users, 25
    req/s; extended limits by email).
    https://kinopoiskapiunofficial.tech/
21. KinoPoisk — Пользовательское соглашение (clauses 5.2, 6.6, 6.7: no automated
    collection, personal non-commercial use).
    https://yandex.ru/legal/kinopoisk_termsofuse/
22. Wikidata — Property P345 (IMDb ID), P2603 (Kinopoisk film ID), P4947 (TMDB movie ID),
    P4983 (TMDB TV series ID), P4835 (TheTVDB series ID).
    https://www.wikidata.org/wiki/Property:P345 ;
    https://www.wikidata.org/wiki/Property:P2603 ;
    https://www.wikidata.org/wiki/Property:P4947 ;
    https://www.wikidata.org/wiki/Property:P4983 ;
    https://www.wikidata.org/wiki/Property:P4835
23. Wikidata — entity data for the property check (labels/descriptions).
    https://www.wikidata.org/w/api.php?action=wbgetentities&ids=P345%7CP2603%7CP4947%7CP4983%7CP4835&props=labels%7Cdescriptions&languages=en&format=json
24. Wikidata — Licensing (CC0 for structured data).
    https://www.wikidata.org/wiki/Wikidata:Licensing
25. Wikidata — Help:Aliases (language-specific aliases, translations, transliterations).
    https://www.wikidata.org/wiki/Help:Aliases
26. Wikidata — Q190050 (*Fight Club* film) labels, aliases, and identifier claims.
    https://www.wikidata.org/wiki/Q190050
27. Wikidata Query Service — live coverage query, 2026-11-03:
    `SELECT (COUNT(DISTINCT ?x) AS ?kp) (COUNT(DISTINCT ?y) AS ?kpImdb)
    (COUNT(DISTINCT ?z) AS ?kpTv) WHERE { ?x wdt:P2603 ?a . OPTIONAL { ?x wdt:P345 ?b .
    BIND(?x AS ?y) } OPTIONAL { ?x wdt:P31 wd:Q5398426 . BIND(?x AS ?z) } }`
    Result: 254,300 / 253,515 / 20,113.
    https://query.wikidata.org/
28. MediaWiki API help — `wbgetentities` (maximum 50 ids, 500 for higher-limit clients).
    https://www.wikidata.org/w/api.php?action=help&modules=wbgetentities
29. TheTVDB — API and Data Licensing; v4 API README (licence models, $12/year
    subscription, aliases/translations, `/updates`).
    https://thetvdb.com/api-information ;
    https://raw.githubusercontent.com/thetvdb/v4-api/main/README.md
30. TheTVDB — v4 API specification (Alias, Translation, SeriesBaseRecord, season-type
    endpoints).
    https://thetvdb.github.io/v4-api/swagger.yml
31. TheTVDB — API sign-up page (account required for a key).
    https://thetvdb.com/api-information/signup
32. PoiskKino API — sources, external ids, tiers and prices (200/day free; 2,500 ₽/month
    for 5,000/day; 5,000 ₽/month unlimited; daily updates).
    https://poiskkino.dev/
33. OMDb API — parameters and changelog (IMDb-ID lookup, type/year, season/episode).
    https://www.omdbapi.com/
34. IMDb URL variants (live probe, 2026-11-03): `https://www.imdb.com/title/tt0133093/`,
    `https://www.imdb.com/ru/title/tt0133093/`, `https://m.imdb.com/title/tt0133093/`.
35. KinoPoisk URL variants (live probe, 2026-11-03): `https://www.kinopoisk.ru/film/301/`,
    `https://www.kinopoisk.ru/series/464963/`; both redirect to Yandex SSO with the path
    preserved.

## Appendix: verification notes

- The IMDb AWS Marketplace listing could not be fetched from this network; claims about
  IMDb commercial pricing are limited to what IMDb's own documentation states (contract
  duration/terms plus usage, trial request), and the exact price is marked unverified.
- KinoPoisk page content could not be fetched because of Yandex SSO; URL patterns were
  verified from HTTP redirect `retpath` values and the provider's `webUrl` example.
- TMDB's live site was partly unreachable from this network; its API terms were read from
  the canonical `themoviedb.org/api-terms-of-use` page via the Internet Archive snapshot
  dated 2025-12-15.
- The Wikidata coverage query was executed once; a second, broader query timed out at the
  WDQS endpoint, so only the first result is reported. The counts are a point-in-time
  measurement, not a guarantee of future coverage.
