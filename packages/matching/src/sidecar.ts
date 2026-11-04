export interface PageFacts {
  /** Every title-like name the page declares. */
  names: string[];
  title: string;
  h1: string[];
  meta: Record<string, string>;
  jsonLd: unknown[];
  /** Player and embed URLs found in JSON-LD, iframes, and video elements. */
  playerUrls: string[];
  downloadAffordances: string[];
  durationSeconds?: number;
  /** Unique episode numbers found in the rendered page. */
  episodeNumbers: number[];
  releaseTokens: string[];
  /** The rendered DOM when the caller has it; empty otherwise. */
  dom: string;
}

const RELEASE_TOKEN = /\b(CAM|TELESYNC|TELECINE|WORKPRINT)\b/gi;
const EPISODE_PATTERN = /(?:s(\d{1,2})[\s._-]*e|episode\s*|эпизод\s*|серия\s*)(\d{1,3})/gi;

function walk(value: unknown, visit: (object: Record<string, unknown>) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      walk(item, visit);
    }
    return;
  }
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    visit(object);
    for (const item of Object.values(object)) {
      walk(item, visit);
    }
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/** Parse an ISO 8601 duration such as `PT1H32M` into seconds. */
export function parseDuration(value: string): number | undefined {
  const match = /^P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/i.exec(
    value.trim(),
  );
  if (!match) {
    return undefined;
  }
  const [, days, hours, minutes, seconds] = match;
  const total =
    Number(days ?? 0) * 86_400 +
    Number(hours ?? 0) * 3_600 +
    Number(minutes ?? 0) * 60 +
    Number(seconds ?? 0);
  return total > 0 ? total : undefined;
}

/**
 * Turn the capture sidecar and rendered DOM into the page facts the matcher
 * scores. The sidecar is untrusted JSON, so every field is read defensively.
 */
export function parseSidecar(
  sidecar: unknown,
  dom = "",
): PageFacts {
  const facts: PageFacts = {
    names: [],
    title: "",
    h1: [],
    meta: {},
    jsonLd: [],
    playerUrls: [],
    downloadAffordances: [],
    episodeNumbers: [],
    releaseTokens: [],
    dom,
  };
  if (sidecar === null || typeof sidecar !== "object") {
    return facts;
  }
  const record = sidecar as Record<string, unknown>;

  facts.title = stringValue(record.title) ?? "";
  if (facts.title) {
    facts.names.push(facts.title);
  }

  if (Array.isArray(record.h1)) {
    facts.h1 = record.h1
      .map((value) => stringValue(value))
      .filter((value): value is string => value !== undefined);
    facts.names.push(...facts.h1);
  }

  if (record.meta !== null && typeof record.meta === "object") {
    for (const [key, value] of Object.entries(
      record.meta as Record<string, unknown>,
    )) {
      const text = stringValue(value);
      if (text !== undefined) {
        facts.meta[key.toLowerCase()] = text;
      }
    }
    for (const key of ["og:title", "twitter:title"]) {
      const value = facts.meta[key];
      if (value) {
        facts.names.push(value);
      }
    }
  }

  if (Array.isArray(record.jsonLd)) {
    facts.jsonLd = record.jsonLd;
    walk(record.jsonLd, (object) => {
      for (const key of ["name", "headline", "alternativeHeadline"]) {
        const value = stringValue(object[key]);
        if (value) {
          facts.names.push(value);
        }
      }
      for (const key of ["contentUrl", "embedUrl"]) {
        const value = stringValue(object[key]);
        if (value) {
          facts.playerUrls.push(value);
        }
      }
      const duration = stringValue(object.duration);
      if (duration) {
        facts.durationSeconds ??= parseDuration(duration);
      }
    });
  }

  for (const key of ["iframes", "videos"]) {
    const values = record[key];
    if (Array.isArray(values)) {
      for (const value of values) {
        const text = stringValue(value);
        if (text) {
          facts.playerUrls.push(text);
        }
      }
    }
  }

  if (Array.isArray(record.downloadAffordances)) {
    facts.downloadAffordances = record.downloadAffordances
      .map((value) => stringValue(value))
      .filter((value): value is string => value !== undefined);
  }

  const metaDuration = numberValue(facts.meta["video:duration"]);
  if (metaDuration !== undefined) {
    facts.durationSeconds ??= metaDuration;
  }

  const text = `${dom} ${JSON.stringify(sidecar)}`;
  const episodes = new Set<number>();
  for (const match of text.matchAll(EPISODE_PATTERN)) {
    const episode = Number(match[2]);
    if (Number.isFinite(episode)) {
      episodes.add(episode);
    }
  }
  facts.episodeNumbers = [...episodes].sort((left, right) => left - right);
  facts.releaseTokens = [
    ...new Set(
      [...text.matchAll(RELEASE_TOKEN)].map((match) => match[1].toUpperCase()),
    ),
  ];

  return facts;
}
