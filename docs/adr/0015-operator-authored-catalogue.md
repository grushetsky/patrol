# The catalogue is operator-authored and deduplicated by identifier, falling back to title-year-type

Patrol stores a hand-keyed catalogue because no metadata source is both lawful and affordable for a commercial rights-holder service: IMDb's free datasets are personal-use only, TMDB needs a written commercial agreement, and KinoPoisk's terms bar commercial use of its site information. The entry field therefore searches the local catalogue for duplicates and Wikidata, which is CC0, for suggestions; it stores only the QID and the values an operator confirms, and it deduplicates by external identifier, falling back to normalized original title, release year, and title type when no identifier is present.

## Considered options

- **A licensed metadata feed.** The best coverage, at a contract, a recurring fee, and a lead time, and it makes the catalogue a projection of a vendor's data rather than the rights holder's own record.
- **KinoPoisk as the reference.** Free and familiar to Russian operators, but clause 6.7 limits use of site information to personal non-commercial purposes, so it cannot feed a commercial catalogue without permission.
- **Purely local search and free text.** No external dependency, and useless on an empty catalogue: no suggestions when entry begins, and no external identity to deduplicate against.
- **Full Wikidata ingestion.** Lawful under CC0, but it would import unconfirmed labels, aliases, years, and types, and turn an optional suggestion source into a metadata dependency.

## Consequences

- Catalogue quality is operator-bound. Entry is a few fields per title, but every title needs a person who knows the work or the rights holder's records.
- Wikidata is a suggestion dependency only. Stored records are snapshots; later Wikidata edits do not propagate, and an unavailable endpoint never blocks entry.
- The record key stays a Patrol-owned UUIDv7, and external identifiers are attributes. A wrong or reassigned identifier is corrected in place rather than re-keying the candidates, violations, and notices that inherit the title.
- Adopting a metadata feed later would mean reconciling hand-made records, not flipping a source. The title record, not an external identifier, is the identity every candidate, violation, and notice inherits.
- The remote lookup carries a contactable `User-Agent` and runs serially, as Wikimedia requires; the endpoint needs no key and charges nothing.
- There is no review state on catalogue records, because the single-tenant model assumes one trusted operator role and a second approval would delay scans without strengthening a fact.
