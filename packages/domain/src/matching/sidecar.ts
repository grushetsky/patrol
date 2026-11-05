/**
 * The extraction-sidecar parser (docs/design/matching-and-classification-rules.md
 * "Strong signals"; docs/design/evidence-capture.md "What a capture records").
 * The capture worker serializes its extraction into the sidecar artifact; this
 * module turns those bytes into the typed facts the matcher and the signal
 * evaluator read, so no consumer ever parses raw JSON-LD or anchor lists
 * itself.
 *
 * The slice-4 extractor produces {title, h1, meta, jsonLd, iframes, videos,
 * downloadAffordances}; slice 5's extraction deepens it with the episode
 * selector, the anchor texts a download affordance needs, and the
 * player-oriented subset of the page's iframes (`playerFrames`). The parser
 * is tolerant by design: a missing, malformed, or older sidecar yields empty
 * facts rather than a throw, because a page that hid its facts is a page
 * with no signals — the capture, not the parse, is the evidence.
 */

/** The typed facts one capture's extraction sidecar carries. */
export interface PageFacts {
  /** The page's <title>. */
  pageTitle: string | null;
  /** The page's <h1> elements, in document order. */
  h1s: string[];
  /** Structured-data names, from JSON-LD `name` fields. */
  structuredNames: string[];
  /** The <meta> content by name/property, as extracted. */
  meta: Record<string, string>;
  /**
   * Every URL a player could live at: a VideoObject's `contentUrl` or
   * `embedUrl`, a player-oriented iframe's src, or a <video>/<source> src.
   */
  playerCandidates: string[];
  /** Declared durations in seconds, from <video> elements and JSON-LD. */
  declaredDurationsSeconds: number[];
  /** Explicit download affordances: torrent, magnet, and media-file links. */
  downloadAffordances: string[];
  /** Episode-selector entries with their per-episode links. */
  episodeLinks: Array<{ label: string; href: string }>;
  /** Anchor texts, where a file size or a resolution-plus-source pair hides. */
  linkTexts: string[];
}

function emptyFacts(): PageFacts {
  return {
    pageTitle: null,
    h1s: [],
    structuredNames: [],
    meta: {},
    playerCandidates: [],
    declaredDurationsSeconds: [],
    downloadAffordances: [],
    episodeLinks: [],
    linkTexts: [],
  };
}

interface RawVideo {
  src?: unknown;
  duration?: unknown;
}

interface RawSidecar {
  title?: unknown;
  h1?: unknown;
  meta?: unknown;
  jsonLd?: unknown;
  iframes?: unknown;
  playerFrames?: unknown;
  videos?: unknown;
  downloadAffordances?: unknown;
  episodeLinks?: unknown;
  linkTexts?: unknown;
}

/**
 * A player-oriented path token: `embed`, `player`, `video`, or `stream`
 * appearing as its own token in the URL's path (bounded by non-alphanumerics,
 * so "previews" or "restream" never count). An iframe or an episode link
 * whose path carries one of these names a player; a generic iframe — an ad
 * frame, an analytics beacon — does not, and advertising frames are exactly
 * the iframes a piracy landing page carries besides its player.
 */
const PLAYER_PATH_TOKEN = /(?:^|[^a-z0-9])(?:embed|player|video|stream)(?![a-z0-9])/i;

/**
 * Whether one iframe src or episode link is player-oriented. Relative hrefs
 * resolve against a placeholder origin — only the path is read. Unparseable
 * values are not player-oriented.
 */
export function isPlayerFrameUrl(url: string): boolean {
  let path: string;
  try {
    path = new URL(url, "https://sidecar.invalid").pathname;
  } catch {
    return false;
  }
  return PLAYER_PATH_TOKEN.test(path);
}

function stringsOf(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function recordOf(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "string") {
      out[key] = entry;
    }
  }
  return out;
}

/** One ISO 8601 duration ("PT1H40M30S", "PT90M", "PT5400S") in seconds. */
export function isoDurationSeconds(value: string): number | null {
  const match = /^P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(
    value.trim(),
  );
  if (match === null) {
    return null;
  }
  const [, days, hours, minutes, seconds] = match;
  const total =
    (days ? Number(days) * 86_400 : 0) +
    (hours ? Number(hours) * 3_600 : 0) +
    (minutes ? Number(minutes) * 60 : 0) +
    (seconds ? Number(seconds) : 0);
  return total > 0 ? total : null;
}

/** Collects VideoObject facts from any JSON-LD node, nested arrays included. */
function videoObjects(node: unknown, sink: { urls: string[]; durations: number[]; names: string[] }): void {
  if (Array.isArray(node)) {
    for (const entry of node) {
      videoObjects(entry, sink);
    }
    return;
  }
  if (typeof node !== "object" || node === null) {
    return;
  }
  const record = node as Record<string, unknown>;
  const type = record["@type"];
  const isVideoObject =
    type === "VideoObject" ||
    (Array.isArray(type) && type.includes("VideoObject"));
  if (isVideoObject) {
    if (typeof record.name === "string") {
      sink.names.push(record.name);
    }
    for (const field of ["contentUrl", "embedUrl"] as const) {
      if (typeof record[field] === "string") {
        sink.urls.push(record[field] as string);
      }
    }
    if (typeof record.duration === "string") {
      const seconds = isoDurationSeconds(record.duration);
      if (seconds !== null) {
        sink.durations.push(seconds);
      }
    } else if (typeof record.duration === "number" && Number.isFinite(record.duration)) {
      sink.durations.push(record.duration);
    }
  }
  // A @graph or an array of nodes carries more than one object.
  for (const key of ["@graph", "itemListElement"] as const) {
    if (record[key] !== undefined) {
      videoObjects(record[key], sink);
    }
  }
}

/**
 * Parses one capture's extraction sidecar. A null, undefined, or malformed
 * input yields empty facts — an unevaluatable page contributes nothing.
 */
export function parseSidecar(input: string | null | undefined): PageFacts {
  if (typeof input !== "string" || input.trim() === "") {
    return emptyFacts();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return emptyFacts();
  }
  if (typeof parsed !== "object" || parsed === null) {
    return emptyFacts();
  }
  const raw = parsed as RawSidecar;
  const facts = emptyFacts();

  if (typeof raw.title === "string") {
    facts.pageTitle = raw.title;
  }
  facts.h1s = stringsOf(raw.h1);
  facts.meta = recordOf(raw.meta);

  const structured = { urls: [] as string[], durations: [] as number[], names: [] as string[] };
  videoObjects(raw.jsonLd, structured);
  facts.structuredNames = structured.names;
  facts.playerCandidates.push(...structured.urls);
  facts.declaredDurationsSeconds.push(...structured.durations);

  // Player-oriented frames only: the extractor's `playerFrames` set when the
  // sidecar carries it, and — for a sidecar an older extractor wrote — the
  // same predicate applied to the raw iframe list, so an ad or analytics
  // iframe never reads as a player.
  const playerFrames = Array.isArray(raw.playerFrames)
    ? stringsOf(raw.playerFrames)
    : stringsOf(raw.iframes).filter(isPlayerFrameUrl);
  facts.playerCandidates.push(...playerFrames);

  if (Array.isArray(raw.videos)) {
    for (const video of raw.videos as RawVideo[]) {
      if (typeof video === "object" && video !== null) {
        if (typeof video.src === "string" && video.src !== "") {
          facts.playerCandidates.push(video.src);
        }
        if (
          typeof video.duration === "number" &&
          Number.isFinite(video.duration) &&
          video.duration > 0
        ) {
          facts.declaredDurationsSeconds.push(video.duration);
        }
      }
    }
  }

  facts.downloadAffordances = stringsOf(raw.downloadAffordances);

  if (Array.isArray(raw.episodeLinks)) {
    for (const entry of raw.episodeLinks) {
      if (
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as { label?: unknown }).label === "string" &&
        typeof (entry as { href?: unknown }).href === "string"
      ) {
        facts.episodeLinks.push(entry as { label: string; href: string });
      }
    }
  }

  facts.linkTexts = stringsOf(raw.linkTexts);

  return facts;
}
