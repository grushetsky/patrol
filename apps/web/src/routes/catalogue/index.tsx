import { useEffect, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { t } from "@patrol/i18n";
import { api } from "../../lib/api/client";
import { fetchSessionCsrfToken } from "../../lib/api/auth";
import { useSession } from "../../lib/session";
import { PRIORITY_MESSAGES } from "../../lib/messages";

/**
 * The catalogue landing screen: title groups with their scan settings, the
 * create-group form, and the way into the titles list. Locales are typed
 * as a comma-separated list because the group declares a handful.
 */
export const Route = createFileRoute("/catalogue/")({
  component: CatalogueIndex,
});

interface TitleGroup {
  id: string;
  name: string;
  locales: string[];
  scanTime: string;
  priority: "high" | "normal" | "low";
}

function CatalogueIndex() {
  const { locale } = useSession();
  const [groups, setGroups] = useState<TitleGroup[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [locales, setLocales] = useState("en, ru");
  const [scanTime, setScanTime] = useState("02:30");
  const [priority, setPriority] = useState<"high" | "normal" | "low">("normal");
  const [busy, setBusy] = useState(false);

  async function load() {
    const { data, response } = await api.GET("/title-groups");
    if (response.ok && data) {
      setGroups(data.items as TitleGroup[]);
    } else {
      setError(t(locale, "web.common.error"));
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function createGroup(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const csrfToken = await fetchSessionCsrfToken();
      if (csrfToken === null) {
        setError(t(locale, "errors.unauthenticated"));
        return;
      }
      const { response } = await api.POST("/title-groups", {
        params: { header: { "X-Patrol-CSRF": csrfToken } },
        body: {
          name,
          locales: locales
            .split(",")
            .map((part) => part.trim())
            .filter((part) => part.length > 0),
          // plainTime on the wire is HH:MM:SSZ; the time input gives HH:MM.
          scanTime: `${scanTime}:00Z`,
          priority,
        },
      });
      if (!response.ok) {
        setError(t(locale, "web.common.error"));
        return;
      }
      setName("");
      await load();
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <h1>{t(locale, "web.catalogue.title")}</h1>
      {error !== null && <p role="alert">{error}</p>}
      <section>
        <h2>{t(locale, "web.catalogue.groups.title")}</h2>
        <p>
          <Link to="/catalogue/titles">{t(locale, "web.catalogue.titles.title")}</Link>
        </p>
        {groups === null ? (
          <p>{t(locale, "web.common.loading")}</p>
        ) : groups.length === 0 ? (
          <p>{t(locale, "web.catalogue.groups.empty")}</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th scope="col">{t(locale, "web.catalogue.groups.nameLabel")}</th>
                <th scope="col">{t(locale, "web.catalogue.groups.localesLabel")}</th>
                <th scope="col">{t(locale, "web.catalogue.groups.scanTimeLabel")}</th>
                <th scope="col">{t(locale, "web.catalogue.groups.priorityLabel")}</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((group) => (
                <tr key={group.id}>
                  <td>
                    <Link
                      to="/catalogue/titles"
                      search={{ titleGroupId: group.id }}
                    >
                      {group.name}
                    </Link>
                  </td>
                  <td>{group.locales.join(", ")}</td>
                  <td>{group.scanTime}</td>
                  <td>{t(locale, PRIORITY_MESSAGES[group.priority])}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <section>
        <form onSubmit={createGroup}>
          <label>
            {t(locale, "web.catalogue.groups.nameLabel")}
            <input value={name} onChange={(e) => setName(e.target.value)} required />
          </label>
          <label>
            {t(locale, "web.catalogue.groups.localesLabel")}
            <input value={locales} onChange={(e) => setLocales(e.target.value)} required />
          </label>
          <label>
            {t(locale, "web.catalogue.groups.scanTimeLabel")}
            <input
              type="time"
              min="02:00"
              max="05:59"
              value={scanTime}
              onChange={(e) => setScanTime(e.target.value)}
              required
            />
          </label>
          <label>
            {t(locale, "web.catalogue.groups.priorityLabel")}
            <select
              value={priority}
              onChange={(e) => setPriority(e.target.value as "high" | "normal" | "low")}
            >
              <option value="high">{t(locale, "web.catalogue.priority.high")}</option>
              <option value="normal">{t(locale, "web.catalogue.priority.normal")}</option>
              <option value="low">{t(locale, "web.catalogue.priority.low")}</option>
            </select>
          </label>
          <button type="submit" disabled={busy}>
            {t(locale, "web.catalogue.groups.create")}
          </button>
        </form>
      </section>
    </main>
  );
}
