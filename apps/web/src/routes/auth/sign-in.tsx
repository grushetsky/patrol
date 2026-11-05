import { useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { t } from "@patrol/i18n";
import { api } from "../../lib/api/client";
import { fetchCsrfToken } from "../../lib/api/auth";
import { resolveLocale } from "../../lib/i18n";
import { Icon } from "../../components/icons";

/**
 * The two-step sign-in (contract Authentication): the password produces a
 * 202 challenge, the second factor — a TOTP code or a recovery code —
 * produces the session cookie and the CSRF token the app then echoes on
 * every mutation.
 */
export const Route = createFileRoute("/auth/sign-in")({
  component: SignIn,
});

type Step = "password" | "second-factor";

function SignIn() {
  const navigate = useNavigate();
  const locale = resolveLocale(null, navigator.language);
  const [step, setStep] = useState<Step>("password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [method, setMethod] = useState<"totp" | "recovery_code">("totp");
  const [code, setCode] = useState("");
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submitPassword(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const token = await fetchCsrfToken();
      const { data, response } = await api.POST("/auth/sign-in", {
        params: { header: { "X-Patrol-CSRF": token } },
        body: { email, password },
      });
      if (response.status === 202 && data && "challengeId" in data) {
        setChallengeId(data.challengeId);
        setStep("second-factor");
        return;
      }
      setError(readError(response.status, data));
    } finally {
      setBusy(false);
    }
  }

  async function submitSecondFactor(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const token = await fetchCsrfToken();
      const { data, response } = await api.POST("/auth/second-factor", {
        params: { header: { "X-Patrol-CSRF": token } },
        body: { challengeId: challengeId!, code, method },
      });
      if (response.ok) {
        navigate({ to: "/" });
        return;
      }
      setError(readError(response.status, data));
    } finally {
      setBusy(false);
    }
  }

  function readError(status: number, data: unknown): string {
    const body = data as { code?: string } | undefined;
    if (body?.code === "account_locked") {
      return t(locale, "errors.account_locked");
    }
    if (status === 401) {
      return step === "password"
        ? t(locale, "errors.invalid_credentials")
        : t(locale, "errors.invalid_second_factor");
    }
    return t(locale, "errors.internal_error");
  }

  return (
    <main className="page">
      <div className="auth-card panel">
        <div className="panel-head">
          <h2>{t(locale, "web.auth.signIn.title")}</h2>
        </div>
        <div className="panel-body">
          <div className="auth-brand">
            <span className="brand-mark" aria-hidden="true">
              <Icon name="shield" />
            </span>
            Patrol
          </div>
          {error !== null && (
            <p className="banner" role="alert">
              {error}
            </p>
          )}
          {step === "password" ? (
            <form className="form-grid" onSubmit={submitPassword}>
              <label className="field">
                <span>{t(locale, "web.auth.signIn.emailLabel")}</span>
                <input
                  className="input"
                  type="email"
                  value={email}
                  autoComplete="username"
                  onChange={(event) => setEmail(event.target.value)}
                  required
                />
              </label>
              <label className="field">
                <span>{t(locale, "web.auth.signIn.passwordLabel")}</span>
                <input
                  className="input"
                  type="password"
                  value={password}
                  autoComplete="current-password"
                  onChange={(event) => setPassword(event.target.value)}
                  required
                />
              </label>
              <button type="submit" className="btn btn-primary" disabled={busy}>
                {t(locale, "web.auth.signIn.submit")}
              </button>
            </form>
          ) : (
            <form className="form-grid" onSubmit={submitSecondFactor}>
              <h2>{t(locale, "web.auth.signIn.secondFactorTitle")}</h2>
              <label className="field">
                <span>
                  {method === "totp"
                    ? t(locale, "web.auth.signIn.codeLabel")
                    : t(locale, "web.auth.signIn.recoveryCodeLabel")}
                </span>
                <input
                  className="input"
                  inputMode={method === "totp" ? "numeric" : "text"}
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  required
                />
              </label>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => {
                  setMethod(method === "totp" ? "recovery_code" : "totp");
                  setCode("");
                }}
              >
                {method === "totp"
                  ? t(locale, "web.auth.signIn.useRecoveryCode")
                  : t(locale, "web.auth.signIn.useTotp")}
              </button>
              <button type="submit" className="btn btn-primary" disabled={busy}>
                {t(locale, "web.auth.signIn.submitSecondFactor")}
              </button>
            </form>
          )}
        </div>
      </div>
    </main>
  );
}
