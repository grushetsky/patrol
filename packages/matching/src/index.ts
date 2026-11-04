export { normalizeTitle, normalizeSlug, searchKey } from "./normalize.js";
export { hostOf, normalizeUrl, registrableDomainOf } from "./url.js";
export {
  parseDuration,
  parseSidecar,
  type PageFacts,
} from "./sidecar.js";
export {
  bandFor,
  evaluateSignals,
  isShortener,
  reputationContribution,
  scoreCandidate,
  titleMatch,
  type MatchKind,
  type ReputationInput,
  type ScoreBand,
  type ScoreContext,
  type ScoreResult,
  type SignalContribution,
  type SignalKind,
  type TitleMatch,
} from "./score.js";
