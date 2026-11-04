import { useState } from "react";
import { useRouter } from "@tanstack/react-router";
import {
  confirmEnrollment,
  setupAccount,
  signIn,
  startEnrollment,
  verifySecondFactor,
  type EnrollmentCeremony,
  type RegistrationCompleted,
  type TotpEnrollment,
} from "../api/auth";
import { errorMessage, setCsrf } from "../api/client";
import type { SetupState } from "../api/server";
import { translate, type Language } from "../i18n";
import { Button, Card, Field, Input, Spinner } from "./ui";

type Mode = "signIn" | "secondFactor" | "setup" | "enrollment" | "recoveryCodes";

export function AuthFlow({
  setup,
  language,
}: {
  setup: SetupState;
  language: Language;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>(setup.bootstrapped ? "signIn" : "setup");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [token, setToken] = useState("");
  const [challengeId, setChallengeId] = useState("");
  const [code, setCode] = useState("");
  const [method, setMethod] = useState<"totp" | "recovery_code">("totp");
  const [ceremony, setCeremony] = useState<EnrollmentCeremony | null>(null);
  const [enrollment, setEnrollment] = useState<TotpEnrollment | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const t = (key: Parameters<typeof translate>[1]) => translate(language, key);

  function fail(cause: unknown) {
    setError(errorMessage(cause, t("authErrorGeneric")));
  }

  async function handleSignIn(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const challenge = await signIn(email, password);
      setChallengeId(challenge.challengeId);
      setCode("");
      setMode("secondFactor");
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(false);
    }
  }

  async function handleSecondFactor(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await verifySecondFactor(challengeId, code, method);
      setCsrf(result.csrfToken);
      await router.invalidate();
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(false);
    }
  }

  async function handleSetup(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const ceremonyResult = await setupAccount(token.trim(), password);
      const enrollmentResult = await startEnrollment(ceremonyResult.enrollmentToken);
      setCeremony(ceremonyResult);
      setEnrollment(enrollmentResult);
      setCode("");
      setMode("enrollment");
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(false);
    }
  }

  async function handleEnrollment(event: React.FormEvent) {
    event.preventDefault();
    if (!ceremony) return;
    setBusy(true);
    setError(null);
    try {
      const result: RegistrationCompleted = await confirmEnrollment(
        ceremony.enrollmentToken,
        code,
      );
      setCsrf(result.csrfToken);
      setRecoveryCodes(result.recoveryCodes);
      setMode("recoveryCodes");
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-xl">
        <div className="mb-6 flex items-center justify-center gap-2 text-lg font-semibold tracking-tight">
          <span className="flex h-10 w-10 items-center justify-center rounded-2xl border border-[var(--accent)]/40 bg-[var(--accent)]/10 text-[var(--accent)]">
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M12 3.2 19 6v5.2c0 4.2-2.8 7.4-7 9-4.2-1.6-7-4.8-7-9V6l7-2.8Z" />
              <path d="m9 12 2.1 2.1L15.4 9.8" />
            </svg>
          </span>
          {t("appTitle")}
        </div>

        <Card className="p-6 md:p-8">
          {mode === "signIn" ? (
            <form className="space-y-5" onSubmit={handleSignIn}>
              <header className="space-y-1">
                <h1 className="auth-title text-3xl">{t("authSignInTitle")}</h1>
                <p className="text-sm text-[var(--muted)]">{t("authSignInLead")}</p>
              </header>
              <Field label={t("authEmail")}>
                <Input
                  type="email"
                  autoComplete="username"
                  required
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </Field>
              <Field label={t("authPassword")}>
                <Input
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </Field>
              {error ? <p className="text-sm text-[var(--error)]">{error}</p> : null}
              <div className="flex items-center justify-between gap-3">
                <Button type="submit" disabled={busy}>
                  {busy ? t("authSigningIn") : t("authSignIn")}
                </Button>
                <button
                  type="button"
                  className="text-xs text-[var(--muted)] underline-offset-4 hover:text-[var(--fg)] hover:underline"
                  onClick={() => {
                    setError(null);
                    setMode("setup");
                  }}
                >
                  {t("authSetupTitle")}
                </button>
              </div>
            </form>
          ) : null}

          {mode === "secondFactor" ? (
            <form className="space-y-5" onSubmit={handleSecondFactor}>
              <header className="space-y-1">
                <h1 className="auth-title text-3xl">{t("authSecondFactorTitle")}</h1>
                <p className="text-sm text-[var(--muted)]">{t("authSecondFactorLead")}</p>
              </header>
              <Field label={method === "totp" ? t("authCode") : t("authRecoveryCode")}>
                <Input
                  inputMode={method === "totp" ? "numeric" : "text"}
                  autoComplete="one-time-code"
                  autoFocus
                  required
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                />
              </Field>
              {error ? <p className="text-sm text-[var(--error)]">{error}</p> : null}
              <div className="flex flex-wrap items-center justify-between gap-3">
                <Button type="submit" disabled={busy}>
                  {busy ? t("authVerifying") : t("authVerify")}
                </Button>
                <button
                  type="button"
                  className="text-xs text-[var(--muted)] underline-offset-4 hover:text-[var(--fg)] hover:underline"
                  onClick={() => {
                    setError(null);
                    setCode("");
                    setMethod(method === "totp" ? "recovery_code" : "totp");
                  }}
                >
                  {method === "totp" ? t("authUseRecovery") : t("authUseTotp")}
                </button>
              </div>
            </form>
          ) : null}

          {mode === "setup" ? (
            <form className="space-y-5" onSubmit={handleSetup}>
              <header className="space-y-1">
                <h1 className="auth-title text-3xl">{t("authSetupTitle")}</h1>
                <p className="text-sm text-[var(--muted)]">{t("authSetupLead")}</p>
              </header>
              {!setup.bootstrapped ? (
                <div className="rounded-xl border border-[var(--warning)]/30 bg-[var(--warning)]/10 p-3 text-xs text-[var(--warning)]">
                  <strong className="block">{t("authBootstrapMissing")}</strong>
                  <span className="mt-1 block text-[var(--muted)]">{t("authBootstrapHint")}</span>
                </div>
              ) : null}
              <Field label={t("authSetupToken")}>
                <Input
                  required
                  value={token}
                  onChange={(event) => setToken(event.target.value)}
                />
              </Field>
              <Field label={t("authChoosePassword")} hint="12+ characters.">
                <Input
                  type="password"
                  autoComplete="new-password"
                  minLength={12}
                  required
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </Field>
              {error ? <p className="text-sm text-[var(--error)]">{error}</p> : null}
              <div className="flex items-center justify-between gap-3">
                <Button type="submit" disabled={busy}>
                  {busy ? t("authCreating") : t("authCreateAccount")}
                </Button>
                {setup.bootstrapped ? (
                  <button
                    type="button"
                    className="text-xs text-[var(--muted)] underline-offset-4 hover:text-[var(--fg)] hover:underline"
                    onClick={() => {
                      setError(null);
                      setMode("signIn");
                    }}
                  >
                    {t("authSignIn")}
                  </button>
                ) : null}
              </div>
            </form>
          ) : null}

          {mode === "enrollment" && enrollment ? (
            <form className="space-y-5" onSubmit={handleEnrollment}>
              <header className="space-y-1">
                <h1 className="auth-title text-3xl">{t("authEnrollmentTitle")}</h1>
                <p className="text-sm text-[var(--muted)]">{t("authEnrollmentLead")}</p>
              </header>
              <div className="space-y-2 rounded-xl border border-[var(--border)] bg-[var(--bg)] p-3 font-mono text-xs">
                <div>
                  <span className="block text-[10px] uppercase tracking-wide text-[var(--muted)]">
                    {t("authSecret")}
                  </span>
                  <span className="break-all">{enrollment.secret}</span>
                </div>
                <div>
                  <span className="block text-[10px] uppercase tracking-wide text-[var(--muted)]">
                    {t("authOtpauth")}
                  </span>
                  <span className="break-all">{enrollment.otpauthUri}</span>
                </div>
              </div>
              <Field label={t("authCode")}>
                <Input
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  autoFocus
                  required
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                />
              </Field>
              {error ? <p className="text-sm text-[var(--error)]">{error}</p> : null}
              <Button type="submit" disabled={busy}>
                {busy ? t("authCompleting") : t("authCompleteEnrollment")}
              </Button>
            </form>
          ) : null}

          {mode === "recoveryCodes" ? (
            <div className="space-y-5">
              <header className="space-y-1">
                <h1 className="auth-title text-3xl">{t("authRecoveryCodesTitle")}</h1>
                <p className="text-sm text-[var(--muted)]">{t("authRecoveryCodesLead")}</p>
              </header>
              <div className="grid grid-cols-2 gap-2 rounded-xl border border-[var(--border)] bg-[var(--bg)] p-4 font-mono text-sm">
                {recoveryCodes.map((recovery) => (
                  <span key={recovery}>{recovery}</span>
                ))}
              </div>
              <Button type="button" onClick={() => void router.invalidate()}>
                {t("authCodesSaved")}
              </Button>
            </div>
          ) : null}
        </Card>

        <p className="mt-4 text-center text-xs text-[var(--muted)]">
          {busy ? <Spinner /> : null}
        </p>
      </div>
    </div>
  );
}
