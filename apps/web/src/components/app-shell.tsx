import { useCallback, useEffect, useState } from "react";
import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import { interpolate, t } from "@patrol/i18n";
import { api } from "../lib/api/client";
import { fetchSessionCsrfToken } from "../lib/api/auth";
import { setSessionLocale, useSession } from "../lib/session";
import { applyTheme, currentTheme, type Theme } from "../lib/theme";
import { Icon, type IconName } from "./icons";
import { Modal } from "./modal";
import { ToastProvider, useToast } from "./toast";

/**
 * The persistent shell (docs/design/dashboard-ui.md "Shell"): a floating top
 * bar with the five section tabs — Review, Violations, and Notices carrying
 * their pending-count badges — the language switch, the theme toggle, and
 * Run scans; a footer reaches Settings. The tab bar is the prototype's
 * surface; every screen renders beneath it in <main class="page">.
 *
 * Not carried over, per the prototype's demonstration-aids rule and the
 * deviations note in dashboard-ui.md: the siren toggle, the prototype-state
 * bar, and the footer's reset control — the reset button resets the
 * prototype's in-memory demo state, which the production app does not have
 * (its state is server-side; the client holds only the theme and language
 * preferences, each resettable where it is set).
 */

const SECTIONS: Array<{
  to: "/" | "/review" | "/violations" | "/notices" | "/catalogue/titles";
  labelKey: "web.nav.dashboard" | "web.nav.review" | "web.nav.violations" | "web.nav.notices" | "web.nav.titles";
  icon: IconName;
  exact?: boolean;
}> = [
  { to: "/", labelKey: "web.nav.dashboard", icon: "gauge", exact: true },
  { to: "/review", labelKey: "web.nav.review", icon: "radar" },
  { to: "/violations", labelKey: "web.nav.violations", icon: "shield" },
  { to: "/notices", labelKey: "web.nav.notices", icon: "file" },
  { to: "/catalogue/titles", labelKey: "web.nav.titles", icon: "film" },
];

/** The tabs' pending counts, answered by the dashboard summary's counters:
 *  candidates awaiting review, open violations, and draft notices. */
interface BadgeCounts {
  candidatesToReview: number;
  openViolations: number;
  draftNotices: number;
}

interface TitleGroupOption {
  id: string;
  name: string;
  locales: string[];
  priority: "high" | "normal" | "low";
}

export function AppShell() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const { locale } = useSession();
  useEffect(() => {
    // The interface's language is announced on the document, not just shown.
    document.documentElement.lang = locale;
  }, [locale]);
  const bare = pathname.startsWith("/auth");
  return (
    <ToastProvider>
      <div className="top-veil" aria-hidden="true" />
      {!bare && <TopBar />}
      <Outlet />
      {!bare && (
        <footer className="foot">
          <span className="foot-links">
            <Link to="/settings">{t(locale, "web.nav.settings")}</Link>
          </span>
        </footer>
      )}
    </ToastProvider>
  );
}

function TopBar() {
  const { locale } = useSession();
  const [badges, setBadges] = useState<BadgeCounts | null>(null);
  const [scanOpen, setScanOpen] = useState(false);

  useEffect(() => {
    // Unauthenticated visits (the auth screens) answer 401: no badges.
    let live = true;
    void api.GET("/dashboard/summary").then(({ data, response }) => {
      if (live && response.ok && data) {
        const counters = data.counters;
        setBadges({
          candidatesToReview: counters.candidatesToReview,
          openViolations: counters.openViolations,
          draftNotices: counters.draftNotices,
        });
      }
    });
    return () => {
      live = false;
    };
  }, []);

  return (
    <header className="topbar">
      <Link className="brand" to="/" aria-label={t(locale, "web.nav.dashboard")}>
        <span className="brand-mark">
          <Icon name="shield" />
        </span>
        <span className="brand-name">Patrol</span>
      </Link>

      <nav className="tabs" aria-label={t(locale, "web.nav.sections")}>
        {SECTIONS.map((section) => (
          <Tab
            key={section.to}
            to={section.to}
            exact={section.exact}
            icon={section.icon}
            label={t(locale, section.labelKey)}
            badge={badgeFor(section.labelKey, badges, locale)}
          />
        ))}
      </nav>

      <div className="topbar-actions">
        <LanguageSwitch />
        <ThemeToggleButton />
        <button type="button" className="btn btn-primary" onClick={() => setScanOpen(true)}>
          <Icon name="radar" size="sm" />
          <span>{t(locale, "web.scan.run")}</span>
        </button>
      </div>

      <RunScansDialog open={scanOpen} onClose={() => setScanOpen(false)} />
    </header>
  );
}

function badgeFor(
  labelKey: (typeof SECTIONS)[number]["labelKey"],
  badges: BadgeCounts | null,
  locale: "en" | "ru",
): { count: number; label: string; tone?: "amber" } | null {
  if (badges === null) {
    return null;
  }
  if (labelKey === "web.nav.review" && badges.candidatesToReview > 0) {
    return {
      count: badges.candidatesToReview,
      label: interpolate(t(locale, "web.nav.badge.candidates"), {
        count: String(badges.candidatesToReview),
      }),
    };
  }
  if (labelKey === "web.nav.violations" && badges.openViolations > 0) {
    return {
      count: badges.openViolations,
      label: interpolate(t(locale, "web.nav.badge.openViolations"), {
        count: String(badges.openViolations),
      }),
    };
  }
  if (labelKey === "web.nav.notices" && badges.draftNotices > 0) {
    return {
      count: badges.draftNotices,
      label: interpolate(t(locale, "web.nav.badge.draftNotices"), {
        count: String(badges.draftNotices),
      }),
      tone: "amber",
    };
  }
  return null;
}

function Tab(props: {
  to: (typeof SECTIONS)[number]["to"];
  exact?: boolean;
  icon: IconName;
  label: string;
  badge: { count: number; label: string; tone?: "amber" } | null;
}) {
  const { to, exact, icon, label, badge } = props;
  return (
    <Link to={to} className="tab" activeOptions={{ exact: exact === true }}>
      <Icon name={icon} />
      <span>{label}</span>
      {badge !== null && (
        <span className="count" data-tone={badge.tone} aria-label={badge.label}>
          {badge.count}
        </span>
      )}
    </Link>
  );
}

/** EN/RU: persists on the account (PATCH /auth/preferences) when a session
 *  stands, and applies locally otherwise — the auth screens' visitor. */
function LanguageSwitch() {
  const { locale } = useSession();
  const toast = useToast();

  const choose = useCallback(
    async (language: "en" | "ru") => {
      setSessionLocale(language);
      const csrfToken = await fetchSessionCsrfToken();
      if (csrfToken === null) {
        return;
      }
      const { response } = await api.PATCH("/auth/preferences", {
        params: { header: { "X-Patrol-CSRF": csrfToken } },
        body: { language },
      });
      if (!response.ok) {
        toast(t(language, "web.common.error"), "red");
      }
    },
    [toast],
  );

  return (
    <div className="lang-switch" role="group" aria-label={t(locale, "web.nav.language")}>
      {(["en", "ru"] as const).map((language) => (
        <button
          key={language}
          type="button"
          lang={language}
          aria-pressed={locale === language}
          onClick={() => void choose(language)}
        >
          {language === "en" ? "EN" : "RU"}
        </button>
      ))}
    </div>
  );
}

function ThemeToggleButton() {
  const { locale } = useSession();
  // The server cannot know the stamped theme, so both sides render the dark
  // default and the mount effect adopts the browser's actual theme — a
  // post-hydration update, never a mismatch.
  const [theme, setTheme] = useState<Theme>("dark");
  useEffect(() => {
    setTheme(currentTheme());
  }, []);
  const next = theme === "light" ? "dark" : "light";
  return (
    <button
      type="button"
      className="btn btn-ghost btn-icon theme-toggle"
      aria-pressed={theme === "light"}
      aria-label={t(locale, next === "light" ? "web.theme.toLight" : "web.theme.toDark")}
      title={t(locale, next === "light" ? "web.theme.toLight" : "web.theme.toDark")}
      onClick={() => {
        applyTheme(next);
        setTheme(next);
      }}
    >
      <Icon name="sun" className="icon--sun" />
      <Icon name="moon" className="icon--moon" />
    </button>
  );
}

/**
 * Run scans (contract Scans_request): the operator names the title groups to
 * scan; each group is one POST /scans with trigger "manual", which queues one
 * scan per enabled engine (the request omits `engine`). The API answers 202
 * with the queued scans — idempotent per group, engine, and due date, so
 * re-running the same day returns the standing scans.
 */
function RunScansDialog(props: { open: boolean; onClose: () => void }) {
  const { open, onClose } = props;
  const { locale } = useSession();
  const toast = useToast();
  const [groups, setGroups] = useState<TitleGroupOption[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) {
      return;
    }
    let live = true;
    void api.GET("/title-groups").then(({ data, response }) => {
      if (live && response.ok && data) {
        setGroups(data.items as TitleGroupOption[]);
      } else if (live) {
        setGroups([]);
      }
    });
    return () => {
      live = false;
    };
  }, [open]);

  const toggle = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const run = useCallback(async () => {
    setBusy(true);
    try {
      const csrfToken = await fetchSessionCsrfToken();
      if (csrfToken === null) {
        toast(t(locale, "errors.unauthenticated"), "red");
        return;
      }
      let queued = 0;
      let failed = 0;
      for (const groupId of selected) {
        const { response } = await api.POST("/scans", {
          params: { header: { "X-Patrol-CSRF": csrfToken } },
          body: { titleGroupId: groupId, trigger: "manual" },
        });
        if (response.status === 202) {
          queued += 1;
        } else {
          failed += 1;
        }
      }
      if (queued > 0) {
        toast(
          interpolate(t(locale, "web.scan.queued"), { groups: String(queued) }),
          "green",
        );
      }
      if (failed > 0) {
        toast(interpolate(t(locale, "web.scan.failed"), { groups: String(failed) }), "red");
      }
      if (queued > 0) {
        setSelected(new Set());
        onClose();
      }
    } finally {
      setBusy(false);
    }
  }, [locale, onClose, selected, toast]);

  return (
    <Modal
      open={open}
      title={t(locale, "web.scan.dialog.title")}
      closeLabel={t(locale, "web.common.close")}
      onClose={onClose}
    >
      <p className="settings-lede">{t(locale, "web.scan.dialog.lede")}</p>
      {groups === null ? (
        <div className="option-list" aria-busy="true">
          {[0, 1, 2].map((index) => (
            <span key={index} className="skeleton skeleton--wide" aria-hidden="true" />
          ))}
        </div>
      ) : groups.length === 0 ? (
        <p className="page-note">{t(locale, "web.scan.dialog.noGroups")}</p>
      ) : (
        <>
          <div className="option-list" role="group" aria-label={t(locale, "web.scan.dialog.groups")}>
            {groups.map((group) => (
              <label key={group.id} className="option">
                <input
                  type="checkbox"
                  className="check"
                  checked={selected.has(group.id)}
                  onChange={() => toggle(group.id)}
                />
                <span className="option-name">{group.name}</span>
                <span className="option-sub">{group.locales.join(", ")}</span>
              </label>
            ))}
          </div>
          <div className="form-actions" style={{ marginTop: 18 }}>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || selected.size === 0}
              onClick={() => void run()}
            >
              {busy ? <span className="spinner" aria-hidden="true" /> : <Icon name="radar" size="sm" />}
              <span>{t(locale, "web.scan.run")}</span>
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
