import { createFileRoute } from "@tanstack/react-router";
import { t, TEST_LOCALE } from "@patrol/i18n";
import { healthQuery } from "../lib/api/queries";

/**
 * The slice-0 shell page: its loader awaits the typed health query, proving
 * the SSR-to-API round trip through the generated client. The interface
 * language selection arrives with operator preferences in slice 1; until
 * then the catalogue resolves in the fixed default.
 */
export const Route = createFileRoute("/")({
  loader: ({ context }) => context.queryClient.ensureQueryData(healthQuery),
  component: Shell,
});

function Shell() {
  // The loader has already awaited the health query; the shell only renders.
  return (
    <main>
      <h1>{t(TEST_LOCALE, "system.title")}</h1>
      <p>{t(TEST_LOCALE, "system.greeting")}</p>
      <p>
        {t(TEST_LOCALE, "system.health.label")}:{" "}
        {/* HealthReport.status is the literal "ok"; render it through the
            catalogue rather than leaking the raw wire value. */}
        <strong>{t(TEST_LOCALE, "system.health.value.ok")}</strong>
      </p>
    </main>
  );
}
