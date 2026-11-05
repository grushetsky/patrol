/**
 * The URL deduplication key (docs/design/query-strategy.md "URL identity",
 * GLOSSARY "Normalized URL"). The rules, in the design's order:
 *
 * | Component | Rule |
 * | --- | --- |
 * | Scheme | Dropped, so `http` and `https` twins collapse. |
 * | Host | Lowercased, with a leading `www.` dropped for the key only. An explicit non-default port stays: the design drops only the scheme. |
 * | Path | Trailing slash trimmed. |
 * | Query parameters | `utm_*`, `fbclid`, `gclid`, and `yclid` removed, the rest sorted by name. |
 * | Fragment | Dropped. |
 *
 * The key never replaces the raw URL Patrol displays or submits; every raw
 * string is retained verbatim and the key is derived on demand.
 */
/** The key a URL deduplicates under. Throws on an unparseable URL. */
export declare function normalizeUrlKey(raw: string): string;
/** The URL's host for matching: lowercased, without a leading `www.`. */
export declare function hostForUrl(raw: string): string;
/**
 * The host's registrable domain: the public suffix plus one label. This is
 * the grouping reputation and reporting aggregate over; it is derived, so
 * the stored host is never overwritten.
 */
export declare function registrableDomainFor(host: string): string;
/** The registrable domain of a URL's host, derived from the raw string. */
export declare function registrableDomainForUrl(raw: string): string;
