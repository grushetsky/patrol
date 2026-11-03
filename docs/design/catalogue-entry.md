# Catalogue entry

Titles enter Patrol only when an operator types them. There is no scraping, vendor API, bulk import, or licensed feed, so the entry surface carries the whole catalogue and the domain model must record what a person entered and where it came from. This document fixes the entry behaviour, the field set, the duplicate rule, and the provenance fields; licensing is settled by the ticket "Manual catalogue entry: what may be stored and referenced", and matching normalization by "_docs/design/matching-and-classification-rules.md_". The terms are those of "_GLOSSARY.md_".

## The entry surface

The "Add title" field searches two indexes and presents one ranked list.

- **The local catalogue** covers every variant of every tracked title, across every title group, so a duplicate is caught before another record exists. A suggestion shows the display title, release year, title type, title group, and the matched variant with its kind and language. Selecting it opens the existing title and offers "Add as variant"; it never starts a new title.
- **Wikidata** supplies entity suggestions through `wbsearchentities`, searched in the title group's locales with `type=item` and a limit of ten. A suggestion shows the label, the entity description, the QID, and the matched alias with its language. Selecting it pre-fills the QID and the matched label as a variant in the search language; it does not seed the original title, the year, or the type, because a label and a free-text description are not those facts. A second read of the selected entity may offer its `P345` and `P2603` claims as IMDb and KinoPoisk identifier suggestions, sourced `wikidata`; nothing is stored until the operator saves.
- **Free text** is always offered as "Create '<text>'". The operator can ignore every suggestion and create a title from what the rights holder supplied.

The remote lookup starts after three characters and a 300 ms pause, runs serially, and carries a contactable `User-Agent`; Wikidata requires identification and states no hard read limit. There is no API key and no fee, and no suggestion writes a catalogue record; only the operator's save does. When Wikidata is unreachable, local suggestions and free-text creation still work, so entry never depends on the network.

The field accepts one title per save. A multi-line paste is rejected rather than split, because splitting it would be a bulk import by another name.

## What the operator enters

| Field | Required | Rule |
| --- | --- | --- |
| Title group | Yes | The one group the title belongs to; it supplies the scan locales and the allowlist scope. |
| Original-title variant | Yes | The title in its original language, with language and script; it is the display title. |
| Additional variants | No | Localized, transliterated, or alternate names, each with language, script, and an optional territory. |
| Release year | Yes | Four-digit year of first release; for a series, the year of the first season's first episode. |
| Title type | Yes | `film`, `series`, `miniseries`, or `other`. |
| Runtime | No | Minutes; for a series, the typical episode runtime. It feeds the `duration` signal and contributes nothing when absent. |
| External identifiers | No | Zero or more of `wikidata`, `imdb`, and `kinopoisk`, each unique per title. |
| Source | Yes | `rights_holder_record`, `operator_knowledge`, or `wikidata`, describing where the original title, year, and type came from. |

**The record key is Patrol's own.** Every tracked title is keyed by a UUIDv7, never by an external identifier; an identifier is an attribute, so a wrong or reassigned value is corrected without re-keying the candidates, violations, and notices that inherit the title.

**The canonical title is not a separate field.** The original-title variant is the canonical label and the display title, as the glossary invariant requires; the model stores no second operator-entered canonical string. The key used for matching is derived from variant text by the normalization rules in "_docs/design/matching-and-classification-rules.md_" and is never typed or stored as a title.

**External identifiers are facts, not lookups.** The accepted shapes are a Wikidata QID (`Q` followed by digits), an IMDb id (`tt` followed by at least seven digits), and a KinoPoisk id (digits). Each carries its own source and retrieval time. A KinoPoisk id is lawful as a fact, preferably read from Wikidata's CC0 `P2603` statement; no KinoPoisk page is fetched, embedded, previewed, or screenshotted during entry. TMDB is not an accepted scheme, because commercial use needs a written agreement and the id buys nothing dedupe or matching does not already have.

**The catalogue stops at the work.** Seasons, episodes, cast, genres, artwork, synopses, ratings, and reviews are not fields. Discovery pairs a URL with a tracked title, and matching reads the page; storing that material would require the licensed feed this route exists to avoid.

## Provenance

| Record | Fields |
| --- | --- |
| Tracked title | `enteredBy`, `enteredAt`, `source`, `updatedBy`, `updatedAt` |
| Title variant | `source`, `addedBy`, `addedAt` |
| External identifier | `source`, `retrievedAt` |

`source` is one of `rights_holder_record`, `operator_knowledge`, or `wikidata`. On the title it names where the operator got the original title, year, and type when they share an origin; a value from another origin is recorded on the variant or identifier that carries it. Variant and identifier provenance is recorded per row because one title can mix them: a QID selected from Wikidata, a Russian variant typed by the operator, and a year copied from the rights holder's release schedule.

There is no review state. A title is scannable as soon as it is saved, because a catalogue record is configuration, not evidence or a legal claim, and the single-tenant operator who enters it is the reviewer. Approval states remain where they carry weight: a review decision confirms a violation, and an operator approves a notice. A correction is a direct edit that records the editor and the time; no draft state stands between the operator and the scan.

KinoPoisk is not a source value. Its agreement limits use of site information to personal non-commercial purposes, so an operator may not read values from its pages for this catalogue; a KinoPoisk identifier reaches Patrol as a fact from Wikidata or from knowledge the operator already holds, never from a KinoPoisk page read during entry.

## Duplicate and near-duplicate handling

Text comparison reuses the matching normalization: NFKC, full case fold, diacritic folding that keeps the native string, punctuation and whitespace collapse, a per-language article-less key, and a declared transliteration scheme. Native strings are never overwritten.

Two hard checks run before a title is created, across every title group, in this order:

1. **External identifier equality.** A supplied `(scheme, value)` that already exists identifies that title, whatever its text says.
2. **Identity triple, when no identifier is supplied.** The same normalized original-title text, release year, and title type identify the same work.

Either check blocks creation and opens the matching title. The operator resolves it by adding the new name as a variant there, or by correcting the existing record when the identifier or the year was wrong; the block is never overridden by pressing create again. A same-named remake, adaptation, or different work with another year or type passes the check and is created as its own title.

A variant joins an existing title only through "Add as variant" on that title. Its text must be unique within the title after normalization. Adding a variant warns when its normalized text already appears on another title with the same year and type, but the operator decides; Patrol never merges two records silently. Near-duplicate suggestions are advisory, and no similarity score creates, blocks, or merges a record on its own.

A merge is offered only while the duplicate has no candidate and no violation. It moves the duplicate's variants and identifiers to the surviving title and archives the duplicate with a `mergedInto` pointer for audit. A duplicate that already has candidates is cleaned up first by resolving them as "wrong work"; a duplicate that has any violation is never merged, because a violation is keyed by its URL and tracked title, and that identity is permanent.

## Rejected routes

- **A licensed metadata feed.** The best field coverage, at a contract and a recurring fee, and it would make the catalogue a projection of a vendor's data rather than the rights holder's own record.
- **KinoPoisk as the browsing reference.** Its purpose clause reaches commercial use however the value is entered, which the licensing research records; a KinoPoisk identifier is still storable as a fact.
- **Local search only.** The catalogue is empty on day one, so the field would suggest nothing when help matters most, and it would offer no external identity for dedupe.
- **Full Wikidata ingestion.** CC0 makes it lawful, but importing labels, aliases, years, and types wholesale would replace operator-confirmed facts with uneven community data and turn an optional suggestion into a metadata dependency.
- **Auto-creating the first suggestion.** Fast, and a reliable way to create the wrong work, the wrong original title, and a duplicate the next operator must merge.
- **A review state on catalogue records.** A second-operator approval is not available in a deployment with one operator, and it would delay scans without strengthening a fact the rights holder already owns.
