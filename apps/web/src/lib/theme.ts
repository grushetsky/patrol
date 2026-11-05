/**
 * Theme state, carried over from the prototype's theme-init.js/theme.js: dark
 * is the default language, light is the Gruvbox counterpart, the explicit
 * choice persists in localStorage, and a visit with no stored choice follows
 * the OS. The stamping happens before first paint through the inline init
 * script in the root route's head, so this module only serves the toggle.
 */

export type Theme = "dark" | "light";

export const THEME_STORAGE_KEY = "patrol.theme";

/** The pre-paint resolver, inlined into <head> before the styles apply. */
export const THEME_INIT_SCRIPT = `(function(){try{var s=localStorage.getItem("${THEME_STORAGE_KEY}");var t=s==="light"||s==="dark"?s:(window.matchMedia&&window.matchMedia("(prefers-color-scheme: light)").matches?"light":"dark");document.documentElement.dataset.theme=t;document.documentElement.style.colorScheme=t;}catch(e){document.documentElement.dataset.theme="dark";}})();`;

export function currentTheme(): Theme {
  if (typeof document === "undefined") {
    return "dark";
  }
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  try {
    if (localStorage.getItem(THEME_STORAGE_KEY) !== theme) {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    }
  } catch {
    /* Storage unavailable: the choice lasts the visit. */
  }
}
