/**
 * The Wikidata proxy behind the add-title field (docs/design/
 * catalogue-entry.md "The entry surface"). Wikidata supplies entity
 * suggestions through `wbsearchentities`, searched in the title group's
 * locales with `type=item` and a limit of ten; a second read of a selected
 * entity may offer its `P345` and `P2603` claims as IMDb and KinoPoisk
 * identifier suggestions. Nothing here writes a catalogue record; only the
 * operator's save does.
 *
 * The remote lookup starts after three characters and a 300 ms pause —
 * client behaviour the server never re-implements; the server enforces only
 * the documented request limits (serial requests, contactable User-Agent,
 * limit ten). Requests run serially: one upstream request per API call,
 * never a fan-out. An unreachable or failing upstream raises
 * WikidataUnavailableError, which the routes map onto 503
 * upstream_unavailable; local suggestions and free-text creation never
 * depend on this module.
 */

export interface WikidataDeps {
  /** The MediaWiki API origin, injectable for tests and staging isolation. */
  origin: string;
  /** A contactable User-Agent; Wikidata requires identification. */
  userAgent: string;
  /** How long one upstream request may take. */
  timeoutMs: number;
  /** The fetch implementation, overridable in tests. */
  fetch?: typeof fetch;
}

export interface WikidataSuggestion {
  qid: string;
  label: string;
  description?: string;
  matchedAlias?: string;
  matchedAliasLanguage?: string;
}

export interface WikidataIdentifierFact {
  scheme: "imdb" | "kinopoisk";
  value: string;
  property: string;
}

export interface WikidataEntity {
  qid: string;
  label: string;
  description?: string;
  identifiers: WikidataIdentifierFact[];
}

/** Raised when Wikidata cannot be reached or answers unusably. */
export class WikidataUnavailableError extends Error {
  constructor(cause: unknown) {
    super(`wikidata unavailable: ${String(cause)}`);
    this.name = "WikidataUnavailableError";
  }
}

/** The maximum suggestion count the design fixes. */
export const WIKIDATA_SUGGESTION_LIMIT = 10;

async function callWikidata(
  deps: WikidataDeps,
  params: Record<string, string>,
): Promise<unknown> {
  const query = new URLSearchParams({
    format: "json",
    origin: "*",
    ...params,
  });
  let response: Response;
  try {
    response = await (deps.fetch ?? fetch)(`${deps.origin}/w/api.php?${query}`, {
      headers: { "user-agent": deps.userAgent, accept: "application/json" },
      signal: AbortSignal.timeout(deps.timeoutMs),
    });
  } catch (error) {
    throw new WikidataUnavailableError(error);
  }
  if (!response.ok) {
    throw new WikidataUnavailableError(`HTTP ${response.status}`);
  }
  try {
    return await response.json();
  } catch (error) {
    throw new WikidataUnavailableError(error);
  }
}

interface SearchApiShape {
  search?: Array<{
    id: string;
    label?: string;
    description?: string;
    match?: { text?: string; language?: string };
  }>;
}

/** One serial wbsearchentities call in one language, at most ten answers. */
export async function searchWikidata(
  deps: WikidataDeps,
  input: { query: string; locale: string },
): Promise<WikidataSuggestion[]> {
  const payload = (await callWikidata(deps, {
    action: "wbsearchentities",
    search: input.query,
    language: input.locale,
    uselang: input.locale,
    type: "item",
    limit: String(WIKIDATA_SUGGESTION_LIMIT),
  })) as SearchApiShape;
  const suggestions: WikidataSuggestion[] = [];
  for (const hit of payload.search ?? []) {
    const label = hit.label ?? "";
    const matchText = hit.match?.text;
    const matchedAlias = matchText !== undefined && matchText !== label
      ? matchText
      : undefined;
    suggestions.push({
      qid: hit.id,
      label,
      ...(hit.description !== undefined && hit.description !== ""
        ? { description: hit.description }
        : {}),
      ...(matchedAlias !== undefined
        ? {
            matchedAlias,
            ...(hit.match?.language !== undefined
              ? { matchedAliasLanguage: hit.match.language }
              : {}),
          }
        : {}),
    });
  }
  return suggestions;
}

interface WikidataEntityShape {
  /** MediaWiki marks an unknown id with a "missing" flag instead of omitting it. */
  missing?: string;
  labels?: Record<string, { value?: string }>;
  descriptions?: Record<string, { value?: string }>;
  claims?: Record<string, Array<{ mainsnak?: { datavalue?: { value?: unknown } } }>>;
}

interface EntityApiShape {
  entities?: Record<string, WikidataEntityShape>;
}

/** The claim properties the second read offers as identifier suggestions. */
const IDENTIFIER_CLAIMS: Array<{ property: string; scheme: "imdb" | "kinopoisk" }> = [
  { property: "P345", scheme: "imdb" },
  { property: "P2603", scheme: "kinopoisk" },
];

function claimValue(entity: WikidataEntityShape, property: string): string | null {
  const claim = entity.claims?.[property]?.[0];
  const value = claim?.mainsnak?.datavalue?.value;
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * One serial wbgetentities read; null when the entity id is unknown. The
 * label and description are read in the caller's language with English as
 * the fallback, so the second read speaks the same language the suggestions
 * were searched in.
 */
export async function readWikidataEntity(
  deps: WikidataDeps,
  qid: string,
  locale = "en",
): Promise<WikidataEntity | null> {
  const payload = (await callWikidata(deps, {
    action: "wbgetentities",
    ids: qid,
    props: "labels|descriptions|claims",
    languages: `${locale}|en`,
  })) as EntityApiShape;
  const entity = payload.entities?.[qid];
  if (entity === undefined || entity.missing !== undefined) {
    return null;
  }
  const label = entity.labels?.[locale]?.value ?? entity.labels?.en?.value ?? "";
  const description =
    entity.descriptions?.[locale]?.value ?? entity.descriptions?.en?.value;
  const identifiers: WikidataIdentifierFact[] = [];
  for (const { property, scheme } of IDENTIFIER_CLAIMS) {
    const value = claimValue(entity, property);
    if (value !== null) {
      identifiers.push({ scheme, value, property });
    }
  }
  return {
    qid,
    label,
    ...(description !== undefined && description !== ""
      ? { description }
      : {}),
    identifiers,
  };
}
