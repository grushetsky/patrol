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

/** Query parameter names and prefixes that carry no page identity. */
const TRACKED_QUERY_NAMES = new Set(["fbclid", "gclid", "yclid"]);
const TRACKED_QUERY_PREFIX = "utm_";

/** True when a query parameter is tracking noise the key drops. */
function isTrackedParameter(name: string): boolean {
  const lowered = name.toLowerCase();
  return TRACKED_QUERY_NAMES.has(lowered) || lowered.startsWith(TRACKED_QUERY_PREFIX);
}

/** The host plus its explicit port: the design drops only the scheme, so a non-default port is page identity. */
function hostWithPort(url: URL): string {
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  // The URL parser reports "" for an absent port and for the scheme's
  // default (https 443, http 80), so an explicit port is exactly what
  // `port` holds here; everything else needs no suffix.
  return url.port === "" ? host : `${host}:${url.port}`;
}

/** The key a URL deduplicates under. Throws on an unparseable URL. */
export function normalizeUrlKey(raw: string): string {
  const url = new URL(raw);
  const host = hostWithPort(url);
  const path = url.pathname.replace(/\/+$/, "");
  const kept = [...url.searchParams.entries()]
    .filter(([name]) => !isTrackedParameter(name))
    // Sorting by name only; equal names keep their relative order, which is
    // the stable serialization the design's "sorted by name" implies.
    .map(([name, value], index) => ({ name, value, index }))
    .sort((left, right) =>
      left.name === right.name
        ? left.index - right.index
        : left.name < right.name
          ? -1
          : 1,
    );
  // Values re-serialize percent-encoded: searchParams decodes them, and
  // joining the decoded forms would collide `?a=b%26c` (one parameter
  // "b&c") with `?a=b&c=d` (two parameters). encodeURIComponent is
  // injective on the decoded forms, so distinct parameter tuples stay
  // distinct keys. (URLSearchParams reads `+` as a space, so `?a=b+c` and
  // `?a=b%20c` still share a key — they are one value under the parser's
  // form-encoding semantics.)
  const query =
    kept.length === 0
      ? ""
      : `?${kept
          .map(
            ({ name, value }) =>
              `${encodeURIComponent(name)}=${encodeURIComponent(value)}`,
          )
          .join("&")}`;
  return `${host}${path}${query}`;
}

/** The URL's host for matching: lowercased, without a leading `www.`. */
export function hostForUrl(raw: string): string {
  return new URL(raw).hostname.toLowerCase().replace(/^www\./, "");
}
