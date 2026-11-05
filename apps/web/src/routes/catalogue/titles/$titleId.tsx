import { useCallback, useEffect, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
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
 * The title detail: variants with their per-row provenance, external
 * identifiers as recorded facts, the pause switch, and the merge action.
 */
export const Route = createFileRoute("/catalogue/titles/$titleId")({
  component: TitleDetail,
});

interface Variant {
  id: string;
  text: string;
  kind: "original" | "localized" | "transliterated" | "alternate";
  language: string;
  script: string;
  source: "rights_holder_record" | "operator_knowledge" | "wikidata";
  addedAt: string;
}

interface Identifier {
  id: string;
  scheme: "wikidata" | "imdb" | "kinopoisk";
  value: string;
  source: "rights_holder_record" | "operator_knowledge" | "wikidata";
  retrievedAt: string;
}

interface Detail {
  title: {
    id: string;
    releaseYear: number;
    titleType: "film" | "series" | "miniseries" | "other";
    paused: boolean;
    mergedIntoTitleId?: string;
    provenance: {
      source: "rights_holder_record" | "operator_knowledge" | "wikidata";
      enteredBy: string;
      enteredAt: string;
    };
  };
  displayTitle: string;
  variants: Variant[];
  externalIdentifiers: Identifier[];
}

function TitleDetail() {
  const { titleId } = Route.useParams();
  const { locale } = useSession();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [variantText, setVariantText] = useState("");
  const [variantKind, setVariantKind] = useState<"localized" | "transliterated" | "alternate">(
    "localized",
  );
  const [variantLanguage, setVariantLanguage] = useState("en");
  const [identifierScheme, setIdentifierScheme] = useState<"wikidata" | "imdb" | "kinopoisk">(
    "wikidata",
  );
  const [identifierValue, setIdentifierValue] = useState("");
  const [mergeTarget, setMergeTarget] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const { data, response } = await api.GET("/titles/{trackedTitleId}", {
      params: { path: { trackedTitleId: titleId } },
    });
    if (response.ok && data) {
      setDetail(data as Detail);
    } else {
      setError(t(locale, "web.common.error"));
    }
  }, [locale, titleId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function mutate(call: (csrfToken: string) => Promise<boolean>) {
    setBusy(true);
    setError(null);
    try {
      const csrfToken = await fetchSessionCsrfToken();
      if (csrfToken === null) {
        setError(t(locale, "errors.unauthenticated"));
        return;
      }
      if (!(await call(csrfToken))) {
        setError(t(locale, "web.common.error"));
        return;
      }
      await load();
    } finally {
      setBusy(false);
    }
  }

  if (detail === null) {
    return (
      <main className="page">
        <PageHead
          eyebrow={t(locale, "web.nav.titles")}
          title={error ?? t(locale, "web.common.loading")}
          actions={
            <Link className="btn btn-ghost btn-sm" to="/catalogue/titles">
              {t(locale, "web.catalogue.titles.title")}
            </Link>
          }
        />
      </main>
    );
  }

  const archived = detail.title.mergedIntoTitleId !== undefined;

  return (
    <main className="page stack">
      <PageHead
        eyebrow={t(locale, "web.nav.titles")}
        title={
          <>
            {detail.displayTitle}{" "}
            <span className="muted">
              ({detail.title.releaseYear}, {t(locale, TITLE_TYPE_MESSAGES[detail.title.titleType])})
            </span>
          </>
        }
        note={
          <>
            {t(locale, "web.catalogue.detail.provenance")}:{" "}
            {t(locale, SOURCE_MESSAGES[detail.title.provenance.source])} —{" "}
            {detail.title.provenance.enteredAt}
          </>
        }
        actions={
          <div className="toolbar-links">
            {/* The prototype's active/paused switch, as the detail's own
                control. */}
            <button
              type="button"
              className="switch"
              role="switch"
              aria-checked={!detail.title.paused}
              disabled={busy || archived}
              aria-label={
                detail.title.paused
                  ? t(locale, "web.catalogue.detail.unpause")
                  : t(locale, "web.catalogue.detail.pause")
              }
              title={
                detail.title.paused
                  ? t(locale, "web.catalogue.detail.unpause")
                  : t(locale, "web.catalogue.detail.pause")
              }
              onClick={() =>
                void mutate(async (csrfToken) => {
                  const { response } = await api.PATCH("/titles/{trackedTitleId}", {
                    params: {
                      path: { trackedTitleId: titleId },
                      header: { "X-Patrol-CSRF": csrfToken },
                    },
                    body: { paused: !detail.title.paused },
                  });
                  return response.ok;
                })
              }
            >
              <span className="switch-thumb" aria-hidden="true" />
            </button>
            <Link className="btn btn-ghost btn-sm" to="/catalogue/titles">
              {t(locale, "web.catalogue.titles.title")}
            </Link>
          </div>
        }
      />
      {error !== null && (
        <p className="banner" role="alert">
          {error}
        </p>
      )}
      {archived && (
        <p className="banner" role="status">
          {t(locale, "web.catalogue.detail.archived")}{" "}
          <Link to="/catalogue/titles/$titleId" params={{ titleId: detail.title.mergedIntoTitleId! }}>
            {detail.title.mergedIntoTitleId}
          </Link>
        </p>
      )}

      <Panel title={t(locale, "web.catalogue.detail.variants")}>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">{t(locale, "web.catalogue.detail.textLabel")}</th>
                <th scope="col">{t(locale, "web.catalogue.detail.kindLabel")}</th>
                <th scope="col">{t(locale, "web.catalogue.create.languageLabel")}</th>
                <th scope="col">{t(locale, "web.catalogue.create.sourceLabel")}</th>
              </tr>
            </thead>
            <tbody>
              {detail.variants.map((variant) => (
                <tr key={variant.id}>
                  <td>{variant.text}</td>
                  <td>{t(locale, VARIANT_KIND_MESSAGES[variant.kind])}</td>
                  <td>
                    {variant.language} / {variant.script}
                  </td>
                  <td>{t(locale, SOURCE_MESSAGES[variant.source])}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!archived && (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void mutate(async (csrfToken) => {
                const { response } = await api.POST(
                  "/titles/{trackedTitleId}/variants",
                  {
                    params: {
                      path: { trackedTitleId: titleId },
                      header: { "X-Patrol-CSRF": csrfToken },
                    },
                    body: {
                      text: variantText,
                      kind: variantKind,
                      language: variantLanguage,
                      script: "Latn",
                      source: "operator_knowledge",
                    },
                  },
                );
                return response.ok;
              });
              setVariantText("");
            }}
          >
            <label className="field">
              <span>{t(locale, "web.catalogue.detail.textLabel")}</span>
              <input className="input" value={variantText} onChange={(e) => setVariantText(e.target.value)} required />
            </label>
            <label className="field">
              <span>{t(locale, "web.catalogue.detail.kindLabel")}</span>
              <select
                className="select"
                value={variantKind}
                onChange={(e) =>
                  setVariantKind(
                    e.target.value as "localized" | "transliterated" | "alternate",
                  )
                }
              >
                <option value="localized">
                  {t(locale, "web.catalogue.variantKind.localized")}
                </option>
                <option value="transliterated">
                  {t(locale, "web.catalogue.variantKind.transliterated")}
                </option>
                <option value="alternate">
                  {t(locale, "web.catalogue.variantKind.alternate")}
                </option>
              </select>
            </label>
            <label className="field">
              <span>{t(locale, "web.catalogue.create.languageLabel")}</span>
              <input
                className="input"
                value={variantLanguage}
                onChange={(e) => setVariantLanguage(e.target.value)}
                required
              />
            </label>
            <button type="submit" className="btn btn-sm" disabled={busy}>
              <Icon name="plus" size="sm" />
              <span>{t(locale, "web.catalogue.detail.addVariant")}</span>
            </button>
          </form>
        )}
      </Panel>

      <Panel title={t(locale, "web.catalogue.detail.identifiers")}>
        <ul className="option-list" style={{ marginBottom: 14 }}>
          {detail.externalIdentifiers.map((identifier) => (
            <li key={identifier.id} className="option">
              <span className="option-name mono">
                {identifier.scheme}: {identifier.value}
              </span>
              <span className="option-sub">{t(locale, SOURCE_MESSAGES[identifier.source])}</span>
              {!archived && (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={busy}
                  onClick={() =>
                    void mutate(async (csrfToken) => {
                      const { response } = await api.DELETE(
                        "/titles/{trackedTitleId}/external-identifiers/{externalIdentifierId}",
                        {
                          params: {
                            path: {
                              trackedTitleId: titleId,
                              externalIdentifierId: identifier.id,
                            },
                            header: { "X-Patrol-CSRF": csrfToken },
                          },
                        },
                      );
                      return response.ok;
                    })
                  }
                >
                  {t(locale, "web.common.remove")}
                </button>
              )}
            </li>
          ))}
        </ul>
        {!archived && (
          <form
            className="form-row"
            onSubmit={(event) => {
              event.preventDefault();
              void mutate(async (csrfToken) => {
                const { response } = await api.POST(
                  "/titles/{trackedTitleId}/external-identifiers",
                  {
                    params: {
                      path: { trackedTitleId: titleId },
                      header: { "X-Patrol-CSRF": csrfToken },
                    },
                    body: { scheme: identifierScheme, value: identifierValue },
                  },
                );
                return response.ok;
              });
              setIdentifierValue("");
            }}
          >
            <label className="field">
              <span>{t(locale, "web.catalogue.create.identifierScheme")}</span>
              <select
                className="select"
                value={identifierScheme}
                onChange={(e) =>
                  setIdentifierScheme(
                    e.target.value as "wikidata" | "imdb" | "kinopoisk",
                  )
                }
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
                value={identifierValue}
                onChange={(e) => setIdentifierValue(e.target.value)}
                required
              />
            </label>
            <button type="submit" className="btn btn-sm" disabled={busy}>
              <Icon name="plus" size="sm" />
              <span>{t(locale, "web.catalogue.detail.addIdentifier")}</span>
            </button>
          </form>
        )}
      </Panel>

      {!archived && (
        <Panel title={t(locale, "web.catalogue.detail.mergeTitle")}>
          <form
            className="form-row"
            onSubmit={(event) => {
              event.preventDefault();
              void mutate(async (csrfToken) => {
                const { response } = await api.POST(
                  "/titles/{trackedTitleId}/merge",
                  {
                    params: {
                      path: { trackedTitleId: titleId },
                      header: { "X-Patrol-CSRF": csrfToken },
                    },
                    body: { survivingTitleId: mergeTarget },
                  },
                );
                return response.ok;
              });
            }}
          >
            <label className="field">
              <span>{t(locale, "web.catalogue.detail.mergeLabel")}</span>
              <input
                className="input mono"
                value={mergeTarget}
                onChange={(e) => setMergeTarget(e.target.value)}
                required
              />
            </label>
            <button type="submit" className="btn btn-danger btn-sm" disabled={busy}>
              {t(locale, "web.catalogue.detail.merge")}
            </button>
          </form>
        </Panel>
      )}
    </main>
  );
}
