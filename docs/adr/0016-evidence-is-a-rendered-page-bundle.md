# Evidence is a rendered page bundle captured at three points

A violation is confirmed by a person looking at a page and cited in a notice months later, so the record must show what the page served, not what the search result claimed. Patrol therefore captures the redirect chain, the final URL and host, the response headers without credentials, the rendered DOM, a full-page screenshot with a viewport thumbnail, an extraction sidecar, and the capture profile, hashing each artifact with SHA-256 and keying the bytes by that hash. A capture carries one reason — `detection` when a candidate forms, `review` when an operator opens a candidate whose live capture is over 24 hours old, and `pre_handoff` when a notice is approved whose live capture is over 7 days old — and one outcome: `captured`, `dead`, `blocked`, or `error`, with `blocked` and `error` retried three times and `dead` recorded as final.

## Considered options

- **Raw HTTP response only**: cheapest, but strong signals such as an injected player iframe exist only after JavaScript runs, so the reviewer would be judging a page Patrol cannot see.
- **A WACZ archive per capture**: the standard replayable container, with a CDXJ index and a hash manifest, at roughly 2–3 MB median and 9–12 MB at the tail because it stores every subresource. Its replay value is real for archiving and unused here: neither recipient nor reviewer path replays a page, and each WARC record embeds a timestamp and a record id that defeat the byte-level deduplication that makes repeat captures of an unchanged page nearly free.
- **Capture at detection only**: one artifact per URL, but a reviewer may then confirm a page whose player vanished a week earlier, and a notice may cite a page with no recent observation.
- **One capture per violation rather than per URL**: duplicates bytes and lets the same page drift into two contradictory records, which "_docs/adr/0002-evidence-per-url.md_" already rejects.

## Consequences

- A bundle costs roughly one page's bytes: text and DOM in the tens of kilobytes, a full-page PNG of a few megabytes, deduplicated by hash across captures that did not change.
- The response body keeps the record honest about what the host served, while the rendered DOM and the screenshot show what a visitor and a reviewer saw.
- Evidence is page-level and shared; a page hosting several tracked titles yields one capture cited by several violations.
- A dead page is evidence of absence and is retained and flagged, never deleted or dropped from a notice, because Google accepts URLs it does not index and a truthful notice about a page that has since gone is still truthful.
- Captures are bounded by navigation, total, DOM, and screenshot ceilings, so a hostile page cannot exhaust the worker and truncation is always flagged.
- Page media is never downloaded or hashed: fingerprinting is out of scope, and the screenshot is stored as the page's appearance rather than as a fingerprint of the work.
- Search-result pages are never captured; result rows stay provenance under "_docs/adr/0011-serp-acquisition-routes.md_".
