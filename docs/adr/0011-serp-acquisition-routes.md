# Search results come from a licensed aggregator for Google and the engine's own API for Yandex

Neither Google nor Bing sells a usable search API any more, and scraping any engine breaches its robots.txt and terms by construction, so Patrol buys Google results from DataForSEO at $0.60 per 1,000 and Yandex results from Yandex Search API v2 at $0.25 per 1,000 deferred. Bing is deferred as a discovery engine and reuses the aggregator when it is added. Both routes sit behind one narrow port, so a provider swap is an adapter, not a redesign.

## Considered options

- Owned scraping: cheapest on paper, a standing contract breach in practice, and more expensive once proxy bandwidth and maintenance are counted.
- Manual monitoring only: lawful and free, but gives up the automated coverage the product exists for.
- SerpAPI: a $2 million United States legal shield for lawful collection, at fifteen times the price.
- Bright Data: names copyright enforcement as a use case, but claims the right to retain and reuse the collected data.
- A Yandex aggregator: three to six times the engine's own price with a weaker contract.

## Consequences

- Search-result rows are provenance, never evidence; evidence is the landing-page capture.
- DataForSEO's adverse-use clause is accepted without legal review, which is a recorded risk rather than a settled position.
- A route that fails disables its engine and alerts the operator; there is no silent fallback and no scraping fallback.
- Patrol holds two vendor relationships, two sets of credentials, and two billing balances.
