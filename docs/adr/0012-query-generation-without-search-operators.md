# Query generation never uses search operators

Patrol issues bare-variant and display-title-plus-intent queries and filters allowlisted hosts after matching, rather than excluding official domains inside the query. DataForSEO multiplies the base price by five for each search operator, so one `-site:` on Google turns $0.60 per 1,000 queries into $3.00, while the post-matching filter costs nothing and can express an allowlist scoped to a title group, a tracked title, or a territory, which an operator cannot.

## Considered options

- **`-site:` exclusions for official domains.** Saves review time on authorized copies, at five times the Google price, and still misses every allowed host the operator has not thought of.
- **`site:` on official domains to inventory authorized copies.** Costs the same multiplier and answers a question nobody asked: an authorized copy is allowlisted, not discovered.
- **Quoted variant phrases for precision.** Free on DataForSEO but it drops pages carrying extra tokens, such as a localized release title with a year, so recall falls without lowering cost.

## Consequences

- Every allowlisted host still surfaces as a candidate, and the allowlist suppresses it after matching, so the review queue carries that noise.
- Adding an operator later multiplies Google's bill fivefold and changes every generated query, so this is not a tuning knob.
- Yandex charges per request rather than per operator, and stays operator-free so both engines generate the same plan shape.
