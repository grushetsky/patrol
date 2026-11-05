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
    episodeLinks: Array<{
        label: string;
        href: string;
    }>;
    /** Anchor texts, where a file size or a resolution-plus-source pair hides. */
    linkTexts: string[];
}
/**
 * Whether one iframe src or episode link is player-oriented. Relative hrefs
 * resolve against a placeholder origin — only the path is read. Unparseable
 * values are not player-oriented.
 */
export declare function isPlayerFrameUrl(url: string): boolean;
/** One ISO 8601 duration ("PT1H40M30S", "PT90M", "PT5400S") in seconds. */
export declare function isoDurationSeconds(value: string): number | null;
/**
 * Parses one capture's extraction sidecar. A null, undefined, or malformed
 * input yields empty facts — an unevaluatable page contributes nothing.
 */
export declare function parseSidecar(input: string | null | undefined): PageFacts;
