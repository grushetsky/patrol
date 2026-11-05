import { useState } from "react";
import { createFileRoute, useSearch } from "@tanstack/react-router";
import { t } from "@patrol/i18n";
import { api } from "../../lib/api/client";
import { fetchCsrfToken } from "../../lib/api/auth";
import { resolveLocale } from "../../lib/i18n";
import { EnrollmentCeremony } from "../../lib/enrollment-ceremony";
import { Icon } from "../../components/icons";

/**
 * The invitation link's landing page (contract InvitationAcceptance): the
 * single-use token in the link and a chosen password are exchanged for an
 * enrolment ceremony token, which then drives the TOTP steps and the
 * one-time recovery-code reveal.
 */
export const Route = createFileRoute("/auth/enrollment")({
  component: Enrollment,
  validateSearch: (search: Record<string, unknown>) => ({
    token: typeof search.token === "string" ? search.token : "",
  }),
});

function Enrollment() {
  const { token } = useSearch({ from: "/auth/enrollment" });
  const locale = resolveLocale(null, navigator.language);
  const [password, setPassword] = useState("");
  const [enrollmentToken, setEnrollmentToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function accept(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const csrfToken = await fetchCsrfToken();
      const { data, error, response } = await api.POST(
        "/invitations/{token}/acceptance",
        {
          params: { path: { token }, header: { "X-Patrol-CSRF": csrfToken } },
          body: { password },
        },
      );
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
    <main className="page">
      <div className="auth-card panel">
        <div className="panel-head">
          <h2>{t(locale, "web.auth.enrollment.title")}</h2>
        </div>
        <div className="panel-body">
          <div className="auth-brand">
            <span className="brand-mark" aria-hidden="true">
              <Icon name="shield" />
            </span>
            Patrol
          </div>
          {enrollmentToken === null ? (
            <form className="form-grid" onSubmit={accept}>
              {error !== null && (
                <p className="banner" role="alert">
                  {error}
                </p>
              )}
              <label className="field">
                <span>{t(locale, "web.auth.enrollment.passwordLabel")}</span>
                <input
                  className="input"
                  type="password"
                  value={password}
                  autoComplete="new-password"
                  minLength={12}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                />
              </label>
              <button type="submit" className="btn btn-primary" disabled={busy || token === ""}>
                {t(locale, "web.auth.enrollment.passwordSubmit")}
              </button>
            </form>
          ) : (
            <EnrollmentCeremony enrollmentToken={enrollmentToken} locale={locale} />
          )}
        </div>
      </div>
    </main>
  );
}
