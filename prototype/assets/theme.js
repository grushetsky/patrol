/* Theme switching for the Patrol prototype. Dark is the default; light uses Gruvbox. */
(() => {
  "use strict";

  const STORAGE_KEY = "patrol.theme";
  const root = document.documentElement;
  const listeners = new Set();
  let theme = root.dataset.theme === "light" ? "light" : "dark";

  function label() {
    return PatrolI18n.t(theme === "light" ? "theme.toDark" : "theme.toLight");
  }

  function apply() {
    root.dataset.theme = theme;
    root.style.colorScheme = theme;
    const text = label();
    document.querySelectorAll("[data-theme-toggle]").forEach((button) => {
      const light = theme === "light";
      button.setAttribute("aria-pressed", String(light));
      button.setAttribute("aria-label", text);
      button.setAttribute("title", text);
    });
  }

  function setTheme(next) {
    if (next !== "light" && next !== "dark") return;
    theme = next;
    try {
      if (localStorage.getItem(STORAGE_KEY) !== theme) localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      /* Ignore unavailable storage. */
    }
    try {
      const url = new URL(location.href);
      if (url.searchParams.has("theme")) {
        url.searchParams.set("theme", theme);
        history.replaceState(null, "", url);
      }
    } catch {
      /* Ignore URLs that cannot be rewritten. */
    }
    apply();
    listeners.forEach((listener) => listener(theme));
  }

  document.addEventListener("click", (event) => {
    const button = event.target.closest("[data-theme-toggle]");
    if (button) setTheme(theme === "light" ? "dark" : "light");
  });

  window.addEventListener("storage", (event) => {
    if (event.key === STORAGE_KEY && (event.newValue === "light" || event.newValue === "dark")) {
      theme = event.newValue;
      apply();
      listeners.forEach((listener) => listener(theme));
    }
  });

  PatrolI18n.onChange(apply);

  window.PatrolTheme = {
    setTheme,
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    get theme() {
      return theme;
    },
  };

  apply();
})();
