import { useEffect, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { t } from "@patrol/i18n";
import { api } from "../../lib/api/client";
import { fetchSessionCsrfToken } from "../../lib/api/auth";
import { useSession } from "../../lib/session";
import { PRIORITY_MESSAGES } from "../../lib/messages";
import { Chip, EmptyState, PageHead, Panel, Skeleton } from "../../components/ui";
import { Icon } from "../../components/icons";

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
    <main className="page stack">
      <PageHead
        eyebrow={t(locale, "web.nav.titles")}
        title={t(locale, "web.catalogue.title")}
        actions={
          <Link className="btn btn-ghost btn-sm" to="/catalogue/titles">
            {t(locale, "web.catalogue.titles.title")}
          </Link>
        }
      />
      {error !== null && (
        <p className="banner" role="alert">
          {error}
        </p>
      )}
      <Panel title={t(locale, "web.catalogue.groups.title")}>
        {groups === null ? (
          <div aria-busy="true">
            {[0, 1, 2].map((index) => (
              <div key={index} style={{ padding: "10px 0" }}>
                <Skeleton variant="wide" />
              </div>
            ))}
          </div>
        ) : groups.length === 0 ? (
          <EmptyState title={t(locale, "web.catalogue.groups.empty")} />
        ) : (
          <div className="table-wrap">
            <table className="table">
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
                    <td className="mono">{group.locales.join(", ")}</td>
                    <td className="mono">{group.scanTime}</td>
                    <td>
                      <Chip tone={group.priority === "high" ? "amber" : "muted"}>
                        {t(locale, PRIORITY_MESSAGES[group.priority])}
                      </Chip>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      <form onSubmit={createGroup}>
        <Panel title={t(locale, "web.catalogue.groups.create")}>
          <div className="form-row">
            <label className="field">
              <span>{t(locale, "web.catalogue.groups.nameLabel")}</span>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} required />
            </label>
            <label className="field">
              <span>{t(locale, "web.catalogue.groups.localesLabel")}</span>
              <input className="input" value={locales} onChange={(e) => setLocales(e.target.value)} required />
            </label>
            <label className="field">
              <span>{t(locale, "web.catalogue.groups.scanTimeLabel")}</span>
              <input
                className="input"
                type="time"
                min="02:00"
                max="05:59"
                value={scanTime}
                onChange={(e) => setScanTime(e.target.value)}
                required
              />
            </label>
            <label className="field">
              <span>{t(locale, "web.catalogue.groups.priorityLabel")}</span>
              <select
                className="select"
                value={priority}
                onChange={(e) => setPriority(e.target.value as "high" | "normal" | "low")}
              >
                <option value="high">{t(locale, "web.catalogue.priority.high")}</option>
                <option value="normal">{t(locale, "web.catalogue.priority.normal")}</option>
                <option value="low">{t(locale, "web.catalogue.priority.low")}</option>
              </select>
            </label>
            <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>
              <Icon name="plus" size="sm" />
              <span>{t(locale, "web.catalogue.groups.create")}</span>
            </button>
          </div>
        </Panel>
      </form>
    </main>
  );
}
