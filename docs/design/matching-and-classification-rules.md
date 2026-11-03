# Matching and classification rules

Patrol turns a search result into a candidate, scores the candidate, and routes it to a human review decision. This document fixes the rules, thresholds, and invariants; the terms are those of "_GLOSSARY.md_".

## Candidate formation

- A search result creates a candidate by pairing its URL with the tracked title whose variant generated the query.
- Candidates deduplicate across queries and engines by (URL, tracked title). Each observation adds its engine, query, locale, rank, and observation time to the candidate.
- A manual URL entry creates a candidate with source `manual`, no engine, and the operator as actor; the operator selects the tracked title.
- A candidate records the matched variant, its kind, language, script, and territory.

## Title match

Normalization follows published standards, not ad hoc regexes: NFKC, full case fold, diacritic folding that retains the original string, punctuation and whitespace collapse, an article-less key per language, and a declared transliteration scheme. The native string is never overwritten.

| Match | Score | Definition |
| --- | --- | --- |
| Exact variant | 0.70 | The normalized variant equals the normalized page title, `h1`, or structured-data name, or occurs there as a complete token sequence. |
| Partial or slug | 0.60 | The variant occurs in the URL slug, or as a substring with extra tokens in the title or `h1`. |
| None | 0.00 | No variant occurs on the page. |

A machine translation of a title is never a match; only catalogue-provided localized variants are.

## Strong signals

Signals are extracted from the captured page, never from the SERP snippet. A signal that cannot be evaluated, such as duration when the catalogue has no runtime, contributes nothing.

| Signal | Definition |
| --- | --- |
| `player` | A `VideoObject` `contentUrl` or `embedUrl`, or a player iframe, pointing at a host with at least one confirmed violation in the last 12 months or on a blocklist, with a title variant on the page. |
| `duration` | A declared duration within ±10% of the tracked title's runtime. |
| `download` | An explicit download affordance: a `.torrent` or `magnet:` link, a `.mkv` or `.mp4` link, a file size, or a resolution paired with a release-source token. |
| `release` | A `CAM`, `TELESYNC`, `TELECINE`, or `WORKPRINT` token for a title not yet released in the candidate's territory, or released there within 30 days. |
| `episodes` | An episode selector listing most or all episodes of a season with per-episode player links. |

The first strong signal adds 0.25 to the score; each additional signal adds 0.05, capped at 0.30. A strong signal without a title match therefore cannot reach the approval band.

## Score and bands

The score is `min(1, title + signals + reputation)`. The title contribution is 0.70 for an exact variant, 0.60 for a partial or slug match, and 0.00 for none. Reputation is keyed by registrable domain and counts confirmed violations in the last 12 months:

| Confirmed violations | Reputation bonus |
| --- | --- |
| 1–2 | 0.02 |
| 3–9 | 0.05 |
| 10 or more | 0.10 |

A blocklist hit adds 0.02, and the total reputation contribution is capped at 0.10.

| Band | Score | Action |
| --- | --- | --- |
| A | 0.95 or above | Approval queue: one-click approve, still recorded as a review decision. |
| B | 0.70 to 0.949 | Review queue: full evidence before a decision. |
| C | Below 0.70 | Suppressed and logged; no notice path. |

Band boundaries are configurable per engine, with 0.95 and 0.70 as the defaults. Reputation is shown as its own score component and never confirms or promotes a candidate on its own; it only adds to the sum. An allowlist hit suppresses the candidate regardless of score.

No score confirms a violation. Every violation is created from a review decision recorded by an operator; band A exists to make that decision one click, not to remove it.

## Review decisions

| Action | Review decision | Effect |
| --- | --- | --- |
| Confirm | Violation | The candidate becomes confirmed and a violation is created. |
| Not a violation | Not a violation | The candidate is dismissed; the pair is suppressed until a material change. |
| Wrong work | Wrong work | The candidate is dismissed for this title and re-matched to the correct tracked title. |
| Authorized here | Authorized here | The candidate is dismissed and a scoped allowlist entry is proposed. |
| Page dead | Page dead | The candidate is dismissed; the pair reopens when the URL serves content again. |

Every decision records the operator, the time, the note, and the evidence it relied on.

## Allowlist

An allowlist entry has a kind, a scope, and an optional territory:

- **Kind:** official domain, licensed destination, or neutral source.
- **Scope:** the rights holder, a title group, or a tracked title.
- **Territory:** an ISO 3166-1 alpha-2 code required for a licensed destination, or `*` for worldwide; official domains and neutral sources ignore it.

Precedence runs from the rights holder's official domains, to global neutral sources, to learned entries, to reputation blocklists. A blocklist is not an allowlist entry and never vetoes a per-URL match; it only feeds reputation.

Learning proposes entries and an operator confirms them. An `authorized_here` decision pre-fills a licensed destination entry scoped to the candidate's tracked title or title group and the candidate's territory. Three consecutive `not_a_violation` decisions on the same registrable domain within 90 days propose a neutral host entry. Nothing is added silently.

An allowlist hit routes the candidate to an allowlist review task, where the operator can correct or remove the entry; it never routes to a notice.

## Dismissal and reopening

A dismissal records the URL, tracked title, review decision, operator, time, note, and the evidence it relied on. It suppresses that (URL, tracked title) pair only.

The pair returns as a candidate when an operator reopens it, or when a new capture shows a material change: a strong signal that was absent at dismissal, an expanded episode range, or a different landing registrable domain. A `page_dead` pair reopens when a capture returns a successful response with content. A `wrong_work` pair stays dismissed for the wrong title while the correct title is matched. An `authorized_here` pair stays dismissed while the allowlist proposal is pending.

## Hosts and reputation

Redirects are resolved before capture, and the requested URL, the full redirect chain, and the final URL are recorded. A violation's host is the final URL's host.

Reputation aggregates at the registrable domain, so subdomains share it. A shortener host never earns reputation and never hosts a violation; if a shortener does not resolve to a landing page, the candidate is suppressed for lack of evidence. A blocklist entry raises the reputation contribution but cannot replace a per-URL match.

## Review queue

The queue orders by score descending, then SERP rank ascending, then observation time descending. Each row shows:

- The matched variant and its kind, language, script, and territory.
- The tracked title, engine, query, locale, territory, and SERP rank.
- The requested URL, final URL, host, and registrable domain.
- The score and its components: title match, each strong signal, and reputation.
- Evidence thumbnails and links: screenshot, captured HTML hash, and capture time.
- Allowlist status with the matching entry's kind and scope.
- Host reputation and the pair's prior review decisions.

## Invariants

1. A violation is created only from a candidate confirmed by a review decision; no score confirms a violation.
2. An allowlist hit prevents confirmation regardless of score and routes to allowlist review.
3. The score is the sum of title match, strong signals, and reputation, capped at 1.0.
4. Reputation alone never confirms or promotes a candidate; it adds at most 0.10.
5. A dismissal suppresses one (URL, tracked title) pair and no other.
6. A dismissed pair returns only on an operator reopen or a material change.
7. A violation's host is the landing page host after redirects; a shortener host never hosts a violation.
8. Reputation aggregates at the registrable domain.
9. Allowlist entries are proposed by review decisions and confirmed by an operator; no entry is created silently.
10. Every score component is recorded with the candidate so a decision can be reproduced.
