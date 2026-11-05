# Dashboard and review interface

This document fixes the operator-facing surface of Patrol: the screens, what each one shows, how the review queue is laid out, and what the title chart plots. It records the decisions reachable from the clickable prototype published at <https://grushetsky.github.io/patrol/dashboard-spec/> and built on `prototype/dashboard-spec` from "_prototype/index.html_". The terms are those of "_GLOSSARY.md_".

The prototype is the basis of the dashboard UI, inseparably linked to it: its information architecture, field sets, chart definitions, layout, and visual language carry over into the built interface. The production UI is the prototype's surface implemented in TanStack Start — extended where the build adds screens and behaviour beyond the prototype, and finished for accessibility, responsiveness, and theme support — never replaced by an unrelated design. A deviation from the prototype's layout or visual language requires an explicit justification in this document.

## Shell

Six sections form the interface, each a hash route: Dashboard, Review, Violations, Notices, Titles, and Settings. The tab bar holds the first five; Settings is reached from the footer. Review, Violations, and Notices carry a badge with their pending count, where pending is candidates awaiting review, open violations, and draft notices respectively.

A persistent top bar holds the section tabs, the language switch, the theme toggle, and Run scans. The footer carries Settings and the reset control.

## Language

The interface ships in English and Russian. The top bar's switch changes the language, the choice persists on the operator's account, and a visit before any choice follows the browser's language with English as the fallback.

Every operator-facing string exists in both languages: the screens, validation and error messages, alerts, invitation and reset emails, and the handoff checklist. Two kinds of text never translate: recipient-facing notice content, which reproduces the recipient's form language verbatim, and catalogue values, which keep the native title strings. The operator-facing checklist in a frozen pack keeps the approving operator's language at approval. Tests and screenshots fix English.

## Dashboard

The dashboard answers three questions in one screen: what is open, what needs a decision, and how the tracked catalogue is trending.

- Four counters lead the page: open violations, candidates to review, notices on file, and acknowledged submissions.
- An engine row shows Google, Bing, and Yandex with a quota badge on an engine whose allowance is exhausted.
- A five-entry activity feed lists the latest scans, review decisions, approvals, and acknowledgements, each with a relative time and a link to Notices.
- The title chart occupies the main panel, with its definition below.

## Title chart

The chart plots title counts over time, one metric at a time. The metric tabs are Tracked titles, Titles with violations, and Resolved violations; the window switches between 7, 14, and 30 days ending today, defaulting to 14. The series selector groups by no grouping (a single total), title group, engine, or recipient.

| Metric | What a day counts | Applicable groupings |
| --- | --- | --- |
| Tracked titles | Every tracked title that is not paused on that day. It is a step count, not a daily event. | None, title group. |
| Titles with violations | Each tracked title once per day when it has at least one open violation on that day, where open means detected on or before the day and not resolved on or before it. Grouped by engine, a title counts once per engine, so the series can sum above the total. | None, title group, engine. |
| Resolved violations | Violations that left the open state on that day. | None, title group, engine, recipient. |

Recipient grouping applies only to resolved violations, and engine grouping applies only to violations and resolutions. Selecting an inapplicable grouping falls back to the total and shows a hint rather than an empty chart.

Resolved has two bases: Removed + closed, the default, and Closed only. Removed means the URL stopped serving the copy; closed means an operator closed the violation after a re-check. A closed violation is never reopened, and a reappearing URL starts a new violation.

The plot's vertical axis auto-scales to four equal ticks on a 1, 2, or 5 step above the series maximum. The horizontal axis labels the first day, the middle day, and the last day, where the last day reads Today and earlier labels read `n d ago`. A single series is drawn as a filled area; multiple series are drawn as lines with a legend. Selecting a day draws a vertical guide and shows every series value for that day in an inspector under the plot.

Three tiles summarise the selected metric: for tracked titles, the current count, the paused count, and the group count; for titles with violations, the count today, the groups affected today, and the peak in the window; for resolved violations, the total in the window, the removed count, and the closed count.

## Review queue

The queue defaults to dense rows, with a card layout kept as an alternative for comparison. Each row exposes what an operator needs to judge a candidate without opening it:

| Column | Content |
| --- | --- |
| Score | The numeric score out of one, the component formula behind it, and a bar. |
| Tracked title | The tracked title and year, the matched title variant, and the variant's kind, language, script, and territory. |
| URL | The requested URL, the final URL when it differs, the host, and the registrable domain. |
| Source | The engine, rank, query, locale, and territory. |
| Evidence | The evidence identifier, its hash, and its capture time. |
| Flags | The allowlist entry and kind when one matches, the host reputation count and bonus, and the latest prior decision. |
| Actions | Confirm, Dismiss, and a menu holding Wrong work, Authorized here, and Page dead. |

Rows are ordered by score descending, then SERP rank ascending, then observation time descending, as fixed by "_docs/design/matching-and-classification-rules.md_". An allowlist hit shows the matching entry and disables Confirm; the other rows show a screenshot thumbnail, the capture time, and the latest capture outcome in the card layout. A row whose newest capture is dead stays in the queue with that outcome visible, because handoff flags it rather than dropping the violation silently.

## Violations

Violations are grouped by tracked title, each group heading showing the open count against the total. A title filter narrows the list. Each violation row shows its host, URL, evidence identifier, and status: open, removed, or in a notice. A violation already attached to a notice cannot be selected again.

Selecting open violations opens a cart fixed at the bottom of the page with the count, a recipient selector, and Draft notice. The cart is the only path from violations to a draft.

## Notices

Each notice is a card showing its identifier, recipient, violation count, signatory, drafting time, and a status chip: draft, approved, delivered, or acknowledged. A stepper renders the same lifecycle as Draft, Approved, Delivered, and Acknowledged.

Actions follow the state: a draft offers Approve, an approved notice without a submission offers Send, a pending submission shows a spinner, and View opens the composed document. The document shows the recipient, the works with their evidence citations, the claimant, the signatory, and the signed statement.

## Titles

Tracked titles render as cards with the display title, year, title group, variant count, external identifier, allowlist count, and an active or paused switch. The screen's add action opens a fuzzy catalogue search, which per "_docs/design/catalogue-entry.md_" searches the local catalogue and Wikidata and pre-fills only the Wikidata QID and the matched label as a search-language variant.

## Settings

Settings is a table of allowlist entries with columns for kind, value, scope, territory, and source, plus a removal action per row. An add form beneath it takes the kind (official domain, licensed destination, or neutral source), the value, the scope (rights holder, title group, or tracked title), the scope target, and an optional territory that defaults to every territory.

## States

The prototype bar switches the interface among four states, which fixes how each screen degrades:

- Normal is the seeded demo.
- Loading replaces the review table with three skeleton rows and the chart with a skeleton panel, keeping the page chrome.
- Quota exhausted marks the spent engine, shows the per-engine banner, and leaves the other engines scanning; one exhausted engine never blocks the others.
- Empty removes candidates, violations, and notices, and each screen shows an empty explanation with its primary action: Run scans on Review, Go to review on Violations, and Open violations on Notices.

Dialogs cover evidence detail, candidate evidence, the composed notice, and catalogue import. Destructive or state-changing actions raise a toast confirming the new state.

## Deliberately not specified

- The DeepSeek brief card, the siren toggle, and the prototype-state bar are demonstration aids. None is adopted by this design.
- The KinoPoisk import was a prototype shortcut and is superseded by the catalogue entry decision: the add path searches the local catalogue and Wikidata, and KinoPoisk is not a browsing reference.
- Breakpoints, spacing, and the component library's theme tokens are left to the build effort, constrained by `shadcn/ui` and TanStack Start conventions.
