# Patrol

Tracks one rights holder's titles across search-engine results, records unauthorized copies as violations with immutable evidence, and submits notices to Google, Bing, and Yandex. This glossary is the canonical vocabulary for the domain model; every ticket and the TypeSpec model use these terms unchanged.

## Language

### Rights and actors

**Rights holder** (`RightsHolder`):
The legal person on whose behalf Patrol identifies violations and signs notices. Exactly one exists per deployment.
_Avoid_: Tenant, customer, client, account.

**Operator** (`Operator`):
An authenticated human who reviews candidates, approves notices, and makes submissions.
_Avoid_: User, admin, account holder.

**Signatory** (`Signatory`):
The natural person authorised to sign notices for the rights holder. It is held in the rights holder's settings and snapshotted into each notice at approval.
_Avoid_: Signer, representative, account.

### Catalogue and scope

**Tracked title** (`TrackedTitle`):
A work the rights holder monitors, carrying its canonical and original titles, year, runtime, external identifiers, and title variants.
_Avoid_: Work, title, content, asset, movie.

**Title variant** (`TitleVariant`):
A recorded string by which a tracked title is known, typed by kind, language, script, and territory. Exactly one variant of a tracked title is its original title and serves as the display title.
_Avoid_: Alias, alternative title, aka.

**Title group** (`TitleGroup`):
An operator-defined set of tracked titles that share scan settings and allowlist scope. Every tracked title belongs to exactly one group.
_Avoid_: Collection, catalogue, franchise, bundle.

**Allowlist entry** (`AllowlistEntry`):
A scoped rule that marks a host or URL prefix as authorized or non-infringing. Its kind is an official domain, a licensed destination, or a neutral source, and its scope is the rights holder, a title group, or a tracked title.
_Avoid_: Whitelist, exception, official domain (as an entity).

### Geography

**Locale** (`Locale`):
A BCP 47 language tag with an optional territory, such as `ru-RU`, used to generate queries and to attribute results.
_Avoid_: Language, country, market.

**Territory** (`Territory`):
An ISO 3166-1 alpha-2 region used when a rule applies to a country rather than a language.
_Avoid_: Country, market, region.

### Discovery

**Engine** (`Engine`):
A search source that returns results for a query. The engines are Google, Bing, and Yandex.
_Avoid_: Provider, search API, recipient.

**Scan** (`Scan`):
One execution of discovery for one title group on one engine, triggered by schedule or by an operator.
_Avoid_: Crawl, sweep, job, run.

**Search query** (`SearchQuery`):
One query issued inside a scan, generated from a title variant for one tracked title and one locale.
_Avoid_: Query, keyword, search term.

**Query plan** (`QueryPlan`):
The set of search queries one scan issues for one title group on one engine, derived when the scan starts.
_Avoid_: Query set, query batch, keyword list, search strategy.

**Search result** (`SearchResult`):
One ranked row returned for a search query, recording URL, rank, title, snippet, and observation time.
_Avoid_: Hit, listing, SERP row.

**Candidate** (`Candidate`):
A URL paired with one tracked title, surfaced by at least one search result, that has not been confirmed as a violation.
_Avoid_: Hit, match, lead, finding.

**Review decision** (`ReviewDecision`):
An operator's disposition of a candidate: a violation, not a violation, wrong work, authorized here, or page dead.
_Avoid_: Resolution, verdict, label.

### Violations and evidence

**Violation** (`Violation`):
A confirmed unauthorized copy of one tracked title, located by the search-result URL that surfaced it and hosted at the landing page it resolves to.
_Avoid_: Infringement, hit, match, takedown.

**Host** (`Host`):
The full hostname that serves the copy, derived from the landing page's final URL after redirects.
_Avoid_: Domain, site.

**Registrable domain** (`RegistrableDomain`):
The eTLD+1 grouping of a host, used to aggregate reputation and reporting across subdomains.
_Avoid_: Root domain, base domain, apex domain.

**Evidence** (`Evidence`):
An immutable, content-addressed record of what a URL served at one capture time. Evidence is captured per URL and shared by every violation that cites that URL.
_Avoid_: Capture, snapshot, artefact, proof.

### Notices and submission

**Recipient** (`Recipient`):
An organisation to which Patrol submits notices. The recipients are Google, Bing, and Yandex.
_Avoid_: Target, addressee, engine, platform.

**Recipient profile** (`RecipientProfile`):
The configuration for one recipient's submission channel: its channel, required fields, limits, account, eligibility, and composition trigger.
_Avoid_: Adapter, integration, connector.

**Notice** (`Notice`):
An immutable document addressed to one recipient, claiming one or more violations of one rights holder, with the required statements and the signatory's attestation captured at approval.
_Avoid_: Takedown, DMCA request, complaint, claim.

**Submission** (`Submission`):
One delivery attempt of an approved notice through a recipient's channel, performed by an operator and recording that operator, the time, and the recipient's response.
_Avoid_: Delivery, send, filing.

## Lifecycle

The journey from discovery to closure crosses four lifecycle records rather than one status field; a scan records the execution that produces their search results.

| Record | States |
|---|---|
| Scan | Queued, Running, Succeeded, Partial, Failed |
| Candidate | Pending, Confirmed, Dismissed |
| Violation | Open, Removed, Closed |
| Notice | Draft, Approved, Withdrawn, Superseded |
| Submission | Pending, Delivered, Acknowledged, Rejected, Failed |

## Invariants

- Exactly one rights holder exists per deployment, and every notice names it.
- Every tracked title belongs to exactly one title group.
- Every title group declares at least one locale.
- Every tracked title has exactly one original-title variant, and that variant is its display title.
- A violation belongs to exactly one tracked title and exactly one host.
- A violation's host comes from its destination URL; the submitted URL and the full redirect chain are retained.
- A page that hosts several tracked titles yields one violation per title; those violations share one evidence record per capture.
- A violation is created only from a candidate confirmed by a review decision.
- At most one open violation exists for a given URL and tracked title. A URL that reappears after removal starts a new violation linked to its predecessor; the closed violation is never reopened.
- An allowlist hit prevents a candidate from being confirmed, regardless of score.
- A notice cites one or more violations of exactly one rights holder and is addressed to exactly one recipient.
- A notice records exactly one signatory at approval.
- A submission cites exactly one approved notice. An approved notice is never edited; a change supersedes it with a new notice.
- A submission is performed by an operator; no scheduled process delivers a notice to a recipient.
- A notice is handed off only under a recipient profile that is eligible for the rights holder's territory.
- A scan targets exactly one title group and exactly one engine; a notice targets exactly one recipient.
- A search result is never edited; a candidate deduplicates results across queries and engines.
- Evidence is immutable. A later capture is a new evidence record and never replaces an earlier one.
