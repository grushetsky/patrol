import { useSyncExternalStore } from "react";
import type { Locale } from "@patrol/i18n";
import { api } from "./api/client";
import { resolveLocale } from "./i18n";

/**
 * The session context every authenticated screen renders through: the
 * resolved interface language and the operator's role, which the settings
 * screens use to hide administrator-only forms. The browser language stands
 * in until the stored preference loads.
 *
 * The state lives in one module-level store rather than a per-component
 * useState: the top bar's language switch changes the locale for every
 * mounted screen at once (it also PATCHes /auth/preferences so the choice
 * persists on the account), which separate component-local copies could not
 * do without a reload.
 */

export interface SessionState {
  locale: Locale;
  role: "operator" | "administrator" | null;
}

const browserLanguage = (): string | null =>
  typeof navigator === "undefined" ? null : navigator.language;

let state: SessionState = {
  locale: resolveLocale(null, browserLanguage()),
  role: null,
};

const listeners = new Set<() => void>();
let loadStarted = false;

function emit() {
  for (const listener of listeners) {
    listener();
  }
}

/** Loads the operator's stored preference and role once, for all subscribers. */
function ensureLoaded() {
  if (loadStarted) {
    return;
  }
  loadStarted = true;
  void api.GET("/auth/session").then(({ data, response }) => {
    if (!response.ok || !data) {
      return;
    }
    state = {
      locale: resolveLocale(data.operator.preferredLanguage ?? null, browserLanguage()),
      role: data.operator.role,
    };
    emit();
  });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  ensureLoaded();
  return () => {
    listeners.delete(listener);
  };
}

export function useSession(): SessionState {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => state,
  );
}

/** The language switch's local half: re-renders every screen in the new
 *  locale immediately; the preference persists through PATCH /auth/preferences
 *  when a session stands. */
export function setSessionLocale(locale: Locale): void {
  // The document's language follows the interface's, announced or not.
  if (typeof document !== "undefined") {
    document.documentElement.lang = locale;
  }
  if (state.locale === locale) {
    return;
  }
  state = { ...state, locale };
  emit();
}
