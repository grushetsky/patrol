import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { t, type Locale } from "@patrol/i18n";
import { api } from "../../lib/api/client";
import { fetchSessionCsrfToken } from "../../lib/api/auth";
import { resolveLocale } from "../../lib/i18n";
import { Icon } from "../../components/icons";

/**
 * The interface-language preference (contract Sessions.updatePreferences):
 * stored on the account, applied across devices, and driving later API
 * messages and emails addressed to the operator.
 */
export const Route = createFileRoute("/auth/preferences")({
  component: Preferences,
});

function Preferences() {
  const [locale, setLocale] = useState<Locale>(() =>
    resolveLocale(null, navigator.language),
  );
  const [language, setLanguage] = useState<"en" | "ru">("en");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // The stored preference, when a session exists, beats the browser's
    // language both for this form's default and the page's own rendering.
    void api.GET("/auth/session").then(({ data, response }) => {
      if (response.ok && data) {
        const preferred = data.operator.preferredLanguage;
        if (preferred === "en" || preferred === "ru") {
          setLanguage(preferred);
          setLocale(preferred);
        }
      }
    });
  }, []);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      // An authenticated mutation echoes the session's own CSRF token —
      // the anonymous pair from GET /auth/csrf answers 403 here.
      const csrfToken = await fetchSessionCsrfToken();
      if (csrfToken === null) {
        setError(t(locale, "errors.unauthenticated"));
        return;
      }
      const { response } = await api.PATCH("/auth/preferences", {
        params: { header: { "X-Patrol-CSRF": csrfToken } },
        body: { language },
      });
      if (response.ok) {
        setSaved(true);
        setLocale(language);
        return;
      }
      setError(t(locale, "errors.internal_error"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="page">
      <div className="auth-card panel">
        <div className="panel-head">
          <h2>{t(locale, "web.auth.preferences.title")}</h2>
        </div>
        <div className="panel-body">
          {error !== null && (
            <p className="banner" role="alert">
              {error}
            </p>
          )}
          <form className="form-grid" onSubmit={save}>
            <label className="field">
              <span>{t(locale, "web.auth.preferences.languageLabel")}</span>
              <select
                className="select"
                value={language}
                onChange={(event) => setLanguage(event.target.value as "en" | "ru")}
              >
                <option value="en">English</option>
                <option value="ru">Русский</option>
              </select>
            </label>
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {t(locale, "web.auth.preferences.submit")}
            </button>
            {saved && (
              <p className="banner" role="status">
                <Icon name="check" size="sm" />
                {t(locale, "web.auth.preferences.saved")}
              </p>
            )}
          </form>
        </div>
      </div>
    </main>
  );
}
