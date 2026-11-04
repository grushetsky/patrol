import { useState } from "react";
import { createFileRoute, useSearch } from "@tanstack/react-router";
import { t } from "@patrol/i18n";
import { api } from "../../lib/api/client";
import { fetchCsrfToken } from "../../lib/api/auth";
import { resolveLocale } from "../../lib/i18n";
import { EnrollmentCeremony } from "../../lib/enrollment-ceremony";

/**
 * The bootstrap administrator's first visit (contract Authentication.setup):
 * the one-time setup token `patrol bootstrap` prints and a chosen password
 * are exchanged for an enrolment ceremony token, exactly like an invitation
 * acceptance — the same ceremony, a different token source.
 */
export const Route = createFileRoute("/auth/setup")({
  component: Setup,
  validateSearch: (search: Record<string, unknown>) => ({
    token: typeof search.token === "string" ? search.token : "",
  }),
});

function Setup() {
  const { token } = useSearch({ from: "/auth/setup" });
  const locale = resolveLocale(null, navigator.language);
  const [setupToken, setSetupToken] = useState(token);
  const [password, setPassword] = useState("");
  const [enrollmentToken, setEnrollmentToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const csrfToken = await fetchCsrfToken();
      const { data, error, response } = await api.POST("/auth/setup", {
        params: { header: { "X-Patrol-CSRF": csrfToken } },
        body: { token: setupToken, password },
      });
      if (response.status === 201 && data) {
        setEnrollmentToken(data.enrollmentToken);
        return;
      }
      if (error?.code === "invitation_invalid") {
        setError(t(locale, "errors.invitation_invalid"));
        return;
      }
      if (error?.code === "invitation_expired") {
        setError(t(locale, "errors.invitation_expired"));
        return;
      }
      setError(t(locale, "errors.internal_error"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <h1>{t(locale, "web.auth.setup.title")}</h1>
      {enrollmentToken === null ? (
        <form onSubmit={submit}>
          {error !== null && <p role="alert">{error}</p>}
          <label>
            {t(locale, "web.auth.setup.tokenLabel")}
            <input
              value={setupToken}
              autoComplete="off"
              onChange={(event) => setSetupToken(event.target.value)}
              required
            />
          </label>
          <label>
            {t(locale, "web.auth.enrollment.passwordLabel")}
            <input
              type="password"
              value={password}
              autoComplete="new-password"
              minLength={12}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </label>
          <button type="submit" disabled={busy}>
            {t(locale, "web.auth.enrollment.passwordSubmit")}
          </button>
        </form>
      ) : (
        <EnrollmentCeremony enrollmentToken={enrollmentToken} locale={locale} />
      )}
    </main>
  );
}
