import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { t, type Locale } from "@patrol/i18n";
import { api } from "./api/client";
import { fetchCsrfToken } from "./api/auth";

/**
 * The TOTP enrolment ceremony every registration ends with: the enrollment
 * token the password step earned begins it, the operator scans the otpauth
 * URI or types the secret, the confirmation signs them in, and the ten
 * recovery codes are revealed exactly once, last.
 */
export function EnrollmentCeremony(props: {
  enrollmentToken: string;
  locale: Locale;
}) {
  const navigate = useNavigate();
  const { enrollmentToken, locale } = props;
  const [secret, setSecret] = useState<string | null>(null);
  const [otpauthUri, setOtpauthUri] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function begin(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const csrfToken = await fetchCsrfToken();
      const { data, response } = await api.POST("/auth/enrollment", {
        params: { header: { "X-Patrol-CSRF": csrfToken } },
        body: { enrollmentToken },
      });
      if (response.ok && data) {
        setSecret(data.secret);
        setOtpauthUri(data.otpauthUri);
        return;
      }
      setError(t(locale, "errors.internal_error"));
    } finally {
      setBusy(false);
    }
  }

  async function confirm(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const csrfToken = await fetchCsrfToken();
      const { data, response } = await api.POST("/auth/enrollment/confirmation", {
        params: { header: { "X-Patrol-CSRF": csrfToken } },
        body: { enrollmentToken, code },
      });
      if (response.status === 201 && data) {
        setRecoveryCodes(data.recoveryCodes);
        return;
      }
      setError(t(locale, "errors.invalid_second_factor"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {error !== null && <p role="alert">{error}</p>}
      {recoveryCodes !== null ? (
        <section>
          <h2>{t(locale, "web.auth.enrollment.recoveryTitle")}</h2>
          <p>{t(locale, "web.auth.enrollment.recoveryOnce")}</p>
          <ul>
            {recoveryCodes.map((recoveryCode) => (
              <li key={recoveryCode}>
                <code>{recoveryCode}</code>
              </li>
            ))}
          </ul>
          <p>{t(locale, "web.auth.enrollment.done")}</p>
          <button type="button" onClick={() => navigate({ to: "/" })}>
            {t(locale, "web.auth.enrollment.done")}
          </button>
        </section>
      ) : secret === null ? (
        <form onSubmit={begin}>
          <button type="submit" disabled={busy}>
            {t(locale, "web.auth.enrollment.start")}
          </button>
        </form>
      ) : (
        <form onSubmit={confirm}>
          <p>
            {t(locale, "web.auth.enrollment.secretLabel")}: <code>{secret}</code>
          </p>
          {otpauthUri !== null && (
            <p>
              {t(locale, "web.auth.enrollment.uriLabel")}{" "}
              <a href={otpauthUri}>{otpauthUri}</a>
            </p>
          )}
          <label>
            {t(locale, "web.auth.enrollment.codeLabel")}
            <input
              inputMode="numeric"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              required
            />
          </label>
          <button type="submit" disabled={busy}>
            {t(locale, "web.auth.enrollment.confirm")}
          </button>
        </form>
      )}
    </>
  );
}
