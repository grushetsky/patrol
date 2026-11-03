# A dismissal suppresses one URL and tracked-title pair

A review decision dismisses a candidate, not a host or a page. Patrol keys suppression by the URL and the tracked title, records the decision, actor, time, and note, and re-surfaces the pair only when an operator reopens it or a material change appears: a strong signal that was absent at dismissal, an expanded episode range, or a different landing registrable domain. A page that hosts several titles therefore keeps its decisions separate, and a dead page that revives is caught.

## Considered options

- Suppress the URL for every title: fewer records, but hides a second work on the same page.
- Suppress the registrable domain on a not-a-violation decision: quieter queue, but hides real copies on shared hosts.
- No suppression: nothing is missed, but the same dismissed page returns every scan.

## Consequences

Dismissals accumulate per pair, and the review queue must show prior decisions so an operator sees why a pair was dismissed. A wrong-work decision re-matches rather than suppressing the correct title.
