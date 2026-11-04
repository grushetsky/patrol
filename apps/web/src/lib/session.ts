import { useEffect, useState } from "react";
import type { Locale } from "@patrol/i18n";
import { api } from "./api/client";
import { resolveLocale } from "./i18n";

/**
 * The session context every authenticated screen renders through: the
 * resolved interface language and the operator's role, which the settings
 * screens use to hide administrator-only forms. The browser language
 * stands in until the stored preference loads.
 */
export interface SessionState {
  locale: Locale;
  role: "operator" | "administrator" | null;
}

export function useSession(): SessionState {
  const [state, setState] = useState<SessionState>(() => ({
    locale: resolveLocale(null, navigator.language),
    role: null,
  }));
  useEffect(() => {
    let cancelled = false;
    void api.GET("/auth/session").then(({ data, response }) => {
      if (cancelled || !response.ok || !data) {
        return;
      }
      setState({
        locale: resolveLocale(data.operator.preferredLanguage ?? null, navigator.language),
        role: data.operator.role,
      });
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return state;
}
