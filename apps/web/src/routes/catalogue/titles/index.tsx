import { useCallback, useEffect, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { t } from "@patrol/i18n";
import { api } from "../../../lib/api/client";
import { useSession } from "../../../lib/session";
import { TITLE_TYPE_MESSAGES } from "../../../lib/messages";

/**
 * The tracked-titles list with the contract's filters: group, pause state,
 * and a query over the titles' variants. Each row links to the detail the
 * variants, identifiers, pause switch, and merge live on.
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
    <main>
      <h1>{t(locale, "web.catalogue.titles.title")}</h1>
      <p>
        <Link to="/catalogue">{t(locale, "web.catalogue.groups.title")}</Link>
      </p>
      {error !== null && <p role="alert">{error}</p>}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void load();
        }}
      >
        <label>
          {t(locale, "web.catalogue.titles.queryLabel")}
          <input value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <label>
          <input
            type="checkbox"
            checked={pausedOnly}
            onChange={(e) => setPausedOnly(e.target.checked)}
          />
          {t(locale, "web.catalogue.titles.pausedOnly")}
        </label>
        <button type="submit">{t(locale, "web.catalogue.titles.filter")}</button>
      </form>
      <p>
        <Link to="/catalogue/titles/new">{t(locale, "web.catalogue.titles.add")}</Link>
      </p>
      {titles === null ? (
        <p>{t(locale, "web.common.loading")}</p>
      ) : titles.length === 0 ? (
        <p>{t(locale, "web.catalogue.titles.empty")}</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th scope="col">{t(locale, "web.catalogue.titles.queryLabel")}</th>
              <th scope="col">{t(locale, "web.catalogue.titles.year")}</th>
              <th scope="col">{t(locale, "web.catalogue.titles.type")}</th>
              <th scope="col">{t(locale, "web.catalogue.titles.group")}</th>
              <th scope="col">{t(locale, "web.catalogue.detail.variants")}</th>
              <th scope="col">{t(locale, "web.catalogue.titles.identifiers")}</th>
            </tr>
          </thead>
          <tbody>
            {titles.map((title) => (
              <tr key={title.id}>
                <td>
                  <Link to="/catalogue/titles/$titleId" params={{ titleId: title.id }}>
                    {title.displayTitle}
                    {title.paused ? ` — ${t(locale, "web.catalogue.titles.paused")}` : ""}
                  </Link>
                </td>
                <td>{title.releaseYear}</td>
                <td>{t(locale, TITLE_TYPE_MESSAGES[title.titleType])}</td>
                <td>{title.titleGroupName}</td>
                <td>{title.variantCount}</td>
                <td>
                  {title.externalIdentifiers
                    .map((identifier) => `${identifier.scheme}:${identifier.value}`)
                    .join(", ")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
