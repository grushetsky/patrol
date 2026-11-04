import { useEffect, useState } from "react";
import { Link, Outlet, useRouter } from "@tanstack/react-router";
import type { DashboardSummary, AuthenticatedSession } from "../api/server";
import { signOut, updateLanguage } from "../api/auth";
import { setCsrf, ApiError, errorMessage } from "../api/client";
import { LanguageContext, translate, type Language, type MessageKey } from "../i18n";
import { RunScansButton } from "./run-scans";
import { Badge, Button, cn } from "./ui";

const NAV: Array<{ to: string; key: MessageKey; badge?: "review" | "violations" | "notices" }> = [
  { to: "/dashboard", key: "dashboard" },
  { to: "/review", key: "review", badge: "review" },
  { to: "/violations", key: "violations", badge: "violations" },
  { to: "/notices", key: "notices", badge: "notices" },
  { to: "/titles", key: "titles" },
];

export function AppShell({
  session,
  summary,
  language: initialLanguage,
}: {
  session: AuthenticatedSession;
  summary: DashboardSummary;
  language: Language;
}) {
  const router = useRouter();
  const [language, setLanguage] = useState<Language>(initialLanguage);
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const saved = localStorage.getItem("patrol.theme");
    if (saved === "light" || saved === "dark") {
      setTheme(saved);
    }
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("patrol.theme", theme);
  }, [theme]);

  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  const t = (key: MessageKey) => translate(language, key);
  const badgeValue = (badge: "review" | "violations" | "notices") => {
    if (badge === "review") return summary.counters.candidatesToReview;
    if (badge === "violations") return summary.counters.openViolations;
    return summary.counters.draftNotices;
  };

  async function handleLanguage(next: Language) {
    if (next === language || busy) return;
    setBusy(true);
    setError(null);
    try {
      setCsrf(session.csrfToken);
      await updateLanguage(next, session.csrfToken);
      setLanguage(next);
      await router.invalidate();
    } catch (cause) {
      setError(errorMessage(cause, t("authErrorGeneric")));
    } finally {
      setBusy(false);
    }
  }

  async function handleSignOut() {
    if (busy) return;
    setBusy(true);
    try {
      setCsrf(session.csrfToken);
      await signOut(session.csrfToken);
      await router.invalidate();
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) {
        await router.invalidate();
      } else {
        setError(errorMessage(cause, t("authErrorGeneric")));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen">
      <header className="topbar-glass">
        <div className="flex flex-wrap items-center gap-3 px-4 py-3 md:px-5">
          <Link to="/dashboard" className="flex items-center gap-2 text-sm font-semibold tracking-tight">
            <span className="flex h-8 w-8 items-center justify-center rounded-xl border border-[var(--accent)]/40 bg-[var(--accent)]/10 text-[var(--accent)]">
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path d="M12 3.2 19 6v5.2c0 4.2-2.8 7.4-7 9-4.2-1.6-7-4.8-7-9V6l7-2.8Z" />
                <path d="m9 12 2.1 2.1L15.4 9.8" />
              </svg>
            </span>
            {t("appTitle")}
          </Link>

          <nav className="order-3 flex w-full items-center gap-1 overflow-x-auto rounded-[18px] border border-[var(--glass-border)] bg-[rgba(255,255,255,0.045)] p-1 backdrop-blur-xl md:order-none md:w-auto md:flex-1">
            {NAV.map((item) => {
              const value = item.badge ? badgeValue(item.badge) : 0;
              return (
                <Link
                  key={item.to}
                  to={item.to}
                  className="relative inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-2 text-sm text-[var(--muted)] transition hover:bg-[var(--surface-raised)] hover:text-[var(--fg)]"
                  activeProps={{
                    className:
                      "relative inline-flex items-center gap-1.5 whitespace-nowrap rounded-[14px] border border-[var(--glass-border)] bg-[var(--glass-bg)] px-3 py-2 text-sm font-medium text-[var(--fg)] shadow-[inset_0_1px_0_rgba(255,255,255,0.16)]",
                  }}
                >
                  {t(item.key)}
                  {value > 0 ? <Badge tone="warning">{value}</Badge> : null}
                </Link>
              );
            })}
          </nav>

          <div className="ml-auto flex items-center gap-1.5">
            <RunScansButton csrfToken={session.csrfToken} language={language} />
            <div className="flex rounded-lg border border-[var(--border)] p-0.5 text-xs">
              {(["en", "ru"] as const).map((code) => (
                <button
                  key={code}
                  type="button"
                  disabled={busy}
                  onClick={() => void handleLanguage(code)}
                  className={cn(
                    "rounded-md px-2 py-1 uppercase transition",
                    language === code
                      ? "bg-[var(--surface-raised)] font-semibold text-[var(--fg)]"
                      : "text-[var(--muted)] hover:text-[var(--fg)]",
                  )}
                >
                  {code}
                </button>
              ))}
            </div>
            <Button
              variant="ghost"
              className="px-2"
              title={theme === "dark" ? t("light") : t("dark")}
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            >
              {theme === "dark" ? (
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.7">
                  <circle cx="12" cy="12" r="4" />
                  <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.7">
                  <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" />
                </svg>
              )}
            </Button>
            <Button variant="ghost" className="px-2 text-xs" onClick={() => void handleSignOut()} disabled={busy}>
              {t("signOut")}
            </Button>
          </div>
        </div>
        {error ? (
          <div className="border-t border-[var(--error)]/30 bg-[var(--error)]/10 px-4 py-2 text-xs text-[var(--error)]">
            {error}
          </div>
        ) : null}
      </header>

      <main className="stack-page px-4 py-8 md:px-2 md:py-10">
        <LanguageContext.Provider value={language}>
          <Outlet />
        </LanguageContext.Provider>
      </main>

      <footer className="mx-auto flex w-full max-w-7xl items-center justify-between gap-4 px-4 pb-8 pt-2 text-xs text-[var(--muted)] md:px-6">
        <span>{t("footerNote")}</span>
        <div className="flex items-center gap-4">
          <Link to="/settings" className="hover:text-[var(--fg)]">
            {t("settings")}
          </Link>
          <a href="https://github.com/grushetsky/patrol" target="_blank" rel="noreferrer" className="hover:text-[var(--fg)]">
            {t("sourceCode")}
          </a>
        </div>
      </footer>
    </div>
  );
}
