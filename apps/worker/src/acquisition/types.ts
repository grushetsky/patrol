export type Engine = "google" | "yandex";
export type ScanTrigger = "scheduled" | "manual" | "recheck" | "manual_recheck";
export type BudgetBucket = "scan" | "recheck";

export interface IntentPhrase {
  text: string;
  version: number;
}

export interface PlannedQuery {
  id: string;
  trackedTitleId: string;
  locale: string;
  kind: "variant" | "intent";
  text: string;
  variantId?: string;
  intentPhrase?: IntentPhrase;
}

export interface QueryPlan {
  generatedAt: string;
  queries: PlannedQuery[];
}

export interface TitleWithVariants {
  id: string;
  displayTitle: string;
  variants: Array<{
    id: string;
    text: string;
    kind: string;
    language: string;
    territory?: string;
  }>;
}

export interface SearchRow {
  url: string;
  title: string;
  snippet: string;
  host: string;
  position: number;
  engine: Engine;
  retrievedAt: string;
}

export interface SearchBatch {
  rows: SearchRow[];
  rawBody: string;
}

export interface SearchContext {
  engine: Engine;
  locale: string;
  territory?: string;
  limit: number;
}

/** One adapter per engine; no vendor type escapes it. */
export interface SearchAdapter {
  readonly engine: Engine;
  search(query: PlannedQuery, context: SearchContext): Promise<SearchBatch>;
  probe(): Promise<void>;
  balanceMinor?(): Promise<number | undefined>;
}

export class AdapterError extends Error {
  constructor(
    readonly kind: "retryable" | "auth" | "balance",
    message: string,
  ) {
    super(message);
    this.name = "AdapterError";
  }
}
