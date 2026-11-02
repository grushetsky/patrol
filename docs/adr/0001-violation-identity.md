# Violation identity is a URL and a tracked title

A page can host several tracked titles, and every notice identifies works individually. Patrol therefore keys a violation by the search-result URL and one tracked title: a page hosting N tracked titles yields N violations, which share the page's evidence. A URL that reappears after removal creates a new violation linked to its predecessor, and the closed record is never reopened, because submitted notices and evidence are immutable.

## Considered options

- A URL-scoped violation with a set of titles: fewer records, but no per-title lifecycle or per-title notice line, and removal of one work could not be tracked separately.
- Reopening the closed violation: simple identity, but rewrites the state a submitted notice already relied on.

## Consequences

Removal is verified per title, so one page can be partly resolved. Reappearance history is a chain of violations rather than a counter on one record.
