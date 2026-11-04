import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { versionQuery } from "../api/queries";
import { resolveLanguage, translate } from "../i18n";

const requestLanguage = createServerFn({ method: "GET" }).handler(() =>
  resolveLanguage(getRequest().headers.get("accept-language")),
);

export const Route = createFileRoute("/")({
  loader: async ({ context }) => {
    const language = import.meta.env.SSR
      ? await requestLanguage()
      : resolveLanguage(
          typeof navigator === "undefined" ? undefined : navigator.language,
        );
    const version = await context.queryClient.ensureQueryData(versionQuery);
    return { language, version };
  },
  component: DashboardPage,
});

function DashboardPage() {
  const { language, version } = Route.useLoaderData();
  return (
    <main>
      <h1>{translate(language, "appTitle")}</h1>
      <p>{translate(language, "reviewQueue")}</p>
      <p>
        {translate(language, "version")}: {version.buildVersion} ·{" "}
        {version.migrationVersion} · {translate(language, "connected")}
      </p>
    </main>
  );
}
