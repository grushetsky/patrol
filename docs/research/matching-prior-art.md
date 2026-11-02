# Matching signals and allowlist taxonomy for SERP piracy hits

- **Date:** 2026-11-03
- **Ticket:** [#4](https://github.com/grushetsky/patrol/issues/4)
- **Question:** How do existing anti-piracy and DMCA services decide that a search result is an
  unauthorized copy of a known title, and how do they keep false positives down?
- **Status:** Research complete; no product code. Branch `research/matching-prior-art`.

How to read the evidence tags used below:

| Tag | Meaning |
|---|---|
| **[PRIMARY]** | Stated by the party that owns the rule, format, API, or data (statute, regulator, search engine, maintainer source code). |
| **[SECONDARY]** | Practitioner or vendor description of someone else's practice. |
| **[INFERENCE]** | My design judgement. Not a published fact. Everything that looks like a number a real system would tune belongs here unless a source states it. |

Note on dates: some first-party pages are archived because the live pages are captcha-walled or
were withdrawn (Yandex, UK IPO). Archive URLs are cited, with the capture date, and claims are
attributed to the capture, not to "today".

---

## 0. The constraint that shapes everything: what a recipient will act on

Before signals and thresholds, the notice format determines what evidence is *required*. Both
major recipients accept a notice consisting of a work description, exact URLs, two sworn
statements, and a signature. Neither asks for screenshots, hashes, or page archives.

**Google** requires: contact information; a description of the work (a representative list is
allowed for multiple works); **each** allegedly infringing URL ("General information about the
location of the content isn't adequate"); a good-faith statement; an accuracy statement under
penalty of perjury; and a signature. [PRIMARY] <https://support.google.com/legal/answer/3463239>

**Microsoft/Bing** requires the same elements in DMCA form: contact information; identification of
the work or a representative list; identification of the material plus "information reasonably
sufficient to permit us to locate the material"; the two statements; and a signature.
[PRIMARY] <https://www.microsoft.com/en-us/legal/intellectualproperty/infringement>

The statutory hook is 17 U.S.C. §512(c)(3)(A), whose elements are: signature, identification of
the work (representative list permitted for multiple works at one site), identification of the
material and information reasonably sufficient to locate it, contact information, a good-faith
statement, and an accuracy statement under penalty of perjury. [PRIMARY]
<https://www.govinfo.gov/content/pkg/USCODE-2023-title17/html/USCODE-2023-title17-chap5-sec512.htm>

**Yandex does not run a DMCA-style per-URL notice desk for search.** Its public help tells
rightsholders that search engines cannot remove third-party content and directs them to site
owners/hosters; a page is only de-indexed once the source page is removed or blocked. [PRIMARY]
<https://yandex.com/support/abuse/en/troubleshooting/search/copyright>. The practical channel is
the rightsholder register created under the 2018 Memorandum: rightsholders submit links, and also
tell Yandex which pages contain **no** violation, and Yandex removes submitted links from search.
As of June 2021 the register held 24,338,936 submitted links across 310,678 domains. [PRIMARY,
archived 2024-10-06] <https://web.archive.org/web/20241006020927/https://yandex.com/rightsholders>

Consequences for Patrol, before any matching logic:

1. Evidence must be **per URL**, not per site or per query.
2. The work description must map to a stable internal work identity, because it is repeated in
   every notice and must survive a representative-list form.
3. The notice is a **sworn statement by the rights-holder**, so a false positive is not merely a
   bad search result; it is a misstatement made under penalty of perjury, and recipients can
   terminate high-volume submitters. Google says it has terminated or suspended Trusted Copyright
   Removal Program partners "for repeatedly sending invalid or incomplete notices". [PRIMARY]
   <https://storage.googleapis.com/gweb-uniblog-publish-prod/documents/How_Google_Fights_Piracy_2018.pdf>
4. Google sends a copy of every search notice to Lumen. [PRIMARY, same report] Anything placed in
   the notice is effectively published, so contact details should be a role address, and nothing
   beyond the statutory fields should be volunteered.

---

## 1. Matching a SERP result to a known work

### 1.1 What the SERP itself gives you

The result object is thin, and its thinness is the core difficulty: a title string, a snippet, a
URL, and a rank. Google's Programmable Search JSON API returns `title`, `snippet`, `link`,
`displayLink`, `mime`, `fileFormat`, and a `pagemap` of structured data; `gl` "boosts" results by
country of origin and `cr` restricts to documents originating in a country, and `totalResults` is
an estimate ("May not be accurate"). [PRIMARY]
<https://developers.google.com/custom-search/v1/reference/rest/v1/Search>

Bing's Web Search API likewise exposes a `queryContext` (including `alteredQuery`, used when the
original query had spelling mistakes) and a `rankingResponse` that orders results by page position
(`pole`, `mainline`, `sidebar`). [PRIMARY]
<https://learn.microsoft.com/en-us/previous-versions/bing/search-apis/bing-web-search/reference/response-objects>

Design consequence: **locale and rank are part of the observation**, because the same query returns
different results by `gl`/`cr` and because rank changes continuously. A candidate matched today at
position 3 may be unfindable tomorrow. Record engine, query string, locale/geo, timestamp, and rank
with every candidate.

### 1.2 Work identity: titles are not identifiers

A single film can legitimately appear as: original title, release title per territory, literal
translation, marketed translation, transliteration/romanization, working title, festival title,
DVD/Blu-ray title, TV title, and ASCII-folded variant. Two public catalogues encode exactly this
taxonomy, which is the best available evidence of what production systems must store:

**IMDb `title.akas`** carries, per alternative title: `region`, `language`, `types` (`alternative`,
`dvd`, `festival`, `tv`, `video`, `working`, `original`, `imdbDisplay`; new values may be added),
free-text `attributes`, and `isOriginalTitle`. `title.episode` carries `parentTconst`,
`seasonNumber`, `episodeNumber`; `title.basics` carries `primaryTitle`, `originalTitle`,
`startYear`, `runtimeMinutes`. [PRIMARY]
<https://developer.imdb.com/non-commercial-datasets/>

**TMDB alternative titles** return `iso_3166_1`, `title`, and a `type` that can be `"romanization"`
(e.g. `Mo'adon Krav` for *Fight Club* in IL). [PRIMARY]
<https://developer.themoviedb.org/reference/movie-alternative-titles>

**Wikidata aliases** are explicitly for "alternative names, like nicknames, acronyms, or
translations", and guidance says to include alternative translations and transliterations,
ASCII versions of non-ASCII labels, and library forms with leading articles dropped ("Idiot" for
*The Idiot*). [PRIMARY] <https://www.wikidata.org/wiki/Help:Aliases>

Recommended model [INFERENCE, built on the above]:

```
work(id, type=movie|series|episode, canonical_title, original_language,
     release_year, runtime_minutes, external_ids{imdb,tmdb,wikidata})
title_variant(work_id, text, script, language, region, kind, source, is_original)
  kind ∈ {original, release_title, literal_translation, marketed_translation,
          transliteration, working_title, festival, dvd, tv, ascii_fold, abbreviation}
```

Rules that follow from the sources:

- Never match on a single string. Match on the **set of variants**, each with its own language and
  script, and record *which* variant matched — that is what makes a notice defensible ("matched the
  Russian release title «Бойцовский клуб»", not "matched some string").
- Keep the original-language title and the romanization as separate variants. TMDB's own data model
  treats romanization as a distinct type, and Wikidata treats transliterations as aliases because
  they are not the same string. [PRIMARY, both above]
- Year and runtime are **disambiguators**, not identifiers: they separate remakes and cuts, but
  release years differ by territory and runtime differs by cut/frame rate. Treat a year mismatch as
  a penalty, never as a veto. [INFERENCE]

### 1.3 Normalization pipeline

Normalization exists to make alias lookup robust across punctuation, case, width, and diacritics.
Each step is a published standard, not a heuristic:

| Step | Rule | Why |
|---|---|---|
| Unicode normalization | NFKC | Full-width/half-width, ligatures, compatibility forms collapse to one form (Unicode Standard Annex #15). |
| Case folding | full case fold, not lowercase | Handles ß/SS, Turkish dotted I correctly. |
| Diacritic folding | NFD then strip combining marks, **retain original** | "Amélie" ↔ "Amelie"; retain the accented variant because some sites use it. |
| Punctuation/whitespace | collapse runs to single space; drop punctuation as a *secondary* key | "Spider-Man" ↔ "Spider Man". |
| Leading article | generate an article-less key per language | Wikidata's own alias guidance does this. |
| Script/transliteration | generate a Latin key via a declared scheme; store the scheme name | Multiple schemes coexist (Pinyin vs Wade-Giles per Wikidata). Never overwrite the native string. |

Sources: Wikidata alias guidance (translations, transliterations, ASCII forms, article-less forms)
[PRIMARY] <https://www.wikidata.org/wiki/Help:Aliases>; TMDB's `romanization` type [PRIMARY]
<https://developer.themoviedb.org/reference/movie-alternative-titles>.

Do **not** rely on a machine translation of the title. A translated title that no distributor ever
used will not appear on pirate pages, and it invents a string that could match an unrelated work.
Prefer catalogue-provided localized titles (IMDb `region`+`language`, TMDB `iso_3166_1`).
[INFERENCE]

### 1.4 Episodes, seasons, and multi-episode pages

Pirate pages are commonly *not* one work per page: a season pack, a "complete series" page, a
multi-episode post, or an anime page numbered by absolute episode. The maintainers of Sonarr have
encoded the real-world naming grammar as an ordered list of regexes, which is the most concrete
public catalogue of the forms an extractor must survive: `S01E05`, `1x05`, `S01E05E06`,
`S01E05-06`, repeated `S01E05 - S01E06`, `S01E05a` split episodes, 4-digit season numbers,
`Season 01 Episode 03`, bracketed `[S01E11E12]`, `(S01E1-3 of 12)`, airdate forms (`2018.04.28`),
absolute numbering for anime, and multi-season packs. [PRIMARY]
<https://github.com/Sonarr/Sonarr/blob/develop/src/NzbDrone.Core/Parser/Parser.cs>

Episode identity comes from the catalogue: IMDb `title.episode` gives `parentTconst`,
`seasonNumber`, `episodeNumber` [PRIMARY]
<https://developer.imdb.com/non-commercial-datasets/>.

Design consequence: a candidate should be able to match **a set of works** (season pack → N
episodes; multi-episode post → range), and the notice should enumerate each episode's work id, or
use one work id per episode in the representative list. A page that matches a *series* but no
specific episode is a lower-confidence candidate than one that matches a specific episode.
[INFERENCE]

### 1.5 Release-source tokens: how "cam rip" becomes a feature

The download ecosystem labels its own artifacts, and those labels are enumerated in open-source
tooling rather than in prose. Radarr's `QualitySource` enum is: `UNKNOWN, CAM, TELESYNC,
TELECINE, WORKPRINT, DVD, TV, WEBDL, WEBRIP, BLURAY`. [PRIMARY]
<https://raw.githubusercontent.com/Radarr/Radarr/develop/src/NzbDrone.Core/Qualities/QualitySource.cs>

This is directly useful in two directions:

- **Positive evidence of a copy**: a page or filename carrying `CAM`/`TELESYNC`/`TELECINE` is
  claiming to be a recording of the work itself, typically before legitimate release. That is a
  strong signal *and* a strong urgency signal (pre-release leakage). Google's own demotion design
  singles out "titles of films identified by content partners as still-in-theater or being prepared
  for commercial release" as a case where "the nature of the copyrighted work may further amplify
  the demotion signal". [PRIMARY]
  <https://storage.googleapis.com/gweb-uniblog-publish-prod/documents/How_Google_Fights_Piracy_2018.pdf>
- **Negative evidence about quality/authorization**: `WEBDL`/`WEBRIP`/`BLURAY` tokens indicate a
  release-grade file, not an authorized stream. Their presence next to a title on a page that is
  not a licensed provider is meaningful.

Do not treat a token alone as a match. Google's own catalogue of invalid notices includes an
anti-piracy firm that asked to delist news articles "presumably because the word 'download'
appeared in the text". [PRIMARY, same report] Tokens are *evidence about the page*, never a
substitute for a work match.

### 1.6 Page-level signals that predict a real copy

The most reliable public specification of "this page hosts a playable video" is Google's
`VideoObject` structured data, because Google requires it to *mean* something:

| Field | Meaning for Patrol |
|---|---|
| `contentUrl` | Direct media file URL — strongest "this is a file, not a review" signal. |
| `embedUrl` | Player URL; host is a useful block/allow feature. |
| `duration` (ISO 8601) | Compare with catalogue runtime. A 1m54s clip is not the film; ~runtime is. |
| `regionsAllowed` / `ineligibleRegion` | Geo-licensing intent. Useful when a page is authorized only in some territories. |
| `interactionStatistic` with `WatchAction` | Declares the page's purpose as watching, not reading. |

[PRIMARY] <https://developers.google.com/search/docs/appearance/structured-data/video>

These fields are also a *false-positive trap*: legitimate review/trailer pages embed a
`VideoObject` too. The discriminator is **duration relative to the work** plus **page type**
(§2), not the mere presence of a player.

Signal table (ranked by evidential strength; strength column is [INFERENCE] built on the primary
formats above):

| # | Signal | Strength | Notes |
|---|---|---|---|
| 1 | Page declares `contentUrl`/`embedUrl` + `duration` ≈ work runtime (± a few %) | Very high | Requires runtime from catalogue (IMDb `runtimeMinutes`). |
| 2 | Player iframe to a known unauthorized host, plus title variant in `<title>`/`h1` | High | Host reputation is a domain-level feature; see §1.7. |
| 3 | Explicit download affordances: `.torrent`, `magnet:`, `.mkv`/`.mp4` links, file size, "1080p/720p" + release-source token | High | Release tokens per §1.5. |
| 4 | Release-source token `CAM`/`TELESYNC`/`TELECINE`/`WORKPRINT` for a pre-release or in-theatre title | High (and urgent) | §1.5 + Google's pre-release amplification. |
| 5 | Episode selector listing most/all episodes of a season with per-episode player links | High | §1.4; season pack structure. |
| 6 | Title variant matched exactly (any language/script) in title, h1, or URL slug | Medium | Needed but insufficient alone. |
| 7 | Dubbed/subtitled markers next to the variant ("Dublado", "Legendado", "VOSTFR", "multi-audio", "sub") | Medium | Practitioner pattern; language tags from BCP 47 help model it. [SECONDARY] |
| 8 | Snippet/title contains "watch online", "full movie", "free", language equivalents | Low alone | Google's invalid-notice examples show keyword-only logic failing. |
| 9 | Domain appears repeatedly across unrelated titles | Domain-level, high | Basis of Google's demotion signal (valid notices per site). |

### 1.7 Domain-level reputation is a first-class signal

Google converts notice volume into ranking treatment: "Google also factors in the number of valid
copyright removal notices we receive for any given site as one signal ... sites for which Google has
received a large number of valid removal notices appear much lower in search results", and by end
of 2017 it had demoted more than 65,000 websites, ~500/week, globally. [PRIMARY]
<https://storage.googleapis.com/gweb-uniblog-publish-prod/documents/How_Google_Fights_Piracy_2018.pdf>

The UK Voluntary Code of Practice formalised this: the shared objective is achieved mainly through
"automated demotion following the receipt of sufficient copyright infringement notices", with a
threshold defined in terms of notices listing a number of URLs in aggregate (thresholds redacted in
the published version), plus follow-up work on domains that change TLD while "retain[ing]
substantially the same identity". [PRIMARY]
<https://web.archive.org/web/20190724091935id_/https://assets.publishing.service.gov.uk/government/uploads/system/uploads/attachment_data/file/609478/code-of-practice-on-search-and-copyright.pdf>

Design consequence: Patrol should maintain a **domain reputation record** fed by its own confirmed
violations (and optionally public blocklists such as WIPO ALERT) and use it as a feature, not as a
verdict. A first-time domain with one match should not be treated like a domain with 500 prior
confirmed violations. [INFERENCE]

---

## 2. Allowlist taxonomy

The UK Code is the clearest published statement that a whitelist is mandatory infrastructure, not
an optimisation: "A whitelist process would need to be created to exclude legitimate sites that
could be caught within this lower threshold", and "Any such process will need to include a
mechanism for challenging entries which are not clearly legitimate websites." [PRIMARY]
<https://web.archive.org/web/20190724091935id_/https://assets.publishing.service.gov.uk/government/uploads/system/uploads/attachment_data/file/609478/code-of-practice-on-search-and-copyright.pdf>

### 2.1 Categories

| Category | Representative members | Scope | Why allowlisted | Primary grounding |
|---|---|---|---|---|
| Rights-holder official | Studio/ distributor/ production company domains; official title sites; official YouTube channels | Per tenant, configurable | The rights-holder's own promotion is by definition authorized | Google's knowledge-panel verification path for claiming a movie: "Get verified on Google" [PRIMARY] <https://developers.google.com/search/docs/appearance/structured-data/movie> |
| Licensed streamers / VOD | Subscription, ad-supported, rental, and purchase services | Per title **and per territory** | Availability is licensed, not global | TMDB/JustWatch watch-provider data is per-country, covering streaming/rental/purchase [PRIMARY] <https://developer.themoviedb.org/reference/movie-watch-providers> |
| Broadcasters / catch-up | National broadcasters' VOD | Per title, per territory | Licensed window | Same as above (provider model) |
| Catalogues / databases | IMDb, TMDB, Wikidata, Wikipedia, fan wikis | Global | Descriptive pages, not copies | These are the identity sources themselves (§1.2) |
| Reviews / criticism | Review sites, blogs, video reviews | Global | Fair use / non-substitutive | Google's invalid-notice list includes takedowns aimed at criticism and commentary [PRIMARY] (2018 report) |
| Trailers / clips | Official trailer pages, trailer aggregators | Per title | Promotional, short duration | `VideoObject.duration` distinguishes a 2-minute trailer from a 100-minute film [PRIMARY] |
| News | News publishers covering release/piracy | Global | Reporting, not distribution | Google's invalid-notice example: articles "discussing the release of the work" targeted because "download" appeared [PRIMARY] |
| Forums / UGC discussion | Reddit, forums, Q&A | Global, with URL-level exceptions | Discussion; but a forum post can host a link. Allowlist the *host*, not every *page* | — |
| Search/social platforms | The engines themselves, social networks | Global | Not a copy host at the URL level | — |
| Government / education | Regulators, archives, universities | Global | Lawful use | — |

Two hard rules, both supported by the Code's own wording:

1. **Allowlists are scoped, not absolute.** A licensed-streamer entry is (title, territory,
   provider). A review-site entry is host-level. An official-domain entry is tenant-level. A single
   global "good domains" list cannot express "Netflix is authorized for this title in DE but not in
   TR". [INFERENCE, from the per-country provider model]
2. **Every allowlist needs a challenge path**, because "not clearly legitimate" is the failure mode
   the Code explicitly anticipates. [PRIMARY, Code §10 fn.2]

### 2.2 Layering

```
L0  tenant config      official domains, official channels, licensed destinations (title+territory)
L1  global catalogue   catalogues, review/news/forum hosts, platforms, government
L2  learned            hosts with N consecutive reviewer "not a violation" decisions
L3  blocklist          hosts with N confirmed violations (domain reputation, §1.7)
```

Precedence: **L0 > L1 > L2 > L3 > unclassified**. A URL on an official domain is never a candidate,
even if the same host also has confirmed violations elsewhere (real case: official channel pages
that re-upload clips). Blocklists must never override a tenant's own domains. [INFERENCE]

WIPO ALERT is the canonical multi-jurisdiction blocklist: national authorities upload lists of
infringing sites; advertising users can consume all lists or only selected countries, via manual
search, spreadsheet, or API; WIPO explicitly does **not** guarantee accuracy ("The national agencies
which create the lists of sites remain solely responsible for their contents"). [PRIMARY]
<https://www.wipo.int/en/web/wipo-alert/faqs>

That last sentence is the design lesson: a third-party blocklist is *evidence*, not truth. It
should raise a score, not remove the need for a per-URL match. [INFERENCE]

---

## 3. Confidence, review queues, and the precision/recall trade-off

### 3.1 Published accuracy numbers (and why they differ so much)

| Source | Measure | Value |
|---|---|---|
| Google, 2017 | URLs requested → removed | >95% removed; ~54M rejected or reinstated [PRIMARY] |
| Google, 2017 | Share of delisted URLs never in the index (one sample) | ~82% [PRIMARY] |
| Urban/Karaganis/Schofield study, cited by Google | Requests with characteristics raising "basic questions about their validity" | 28.4% [PRIMARY as cited; SECONDARY study] |
| Bing, H1 2026 | URLs requested → accepted | 253,941,941 / 254,670,551 = 99.71% [PRIMARY] |

Sources: Google 2018 report
<https://storage.googleapis.com/gweb-uniblog-publish-prod/documents/How_Google_Fights_Piracy_2018.pdf>;
Microsoft report <https://www.microsoft.com/en-us/corporate-responsibility/copyright-removal-requests-report>.
The underlying study is *Notice and Takedown in Everyday Practice* (Urban, Karaganis, Schofield),
SSRN 2755628.

Read these carefully:

- Bing's 99.71% is **not** evidence that Bing receives better notices; its own note says the data
  excludes "requests initially deemed noncompliant during preliminary reviews conducted prior to
  entry of the request into our standard tracking tools". [PRIMARY, same page] The denominator is
  post-screening.
- Google's ~5% rejection plus a 28.4% "questionable" rate in an external audit means
  **rightsholder-generated notice streams are not high-precision by default**. Patrol's own queue
  must assume its candidates are guilty until reviewed.
- The 82% not-in-index figure means much notice volume is speculative: URLs that were never
  visible. Patrol should check index presence at capture time and record it; submitting URLs that
  are not in the index produces no user-visible benefit but does create perjury exposure.

### 3.2 How practitioners keep false positives down

| Mechanism | Evidence |
|---|---|
| **Human review of every match before action** | YouTube Copyright Match Tool: "just because we've found a matching video doesn't mean it's infringing"; user must review and choose Archive / Request removal / Contact channel. [PRIMARY] <https://support.google.com/youtube/answer/7648743> |
| **Two-tier matching: exact copies auto-actionable, "potential matches" reviewed** | Same tool: a "Prevent Copies" feature surfaces "potential matches" that "weren't eligible to be automatically prevented from upload because they weren't copies". [PRIMARY] |
| **Prioritisation by reach** | Same tool filters matches by "Total views" and channels by "Subscribers". [PRIMARY] |
| **Trust tiering of submitters** | Google's Trusted Copyright Removal Program for owners "with a proven track record of submitting accurate notices"; partners terminated/suspended for repeated invalid notices. [PRIMARY] |
| **Recipient-side validity review + counter-notice** | Google reinstated >210,000 URLs in 2017 on >26,000 counter notifications. [PRIMARY] |
| **Human reviewer on legal removals** | Microsoft: "a specially trained human reviewer may look at the content and conduct." [PRIMARY] <https://www.bing.com/bingpolicies/archives> |
| **Whitelist + challenge process** | UK Code, §10 and fn.2. [PRIMARY] |
| **Rightsholder marks false entries in the register** | Yandex: rightsholders "inform Yandex about those pages that do not contain any copyright violations." [PRIMARY, archived] |
| **Mandatory review before submission** | Google Search relies on the submitter's sworn statements; abuse is handled by rejection and program termination, i.e. after the fact. [PRIMARY] |

### 3.3 The trade-off, stated as a design decision

The costs are asymmetric:

- **False positive**: a sworn, perjured-adjacent claim against a legitimate site; possible
  counter-notice and reinstatement; reputational damage with the recipient (which can suspend the
  submitter's high-volume channel); and, for a tenant, a public Lumen record naming them.
- **False negative**: one link stays up. Google's demotion already reduces the domain's visibility
  globally based on aggregate valid notices, and the next sweep will see the URL again.

Therefore: **precision first, recall recovered by repeated sweeps and domain-level escalation.**
[INFERENCE] This is also what the two formal measurement regimes do:

- The UK Code measures **aggregate results for an agreed set of neutral queries**, not total
  coverage: "For an agreed sample of searches using neutral queries in conjunction with artist or
  content name, the aggregate results should be as follows ..." (targets redacted), with quarterly
  independent research by the IPO. [PRIMARY]
  <https://web.archive.org/web/20190724091935id_/https://assets.publishing.service.gov.uk/government/uploads/system/uploads/attachment_data/file/609478/code-of-practice-on-search-and-copyright.pdf>
- YouTube prioritises by views/subscribers rather than trying to action every match. [PRIMARY]

### 3.4 Recommended queue shape

Scores and cut-offs are [INFERENCE]; the *bands* and the *actions* are the transferable pattern.

| Band | Suggested score | Action | Review effort |
|---|---|---|---|
| A — auto-submit eligible | ≥ 0.95 **and** no allowlist hit **and** ≥ 2 independent strong signals (§1.6 #1–#5) | Assemble notice, hold for a single-click approval (never fully unattended at launch) | sampled audit |
| B — review | 0.70–0.95, or any single strong signal without corroboration | Human decides violation / not / allowlist | full |
| C — suppressed | < 0.70, or allowlist hit, or page type is review/news/catalogue/trailer | Log only; feed the allowlist learner | none |
| D — blocked | domain reputation above threshold **and** title match present | Auto-submit with domain evidence attached | sampled audit |

Non-negotiable invariants [INFERENCE]:

- An allowlist hit **cannot** be overridden by score. It routes to a review task ("is this
  allowlist entry wrong?"), never to a notice.
- Every band-A item still records the full evidence set (§4), because it may be challenged.
- Reviewer decisions are labelled data: `violation`, `not_a_violation`, `wrong_work`,
  `authorized_here`, `page_dead`. These labels are what make thresholds tunable later, and
  `wrong_work` vs `not_a_violation` separates matching errors from policy errors.
- Thresholds are per engine and per tenant, because Yandex's channel (register entry) has different
  consequences from a DMCA notice.

---

## 4. Evidence conventions: what to capture, and what recipients actually need

### 4.1 Required vs supporting

| Item | Required by recipient? | Purpose | Source / standard |
|---|---|---|---|
| Exact URL(s) of the alleged infringement | **Yes** — "General information about the location of the content isn't adequate" | Locate the material | Google help [PRIMARY] |
| Work identification (or representative list) | **Yes** | Identify the work | §512(c)(3)(A)(ii); Google/Microsoft help [PRIMARY] |
| Good-faith + accuracy statements, signature | **Yes** | Legal effect | §512(c)(3)(A)(v),(vi),(i) [PRIMARY] |
| Contact information | **Yes** | Correspondence | §512(c)(3)(A)(iv) [PRIMARY] |
| Timestamped page HTML (raw bytes) | No | Prove what the page said at time T; re-extract features offline | Practitioner convention [SECONDARY] |
| SHA-256 of captured bytes | No | Tamper-evidence; detect later alteration of the same URL | FIPS 180-4 (SHA-256); hash-then-timestamp per RFC 3161 [PRIMARY for the standards] |
| Screenshot (PNG) | No | Human-reviewable, shows rendered state incl. player | Practitioner convention [SECONDARY] |
| Third-party archive snapshot (Wayback) | No | Independent timestamp; survives capture disputes | `web.archive.org/save/<url>`; Availability API returns `timestamp` + snapshot URL [PRIMARY] <https://archive.org/help/wayback_api.php> |
| Trusted timestamp token over the hash | No | Proof the datum existed before a time | RFC 3161 [PRIMARY] <https://www.rfc-editor.org/rfc/rfc3161> |
| SERP observation (engine, query, locale, rank, timestamp) | No | Explains why this URL was surfaced; needed for audit and for "not in index" checks | Google/Bing API field docs [PRIMARY] |

Why the "No" items still matter: the notice is a sworn statement, and the recipient's process
includes counter-notice and reinstatement (Google reinstated >210k URLs in 2017). When a site
owner disputes, the only defence is a contemporaneous record of what the page served. Google's own
transparency mechanism publishes the notice to Lumen, so the *claim* is public but the *proof* is
not — Patrol must hold the proof. [INFERENCE from the primary facts above]

### 4.2 Recommended evidence record

One immutable record per (candidate, capture). Content-addressed, append-only.

```
capture
  id, candidate_id, work_ids[], observed_at (UTC, RFC 3339)
  serp: engine, query, gl/cr, device/locale, rank, result_title, snippet, display_url
  http: requested_url, final_url (after redirects), status, content_type,
        response_headers_subset(date, server, content-length), body_sha256, body_bytes_ref
  render: screenshot_png_ref, screenshot_sha256, viewport, ua_string, js_enabled
  extract: page_type, matched_variant, matched_alias_kind, match_score_components,
           video_object{duration, content_url, embed_url, regions_allowed},
           release_tokens[], download_links[], embed_hosts[], episode_range
  archive: wayback_snapshot_url, wayback_timestamp (nullable)
  attestation: rfc3161_token (optional), hash_manifest_sha256
  reviewer: decision, actor, decided_at, note
  notice: engine, submitted_at, notice_id, urls[], outcome, counter_notice
```

Retention: at least as long as the notice can be challenged plus the applicable limitation period;
store WORM (object lock) with a separate hash manifest. [INFERENCE]

Order of capture, because pages are volatile: fetch → hash → screenshot → Wayback save → extract.
Never extract from a live page twice and call it one observation. [INFERENCE]

### 4.3 What to put in the notice body

Keep it to what is required, plus what makes verification cheap for the recipient:

1. Work: canonical title, original title, year, and the identifier used internally; for series,
   season/episode. Use the representative-list form when several works are in one notice. [PRIMARY]
2. URLs: one per line, exact, with scheme; no ranges, no "site:example.com". [PRIMARY]
3. Per-URL optional one-liner only if it adds locative value (e.g. "episode 4 player"). Do not add
   argumentation; it is not read and it creates inconsistent statements. [INFERENCE]
4. Statements and signature exactly as the recipient specifies. [PRIMARY]
5. Role contact address, not a personal one, because Google forwards notices to Lumen. [PRIMARY]

Do **not** attach screenshots or hashes to the notice unless asked: they are not part of the
published format, and Google's transparency pipeline republishes the notice. Keep them in the
evidence store. [INFERENCE]

---

## 5. What this means for the design

1. **Model works, not strings.** A work has a canonical identity, a language, a year, a runtime, and
   a typed set of title variants (original / release / translation / transliteration / working /
   ascii). Every candidate carries the matched variant and its kind. This is the difference between
   a notice that says "matched «Бойцовский клуб», the Russian release title" and one that says
   "title contains the words".
2. **Normalize with standards, not regexes.** NFKC + full case fold + diacritic fold + article-less
   key + declared transliteration scheme; always retain the native string. Two catalogue models
   (IMDb `title.akas`, TMDB `alternative_titles`) already encode the taxonomy; copy it.
3. **Score with independent evidence, not one strong token.** Require at least two of: player/file
   URL, duration≈runtime, download affordance, release-source token, episode structure — plus a
   title-variant match. A page with a player and no duration match is a trailer until proven
   otherwise.
4. **Domain reputation is a feature with a separate lifecycle.** Feed it from confirmed violations;
   treat WIPO ALERT and similar lists as inputs with no accuracy guarantee; never let a blocklist
   entry replace a per-URL match.
5. **Allowlists are scoped.** Tenant official domains (global), licensed destinations
   (title × territory × provider), and global non-copy categories (catalogue/review/news/forum/
   trailer). Allowlist hits are reviewable, never silently dropped and never overridable by score.
6. **Precision-first queue.** Three bands (auto-submit-eligible, review, suppressed) + a domain-
   reputation fast path; human approval of every notice at launch; prioritise by reach (views/
   subscribers, SERP rank) as YouTube does. Expect the first weeks of labels to move the thresholds.
7. **Measure the way the UK Code does.** Maintain a fixed set of "neutral" queries per title ×
   locale, measure the share of top-N results that are unauthorized *after* allowlisting, and track
   it over time. Also measure precision on a random sample of submitted notices. Coverage (recall)
   is a secondary, slow-moving metric.
8. **Capture first, extract second.** Every candidate gets raw bytes + hash + screenshot + timestamp
   + (best-effort) Wayback snapshot before classification. The notice only needs the URL; the
   defence needs everything else.
9. **Yandex is a different product surface.** There is no per-URL DMCA desk; the register is fed by
   rightsholders and also accepts "this page is clean" reports. Design the Yandex adapter around
   register submission and around source-page status, not around a Google-style webform.

---

## 6. Open risks / what could not be verified

| Risk | Detail |
|---|---|
| No public vendor thresholds | No anti-piracy vendor publishes score cut-offs or precision/recall on SERP matching. Every number in §3.4 is a proposal to be calibrated, not a benchmark. |
| Notice accuracy data is US-centric and dated | The 28.4% figure comes from 2016–17 Google data; Bing's 99.71% uses a post-screening denominator. Neither predicts Patrol's own error rate. |
| Allowlist drift | Licensed windows open and close; a title can be authorized today and not tomorrow. Provider data (TMDB/JustWatch) is per-country but not authoritative for a specific contract. Tenant confirmation is required. |
| Terminology of "cam rip" | Release tags are a self-describing ecosystem convention (Radarr enum), not a standard. Variants (`HDCAM`, `HDTS`, `DVDSCR`, `REMUX`) exist beyond the enum and must be handled by an extensible token table. |
| Yandex mechanics | The register page is archived (captured 2024-10-06; statistics as of June 2021); current submission mechanics and any API are not publicly documented in English. |
| Wayback reliability | Snapshots can fail, be excluded by robots policy, or be removed on request. Treat the archive as corroboration, never as the sole record. |
| Geo/locale effects on SERP | `gl`/`cr` change results; a hit found in one locale may be irrelevant or invisible in another. The legal significance of the locale (where the infringement is actionable) is a legal question, not a matching question. |
| Multi-episode work identity | A season-pack page maps to N works; the notice must enumerate them correctly or the recipient may treat the notice as overbroad. |

---

## 7. Citations

Primary:

1. 17 U.S.C. §512 — <https://www.govinfo.gov/content/pkg/USCODE-2023-title17/html/USCODE-2023-title17-chap5-sec512.htm>
2. Google, *What is copyright?* (notice requirements) — <https://support.google.com/legal/answer/3463239>
3. Microsoft, *Reporting Infringement to Microsoft* — <https://www.microsoft.com/en-us/legal/intellectualproperty/infringement>
4. Microsoft, *Copyright Content Removal Requests* (H1 2026 figures) — <https://www.microsoft.com/en-us/corporate-responsibility/copyright-removal-requests-report>
5. Google, *How Google Fights Piracy* (Nov 2018) — <https://storage.googleapis.com/gweb-uniblog-publish-prod/documents/How_Google_Fights_Piracy_2018.pdf>
6. UK IPO, *Code of Practice on Search and Copyright* (2017), archived — <https://web.archive.org/web/20190724091935id_/https://assets.publishing.service.gov.uk/government/uploads/system/uploads/attachment_data/file/609478/code-of-practice-on-search-and-copyright.pdf>
7. UK IPO press release (withdrawn 2025) — <https://www.gov.uk/government/news/search-engines-and-creative-industries-sign-anti-piracy-agreement>
8. Yandex, *A website in the search results contains content that violates my copyright* — <https://yandex.com/support/abuse/en/troubleshooting/search/copyright>
9. Yandex, *Protecting the Interests of Copyright Holders* (archived 2024-10-06) — <https://web.archive.org/web/20241006020927/https://yandex.com/rightsholders>
10. Bing, *How Bing delivers search results* (copyright + human review) — <https://www.bing.com/bingpolicies/archives>
11. YouTube, *How Content ID works* — <https://support.google.com/youtube/answer/2797370>
12. YouTube, *Use the Copyright Match Tool* — <https://support.google.com/youtube/answer/7648743>
13. Google, *Video (VideoObject) structured data* — <https://developers.google.com/search/docs/appearance/structured-data/video>
14. Google, *Movie carousel structured data* — <https://developers.google.com/search/docs/appearance/structured-data/movie>
15. Google, *Custom Search JSON API: Search* — <https://developers.google.com/custom-search/v1/reference/rest/v1/Search>
16. Microsoft, *Bing Web Search API v7 response objects* — <https://learn.microsoft.com/en-us/previous-versions/bing/search-apis/bing-web-search/reference/response-objects>
17. IMDb, *Non-Commercial Datasets* (`title.akas`, `title.episode`, `title.basics`) — <https://developer.imdb.com/non-commercial-datasets/>
18. TMDB, *Alternative Titles* — <https://developer.themoviedb.org/reference/movie-alternative-titles>
19. TMDB, *Watch Providers* (JustWatch) — <https://developer.themoviedb.org/reference/movie-watch-providers>
20. Wikidata, *Help:Aliases* — <https://www.wikidata.org/wiki/Help:Aliases>
21. Sonarr, `Parser.cs` (episode naming grammar) — <https://github.com/Sonarr/Sonarr/blob/develop/src/NzbDrone.Core/Parser/Parser.cs>
22. Radarr, `QualitySource.cs` (release sources) — <https://github.com/Radarr/Radarr/blob/develop/src/NzbDrone.Core/Qualities/QualitySource.cs>
23. WIPO, *WIPO ALERT FAQ* — <https://www.wipo.int/en/web/wipo-alert/faqs>
24. Internet Archive, *Wayback Machine APIs* — <https://archive.org/help/wayback_api.php>
25. IETF, *RFC 3161: Time-Stamp Protocol* — <https://www.rfc-editor.org/rfc/rfc3161>

Secondary / cited-through:

26. Urban, Karaganis & Schofield, *Notice and Takedown in Everyday Practice* (2017), SSRN 2755628 — <https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2755628> (the 28.4% figure is quoted from this study by Google's report; access was blocked, so the number is cited as Google reports it)
27. Practitioner keyword patterns for dubs/subtitles ("Dublado", "Legendado", "VOSTFR") — no authoritative source; treated as secondary observation.
