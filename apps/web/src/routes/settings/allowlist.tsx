import { useCallback, useEffect, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { t } from "@patrol/i18n";
import { api } from "../../lib/api/client";
import { fetchSessionCsrfToken } from "../../lib/api/auth";
import { useSession } from "../../lib/session";
import {
  ALLOWLIST_KIND_MESSAGES,
  ALLOWLIST_MATCH_MESSAGES,
  ALLOWLIST_SCOPE_MESSAGES,
} from "../../lib/messages";

/**
 * The allowlist table with its add form and removal. Any operator may add
 * or remove an entry; the filters mirror the contract's query parameters.
 */
export const Route = createFileRoute("/settings/allowlist")({
  component: AllowlistScreen,
});

interface Entry {
  id: string;
  kind: "official_domain" | "licensed_destination" | "neutral_source";
  matchKind: "host" | "url_prefix";
  value: string;
  scope: "rights_holder" | "title_group" | "tracked_title";
  territory?: string;
}

function AllowlistScreen() {
  const { locale } = useSession();
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [kind, setKind] = useState<"official_domain" | "licensed_destination" | "neutral_source">(
    "official_domain",
  );
  const [matchKind, setMatchKind] = useState<"host" | "url_prefix">("host");
  const [value, setValue] = useState("");
  const [scope, setScope] = useState<"rights_holder" | "title_group" | "tracked_title">(
    "rights_holder",
  );
  const [target, setTarget] = useState("");
  const [territory, setTerritory] = useState("");

  const load = useCallback(async () => {
    const { data, response } = await api.GET("/settings/allowlist");
    if (response.ok && data) {
      setEntries(data.items as Entry[]);
    } else {
      setError(t(locale, "web.common.error"));
    }
  }, [locale]);

  useEffect(() => {
    void load();
  }, [load]);

  async function add(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const csrfToken = await fetchSessionCsrfToken();
      if (csrfToken === null) {
        setError(t(locale, "errors.unauthenticated"));
        return;
      }
      const { response } = await api.POST("/settings/allowlist", {
        params: { header: { "X-Patrol-CSRF": csrfToken } },
        body: {
          kind,
          matchKind,
          value,
          scope,
          ...(scope === "title_group" && target.length > 0
            ? { titleGroupId: target }
            : {}),
          ...(scope === "tracked_title" && target.length > 0
            ? { trackedTitleId: target }
            : {}),
          ...(kind === "licensed_destination" && territory.length > 0
            ? { territory }
            : {}),
        },
      });
      if (response.ok) {
        setValue("");
        await load();
        return;
      }
      setError(t(locale, "web.common.error"));
    } finally {
      setBusy(false);
    }
  }

  async function remove(entryId: string) {
    setBusy(true);
    setError(null);
    try {
      const csrfToken = await fetchSessionCsrfToken();
      if (csrfToken === null) {
        setError(t(locale, "errors.unauthenticated"));
        return;
      }
      const { response } = await api.DELETE("/settings/allowlist/{allowlistEntryId}", {
        params: {
          path: { allowlistEntryId: entryId },
          header: { "X-Patrol-CSRF": csrfToken },
        },
      });
      if (response.ok) {
        await load();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <h1>{t(locale, "web.settings.allowlist.title")}</h1>
      <p>
        <Link to="/settings">{t(locale, "web.settings.title")}</Link>
      </p>
      {error !== null && <p role="alert">{error}</p>}
      {entries === null ? (
        <p>{t(locale, "web.common.loading")}</p>
      ) : entries.length === 0 ? (
        <p>{t(locale, "web.settings.allowlist.empty")}</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th scope="col">{t(locale, "web.settings.allowlist.kind")}</th>
              <th scope="col">{t(locale, "web.settings.allowlist.matchKind")}</th>
              <th scope="col">{t(locale, "web.settings.allowlist.value")}</th>
              <th scope="col">{t(locale, "web.settings.allowlist.scope")}</th>
              <th scope="col">{t(locale, "web.settings.allowlist.territory")}</th>
              <th scope="col" />
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={entry.id}>
                <td>{t(locale, ALLOWLIST_KIND_MESSAGES[entry.kind])}</td>
                <td>{t(locale, ALLOWLIST_MATCH_MESSAGES[entry.matchKind])}</td>
                <td>{entry.value}</td>
                <td>{t(locale, ALLOWLIST_SCOPE_MESSAGES[entry.scope])}</td>
                <td>{entry.territory ?? "—"}</td>
                <td>
                  <button disabled={busy} onClick={() => void remove(entry.id)}>
                    {t(locale, "web.common.remove")}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <form onSubmit={add}>
        <label>
          {t(locale, "web.settings.allowlist.kind")}
          <select
            value={kind}
            onChange={(e) =>
              setKind(
                e.target.value as
                  | "official_domain"
                  | "licensed_destination"
                  | "neutral_source",
              )
            }
          >
            {(["official_domain", "licensed_destination", "neutral_source"] as const).map(
              (option) => (
                <option key={option} value={option}>
                  {t(locale, ALLOWLIST_KIND_MESSAGES[option])}
                </option>
              ),
            )}
          </select>
        </label>
        <label>
          {t(locale, "web.settings.allowlist.matchKind")}
          <select
            value={matchKind}
            onChange={(e) => setMatchKind(e.target.value as "host" | "url_prefix")}
          >
            <option value="host">{t(locale, "web.allowlist.matchKind.host")}</option>
            <option value="url_prefix">
              {t(locale, "web.allowlist.matchKind.url_prefix")}
            </option>
          </select>
        </label>
        <label>
          {t(locale, "web.settings.allowlist.value")}
          <input value={value} onChange={(e) => setValue(e.target.value)} required />
        </label>
        <label>
          {t(locale, "web.settings.allowlist.scope")}
          <select
            value={scope}
            onChange={(e) =>
              setScope(
                e.target.value as "rights_holder" | "title_group" | "tracked_title",
              )
            }
          >
            {(["rights_holder", "title_group", "tracked_title"] as const).map((option) => (
              <option key={option} value={option}>
                {t(locale, ALLOWLIST_SCOPE_MESSAGES[option])}
              </option>
            ))}
          </select>
        </label>
        {scope !== "rights_holder" && (
          <label>
            {t(locale, "web.settings.allowlist.target")}
            <input value={target} onChange={(e) => setTarget(e.target.value)} required />
          </label>
        )}
        {kind === "licensed_destination" && (
          <label>
            {t(locale, "web.settings.allowlist.territory")}
            <input
              value={territory}
              onChange={(e) => setTerritory(e.target.value)}
              pattern="[A-Z]{2}"
              required
            />
          </label>
        )}
        <button type="submit" disabled={busy}>
          {t(locale, "web.settings.allowlist.add")}
        </button>
      </form>
    </main>
  );
}
