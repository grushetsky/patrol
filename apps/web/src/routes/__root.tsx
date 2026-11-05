import type { QueryClient } from "@tanstack/react-query";
import {
  HeadContent,
  Scripts,
  createRootRouteWithContext,
} from "@tanstack/react-router";

import { AppShell } from "../components/app-shell";
import { THEME_INIT_SCRIPT, type Theme } from "../lib/theme";
import "../styles/app.css";

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Patrol" },
    ],
    links: [{ rel: "icon", href: "/favicon.svg", type: "image/svg+xml" }],
    scripts: [
      // Stamps the theme before the first paint: the stored choice, else the
      // OS preference, else the prototype's dark default.
      { children: THEME_INIT_SCRIPT },
    ],
  }),
  component: RootComponent,
});

function RootComponent() {
  return <RootDocument />;
}

function RootDocument() {
  // The server renders the dark default; the pre-paint script has already
  // stamped the resolved theme by the time the client renders, so React's
  // first render adopts it and hydration sees matching attributes (the
  // suppressHydrationWarning is belt-and-braces for the toggling script).
  const theme: Theme =
    typeof document === "undefined" || document.documentElement.dataset.theme !== "light"
      ? "dark"
      : "light";
  return (
    // `lang` is the SSR default only: the session's effect (lib/session,
    // app-shell) stamps the chosen locale onto the same attribute on mount.
    <html lang="en" data-theme={theme} suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body>
        <AppShell />
        <Scripts />
      </body>
    </html>
  );
}
