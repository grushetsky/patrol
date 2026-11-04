# The HTTP contract is one service spanning separate domain and HTTP namespaces

TypeSpec is the single source for the domain and the API, but the two have different consumers: the JSON Schema bundle validates domain records on the server, while the OpenAPI document drives the generated client and the route validators. Patrol therefore declares one `@service` on `Patrol` and keeps the models in `Patrol.Domain` and the routes and HTTP models in `Patrol.Http`. The emitter writes one OpenAPI document and one JSON Schema bundle, and `@statusCode` never reaches a domain validator.

## Considered options

- **Two `@service` namespaces, one per side.** Gives each document its own name and keeps component names short, but the emitter writes two OpenAPI documents, fully qualifies every cross-service reference, and forces a client generator or a hand-written merge step to combine them.
- **One namespace holding both models and routes.** Simplest source layout and the shortest component names, but response wrappers with `@statusCode` and route-only read models land in the domain bundle, so a domain validator can require a status field that a domain record never carries.
- **A hand-written OpenAPI document beside the TypeSpec model.** Removes the emitter gap from the critical path, and replaces the contract's single source with two artifacts that drift.

## Consequences

Component names carry their namespace (`Domain.TrackedTitle`, `Http.ReviewDecisionRequest`), so a client generator must not assume bare names. HTTP unions emit as `anyOf` without OpenAPI `discriminator` metadata, because the JSON Schema emitter ignores `@discriminated`; clients narrow on the literal discriminator property. The JSON Schema bundle also carries parameter models (`CsrfToken`, `PageRequest`), which a validator ignores because it looks definitions up by `$id`. The pipeline is verified in "_contract/HTTP.md_".
