import { useEffect, useRef, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { t } from "@patrol/i18n";
import { api } from "../../../lib/api/client";
import { fetchSessionCsrfToken } from "../../../lib/api/auth";
import { useSession } from "../../../lib/session";
import {
  SOURCE_MESSAGES,
  TITLE_TYPE_MESSAGES,
  VARIANT_KIND_MESSAGES,
} from "../../../lib/messages";
import { PageHead, Panel } from "../../../components/ui";
import { Icon } from "../../../components/icons";

/**
 * The add-title field (docs/design/catalogue-entry.md "The entry surface"):
 * one ranked list over two indexes. The local catalogue catches duplicates
 * before another record exists; Wikidata supplies entity suggestions —
 * the lookup starts after three characters and a 300 ms pause, and a
 * failure degrades to local-only. Free text is always offered; nothing is
 * stored until the operator saves.
 */
export const Route = createFileRoute("/catalogue/titles/new")({
  component: AddTitle,
});

const WIKIDATA_MIN_CHARS = 3;
const WIKIDATA_DEBOUNCE_MS = 300;

interface Suggestion {
  trackedTitleId: string;
  displayTitle: string;
  releaseYear: number;
  titleType: string;
  titleGroupName: string;
  matchedVariant: {
    text: string;
    kind: "original" | "localized" | "transliterated" | "alternate";
    language: string;
  };
}

interface WikidataSuggestion {
  qid: string;
  label: string;
  description?: string;
  matchedAlias?: string;
}

interface WikidataIdentifierFact {
  scheme: "imdb" | "kinopoisk";
  value: string;
  property: string;
}

interface PrefilledVariant {
  text: string;
  kind: "localized";
  language: string;
  script: string;
  source: "wikidata";
}

interface TitleGroup {
  id: string;
  name: string;
}

/** The identifier shapes the API accepts; a claim outside them is not prefilled. */
function isPrefillableValue(
  scheme: "wikidata" | "imdb" | "kinopoisk",
  value: string,
): boolean {
  if (scheme === "wikidata") {
    return /^Q\d+$/.test(value);
  }
  if (scheme === "imdb") {
    return /^tt\d{7,}$/.test(value);
  }
  return /^\d+$/.test(value);
}

function AddTitle() {
  const { locale } = useSession();
  const navigate = useNavigate();
  const [tab, setTab] = useState<"local" | "wikidata">("local");
  const [text, setText] = useState("");
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [wikidata, setWikidata] = useState<WikidataSuggestion[]>([]);
  const [wikidataDown, setWikidataDown] = useState(false);
  const [groups, setGroups] = useState<TitleGroup[]>([]);
  const [groupId, setGroupId] = useState("");
  const [language, setLanguage] = useState("en");
  const [script, setScript] = useState("Latn");
  const [year, setYear] = useState("");
  const [titleType, setTitleType] = useState<"film" | "series" | "miniseries" | "other">("film");
  const [runtime, setRuntime] = useState("");
  const [source, setSource] = useState<"rights_holder_record" | "operator_knowledge" | "wikidata">(
    "rights_holder_record",
  );
  const [identifiers, setIdentifiers] = useState<Array<{ scheme: "wikidata" | "imdb" | "kinopoisk"; value: string }>>([]);
  const [variants, setVariants] = useState<PrefilledVariant[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The identifier values an earlier selection prefilled, so a new selection replaces them. */
  const prefilledValues = useRef<Set<string>>(new Set());
  /** Guards the entity read against a stale answer after a rapid re-selection. */
  const selectionSeq = useRef(0);

  useEffect(() => {
    void api.GET("/title-groups").then(({ data, response }) => {
      if (response.ok && data && data.items.length > 0) {
        setGroups(data.items as TitleGroup[]);
        setGroupId((data.items[0] as TitleGroup).id);
      }
    });
  }, []);

  // Local suggestions follow typing directly; the Wikidata lookup waits
  // for three characters and a 300 ms pause, and runs serially.
  useEffect(() => {
    if (text.trim().length === 0) {
      setSuggestions([]);
      setWikidata([]);
      return;
    }
    void api
      .GET("/catalogue/suggestions", { params: { query: { query: text.trim() } } })
      .then(({ data, response }) => {
        if (response.ok && data) {
          setSuggestions(data.suggestions as Suggestion[]);
        }
      });
    if (debounce.current !== null) {
      clearTimeout(debounce.current);
    }
    if (text.trim().length < WIKIDATA_MIN_CHARS) {
      setWikidata([]);
      setWikidataDown(false);
      return;
    }
    debounce.current = setTimeout(() => {
      void api
        .GET("/catalogue/wikidata-suggestions", {
          params: { query: { query: text.trim(), locale: language.split("-")[0] } },
        })
        .then(({ data, response }) => {
          if (response.ok && data) {
            setWikidata(data.suggestions as WikidataSuggestion[]);
            setWikidataDown(false);
          } else if (response.status === 503) {
            // Degradation: local suggestions and creation still work.
            setWikidataDown(true);
            setWikidata([]);
          }
        });
    }, WIKIDATA_DEBOUNCE_MS);
    return () => {
      if (debounce.current !== null) {
        clearTimeout(debounce.current);
      }
    };
  }, [text, language]);

  /**
   * Selecting a Wikidata suggestion pre-fills, and stores nothing
   * (docs/design/catalogue-entry.md "The entry surface"): the QID as a
   * wikidata identifier, the label as a variant in the search language,
   * and — through the second read — the entity's IMDb and KinoPoisk claims
   * as further identifier suggestions. The original title, year, and type
   * stay the operator's to enter: a label is not those facts.
   */
  async function selectWikidataSuggestion(suggestion: WikidataSuggestion) {
    const searchLocale = language.split("-")[0];
    const previous = prefilledValues.current;
    const selection = new Set<string>([suggestion.qid]);
    const seq = ++selectionSeq.current;
    // Drop the previous selection's prefill; the operator's own rows stay.
    setIdentifiers((current) => [
      ...current.filter((identifier) => !previous.has(identifier.value)),
      { scheme: "wikidata", value: suggestion.qid },
    ]);
    setVariants(
      suggestion.label.length > 0
        ? [
            {
              text: suggestion.label,
              kind: "localized",
              language: searchLocale,
              script,
              source: "wikidata",
            },
          ]
        : [],
    );
    prefilledValues.current = selection;
    const { data, response } = await api.GET(
      "/catalogue/wikidata-entities/{qid}",
      { params: { path: { qid: suggestion.qid } } },
    );
    if (seq !== selectionSeq.current) {
      // A newer selection owns the prefill; this read is stale.
      return;
    }
    if (response.ok && data) {
      const facts = ((data.identifiers ?? []) as WikidataIdentifierFact[]).filter(
        (fact) => isPrefillableValue(fact.scheme, fact.value),
      );
      for (const fact of facts) {
        selection.add(fact.value);
      }
      setIdentifiers((current) => [
        ...current.filter(
          (identifier) =>
            !previous.has(identifier.value) ||
            identifier.value === suggestion.qid,
        ),
        ...facts.map((fact) => ({ scheme: fact.scheme, value: fact.value })),
      ]);
      prefilledValues.current = selection;
    }
  }

  async function create(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const csrfToken = await fetchSessionCsrfToken();
      if (csrfToken === null) {
        setError(t(locale, "errors.unauthenticated"));
        return;
      }
      const { data, response } = await api.POST("/titles", {
        params: { header: { "X-Patrol-CSRF": csrfToken } },
        body: {
          titleGroupId: groupId,
          originalVariant: { text: text.trim(), language, script },
          releaseYear: Number.parseInt(year, 10),
          titleType,
          additionalVariants: variants,
          externalIdentifiers: identifiers.filter((id) => id.value.length > 0),
          source,
        },
      });
      if (response.ok && data) {
        navigate({
          to: "/catalogue/titles/$titleId",
          params: { titleId: data.title.id },
        });
        return;
      }
      if (response.status === 409) {
        // A duplicate: the existing title opens instead.
        const existing = (data as { existingTitleId?: string }).existingTitleId;
        if (existing !== undefined) {
          navigate({
            to: "/catalogue/titles/$titleId",
            params: { titleId: existing },
          });
          return;
        }
      }
      setError(t(locale, "web.common.error"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="page stack">
      <PageHead
        eyebrow={t(locale, "web.nav.titles")}
        title={t(locale, "web.catalogue.search.title")}
        actions={
          <Link className="btn btn-ghost btn-sm" to="/catalogue/titles">
            {t(locale, "web.catalogue.titles.title")}
          </Link>
        }
      />
      <Panel title={t(locale, "web.catalogue.search.title")}>
        <input
          className="input"
          placeholder={t(locale, "web.catalogue.search.placeholder")}
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-label={t(locale, "web.catalogue.search.placeholder")}
        />
        <div role="tablist" className="chart-toolbar" style={{ margin: "12px 0" }}>
          <button
            type="button"
            role="tab"
            className="chart-tab"
            aria-selected={tab === "local"}
            onClick={() => setTab("local")}
          >
            {t(locale, "web.catalogue.search.tab.local")}
          </button>
          <button
            type="button"
            role="tab"
            className="chart-tab"
            aria-selected={tab === "wikidata"}
            onClick={() => setTab("wikidata")}
          >
            {t(locale, "web.catalogue.search.tab.wikidata")}
          </button>
        </div>
        {tab === "local" ? (
          suggestions.length === 0 ? (
            <p className="page-note" style={{ margin: 0 }}>
              {t(locale, "web.catalogue.search.localEmpty")}
            </p>
          ) : (
            <div className="option-list">
              {suggestions.map((suggestion) => (
                <div key={suggestion.trackedTitleId} className="option">
                  <Link
                    to="/catalogue/titles/$titleId"
                    params={{ titleId: suggestion.trackedTitleId }}
                    className="option-name"
                    style={{ textDecoration: "none" }}
                  >
                    {suggestion.displayTitle} ({suggestion.releaseYear},{" "}
                    {suggestion.titleGroupName})
                  </Link>
                  <span className="option-sub">
                    {t(locale, "web.catalogue.search.matchedVariant")}:{" "}
                    {suggestion.matchedVariant.text} (
                    {t(locale, VARIANT_KIND_MESSAGES[suggestion.matchedVariant.kind])})
                  </span>
                </div>
              ))}
            </div>
          )
        ) : wikidataDown ? (
          <p className="page-note" role="status" style={{ margin: 0 }}>
            {t(locale, "web.catalogue.search.wikidataUnavailable")}
          </p>
        ) : wikidata.length === 0 ? (
          <p className="page-note" style={{ margin: 0 }}>
            {t(locale, "web.catalogue.search.wikidataEmpty")}
          </p>
        ) : (
          <div className="option-list">
            {wikidata.map((suggestion) => (
              <button
                key={suggestion.qid}
                type="button"
                className="option"
                style={{ textAlign: "left", font: "inherit" }}
                onClick={() => void selectWikidataSuggestion(suggestion)}
              >
                <span className="option-name">{suggestion.label}</span>
                <span className="option-sub">
                  {suggestion.qid}
                  {suggestion.description !== undefined ? ` — ${suggestion.description}` : ""}
                  {suggestion.matchedAlias !== undefined ? ` — ${suggestion.matchedAlias}` : ""}
                </span>
              </button>
            ))}
          </div>
        )}
      </Panel>
      <form onSubmit={create}>
        <Panel title={t(locale, "web.catalogue.create.title")}>
          {error !== null && (
            <p className="banner" role="alert">
              {error}
            </p>
          )}
          <div className="form-grid">
            <div className="form-row">
              <label className="field">
                <span>{t(locale, "web.catalogue.create.groupLabel")}</span>
                <select
                  className="select"
                  value={groupId}
                  onChange={(e) => setGroupId(e.target.value)}
                >
                  {groups.map((group) => (
                    <option key={group.id} value={group.id}>
                      {group.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>{t(locale, "web.catalogue.create.languageLabel")}</span>
                <input className="input" value={language} onChange={(e) => setLanguage(e.target.value)} required />
              </label>
              <label className="field">
                <span>{t(locale, "web.catalogue.create.scriptLabel")}</span>
                <input className="input" value={script} onChange={(e) => setScript(e.target.value)} required />
              </label>
              <label className="field">
                <span>{t(locale, "web.catalogue.create.yearLabel")}</span>
                <input
                  className="input"
                  value={year}
                  onChange={(e) => setYear(e.target.value)}
                  required
                  inputMode="numeric"
                  pattern="\d{4}"
                />
              </label>
              <label className="field">
                <span>{t(locale, "web.catalogue.create.typeLabel")}</span>
                <select
                  className="select"
                  value={titleType}
                  onChange={(e) =>
                    setTitleType(e.target.value as "film" | "series" | "miniseries" | "other")
                  }
                >
                  {(["film", "series", "miniseries", "other"] as const).map((kind) => (
                    <option key={kind} value={kind}>
                      {t(locale, TITLE_TYPE_MESSAGES[kind])}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>{t(locale, "web.catalogue.create.runtimeLabel")}</span>
                <input className="input" value={runtime} onChange={(e) => setRuntime(e.target.value)} inputMode="numeric" />
              </label>
              <label className="field">
                <span>{t(locale, "web.catalogue.create.sourceLabel")}</span>
                <select
                  className="select"
                  value={source}
                  onChange={(e) =>
                    setSource(
                      e.target.value as
                        | "rights_holder_record"
                        | "operator_knowledge"
                        | "wikidata",
                    )
                  }
                >
                  {(["rights_holder_record", "operator_knowledge", "wikidata"] as const).map(
                    (origin) => (
                      <option key={origin} value={origin}>
                        {t(locale, SOURCE_MESSAGES[origin])}
                      </option>
                    ),
                  )}
                </select>
              </label>
            </div>
            {variants.length > 0 && (
              <fieldset className="option-list" style={{ border: 0, padding: 0, margin: 0 }}>
                <legend className="field-label">{t(locale, "web.catalogue.detail.variants")}</legend>
                {variants.map((variant, index) => (
                  <div key={`${variant.text}/${variant.language}`} className="option">
                    <span className="option-name">
                      {variant.text} ({variant.language}/{variant.script} —{" "}
                      {t(locale, VARIANT_KIND_MESSAGES[variant.kind])})
                    </span>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() =>
                        setVariants((current) =>
                          current.filter((_, at) => at !== index),
                        )
                      }
                    >
                      {t(locale, "web.common.remove")}
                    </button>
                  </div>
                ))}
              </fieldset>
            )}
            {identifiers.map((identifier, index) => (
              <fieldset key={index} className="form-row" style={{ border: 0, padding: 0, margin: 0 }}>
                <label className="field">
                  <span>{t(locale, "web.catalogue.create.identifierScheme")}</span>
                  <select
                    className="select"
                    value={identifier.scheme}
                    onChange={(e) => {
                      const next = [...identifiers];
                      next[index] = {
                        ...identifier,
                        scheme: e.target.value as "wikidata" | "imdb" | "kinopoisk",
                      };
                      setIdentifiers(next);
                    }}
                  >
                    <option value="wikidata">wikidata</option>
                    <option value="imdb">imdb</option>
                    <option value="kinopoisk">kinopoisk</option>
                  </select>
                </label>
                <label className="field">
                  <span>{t(locale, "web.catalogue.create.identifierValue")}</span>
                  <input
                    className="input"
                    value={identifier.value}
                    onChange={(e) => {
                      const next = [...identifiers];
                      next[index] = { ...identifier, value: e.target.value };
                      setIdentifiers(next);
                    }}
                  />
                </label>
              </fieldset>
            ))}
            <div className="form-actions">
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() =>
                  setIdentifiers([...identifiers, { scheme: "wikidata", value: "" }])
                }
              >
                <Icon name="plus" size="sm" />
                <span>{t(locale, "web.catalogue.create.addIdentifier")}</span>
              </button>
              <button type="submit" className="btn btn-primary" disabled={busy}>
                <Icon name="plus" size="sm" />
                <span>{t(locale, "web.catalogue.search.createPrefix")} “{text.trim()}”</span>
              </button>
            </div>
          </div>
        </Panel>
      </form>
    </main>
  );
}
