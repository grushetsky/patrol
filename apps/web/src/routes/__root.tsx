import { useEffect, type ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import {
  HeadContent,
  Scripts,
  createRootRouteWithContext,
} from "@tanstack/react-router";
import {
  dashboardSummaryFn,
  requestLanguageFn,
  sessionFn,
  setupFn,
} from "../api/server";
import { AuthFlow } from "../components/auth";
import { AppShell } from "../components/shell";
import { LanguageContext } from "../i18n";
import "../styles.css";

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  loader: async () => {
    const [session, setup, language] = await Promise.all([
      sessionFn(),
      setupFn(),
      requestLanguageFn(),
    ]);
    const summary = session ? await dashboardSummaryFn() : null;
    return { session, setup, language, summary };
  },
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Patrol" },
    ],
  }),
  component: RootComponent,
});

function RootComponent() {
  const { session, setup, language, summary } = Route.useLoaderData();
  const { queryClient } = Route.useRouteContext();

  useEffect(() => {
    const saved = localStorage.getItem("patrol.theme");
    if (saved === "light" || saved === "dark") {
      document.documentElement.dataset.theme = saved;
    }
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <RootDocument language={language}>
        {session && summary ? (
          <AppShell session={session} summary={summary} />
        ) : (
          <LanguageContext.Provider value={language}>
            <AuthFlow setup={setup} language={language} />
          </LanguageContext.Provider>
        )}
      </RootDocument>
    </QueryClientProvider>
  );
}

function RootDocument({
  children,
  language,
}: Readonly<{ children: ReactNode; language: "en" | "ru" }>) {
  return (
    <html lang={language} data-theme="dark" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
