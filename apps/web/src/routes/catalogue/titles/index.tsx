import { useCallback, useEffect, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { t } from "@patrol/i18n";
import { api } from "../../../lib/api/client";
import { useSession } from "../../../lib/session";
import { TITLE_TYPE_MESSAGES } from "../../../lib/messages";
import { Chip, EmptyState, PageHead, Skeleton } from "../../../components/ui";
import { Icon } from "../../../components/icons";

/**
 * The tracked-titles list with the contract's filters: group, pause state,
 * and a query over the titles' variants. The prototype renders these as
 * cards — poster glyph, display title, group, variant count, identifiers,
 * and the paused state — each linking to the detail the variants,
 * identifiers, pause switch, and merge live on.
 */
export const Route = createFileRoute("/catalogue/titles/")({
  component: TitlesIndex,
  validateSearch: (search: Record<string, unknown>): { titleGroupId?: string } => ({
    ...(typeof search.titleGroupId === "string"
      ? { titleGroupId: search.titleGroupId }
      : {}),
  }),
});

interface TitleCard {
  id: string;
  displayTitle: string;
  releaseYear: number;
  titleType: "film" | "series" | "miniseries" | "other";
  titleGroupId: string;
  titleGroupName: string;
  variantCount: number;
  paused: boolean;
  externalIdentifiers: Array<{ scheme: string; value: string }>;
}

function TitlesIndex() {
  const { locale } = useSession();
  const search = Route.useSearch();
  const [titles, setTitles] = useState<TitleCard[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [pausedOnly, setPausedOnly] = useState(false);

  const load = useCallback(async () => {
    const { data, response } = await api.GET("/titles", {
      params: {
        query: {
          ...(search.titleGroupId !== undefined ? { titleGroupId: search.titleGroupId } : {}),
          ...(query.trim().length > 0 ? { query: query.trim() } : {}),
          ...(pausedOnly ? { paused: true } : {}),
        },
      },
    });
    if (response.ok && data) {
      setTitles(data.items as TitleCard[]);
    } else {
      setError(t(locale, "web.common.error"));
    }
  }, [locale, pausedOnly, query, search.titleGroupId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <main className="page">
      <PageHead
        eyebrow={t(locale, "web.nav.titles")}
        title={t(locale, "web.catalogue.titles.title")}
        note={search.titleGroupId !== undefined ? undefined : t(locale, "web.catalogue.titles.note")}
        actions={
          <div className="toolbar-links">
            <Link className="btn btn-ghost btn-sm" to="/catalogue">
              {t(locale, "web.catalogue.groups.title")}
            </Link>
            <Link className="btn btn-primary btn-sm" to="/catalogue/titles/new">
              <Icon name="plus" size="sm" />
              <span>{t(locale, "web.catalogue.titles.add")}</span>
            </Link>
          </div>
        }
      />
      {error !== null && (
        <p className="banner" role="alert">
          {error}
        </p>
      )}
      <form
        className="filter-bar"
        style={{ marginBottom: 18 }}
        onSubmit={(event) => {
          event.preventDefault();
          void load();
        }}
      >
        <label className="field" style={{ gap: 4, flex: "1 1 240px" }}>
          <span className="field-label">{t(locale, "web.catalogue.titles.queryLabel")}</span>
          <input className="input" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <input
            type="checkbox"
            className="check"
            checked={pausedOnly}
            onChange={(e) => setPausedOnly(e.target.checked)}
          />
          {t(locale, "web.catalogue.titles.pausedOnly")}
        </label>
        <button type="submit" className="btn btn-sm">
          {t(locale, "web.catalogue.titles.filter")}
        </button>
      </form>
      {titles === null ? (
        <div className="title-grid" aria-busy="true">
          {[0, 1, 2, 3].map((index) => (
            <div key={index} className="title-card" aria-hidden="true">
              <Skeleton variant="score" />
              <Skeleton variant="wide" />
              <Skeleton variant="short" />
            </div>
          ))}
        </div>
      ) : titles.length === 0 ? (
        <EmptyState title={t(locale, "web.catalogue.titles.empty")}>
          {t(locale, "web.catalogue.titles.emptyHint")}
        </EmptyState>
      ) : (
        <div className="title-grid">
          {titles.map((title) => (
            <article key={title.id} className={`title-card${title.paused ? " is-paused" : ""}`}>
              {/* The poster glyph the prototype fakes for a title without
                  art: the display title's first letter on the tinted tile. */}
              <Link
                className="poster"
                to="/catalogue/titles/$titleId"
                params={{ titleId: title.id }}
                aria-hidden="true"
                tabIndex={-1}
              >
                {title.displayTitle.slice(0, 1).toUpperCase()}
              </Link>
              <div className="title-main">
                <h2 className="title-name">
                  <Link to="/catalogue/titles/$titleId" params={{ titleId: title.id }}>
                    {title.displayTitle} <span className="muted">({title.releaseYear})</span>
                  </Link>
                </h2>
                <div className="title-sub">
                  {title.titleGroupName}
                  {title.externalIdentifiers.length > 0 &&
                    ` · ${title.externalIdentifiers.map((identifier) => `${identifier.scheme}:${identifier.value}`).join(", ")}`}
                </div>
                <div className="title-meta">
                  <Chip tone="blue">{t(locale, TITLE_TYPE_MESSAGES[title.titleType])}</Chip>
                  <Chip>
                    {t(locale, "web.catalogue.detail.variants")}: {title.variantCount}
                  </Chip>
                  {title.paused && <Chip tone="amber" dot>{t(locale, "web.catalogue.titles.paused")}</Chip>}
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
    </main>
  );
}
