/* Apply the saved theme before the stylesheets paint. */
(() => {
  "use strict";
  try {
    const query = new URLSearchParams(location.search).get("theme");
    const stored = localStorage.getItem("patrol.theme");
    const theme = query === "light" || query === "dark" ? query : stored === "light" || stored === "dark" ? stored : "dark";
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
  } catch {
    document.documentElement.dataset.theme = "dark";
  }
})();
