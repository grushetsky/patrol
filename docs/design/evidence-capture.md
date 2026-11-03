# Evidence capture

Evidence is Patrol's record of what a URL actually served. A violation is confirmed by a person looking at a page, cited in a notice months later, and defended years later still, so the record must survive redirects, redeployments, and the disappearance of the page itself. This document fixes what a capture contains, when Patrol captures, how the record stays immutable, and how long it lives. The terms are those of "_GLOSSARY.md_"; the storage substrate is "_docs/adr/0006-evidence-in-object-storage.md_", the per-URL sharing rule is "_docs/adr/0002-evidence-per-url.md_", the capture set and timing are "_docs/adr/0016-evidence-is-a-rendered-page-bundle.md_", the fetch posture is "_docs/adr/0018-single-url-evidence-fetch.md_", and the retention windows are "_docs/adr/0017-evidence-retention-windows.md_".

## Evidence is for the defence, not for the notice

Google, Bing, and Yandex each ask for a URL, an identification of the work, a sworn statement, and a signature. None of them asks for a screenshot, a page copy, or a hash, and none of them publishes an attachment channel that would carry one. Patrol therefore never uploads evidence. Evidence exists so that an operator can reach a review decision on what the page really served, and so that the rights holder can answer a counter-notice, a misrepresentation claim, or a dispute about what a notice said.

Two consequences follow, and they shape everything below:

- A capture is taken because a **person or a score needs to see the page**, not because a recipient asked for it.
- Captures are cheap enough to take often and complete enough to be read later, but they never become a bulk archive of the web.

## What a capture records

One capture is one fetch of one URL, recorded as one `Evidence` row plus the artifacts that fetch produced. Artifacts are content-addressed, so two captures of an unchanged page share their bytes and differ only in the row that says when and why the page was read.

| Field or artifact | Contents | Why it is kept |
| --- | --- | --- |
| Requested URL | The URL as it was submitted or surfaced, normalized for comparison but stored verbatim | The notice names the submitted URL, and a redirect must not rewrite it |
| Redirect chain | Every hop with its status and `Location` | Shortener and multi-hop chains are common; the chain proves how one URL became the other |
| Final URL and host | The landing page after redirects, with the host derived from it | The violation's host is the destination host, per "_docs/adr/0004-destination-host.md_" |
| Response headers | The full header map minus `Set-Cookie`, `Cookie`, and `Authorization` | Content type, `Server`, `Last-Modified`, and `ETag` support hosting and freshness claims without carrying visitor credentials |
| Response body | The HTML bytes the server actually returned, before any script ran | The only artifact that is what the host served rather than what the browser made of it |
| Rendered DOM | `outerHTML` after load, UTF-8, with a truncation flag if it exceeded the ceiling | The page as a visitor saw it, including what JavaScript injected |
| Full-page screenshot | PNG of the rendered page, capped by height | What a person actually saw; the only artifact a non-technical reader can interpret |
| Viewport thumbnail | JPEG derived from the screenshot | Renders the review queue without shipping full-page PNGs to the browser |
| Extraction sidecar | Page title, `h1` texts, `meta` and `og:*` values, JSON-LD blobs, iframes, `video` and `source` elements, and download affordances as JSON | The strong signals are computed from this, and the sidecar hash lets a later reader see exactly what the extractor saw |
| Capture profile | User agent, viewport, locale, timezone, JavaScript and resource-blocking settings, navigation policy, and extractor version | Without it a capture cannot be explained or repeated |
| Hashes | SHA-256 of the response body, the DOM, the screenshot, the thumbnail, the sidecar, and the header artifact | Duplicate detection, tamper evidence, and a stable identity across buckets |

A capture record also carries its identity (`UUIDv7`), the capture reason, the outcome, a failure reason where the outcome is not `captured`, the HTTP status, the attempt count, and the observation time in UTC. The screenshot is not decoration: Russian practice accepts a screenshot as proof when it carries the page URL and the exact time it was taken, which is why the capture time is part of the record rather than an incidental log line.

### What is deliberately not captured

- **Search-engine result pages.** The engines' terms range from a storage prohibition to silence, and "_docs/design/serp-acquisition-route.md_" already settles that result rows are provenance. A search result keeps its URL, rank, title, snippet, query, locale, engine, observation time, and a reference to the vendor's stored payload; no result page is ever fetched or stored.
- **Page media.** Patrol does not download or hash the film, the poster, or any other image the page serves. Hashing media to recognise it elsewhere is fingerprinting, which this effort puts out of scope; the screenshot is the only image Patrol stores, and it is stored as the page's appearance, not as a fingerprint of the work.
- **Third-party analytics and tracking payloads.** Requests to advertising, analytics, and beacon hosts are blocked, so a capture does not become a record of who visited the pirate site.
- **Anything behind a login.** Patrol never authenticates, never accepts a paywall offer, and never circumvents a challenge or DRM.

### Ceilings

A capture is bounded so that a hostile page cannot exhaust the worker: a 25-second navigation budget, readiness defined as a completed `load` plus a two-second settle rather than a network-idle heuristic, a 45-second total budget, a 10 MB DOM ceiling, a screenshot capped at 16 000 pixels of height because Chromium's full-page capture fails above 16 384, and blocked media, websocket, service-worker, and third-party analytics requests, while fonts and stylesheets are allowed so the screenshot matches what a visitor sees. Exceeding a ceiling produces a truncated but honest artifact with its flag set, never a silent partial.

## When Patrol captures

Three points, each with its own reason recorded on the row:

| Reason | Trigger | Freshness rule | What it exists to prove |
| --- | --- | --- | --- |
| `detection` | A candidate is formed from a search result or from manual URL entry | Always captured | What the page served when it was first surfaced, before anyone acted on it |
| `review` | An operator opens a candidate, or records a review decision | Captured when the newest live capture is more than 24 hours old | What the reviewer actually decided on, and what the page served at that moment |
| `pre_handoff` | A notice is approved and a submission is queued | Captured when the newest live capture is more than 7 days old | The page's most recent state before the rights holder attests to it |

A review decision and a notice each pin the exact captures they relied on, so a later capture never changes what an earlier decision or notice claimed.

The rule for a page that has gone away is deliberate: a `pre_handoff` capture that comes back `dead` **flags** the violation for the operator and never deletes it or drops it from the notice silently. Google accepts URLs that are not in its index, and a notice about a page that has since been taken down is still a truthful notice about a page that hosted a copy. The operator sees both the latest dead capture and the earlier live ones, and chooses.

A URL that reappears after a removal starts a new violation, per "_docs/adr/0001-violation-identity.md_". It gets a fresh `detection` capture; unchanged bytes deduplicate in the object store, but the row and its timestamp are new, and the closed violation keeps the captures its own notice cited.

## Outcomes and retries

Every capture ends in one of four outcomes:

| Outcome | Meaning | Retry |
| --- | --- | --- |
| `captured` | A successful response with a parseable body | None |
| `dead` | `404`, `410`, a DNS failure, a refused connection, or an empty body | None; the page is recorded as dead at that time |
| `blocked` | `401`, `403`, `429`, or `451`, a CAPTCHA or interstitial challenge, or a block page detected by its fingerprint | Up to three attempts with backoff inside 24 hours |
| `error` | A timeout, a TLS failure, a navigation crash, or a parse failure | Up to three attempts with backoff inside 24 hours |

Retries never change posture: no proxy rotation, no user-agent rotation, no challenge solving, and no second egress route. A page that blocks Patrol stays blocked, and the candidate is suppressed with `blocked` as its reason. Every attempt is a row, so the record shows three refusals rather than one unexplained absence.

A `dead` or `blocked` capture still creates a metadata record: an absence is evidence too, and it is what explains why a candidate was dismissed or why a violation was flagged at handoff. It carries no blobs unless a body was actually returned.

## Immutability

Five mechanisms, each of which alone would be insufficient:

1. **Append-only metadata.** The application role holds `INSERT` and `SELECT` on the evidence tables and no `UPDATE` or `DELETE`. The only columns a later process may write are the purge markers, written by a separate retention role. A corrected capture is a new row, never an edit.
2. **Content-addressed blobs.** Objects are keyed by the SHA-256 of their bytes, so an unchanged artifact produces an identical key and no object is ever overwritten. Production buckets enable versioning and Object Lock in compliance mode, with each object's retention date set to the purge deadline of the citations that reference it and extended, never shortened, when a later citation arrives. Compliance mode is irreversible, so the retention date is chosen deliberately at write time; development and providers without compliance mode use governance mode and accept a weaker guarantee.
3. **Version-pinned reads and deletes.** A delete marker makes a key unreadable even though its version survives, which would hide evidence from every citation while storage still held it. No component issues an unversioned delete; reads name the version or the content hash, and the retention role deletes a specific version id only after that version's lock has lapsed.
4. **Pinned citations.** A review decision and a notice each reference evidence ids at the moment they are recorded or approved. The notice model holds those ids as immutable data, so the claim "this is what the page served when we attested" survives any later capture.
5. **Hashes in two places.** Each artifact's SHA-256 is recorded both in PostgreSQL and in the object's own metadata. A restore that produces different bytes fails a check rather than silently passing. A hash manifest per capture is also what the rights holder would certify to authenticate the record as machine-generated under FRE 902(13)–(14), should a notice ever be contested.

Content addressing creates one hazard worth naming: one blob serves many records, so a blob can outlive every citation that once referenced it while another record still needs it. The retention job therefore deletes a blob only when no unpurged artifact row still references its hash, and it deletes in the order "metadata marker first, bytes second", so an interrupted run leaves orphaned bytes rather than dangling citations.

## Storage layout

PostgreSQL holds the records; the bucket holds the bytes.

| Record | Purpose |
| --- | --- |
| `evidence` | One row per capture: identity, requested and final URL, host, reason, outcome, status, profile and extractor versions, observation time, purge marker |
| `evidence_artifact` | One row per artifact: kind, SHA-256, size, content type, dimensions where relevant, and the evidence row it belongs to |
| `violation_evidence` | The captures a violation cites, with the role they played |
| `notice_evidence` | The captures an approved notice cites, frozen at approval |
| `legal_hold` | The scope, reason, operator, and release of a hold that suspends purging |

Bucket keys group by purpose, then by hash, so listing never mixes provenance with evidence:

- `evidence/sha256/<first two>/<next two>/<full hash>` for evidence artifacts.
- `serp/<engine>/<year>/<month>/<scan id>/<query hash>.json.gz` for the raw search payload Patrol owns.
- `derived/thumbnail/sha256/...` for the viewport thumbnails.

The raw search payload rules follow "_docs/design/serp-acquisition-route.md_": a Yandex response is Patrol's own data and is kept compressed for 90 days for parser audits, while a DataForSEO response is referenced rather than copied because the vendor retains standard-queue results for 30 days. Result rows themselves are kept permanently as provenance.

## Retention

| Material | Retained | Then |
| --- | --- | --- |
| Evidence cited by an open violation, or by a notice that is drafted, approved, or awaiting acknowledgement | Indefinitely | Nothing is purged while a citation is live |
| Evidence whose citations are all closed | Five years after the later of the violation's closure and the last submission citing it | Bytes purged; the metadata row survives with its purge marker |
| Captures never cited by a violation | Twelve months after the last review decision, or twelve months after capture where no decision was recorded | Bytes purged; metadata survives |
| Raw search payloads Patrol owns | 90 days | Deleted |
| Evidence under a legal hold | Until the hold is released | A release is itself recorded |

Five years is a floor set above the limitation period, never at it. A copyright claim runs three years from accrual under 17 U.S.C. §507(b), and a misrepresentation claim against the complainant under §512(f) can accrue later than the notice, when the target learned of it; Russian claims run three years under ГК РФ art. 196. Two further years cover delayed accrual and service, so the bytes do not vanish on the last day a claim could be filed.

A legal hold — a dispute, a counter-notice, a threatened claim, or an operator's own instruction — outranks every other rule and is recorded with its reason, its operator, and its release. It must reach every deletion path, not just the deadline: bucket lifecycle expiry, deletion at violation closure, and shared-blob cleanup all stop while a hold covers the record, because a spoliation sanction under FRCP 37(e) is the cost of a purge that ran while a dispute was reasonably anticipated.

Purging removes bytes and never rewrites history: the record stays, the artifact rows stay with their hashes and sizes, and the purge marker says when and why the bytes went. A notice approved before a purge therefore still explains exactly which capture it cited and what that capture contained, even though the bytes are gone.

## What the fetch is, and is not

Captures are single-URL evidentiary fetches. Patrol fetches the landing page of a URL that discovery already surfaced or an operator already typed, once per capture point, and it does not follow links, enumerate a site, or crawl. It identifies itself with a user agent naming Patrol and the rights holder's contact URL, and it does not consult `robots.txt`, because a disallow rule is an instruction to crawlers about indexing and offers no basis for refusing to record a page that is being reported for infringement. The full trade-off, including the contrary posture and why it was rejected, is in "_docs/adr/0018-single-url-evidence-fetch.md_".

That posture rests on three settled points rather than on optimism. Reproducing an infringing page as evidence is a narrow evidentiary use that supports fair use under 17 U.S.C. §107 on the reasoning of *Bond v. Blum*; "exceeds authorized access" under the CFAA is a gates-up-or-down question after *Van Buren v. United States*, and *hiQ Labs v. LinkedIn* treats a public page's `robots.txt` as voluntary rather than a gate. The limits are what keep it there: no password, no IP block, and no challenge is ever circumvented, and a host that sends an individualized objection or blocks Patrol is recorded, excluded from further capture, and surfaced to the operator, since continued access after a personal cease-and-desist is where *Facebook v. Power Ventures* draws the line.

Four ordering rules keep the fetch minimal:

- **Allowlists are checked before the fetch.** A URL matching an allowlist entry becomes a candidate with an allowlist hit and is never fetched, so Patrol does not touch an official domain or a licensed destination at all. The review queue must therefore render allowlist rows without evidence thumbnails.
- **One fetch per URL per capture point.** Deduplication keyed on the normalized URL and the capture point prevents a re-check or a second query from re-fetching the same page.
- **Per-host politeness.** At most one capture per host at a time, with a short spacing between captures of the same host, and no more than a handful of concurrent captures overall, so a thousand URLs on one platform do not become a flood.
- **An individualized objection stops capture.** A host that sends Patrol a cease-and-desist, a block notice, or an abuse complaint naming Patrol has its captures suspended for that host, with the objection recorded and the affected candidates surfaced to the operator; only an operator's explicit decision reopens it.

Evidence never leaves Patrol in v1: recipients receive URLs and statements, not attachments, and any future export to a recipient, a host, or counsel is a separate decision with its own redaction question, since a screenshot can carry third-party advertising and personal data.

## How this lands in the domain model

The `Evidence` row carries the identity, URL, and outcome; artifacts are a child record; and `violation_evidence` and `notice_evidence` are the two citation paths. The HTTP contract exposes a capture on a candidate or a violation, the artifacts as signed download references, and the citation list on a notice; it exposes no mutation of a capture. The TypeSpec model that follows from this lives in the ticket "TypeSpec domain model".

## Open risks

- No provider promises retention, so the evidence chain rests entirely on landing-page captures; a page that is dead before the first capture is a candidate with no evidence and no notice.
- Object Lock is not available on every S3-compatible provider, and MinIO in development offers governance rather than compliance semantics, so immutability in development is weaker than in production.
- Rendered captures are not perfectly reproducible: a page that changes between two captures of the same URL yields a different hash by design, and the capture profile plus the attempt rows are what make the difference explainable.
- A purge is irreversible, and a mistaken window destroys defence material that a legal hold would have preserved.
- A hostile host can serve a different page to Patrol's user agent, which is a reason to keep the raw DOM and the screenshot rather than extraction alone, but is not something the capture can prevent.

## Sources

- "_docs/research/notice-submission.md_" on `research/notice-submission` at `b063eeb`: recipient fields, limits, and acknowledgement signals, including that none requires an attachment.
- "_docs/research/serp-providers.md_" on `research/serp-providers` at `47e79bd`: provider retention clauses and terms.
- "_docs/research/matching-prior-art.md_" on `research/matching-prior-art` at `5327830`: evidence serves the defence, not the notice.
- Recipient policy pages read for the required-element lists: Google Legal Help, Microsoft Legal, and Yandex's Copyright Infringement Policy (effective 2012-12-12), plus Google's Transparency Report FAQ for the treatment of URLs outside its index (accessed 2026-11-03).
- 17 U.S.C. §§107, 507(b), and 512(f); *Warner Chappell Music, Inc. v. Nealy*, No. 22-1078 (U.S. May 9, 2024); *Bond v. Blum*, 317 F.3d 385 (4th Cir. 2003); *Van Buren v. United States*, 141 S. Ct. 1648 (2021); *hiQ Labs, Inc. v. LinkedIn Corp.*, 31 F.4th 1180 (9th Cir. 2022); *Facebook v. Power Ventures*, 844 F.3d 1058 (9th Cir. 2016).
- ГК РФ arts. 196 and 200, and Постановление Пленума ВС РФ № 10 of April 23, 2019, paragraph 55, on screenshots showing the URL and capture time.
- Fed. R. Evid. 902(13)–(14) as amended in 2017, and Fed. R. Civ. P. 37(e) as amended in 2015.
- ISO 28500:2017 (WARC 1.1) and WACZ 1.1.1 for the archival container considered and rejected in "_docs/adr/0016-evidence-is-a-rendered-page-bundle.md_"; Web Almanac 2025 page-weight data for the size estimate.
- Playwright's `Page.goto` and `Page.screenshot` documentation, and the Chromium full-page capture limit, for the readiness policy and screenshot ceiling (accessed 2026-11-03).
- Amazon S3 Object Lock documentation for compliance and governance semantics, including that a delete marker is not protected by retention.
